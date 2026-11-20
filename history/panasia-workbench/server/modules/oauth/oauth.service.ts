import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { Request } from 'express';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  WORKBENCH_OAUTH_CLIENTS_DDL,
  WORKBENCH_OAUTH_CODES_DDL,
  WORKBENCH_OAUTH_GRANTS_DDL,
  workbenchOauthClients,
  workbenchOauthCodes,
  workbenchOauthGrants,
} from '@server/database/standalone-schema';
import type { OAuthGrantListResponse } from '@shared/api.interface';
import { AuthConfig } from '../auth/auth.config';
import { LoginAccountService } from '../auth/login-account.service';
import { signToken, verifyToken } from '../auth/session.util';
import {
  ACCESS_TOKEN_PREFIX,
  MAX_REDIRECT_URIS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_PREFIX,
  TOKEN_ENDPOINT_AUTH_METHODS,
  describeRedirect,
  isPkceValue,
  oauthUrls,
  pkceChallengeOf,
  redirectUriMatches,
  redirectUriProblem,
  type OAuthUrls,
} from './oauth-rules';

const ACCESS_TTL_SECONDS = 3600;
/** 刷新令牌 90 天，每次刷新顺延：一直在用就一直不用重连 */
const REFRESH_TTL_MS = 90 * 24 * 3600_000;
const CODE_TTL_MS = 5 * 60_000;
/** 授权页签名票据：打开授权页到点同意之间最多这么久 */
const CONSENT_TTL_SECONDS = 600;
/** 从没签过授权码的注册留 30 天（ChatGPT 可能拿旧注册重试） */
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 3600_000;
const GRANT_CACHE_TTL_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;
/**
 * 动态注册不登录就能调：按 IP 和全站各限一道，防有人刷库。
 * 现在两层反代下应用看到的 IP 全是边缘机（内层 Caddy 不信任边缘、改写了 X-Forwarded-For），
 * 按 IP 这道实际是全公司共用一个桶，所以给到 60 次/时，大家同时接入也够用
 */
const REGISTER_LIMIT_PER_IP = 60;
const REGISTER_LIMIT_GLOBAL = 300;
const REGISTER_WINDOW_MS = 3600_000;

const ACCESS_TOKEN_TYPE = 'DEMO_ONLY_REDACTED';
const CONSENT_TOKEN_TYPE = 'DEMO_ONLY_REDACTED';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 令牌端点 / 注册端点的标准错误（error 码照 RFC，description 给人看） */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface OAuthClient {
  id: string;
  secretDigest: string | null;
  authMethod: string;
  clientName: string;
  redirectUris: string[];
}

/** 授权页签名票据里带的授权请求（同意时原样取回，不信表单里别的字段） */
export interface ConsentRequest {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
}

export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface GrantRow {
  id: string;
  clientId: string;
  userId: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 会话密钥派生出各自用途的子密钥：OAuth 的票据和登录会话票据互相冒充不了 */
function deriveKey(secret: Buffer, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`panasia-workbench/${purpose}/v1`).digest();
}

function readText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

/**
 * 工作台自己当 OAuth 授权服务器（2026-10-25）：给 ChatGPT 网页版这类只能 OAuth、填不了请求头的 MCP 客户端用。
 * 应用自助注册 → 员工在授权页（统一登录后）点同意 → 授权码 + PKCE 换令牌 → 带访问令牌调 /openapi/mcp，
 * 身份 = 授权的人，工具按本人角色分档（同个人 API Key）。表启动时自建。
 */
@Injectable()
export class OAuthService implements OnModuleInit {
  private readonly logger = new Logger(OAuthService.name);
  private readonly accessKey: Buffer;
  private readonly consentKey: Buffer;
  private readonly grantCache = new Map<string, { row: GrantRow | null; expiresAt: number }>();
  private readonly registerHits = new Map<string, number[]>();
  private registerGlobalHits: number[] = [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly config: AuthConfig,
    private readonly accounts: LoginAccountService,
  ) {
    this.accessKey = deriveKey(config.sessionSecret, 'oauth-access-token');
    this.consentKey = deriveKey(config.sessionSecret, 'oauth-consent');
  }

  async onModuleInit(): Promise<void> {
    const tables: [string, string[]][] = [
      ['workbench_oauth_clients', WORKBENCH_OAUTH_CLIENTS_DDL],
      ['workbench_oauth_codes', WORKBENCH_OAUTH_CODES_DDL],
      ['workbench_oauth_grants', WORKBENCH_OAUTH_GRANTS_DDL],
    ];
    for (const [table, ddl] of tables) {
      await ensureStandaloneTable(this.db, this.logger, table, ddl, 'OAuth 授权不可用');
    }
  }

  /** 对外地址：PUBLIC_BASE_URL 优先（反代后面 Host 不一定对），没配按请求拼 */
  urls(req: Request): OAuthUrls {
    const raw = this.config.publicBaseUrl ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    let origin = raw;
    try {
      origin = new URL(raw).origin;
    } catch {
      // Host 头不合法时原样用，发现文档里的地址照样能看出问题
    }
    return oauthUrls(origin, this.config.basePath);
  }

  // ───────── 动态注册（RFC 7591） ─────────

  /** 滑动窗口计数，超了返回 false（只在内存里，重启清零） */
  allowRegistration(ip: string): boolean {
    const now = Date.now();
    const keep = (hits: number[]): number[] =>
      hits.filter((at: number) => now - at < REGISTER_WINDOW_MS);
    this.registerGlobalHits = keep(this.registerGlobalHits);
    const mine = keep(this.registerHits.get(ip) ?? []);
    if (mine.length >= REGISTER_LIMIT_PER_IP || this.registerGlobalHits.length >= REGISTER_LIMIT_GLOBAL) {
      this.registerHits.set(ip, mine);
      return false;
    }
    mine.push(now);
    this.registerHits.set(ip, mine);
    this.registerGlobalHits.push(now);
    if (this.registerHits.size > 5000) {
      for (const [key, hits] of this.registerHits) {
        if (keep(hits).length === 0) this.registerHits.delete(key);
      }
    }
    return true;
  }

  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OAuthError('invalid_client_metadata', '注册请求要是 JSON 对象');
    }
    const input = body as Record<string, unknown>;
    const rawUris = input.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0 || rawUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uris 要是 1～${MAX_REDIRECT_URIS} 个回调地址`,
      );
    }
    const redirectUris: string[] = [];
    for (const raw of rawUris) {
      const problem = redirectUriProblem(raw);
      if (problem) throw new OAuthError('invalid_redirect_uri', problem);
      if (!redirectUris.includes(raw as string)) redirectUris.push(raw as string);
    }
    // RFC 7591 缺省是 client_secret_basic
    const method = (input.token_endpoint_auth_method ?? 'client_secret_basic') as string;
    if (!(TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(method)) {
      throw new OAuthError(
        'invalid_client_metadata',
        `token_endpoint_auth_method 只支持 ${TOKEN_ENDPOINT_AUTH_METHODS.join(' / ')}`,
      );
    }
    const responseTypes = input.response_types;
    if (
      responseTypes !== undefined &&
      (!Array.isArray(responseTypes) || responseTypes.some((type: unknown) => type !== 'code'))
    ) {
      throw new OAuthError('invalid_client_metadata', 'response_types 只支持 code');
    }
    const clientName = readText(input.client_name, 100) ?? '';
    const metadata: Record<string, unknown> = {};
    for (const key of ['client_uri', 'logo_uri', 'tos_uri', 'policy_uri', 'software_id', 'software_version']) {
      const value = readText(input[key], 500);
      if (value) metadata[key] = value;
    }
    const clientId = randomToken(18);
    const secret = method === 'none' ? null : randomToken(32);
    const now = new Date();
    await this.db.insert(workbenchOauthClients).values({
      id: clientId,
      secretDigest: secret ? digestOf(secret) : null,
      authMethod: method,
      clientName,
      redirectUris,
      metadata,
    });
    // 顺手清掉从没用过的旧注册
    void this.db
      .delete(workbenchOauthClients)
      .where(
        and(
          isNull(workbenchOauthClients.lastUsedAt),
          lt(workbenchOauthClients.createdAt, new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)),
        ),
      )
      .catch((error: unknown) => this.logger.warn(`清理旧 OAuth 注册失败：${String(error)}`));
    this.logger.log(
      `OAuth 应用注册：${clientName || '（未命名）'} ${clientId} ${method} → ${redirectUris.join(' ')}`,
    );
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: OAUTH_SCOPE,
      ...metadata,
    };
  }

  async findClient(clientId: string | null): Promise<OAuthClient | null> {
    if (!clientId || clientId.length > 64) return null;
    const rows = await this.db
      .select({
        id: workbenchOauthClients.id,
        secretDigest: workbenchOauthClients.secretDigest,
        authMethod: workbenchOauthClients.authMethod,
        clientName: workbenchOauthClients.clientName,
        redirectUris: workbenchOauthClients.redirectUris,
      })
      .from(workbenchOauthClients)
      .where(eq(workbenchOauthClients.id, clientId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 授权请求的回调：带了就要对得上注册的；没带且只注册了一个就用它 */
  resolveRedirectUri(client: OAuthClient, presented: string | null): string | null {
    if (presented === null) {
      return client.redirectUris.length === 1 ? client.redirectUris[0] : null;
    }
    return client.redirectUris.some((uri: string) => redirectUriMatches(uri, presented))
      ? presented
      : null;
  }

  /**
   * 令牌 / 吊销端点认应用：机密客户端要 client_secret（Basic 或表单都收，不卡注册时报的那种），
   * 公开客户端只认 client_id（靠 PKCE）
   */
  async authenticateClient(
    clientId: string | null,
    secret: string | null,
  ): Promise<OAuthClient> {
    const client = await this.findClient(clientId);
    if (!client) {
      throw new OAuthError('invalid_client', '应用没有在工作台登记，请在 AI 工具里重新连接', 401);
    }
    if (client.secretDigest && (!secret || !sameDigest(digestOf(secret), client.secretDigest))) {
      throw new OAuthError('invalid_client', 'client_secret 不对', 401);
    }
    return client;
  }

  // ───────── 授权页 ─────────

  signConsent(request: ConsentRequest): string {
    return signToken(
      {
        typ: CONSENT_TOKEN_TYPE,
        ...request,
        exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_SECONDS,
      },
      this.consentKey,
    );
  }

  readConsent(token: unknown): ConsentRequest | null {
    const payload = verifyToken(token, this.consentKey);
    if (
      !payload ||
      payload.typ !== CONSENT_TOKEN_TYPE ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      typeof payload.userId !== 'string' ||
      typeof payload.clientId !== 'string' ||
      typeof payload.redirectUri !== 'string' ||
      !isPkceValue(payload.codeChallenge)
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      state: typeof payload.state === 'string' ? payload.state : null,
      resource: typeof payload.resource === 'string' ? payload.resource : null,
    };
  }

  /** 点了同意：签一次性授权码（库里只存 digest） */
  async issueCode(request: ConsentRequest): Promise<string> {
    const code = randomToken(32);
    const now = new Date();
    await this.db.insert(workbenchOauthCodes).values({
      codeDigest: digestOf(code),
      clientId: request.clientId,
      userId: request.userId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
    await this.db
      .update(workbenchOauthClients)
      .set({ lastUsedAt: now })
      .where(eq(workbenchOauthClients.id, request.clientId));
    void this.db
      .delete(workbenchOauthCodes)
      .where(lt(workbenchOauthCodes.expiresAt, new Date(now.getTime() - 24 * 3600_000)))
      .catch((error: unknown) => this.logger.warn(`清理过期授权码失败：${String(error)}`));
    return code;
  }

  // ───────── 令牌端点 ─────────

  async exchangeCode(input: {
    client: OAuthClient;
    code: string | null;
    verifier: string | null;
    redirectUri: string | null;
    resource: string | null;
  }): Promise<TokenSet> {
    if (!input.code) throw new OAuthError('invalid_request', '缺 code');
    const digest = digestOf(input.code);
    const now = new Date();
    // 先原子地占用：同一张码并发来换，只有一次拿得到
    const claimed = await this.db
      .update(workbenchOauthCodes)
      .set({ usedAt: now })
      .where(and(eq(workbenchOauthCodes.codeDigest, digest), isNull(workbenchOauthCodes.usedAt)))
      .returning();
    const code = claimed[0];
    if (!code) {
      const used = await this.db
        .select({ grantId: workbenchOauthCodes.grantId })
        .from(workbenchOauthCodes)
        .where(eq(workbenchOauthCodes.codeDigest, digest))
        .limit(1);
      if (used[0]?.grantId) {
        // 用过的码又来换：码可能被截获了，按 OAuth 2.1 吊销它换出的授权
        await this.revokeGrantById(used[0].grantId);
        this.logger.warn(`OAuth 授权码重复使用，已吊销授权 ${used[0].grantId}`);
      }
      throw new OAuthError('invalid_grant', '授权码无效或已用过');
    }
    if (code.clientId !== input.client.id) {
      throw new OAuthError('invalid_grant', '授权码不是发给这个应用的');
    }
    if (code.expiresAt.getTime() <= now.getTime()) {
      throw new OAuthError('invalid_grant', '授权码过期了，请重新授权');
    }
    if (input.redirectUri !== null && input.redirectUri !== code.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri 和授权时的不一致');
    }
    if (!isPkceValue(input.verifier) || pkceChallengeOf(input.verifier) !== code.codeChallenge) {
      throw new OAuthError('invalid_grant', 'code_verifier 不对');
    }
    if (input.resource !== null && code.resource !== null && input.resource !== code.resource) {
      throw new OAuthError('invalid_target', 'resource 和授权时的不一致');
    }
    await this.assertAccountUsable(code.userId);
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
    const grantId = await this.db.transaction(async (tx) => {
      // 一个人对一个应用只留一份授权：重新连接时旧的作废
      await tx
        .update(workbenchOauthGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(workbenchOauthGrants.clientId, code.clientId),
            eq(workbenchOauthGrants.userId, code.userId),
            isNull(workbenchOauthGrants.revokedAt),
          ),
        );
      const rows = await tx
        .insert(workbenchOauthGrants)
        .values({
          clientId: code.clientId,
          userId: code.userId,
          scope: OAUTH_SCOPE,
          resource: input.resource ?? code.resource,
          refreshDigest: digestOf(refreshToken),
          refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
          lastUsedAt: now,
        })
        .returning({ id: workbenchOauthGrants.id });
      await tx
        .update(workbenchOauthCodes)
        .set({ grantId: rows[0].id })
        .where(eq(workbenchOauthCodes.codeDigest, digest));
      return rows[0].id;
    });
    this.dropGrantCache();
    this.logger.log(`OAuth 发令牌：${input.client.clientName || input.client.id} → ${code.userId}`);
    return this.tokenSet(grantId, refreshToken);
  }

  async refresh(input: { client: OAuthClient; refreshToken: string | null }): Promise<TokenSet> {
    if (!input.refreshToken) throw new OAuthError('invalid_request', '缺 refresh_token');
    const digest = digestOf(input.refreshToken);
    const now = new Date();
    const rows = await this.db
      .select()
      .from(workbenchOauthGrants)
      .where(
        and(
          or(
            eq(workbenchOauthGrants.refreshDigest, digest),
            eq(workbenchOauthGrants.prevRefreshDigest, digest),
          ),
          isNull(workbenchOauthGrants.revokedAt),
        ),
      )
      .limit(1);
    const grant = rows[0];
    if (!grant || grant.clientId !== input.client.id) {
      throw new OAuthError('invalid_grant', '刷新令牌无效，请在 AI 工具里重新连接');
    }
    if (grant.refreshExpiresAt.getTime() <= now.getTime()) {
      throw new OAuthError('invalid_grant', '授权过期了，请在 AI 工具里重新连接');
    }
    await this.assertAccountUsable(grant.userId);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
    if (input.client.secretDigest) {
      // 机密客户端：刷新令牌要配 client_secret 才能用，不轮换（防并发刷新互相作废），只顺延有效期
      await this.db
        .update(workbenchOauthGrants)
        .set({ refreshExpiresAt, lastUsedAt: now })
        .where(eq(workbenchOauthGrants.id, grant.id));
      return this.tokenSet(grant.id, input.refreshToken);
    }
    // 公开客户端按 OAuth 2.1 轮换。用的是最新那张：它退成「上一张」；用的是上一张（上次的新令牌客户端没收到）：
    // 换一张新的顶掉没收到的那张。条件更新防并发
    const next = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
    const usedCurrent = grant.refreshDigest === digest;
    const updated = await this.db
      .update(workbenchOauthGrants)
      .set({
        refreshDigest: digestOf(next),
        prevRefreshDigest: usedCurrent ? digest : grant.prevRefreshDigest,
        refreshExpiresAt,
        lastUsedAt: now,
      })
      .where(
        and(
          eq(workbenchOauthGrants.id, grant.id),
          eq(workbenchOauthGrants.refreshDigest, grant.refreshDigest),
          isNull(workbenchOauthGrants.revokedAt),
        ),
      )
      .returning({ id: workbenchOauthGrants.id });
    if (updated.length === 0) {
      throw new OAuthError('invalid_grant', '刷新令牌刚被用过，请重试');
    }
    return this.tokenSet(grant.id, next);
  }

  /** RFC 7009：吊销刷新令牌或访问令牌 = 吊销整份授权；不认识的令牌也算成功 */
  async revokeToken(client: OAuthClient, token: string | null): Promise<void> {
    if (!token) return;
    let grantId: string | null = null;
    if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
      const digest = digestOf(token);
      const rows = await this.db
        .select({ id: workbenchOauthGrants.id, clientId: workbenchOauthGrants.clientId })
        .from(workbenchOauthGrants)
        .where(
          or(
            eq(workbenchOauthGrants.refreshDigest, digest),
            eq(workbenchOauthGrants.prevRefreshDigest, digest),
          ),
        )
        .limit(1);
      grantId = rows[0]?.clientId === client.id ? rows[0].id : null;
    } else {
      const fromAccess = this.readAccessToken(token);
      const row = fromAccess ? await this.loadGrant(fromAccess) : null;
      grantId = row?.clientId === client.id ? row.id : null;
    }
    if (grantId) {
      await this.revokeGrantById(grantId);
      this.logger.log(`OAuth 应用自己吊销了授权 ${grantId}`);
    }
  }

  // ───────── MCP 鉴权（auth-gate 调） ─────────

  /** 访问令牌 → 授权的人；签名不对、过期、授权已收回一律 null */
  async verifyAccessToken(raw: string): Promise<{ userId: string; grantId: string } | null> {
    const grantId = this.readAccessToken(raw);
    if (!grantId) return null;
    const grant = await this.loadGrant(grantId);
    if (!grant || grant.revokedAt) return null;
    if (grant.lastUsedAt === null || Date.now() - grant.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      grant.lastUsedAt = new Date();
      void this.db
        .update(workbenchOauthGrants)
        .set({ lastUsedAt: grant.lastUsedAt })
        .where(eq(workbenchOauthGrants.id, grant.id))
        .catch(() => undefined);
    }
    return { userId: grant.userId, grantId: grant.id };
  }

  // ───────── 「我的」页 ─────────

  async listGrants(userId: string): Promise<OAuthGrantListResponse> {
    const rows = await this.db
      .select({
        id: workbenchOauthGrants.id,
        clientName: workbenchOauthClients.clientName,
        redirectUris: workbenchOauthClients.redirectUris,
        createdAt: workbenchOauthGrants.createdAt,
        lastUsedAt: workbenchOauthGrants.lastUsedAt,
      })
      .from(workbenchOauthGrants)
      .leftJoin(workbenchOauthClients, eq(workbenchOauthClients.id, workbenchOauthGrants.clientId))
      .where(
        and(
          eq(workbenchOauthGrants.userId, userId),
          isNull(workbenchOauthGrants.revokedAt),
          gt(workbenchOauthGrants.refreshExpiresAt, new Date()),
        ),
      )
      .orderBy(desc(workbenchOauthGrants.createdAt));
    return {
      items: rows.map((row) => ({
        id: row.id,
        clientName: row.clientName ?? '',
        redirectLabel: row.redirectUris?.[0] ? describeRedirect(row.redirectUris[0]).label : '',
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })),
    };
  }

  /** 收回：只能收回自己的，别人的 / 不存在同样 404；重复收回幂等 */
  async revokeGrantOfUser(userId: string, id: string): Promise<{ ok: true }> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('授权不存在');
    const rows = await this.db
      .update(workbenchOauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(workbenchOauthGrants.id, id), eq(workbenchOauthGrants.userId, userId)))
      .returning({ id: workbenchOauthGrants.id });
    if (rows.length === 0) throw new NotFoundException('授权不存在');
    this.dropGrantCache();
    return { ok: true };
  }

  // ───────── 内部 ─────────

  private tokenSet(grantId: string, refreshToken: string): TokenSet {
    const now = Math.floor(Date.now() / 1000);
    // jti：同一秒里刷新两次也是两张不同的令牌
    const accessToken = signToken(
      { typ: ACCESS_TOKEN_TYPE, gid: grantId, jti: randomToken(9), iat: now, exp: now + ACCESS_TTL_SECONDS },
      this.accessKey,
    );
    return {
      access_token: `${ACCESS_TOKEN_PREFIX}${accessToken}`,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    };
  }

  /** 验签取授权 ID（不查库） */
  private readAccessToken(raw: string): string | null {
    if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const payload = verifyToken(raw.slice(ACCESS_TOKEN_PREFIX.length), this.accessKey);
    if (
      !payload ||
      payload.typ !== ACCESS_TOKEN_TYPE ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      typeof payload.gid !== 'string' ||
      !UUID_PATTERN.test(payload.gid)
    ) {
      return null;
    }
    return payload.gid;
  }

  /** 授权行 60 秒缓存（本进程里收回会立刻清缓存） */
  private async loadGrant(grantId: string): Promise<GrantRow | null> {
    const cached = this.grantCache.get(grantId);
    if (cached && cached.expiresAt > Date.now()) return cached.row;
    const rows = await this.db
      .select({
        id: workbenchOauthGrants.id,
        clientId: workbenchOauthGrants.clientId,
        userId: workbenchOauthGrants.userId,
        revokedAt: workbenchOauthGrants.revokedAt,
        lastUsedAt: workbenchOauthGrants.lastUsedAt,
      })
      .from(workbenchOauthGrants)
      .where(eq(workbenchOauthGrants.id, grantId))
      .limit(1);
    const row = rows[0] ?? null;
    if (this.grantCache.size > 5000) this.grantCache.clear();
    this.grantCache.set(grantId, { row, expiresAt: Date.now() + GRANT_CACHE_TTL_MS });
    return row;
  }

  private dropGrantCache(): void {
    this.grantCache.clear();
  }

  private async revokeGrantById(grantId: string): Promise<void> {
    await this.db
      .update(workbenchOauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(workbenchOauthGrants.id, grantId), isNull(workbenchOauthGrants.revokedAt)));
    this.dropGrantCache();
  }

  /** 账号停用了就不再发令牌（已发的访问令牌在 MCP 那边按账号行同样 401） */
  private async assertAccountUsable(userId: string): Promise<void> {
    const account = await this.accounts.findByMiaodaUserId(userId);
    if (!account || !account.enabled) {
      throw new OAuthError('invalid_grant', '工作台账号已停用');
    }
  }
}
