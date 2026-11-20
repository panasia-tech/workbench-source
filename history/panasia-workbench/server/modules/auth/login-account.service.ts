import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  WORKBENCH_LOGIN_ACCOUNTS_DDL,
  workbenchLoginAccounts,
} from '@server/database/standalone-schema';
import { AuthConfig, KNOWN_ROLES, USER_ID_PATTERN, type KnownRole } from './auth.config';
import type { OidcIdentity } from './oidc.service';

export const AUTHENTIK_PROVIDER = 'authentik';

const CACHE_TTL_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LoginAccountRow = typeof workbenchLoginAccounts.$inferSelect;

export type LoginResolution =
  | { status: 'ok'; account: LoginAccountRow }
  | { status: 'disabled' }
  /** 这个登录名已被另一个统一账号认领 */
  | { status: 'conflict' }
  /** 管理员还没为这个人建对照行；hint 给登录页展示，方便报给管理员 */
  | { status: 'not_provisioned'; hint: string }
  /** 对照行里的妙搭 userId 不合法，拒绝进会话 */
  | { status: 'invalid_user_id' };

export interface NotifyTarget {
  openId: string | null;
  email: string | null;
}

/** 管理端「员工」页用：登录过工作台的人 */
export interface LoginAccountBrief {
  userId: string;
  displayName: string | null;
  loginName: string | null;
  lastLoginAt: Date | null;
}

function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

@Injectable()
export class LoginAccountService implements OnModuleInit {
  private readonly logger = new Logger(LoginAccountService.name);
  private readonly cache = new Map<
    string,
    { row: LoginAccountRow | null; expiresAt: number }
  >();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly config: AuthConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTable();
  }

  /** 幂等建表；建表失败只记错误不阻断启动（登录会失败，日志里有原因） */
  async ensureTable(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'workbench_login_accounts',
      WORKBENCH_LOGIN_ACCOUNTS_DDL,
      '统一登录不可用',
    );
  }

  async findById(id: string): Promise<LoginAccountRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.row;
    }
    const rows: LoginAccountRow[] = await this.db
      .select()
      .from(workbenchLoginAccounts)
      .where(eq(workbenchLoginAccounts.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    this.cache.set(id, { row, expiresAt: Date.now() + CACHE_TTL_MS });
    return row;
  }

  /** 按工作台用户 ID 找对照行（个人 API Key 反查身份用），与 findById 同一套 60 秒缓存 */
  async findByMiaodaUserId(miaodaUserId: string): Promise<LoginAccountRow | null> {
    const cacheKey = `user:${miaodaUserId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.row;
    }
    const rows: LoginAccountRow[] = await this.db
      .select()
      .from(workbenchLoginAccounts)
      .where(eq(workbenchLoginAccounts.miaodaUserId, miaodaUserId))
      .limit(1);
    const row = rows[0] ?? null;
    this.cache.set(cacheKey, { row, expiresAt: Date.now() + CACHE_TTL_MS });
    return row;
  }

  /**
   * 统一账号 → 对照行：先认 subject，再按管理员预填的登录名首次认领；
   * 都没有且开了自动开号（AUTH_AUTO_PROVISION，默认开）就按 ERP 员工 ID 接管或新建一行。
   */
  async resolveOidcLogin(identity: OidcIdentity): Promise<LoginResolution> {
    const bySubject = await this.findBySubject(identity.subject);
    if (bySubject) {
      return this.checkUsable(bySubject);
    }
    const claimed = await this.claimByLoginName(identity);
    if (
      this.config.autoProvision &&
      (claimed.status === 'not_provisioned' || claimed.status === 'conflict')
    ) {
      return this.provision(identity, claimed);
    }
    return claimed;
  }

  /** 管理员按登录名预建、还没人认领的行：首次登录认领 */
  private async claimByLoginName(identity: OidcIdentity): Promise<LoginResolution> {
    const names = this.candidateLoginNames(identity);
    const hint = identity.username ?? identity.email ?? identity.subject;
    if (names.length === 0) {
      return { status: 'not_provisioned', hint };
    }
    const nameColumn = sql<string>`lower(${workbenchLoginAccounts.loginName})`;
    const unclaimed: LoginAccountRow[] = await this.db
      .select()
      .from(workbenchLoginAccounts)
      .where(
        and(
          eq(workbenchLoginAccounts.provider, AUTHENTIK_PROVIDER),
          isNull(workbenchLoginAccounts.subject),
          inArray(nameColumn, names),
        ),
      );
    if (unclaimed.length === 0) {
      const claimedByOther: { id: string }[] = await this.db
        .select({ id: workbenchLoginAccounts.id })
        .from(workbenchLoginAccounts)
        .where(
          and(
            eq(workbenchLoginAccounts.provider, AUTHENTIK_PROVIDER),
            isNotNull(workbenchLoginAccounts.subject),
            ne(workbenchLoginAccounts.subject, identity.subject),
            inArray(nameColumn, names),
          ),
        )
        .limit(1);
      return claimedByOther.length > 0
        ? { status: 'conflict' }
        : { status: 'not_provisioned', hint };
    }
    // 用户名匹配优先于邮箱匹配
    const target =
      unclaimed.find(
        (row: LoginAccountRow) => (row.loginName ?? '').toLowerCase() === names[0],
      ) ?? unclaimed[0];
    if (!target.enabled) {
      return { status: 'disabled' };
    }
    const claimed: { id: string }[] = await this.db
      .update(workbenchLoginAccounts)
      .set({ subject: identity.subject, updatedAt: new Date() })
      .where(
        and(eq(workbenchLoginAccounts.id, target.id), isNull(workbenchLoginAccounts.subject)),
      )
      .returning({ id: workbenchLoginAccounts.id });
    if (claimed.length === 0) {
      // 并发认领：再按 subject 查一次
      const again = await this.findBySubject(identity.subject);
      return again ? this.checkUsable(again) : { status: 'conflict' };
    }
    this.logger.log(
      `统一账号首次认领：${hint} → 妙搭 userId ${target.miaodaUserId}`,
    );
    this.invalidate(target.id);
    return this.checkUsable({ ...target, subject: identity.subject });
  }

  /**
   * 自动开号。工作台用户 ID（各业务表外键）优先用 ERP 员工 ID（erp_sub）；没有 erp_sub 的号只在
   * AUTH_ALLOW_NON_ERP 打开时用 Authentik 的 sub，否则照旧等管理员预建（返回 fallback）。
   */
  private async provision(
    identity: OidcIdentity,
    fallback: LoginResolution,
  ): Promise<LoginResolution> {
    const userId =
      identity.erpSub ?? (this.config.allowNonErpProvision ? identity.subject : null);
    const who = identity.username ?? identity.email ?? identity.subject;
    if (userId === null) {
      this.logger.warn(`统一账号 ${who} 没有 erp_sub（不是 ERP 员工号），不自动开号`);
      return fallback;
    }
    if (!USER_ID_PATTERN.test(userId)) {
      this.logger.error(`自动开号被拒：用户 ID「${userId}」含非法字符（${who}）`);
      return { status: 'invalid_user_id' };
    }
    if (identity.erpSub) {
      const relinked = await this.relinkByUserId(identity, identity.erpSub);
      if (relinked) return relinked;
    }
    await this.releaseStaleLoginName(identity);
    const inserted: LoginAccountRow[] = await this.db
      .insert(workbenchLoginAccounts)
      .values({
        provider: AUTHENTIK_PROVIDER,
        subject: identity.subject,
        loginName: clip(identity.username, 255),
        email: clip(identity.email, 255),
        miaodaUserId: userId,
        displayName: clip(identity.displayName ?? identity.username, 100),
        idpGroups: identity.groups.slice(0, 100),
        note: identity.erpSub ? '首次统一登录自动开号（ERP 员工）' : '首次统一登录自动开号（非 ERP 号）',
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // 同一人并发登录，另一边先建了
      const again = await this.findBySubject(identity.subject);
      return again ? this.checkUsable(again) : { status: 'conflict' };
    }
    this.logger.log(
      `统一账号自动开号：${who} → 工作台用户 ID ${userId}${identity.erpSub ? '（ERP 员工 ID）' : '（Authentik sub）'}`,
    );
    return this.checkUsable(inserted[0]);
  }

  /**
   * 同一个 ERP 员工已有对照行就接过来，不另建：管理员按 ERP 员工 ID 预建、还没认领的行（优先），
   * 或这人换过统一账号（Authentik 号重建、sub 变了）留下的旧行。停用的行照样拦住。
   */
  private async relinkByUserId(
    identity: OidcIdentity,
    erpSub: string,
  ): Promise<LoginResolution | null> {
    const rows: LoginAccountRow[] = await this.db
      .select()
      .from(workbenchLoginAccounts)
      .where(
        and(
          eq(workbenchLoginAccounts.provider, AUTHENTIK_PROVIDER),
          eq(workbenchLoginAccounts.miaodaUserId, erpSub),
        ),
      )
      .orderBy(
        sql`${workbenchLoginAccounts.subject} IS NULL DESC`,
        desc(sql`coalesce(${workbenchLoginAccounts.lastLoginAt}, ${workbenchLoginAccounts.createdAt})`),
      )
      .limit(1);
    const target = rows[0];
    if (!target) return null;
    if (!target.enabled) return { status: 'disabled' };
    try {
      await this.db
        .update(workbenchLoginAccounts)
        .set({ subject: identity.subject, updatedAt: new Date() })
        .where(eq(workbenchLoginAccounts.id, target.id));
    } catch (error) {
      if (postgresErrorCode(error) !== '23505') throw error;
      const again = await this.findBySubject(identity.subject);
      return again ? this.checkUsable(again) : { status: 'conflict' };
    }
    this.invalidate(target.id);
    if (target.subject === null) {
      this.logger.log(`统一账号按 ERP 员工 ID 认领预建行：${erpSub}`);
    } else {
      this.logger.warn(
        `ERP 员工 ${erpSub} 换了统一账号（sub ${target.subject} → ${identity.subject}），对照行改绑到新账号`,
      );
    }
    return this.checkUsable({ ...target, subject: identity.subject });
  }

  /**
   * ERP 删员工时把用户名改成 xxx__del_xxx、腾给新人：Authentik 用户名同一时刻唯一，别的 subject 的行
   * 还挂着这个登录名就是过时的。清掉它（那一行照旧按 subject 登录），给新行腾出登录名唯一索引。
   */
  private async releaseStaleLoginName(identity: OidcIdentity): Promise<void> {
    if (!identity.username) return;
    const released: { id: string; userId: string }[] = await this.db
      .update(workbenchLoginAccounts)
      .set({ loginName: null, updatedAt: new Date() })
      .where(
        and(
          eq(workbenchLoginAccounts.provider, AUTHENTIK_PROVIDER),
          isNotNull(workbenchLoginAccounts.subject),
          ne(workbenchLoginAccounts.subject, identity.subject),
          eq(sql`lower(${workbenchLoginAccounts.loginName})`, identity.username.toLowerCase()),
        ),
      )
      .returning({ id: workbenchLoginAccounts.id, userId: workbenchLoginAccounts.miaodaUserId });
    for (const row of released) {
      this.invalidate(row.id);
      this.logger.warn(
        `登录名 ${identity.username} 已归新账号，清掉旧对照行（用户 ID ${row.userId}）上过时的登录名`,
      );
    }
  }

  /** 每次登录刷新 IdP 侧信息：组、邮箱；显示名、登录名只在本地没填时补 */
  async recordLogin(account: LoginAccountRow, identity: OidcIdentity): Promise<void> {
    await this.db
      .update(workbenchLoginAccounts)
      .set({
        idpGroups: identity.groups.slice(0, 100),
        email: clip(identity.email, 255) ?? account.email,
        displayName:
          account.displayName ?? clip(identity.displayName ?? identity.username, 100),
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workbenchLoginAccounts.id, account.id));
    this.invalidate(account.id);
    if (account.loginName !== null || !identity.username) return;
    // 登录名单独补：撞了别的行的登录名（唯一索引）就不补，不能连累上面刷新组
    await this.db
      .update(workbenchLoginAccounts)
      .set({ loginName: clip(identity.username, 255) })
      .where(
        and(eq(workbenchLoginAccounts.id, account.id), isNull(workbenchLoginAccounts.loginName)),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `补登录名 ${identity.username} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** 角色 = 本地授予 ∪ Authentik 组映射（AUTH_BOSS_GROUPS / AUTH_ADMIN_GROUPS） */
  resolveRoles(account: Pick<LoginAccountRow, 'roles' | 'idpGroups'>): KnownRole[] {
    const granted = new Set<KnownRole>();
    for (const role of account.roles ?? []) {
      if ((KNOWN_ROLES as readonly string[]).includes(role)) {
        granted.add(role as KnownRole);
      }
    }
    const groups = new Set(account.idpGroups ?? []);
    for (const role of KNOWN_ROLES) {
      if (this.config.roleGroups[role].some((group: string) => groups.has(group))) {
        granted.add(role);
      }
    }
    return [...granted];
  }

  /** 飞书通知收件信息：同一人多行时 open_id 优先 */
  async findNotifyTargets(userIds: string[]): Promise<Map<string, NotifyTarget>> {
    const result = new Map<string, NotifyTarget>();
    if (userIds.length === 0) return result;
    const rows: { userId: string; openId: string | null; email: string | null }[] =
      await this.db
        .select({
          userId: workbenchLoginAccounts.miaodaUserId,
          openId: workbenchLoginAccounts.feishuOpenId,
          email: workbenchLoginAccounts.email,
        })
        .from(workbenchLoginAccounts)
        .where(
          and(
            inArray(workbenchLoginAccounts.miaodaUserId, userIds),
            eq(workbenchLoginAccounts.enabled, true),
          ),
        );
    for (const row of rows) {
      const current = result.get(row.userId) ?? { openId: null, email: null };
      result.set(row.userId, {
        openId: current.openId ?? row.openId ?? null,
        email: current.email ?? row.email ?? null,
      });
    }
    return result;
  }

  async listDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (userIds.length === 0) return result;
    const rows: { userId: string; name: string | null }[] = await this.db
      .select({
        userId: workbenchLoginAccounts.miaodaUserId,
        name: workbenchLoginAccounts.displayName,
      })
      .from(workbenchLoginAccounts)
      .where(inArray(workbenchLoginAccounts.miaodaUserId, userIds));
    for (const row of rows) {
      if (row.name && !result.has(row.userId)) result.set(row.userId, row.name);
    }
    return result;
  }

  /** 登录过工作台、没停用的人（同一用户 ID 多行取最近登录的一行），最近登录的在前 */
  async listActiveAccounts(): Promise<LoginAccountBrief[]> {
    const rows: LoginAccountBrief[] = await this.db
      .select({
        userId: workbenchLoginAccounts.miaodaUserId,
        displayName: workbenchLoginAccounts.displayName,
        loginName: workbenchLoginAccounts.loginName,
        lastLoginAt: workbenchLoginAccounts.lastLoginAt,
      })
      .from(workbenchLoginAccounts)
      .where(
        and(
          eq(workbenchLoginAccounts.enabled, true),
          isNotNull(workbenchLoginAccounts.subject),
        ),
      )
      .orderBy(
        desc(sql`coalesce(${workbenchLoginAccounts.lastLoginAt}, ${workbenchLoginAccounts.createdAt})`),
      );
    const seen = new Set<string>();
    return rows.filter((row: LoginAccountBrief) => {
      if (seen.has(row.userId)) return false;
      seen.add(row.userId);
      return true;
    });
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }

  private async findBySubject(subject: string): Promise<LoginAccountRow | null> {
    const rows: LoginAccountRow[] = await this.db
      .select()
      .from(workbenchLoginAccounts)
      .where(
        and(
          eq(workbenchLoginAccounts.provider, AUTHENTIK_PROVIDER),
          eq(workbenchLoginAccounts.subject, subject),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private checkUsable(row: LoginAccountRow): LoginResolution {
    if (!row.enabled) return { status: 'disabled' };
    if (!USER_ID_PATTERN.test(row.miaodaUserId)) {
      this.logger.error(
        `对照行 ${row.id} 的 miaoda_user_id「${row.miaodaUserId}」含非法字符，拒绝登录`,
      );
      return { status: 'invalid_user_id' };
    }
    return { status: 'ok', account: row };
  }

  /** 用户名在前；邮箱只在 IdP 没明说未验证时才用 */
  private candidateLoginNames(identity: OidcIdentity): string[] {
    const names: string[] = [];
    if (identity.username) names.push(identity.username.toLowerCase());
    if (identity.email && identity.emailVerified) names.push(identity.email.toLowerCase());
    return [...new Set(names)];
  }
}
