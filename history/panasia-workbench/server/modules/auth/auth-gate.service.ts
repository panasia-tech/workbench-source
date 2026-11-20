import { Injectable, Logger } from '@nestjs/common';
import type { CookieOptions, NextFunction, Request, Response } from 'express';

import { AuthConfig, KNOWN_ROLES, USER_ID_PATTERN, type OpenApiScope } from './auth.config';
import { LoginAccountService } from './login-account.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { OAuthService } from '../oauth/oauth.service';
import { OAUTH_SCOPE } from '../oauth/oauth-rules';
import {
  SESSION_COOKIE,
  SESSION_TOKEN_TYPE,
  signToken,
  verifyToken,
  type SessionPayload,
} from './session.util';
import { setSessionFacts, type SessionFacts } from './session-facts';

/** 妙搭网关注入身份用的请求头，平台 UserContextMiddleware 只认它 */
const IDENTITY_HEADER = 'x-larkgw-suda-webuser';
/** 外来请求不许自带的平台头（身份 / 租户域名，后者会改前端 basename） */
const STRIPPED_HEADERS = [IDENTITY_HEADER, 'x-miaoda-tenant-host', 'x-miaoda-custom-host'];

/** 开放接口系统身份：沿用平台口径 user_id = -1 */
const SYSTEM_USER_ID = -1;

/** 平台内部路由：外面没有网关挡，直接 404（转发器 = 开放代理、innerapi = 免鉴权触发器/MCP/热更新） */
const PLATFORM_INTERNAL_PREFIXES = [
  '/__innerapi__',
  '/api/__platform__',
  '/spark/',
  '/af/',
  '/app/',
  '/ai/api/',
];

/** 不登录也能访问的路径（精确匹配） */
const PUBLIC_PATHS = new Set([
  '/login',
  '/auth/oidc/login',
  '/auth/oidc/callback',
  '/auth/logout',
  '/auth/dev-login',
  '/api/auth/options',
  '/api/auth/me',
  '/favicon.svg',
  '/favicon.ico',
  '/robots.txt',
  // OAuth（10-25，ChatGPT 网页版等只能 OAuth 的 MCP 客户端）：发现文档 / 注册 / 换令牌不登录；
  // 授权页自己判登录（没登录跳统一登录再回来）
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/openapi/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/openapi/mcp',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
]);

const OPENAPI_SCOPES: { prefix: string; scope: OpenApiScope }[] = [
  { prefix: '/openapi/mcp', scope: 'mcp' },
  { prefix: '/openapi/task-review', scope: 'taskReview' },
  { prefix: '/openapi/erp', scope: 'erpBridge' },
  { prefix: '/openapi/api-keys', scope: 'apiKeysVerify' },
];

export interface SessionUser {
  userId: string | number;
  name: string;
  roles: string[];
  isSystem: boolean;
}

export interface IssueSessionInput {
  kind: SessionPayload['kind'];
  userId: string;
  accountId?: string;
  name?: string;
  roles?: string[];
  /** 统一登录：erp_sub 就是 userId（登录回调里核对） */
  erpIdentity?: boolean;
}

function extractApiKey(req: Request): string {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  // 妙搭网关时代 task-review 兜底接口也收 X-Api-Key，保留兼容
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

/**
 * 登录闸门：替代妙搭网关。
 *
 * 在 Nest 模块中间件之前跑（main.ts 里 app.use），先剥掉外来身份头，再按自己的会话 /
 * 开放接口 key 写回 x-larkgw-suda-webuser，平台的 UserContextMiddleware、@NeedLogin、
 * @CanRole、数据层 SET LOCAL 照旧工作。
 */
@Injectable()
export class AuthGateService {
  private readonly logger = new Logger(AuthGateService.name);

  constructor(
    private readonly config: AuthConfig,
    private readonly accounts: LoginAccountService,
    private readonly apiKeys: ApiKeysService,
    private readonly oauth: OAuthService,
  ) {}

  async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    for (const header of STRIPPED_HEADERS) {
      delete req.headers[header];
    }
    // Express 路由不区分大小写，判路径一律按小写，防 /OpenApi/mcp 之类绕过
    const path = this.relativePath(req.path).toLowerCase();

    if (PLATFORM_INTERNAL_PREFIXES.some((prefix: string) => path.startsWith(prefix))) {
      this.sendError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }
    if (path === '/openapi' || path.startsWith('/openapi/')) {
      void this.handleOpenApi(req, res, next, path);
      return;
    }
    // /.well-known 下只有 OAuth 发现文档（在 PUBLIC_PATHS 里），别的一律 404：
    // 跳登录页的话 MCP 客户端拿 HTML 当 JSON 解析失败，会以为整个 OAuth 不可用
    if (path.startsWith('/.well-known/') && !PUBLIC_PATHS.has(path)) {
      this.sendError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }

    const user = await this.readSession(req, res);
    if (user) {
      this.writeIdentity(req, user);
      next();
      return;
    }
    if (PUBLIC_PATHS.has(path)) {
      next();
      return;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      this.sendError(res, 401, 'UNAUTHORIZED', '未登录或登录已过期');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.redirect(302, this.loginPath(req.originalUrl));
      return;
    }
    this.sendError(res, 401, 'UNAUTHORIZED', '未登录或登录已过期');
  }

  /** 签一张会话票据写进 cookie */
  issueSession(res: Response, input: IssueSessionInput): void {
    const now = Math.floor(Date.now() / 1000);
    const payload: SessionPayload = {
      typ: SESSION_TOKEN_TYPE,
      kind: input.kind,
      uid: input.userId,
      ...(input.accountId ? { aid: input.accountId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.roles ? { roles: input.roles } : {}),
      ...(input.kind === 'oidc' ? { erp: input.erpIdentity === true } : {}),
      iat: now,
      exp: now + Math.floor(this.config.sessionTtlMs / 1000),
    };
    res.cookie(SESSION_COOKIE, signToken(payload, this.config.sessionSecret), {
      ...this.cookieOptions(),
      maxAge: this.config.sessionTtlMs,
    });
  }

  clearSession(res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: this.config.basePath || '/',
    };
  }

  /** 站内绝对路径（带 CLIENT_BASE_PATH） */
  appPath(path: string): string {
    return `${this.config.basePath}${path}`;
  }

  loginPath(next?: string, extra?: Record<string, string>): string {
    const params = new URLSearchParams();
    if (next) params.set('next', next);
    for (const [key, value] of Object.entries(extra ?? {})) {
      params.set(key, value);
    }
    const query = params.toString();
    return this.appPath(`/login${query ? `?${query}` : ''}`);
  }

  private relativePath(path: string): string {
    const base = this.config.basePath;
    if (base && (path === base || path.startsWith(`${base}/`))) {
      return path.slice(base.length) || '/';
    }
    return path;
  }

  private async handleOpenApi(
    req: Request,
    res: Response,
    next: NextFunction,
    path: string,
  ): Promise<void> {
    const matched = OPENAPI_SCOPES.find(
      ({ prefix }: { prefix: string }) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (!matched) {
      this.sendError(res, 404, 'NOT_FOUND', '接口不存在');
      return;
    }
    const rawKey = extractApiKey(req);
    const entry = this.config.matchApiKey(matched.scope, rawKey);
    if (entry) {
      this.logger.log(`开放接口 ${req.method} ${path} ← key「${entry.name}」`);
      this.writeIdentity(req, {
        userId: SYSTEM_USER_ID,
        name: `openapi:${entry.name}`,
        // 系统 key 即老板身份（豆包链路），个人 key 走下面分支带真实角色
        roles: ['boss'],
        isSystem: true,
      });
      next();
      return;
    }
    // 个人凭证（仅 MCP 端点）：个人 API Key 或 OAuth 访问令牌，身份 = 本人，角色按对照行实时解析
    if (matched.scope === 'mcp') {
      const user = await this.resolvePersonalCredential(rawKey);
      if (user) {
        this.writeIdentity(req, user);
        next();
        return;
      }
    }
    this.logger.warn(
      `开放接口 key 不对或没带：${req.method} ${path} ip=${req.ip ?? ''}${
        this.config.hasApiKeys(matched.scope) ? '' : '（这一组还没配置 key）'
      }`,
    );
    res.setHeader(
      'WWW-Authenticate',
      matched.scope === 'mcp'
        ? this.mcpChallenge(req, rawKey !== '')
        : 'Bearer realm="panasia-workbench"',
    );
    this.sendError(res, 401, 'UNAUTHORIZED', 'API Key 无效');
  }

  /** wk_ 个人 API Key（10-22）或 wkat_ OAuth 访问令牌（10-25）→ 本人身份；账号停用一律不认 */
  private async resolvePersonalCredential(rawKey: string): Promise<SessionUser | null> {
    const owner =
      (await this.apiKeys.findActiveByKey(rawKey))?.userId ??
      (await this.oauth.verifyAccessToken(rawKey))?.userId ??
      null;
    if (!owner) return null;
    const account = await this.accounts.findByMiaodaUserId(owner);
    if (!account || !account.enabled) return null;
    return {
      userId: account.miaodaUserId,
      name: account.displayName ?? account.loginName ?? '',
      roles: this.accounts.resolveRoles(account),
      isSystem: false,
    };
  }

  /**
   * MCP 401 带上受保护资源元数据地址（RFC 9728）：ChatGPT 网页版这类 OAuth 客户端靠它找到授权页；
   * 带了令牌但不认时加 invalid_token（RFC 6750）
   */
  private mcpChallenge(req: Request, presented: boolean): string {
    const params = [
      'realm="panasia-workbench"',
      `resource_metadata="${this.oauth.urls(req).resourceMetadata}"`,
      `scope="${OAUTH_SCOPE}"`,
    ];
    if (presented) params.push('error="invalid_token"');
    return `Bearer ${params.join(', ')}`;
  }

  private async readSession(req: Request, res: Response): Promise<SessionUser | null> {
    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const raw = cookies[SESSION_COOKIE];
    if (raw === undefined) return null;
    const payload = verifyToken(raw, this.config.sessionSecret) as Partial<SessionPayload> | null;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const valid =
      payload !== null &&
      payload.typ === SESSION_TOKEN_TYPE &&
      typeof payload.exp === 'number' &&
      payload.exp > nowSeconds &&
      typeof payload.uid === 'string' &&
      USER_ID_PATTERN.test(payload.uid);
    if (!valid) {
      this.clearSession(res);
      return null;
    }
    const resolved = await this.resolveSessionUser(payload as SessionPayload);
    if (!resolved) {
      this.clearSession(res);
      return null;
    }
    // 会话里服务端才知道的事（如工作台 ID 是否来自 ERP 身份）按请求对象记下，业务接口用 getSessionFacts 取
    setSessionFacts(req, resolved.facts);
    // 滑动续期：剩余不到一半就换新票，常用的人不会被踢
    if ((payload.exp - nowSeconds) * 1000 < this.config.sessionTtlMs / 2) {
      this.issueSession(res, {
        kind: payload.kind as SessionPayload['kind'],
        userId: payload.uid as string,
        accountId: payload.aid,
        name: payload.name,
        roles: payload.roles,
        erpIdentity: payload.erp === true,
      });
    }
    return resolved.user;
  }

  private async resolveSessionUser(
    payload: SessionPayload,
  ): Promise<{ user: SessionUser; facts: SessionFacts } | null> {
    if (payload.kind === 'dev') {
      if (!this.config.devLoginEnabled) return null;
      return {
        user: {
          userId: payload.uid,
          name: typeof payload.name === 'string' ? payload.name : '',
          roles: (payload.roles ?? []).filter((role: string) =>
            (KNOWN_ROLES as readonly string[]).includes(role),
          ),
          isSystem: false,
        },
        facts: {
          kind: 'dev',
          userId: payload.uid,
          accountId: null,
          erpIdentity: false,
          loginName: null,
        },
      };
    }
    if (payload.kind !== 'oidc' || typeof payload.aid !== 'string') return null;
    // 账号行 60 秒缓存：停用、改角色最迟一分钟生效
    const account = await this.accounts.findById(payload.aid);
    if (!account || !account.enabled || account.miaodaUserId !== payload.uid) {
      return null;
    }
    return {
      user: {
        userId: account.miaodaUserId,
        name: account.displayName ?? account.loginName ?? '',
        roles: this.accounts.resolveRoles(account),
        isSystem: false,
      },
      facts: {
        kind: 'oidc',
        userId: account.miaodaUserId,
        accountId: account.id,
        erpIdentity: payload.erp === true,
        loginName: account.loginName,
      },
    };
  }

  private writeIdentity(req: Request, user: SessionUser): void {
    const webUser = {
      user_id: user.userId,
      app_id: '',
      login_url: this.loginPath(),
      user_type: '',
      env: 'runtime',
      user_name: { zh_cn: user.name, en_us: user.name },
      is_system_account: user.isSystem,
      roles: user.roles,
    };
    req.headers[IDENTITY_HEADER] = encodeURIComponent(JSON.stringify(webUser));
  }

  /** 与 GlobalExceptionFilter 同形的错误体 */
  private sendError(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ error: { code, message, timestamp: Date.now() } });
  }
}
