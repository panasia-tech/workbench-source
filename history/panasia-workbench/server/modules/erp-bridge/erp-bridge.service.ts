import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  erpBindings,
  erpEntryTokens,
  systemConfigs,
} from '@server/database/schema';
import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import { ERP_ENTRY_TOKENS_UPGRADE_DDL } from '@server/database/standalone-schema';
import type {
  ErpBindingInfo,
  ErpBindingResponse,
  ErpEntryResponse,
  ErpVerifyResponse,
  UpdateErpBindingRequest,
} from '@shared/api.interface';

const DEFAULT_ERP_ENTRY_URL = 'http://127.0.0.1:8000';
const TOKEN_TTL_SECONDS = 60;
const TOKEN_TTL_MS = TOKEN_TTL_SECONDS * 1000;

type ErpBindingRow = typeof erpBindings.$inferSelect;

/**
 * 员工端 ERP 接口的调用方（见 erp-bridge.controller.ts callerOf）。
 * erpIdentity：本人登录（不是演示视角）、而且统一登录时核对过工作台用户 ID 就是 ERP 员工 ID（会话票据里记的，
 * 客户端改不了）。只有这种人自动绑定、开的入口才有工作台担保
 */
export interface ErpCaller {
  userId: string;
  erpIdentity: boolean;
  /** 统一登录的登录名（ERP 登录账号），自动绑定时当 ERP 用户名显示 */
  loginName: string | null;
}

@Injectable()
export class ErpBridgeService implements OnModuleInit {
  private readonly logger = new Logger(ErpBridgeService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 10-19 加的 erp_verified 列：已建好的库启动时幂等补上（不用人工迁移） */
  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'erp_entry_tokens',
      ERP_ENTRY_TOKENS_UPGRADE_DDL,
      'erp_entry_tokens 缺 erp_verified 列，ERP 免登入口用不了',
    );
  }

  private toInfo(row: ErpBindingRow): ErpBindingInfo {
    return {
      erpUserId: row.erpUserId,
      erpUsername: row.erpUsername,
      boundAt: row.createdAt.toISOString(),
    };
  }

  async getBinding(userId: string): Promise<ErpBindingInfo | null> {
    const rows: ErpBindingRow[] = await this.db
      .select()
      .from(erpBindings)
      .where(eq(erpBindings.miaodaUserId, userId));
    return rows.length > 0 ? this.toInfo(rows[0]) : null;
  }

  /** 「我的」页、「工作」页读绑定：ERP 身份的人没绑定就先自动绑上 */
  async getBindingState(caller: ErpCaller): Promise<ErpBindingResponse> {
    return this.stateOf(caller, await this.ensureAutoBinding(caller));
  }

  /** 进 ERP 免输密码要满足的：ERP 身份，且绑定的就是自己的 ERP 账号（工作台用户 ID = ERP 员工 ID） */
  private passwordFree(caller: ErpCaller, binding: ErpBindingInfo | null): boolean {
    return caller.erpIdentity && binding !== null && binding.erpUserId === caller.userId;
  }

  private stateOf(caller: ErpCaller, binding: ErpBindingInfo | null): ErpBindingResponse {
    return {
      binding,
      erpIdentity: caller.erpIdentity,
      passwordFree: this.passwordFree(caller, binding),
    };
  }

  /**
   * 免绑定（10-19）：用 ERP 账号从统一登录登进来的人，工作台用户 ID 就是 ERP 员工 ID，没绑定就绑到自己
   * （erpUserId = 用户 ID，ERP 按员工 ID 认得出；用户名取统一登录的登录名）。已经有绑定的（包括手动绑到别的
   * 账号的）不动；不是 ERP 身份的照旧手动绑
   */
  private async ensureAutoBinding(caller: ErpCaller): Promise<ErpBindingInfo | null> {
    const existing = await this.getBinding(caller.userId);
    if (existing || !caller.erpIdentity) return existing;
    const inserted = await this.db
      .insert(erpBindings)
      .values({
        miaodaUserId: caller.userId,
        erpUserId: caller.userId,
        erpUsername: caller.loginName ? caller.loginName.slice(0, 255) : null,
      })
      .onConflictDoNothing()
      .returning({ id: erpBindings.id });
    if (inserted.length > 0) {
      this.logger.log(
        `ERP 账号自动绑定：工作台用户 ${caller.userId}${caller.loginName ? `（${caller.loginName}）` : ''}`,
      );
    }
    return this.getBinding(caller.userId);
  }

  async upsertBinding(
    caller: ErpCaller,
    dto: UpdateErpBindingRequest,
  ): Promise<ErpBindingResponse> {
    const erpUserId = dto.erpUserId.trim();
    if (!erpUserId) {
      throw new BadRequestException('ERP 账号 ID 不能为空');
    }
    const erpUsername = dto.erpUsername?.trim() || null;
    const rows: ErpBindingRow[] = await this.db
      .insert(erpBindings)
      .values({ miaodaUserId: caller.userId, erpUserId, erpUsername })
      .onConflictDoUpdate({
        target: erpBindings.miaodaUserId,
        set: { erpUserId, erpUsername, updatedAt: new Date() },
      })
      .returning();
    return this.stateOf(caller, this.toInfo(rows[0]));
  }

  async deleteBinding(userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(erpBindings)
      .where(eq(erpBindings.miaodaUserId, userId))
      .returning({ id: erpBindings.id });
    return rows.length > 0;
  }

  async createEntry(caller: ErpCaller): Promise<ErpEntryResponse> {
    const binding = await this.ensureAutoBinding(caller);
    if (!binding) {
      throw new BadRequestException('尚未绑定 ERP 账号，请先在「我的」页绑定');
    }
    await this.cleanupExpiredTokens();
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    // 工作台担保在开入口这一刻定下来：本人登录、ERP 身份、绑定的就是自己（verify 时再核一遍绑定）
    await this.db.insert(erpEntryTokens).values({
      token,
      miaodaUserId: caller.userId,
      expiresAt,
      erpVerified: this.passwordFree(caller, binding),
    });
    const base = await this.resolveEntryBaseUrl();
    const url = `${base}${base.includes('?') ? '&' : '?'}entry_token=${token}`;
    return { url, expiresInSeconds: TOKEN_TTL_SECONDS };
  }

  async verifyToken(token: string): Promise<ErpVerifyResponse> {
    const consumed = await this.db
      .update(erpEntryTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(erpEntryTokens.token, token), isNull(erpEntryTokens.usedAt)),
      )
      .returning();
    if (consumed.length === 0) {
      throw new BadRequestException('entry token 无效或已被使用');
    }
    const row = consumed[0];
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('entry token 已过期，请从工作台重新进入');
    }
    const binding = await this.getBinding(row.miaodaUserId);
    if (!binding) {
      throw new BadRequestException('该账号尚未绑定 ERP 账号');
    }
    return {
      miaodaUserId: row.miaodaUserId,
      erpUserId: binding.erpUserId,
      erpUsername: binding.erpUsername,
      // 开入口时有担保，且这 60 秒里绑定没被改成别的账号；旧 token 没这一列的值，是 false
      erpVerified:
        row.erpVerified === true && binding.erpUserId === row.miaodaUserId,
    };
  }

  private async cleanupExpiredTokens(): Promise<void> {
    try {
      await this.db
        .delete(erpEntryTokens)
        .where(
          lt(erpEntryTokens.expiresAt, new Date(Date.now() - 24 * 3600 * 1000)),
        );
    } catch (error) {
      this.logger.warn('清理过期 entry token 失败', error);
    }
  }

  private async resolveEntryBaseUrl(): Promise<string> {
    try {
      const rows = await this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(eq(systemConfigs.configKey, 'erp.entry_url'));
      const raw =
        rows.length > 0 && rows[0].configValue != null
          ? rows[0].configValue
          : null;
      const value =
        raw && typeof raw === 'object' && 'value' in raw
          ? String((raw as { value: unknown }).value)
          : '';
      return value.trim() || DEFAULT_ERP_ENTRY_URL;
    } catch (error) {
      this.logger.warn('读取 erp.entry_url 配置失败，使用默认地址', error);
      return DEFAULT_ERP_ENTRY_URL;
    }
  }
}
