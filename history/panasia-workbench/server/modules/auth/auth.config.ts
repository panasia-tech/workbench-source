import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** 平台角色：@CanRole 只用到这两个，会话里只允许出现它们 */
export const KNOWN_ROLES = ['boss', 'admin'] as const;
export type KnownRole = (typeof KNOWN_ROLES)[number];

/**
 * 妙搭 userId 的合法形态。数据层会把它拼进 `SET LOCAL app.user_id = '…'`，
 * 所以进会话前必须卡死字符集，杜绝引号注入。
 */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 开放接口四组 key：豆包 MCP、豆包审凭证兜底、ERP 换身份、全系统个人 key 验证 */
export type OpenApiScope = 'mcp' | 'taskReview' | 'erpBridge' | 'apiKeysVerify';

export interface ApiKeyEntry {
  name: string;
  digest: Buffer;
}

export interface OidcSettings {
  /** 发行方，如 http://127.0.0.1:8000 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** 显式回调地址；为空时按 PUBLIC_BASE_URL（或请求 Host）拼 /auth/oidc/callback */
  redirectUri: string | null;
  /** 登录按钮上显示的名字 */
  providerName: string;
}

const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_API_KEY_LENGTH = 24;
const DEFAULT_SESSION_HOURS = 168;
/** erp：工作台应用在 Authentik 里加的作用域，带 erp_sub（ERP 员工 ID），见 deploy/README.md */
const DEFAULT_OIDC_SCOPES = 'openid profile email erp';
/** 与 ERP 迁移 079 种的平台分组同名（ERP 后台「系统管理 → 统一登录」里挂人，每 5 分钟同步到 Authentik） */
const DEFAULT_BOSS_GROUPS = '工作台老板';
const DEFAULT_ADMIN_GROUPS = '工作台管理员';

function readFlag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

/** 默认开的开关：只有 false / 0 / no / off 算关（同 optional-features 的口径） */
function readFlagDefaultOn(raw: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes((raw ?? '').trim().toLowerCase());
}

function readList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item: string) => item.trim())
    .filter((item: string) => item !== '');
}

function digestKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** CLIENT_BASE_PATH 规整成「/xxx」或空串（根路径部署） */
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * 独立部署的登录、会话与开放接口 key 配置，全部来自环境变量（见 deploy/.env.example）。
 * 启动时读一次；改了要重启。
 */
@Injectable()
export class AuthConfig {
  private readonly logger = new Logger(AuthConfig.name);

  readonly isProduction = process.env.NODE_ENV === 'production';
  readonly basePath = normalizeBasePath(process.env.CLIENT_BASE_PATH);
  readonly publicBaseUrl: string | null =
    (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '') || null;
  readonly sessionSecret: Buffer;
  readonly sessionTtlMs: number;
  readonly cookieSecure: boolean;
  readonly oidc: OidcSettings | null;
  readonly devLoginEnabled: boolean;
  readonly roleGroups: Record<KnownRole, string[]>;
  /**
   * 统一登录找不到对照行时自动开号（AUTH_AUTO_PROVISION，默认开）：工作台用户 ID 用 ERP 员工 ID（erp_sub）。
   * 关掉就回到「管理员预建对照行、本人首次登录认领」
   */
  readonly autoProvision: boolean;
  /** 没有 erp_sub 的统一账号（Authentik 管理员等非 ERP 号）也自动开号，用 Authentik 的 sub 当用户 ID；默认不允许 */
  readonly allowNonErpProvision: boolean;
  private readonly apiKeys: Record<OpenApiScope, ApiKeyEntry[]>;

  constructor() {
    this.sessionSecret = this.readSessionSecret();
    const hours = Number(process.env.AUTH_SESSION_HOURS ?? DEFAULT_SESSION_HOURS);
    this.sessionTtlMs =
      (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_HOURS) *
      3600_000;
    this.cookieSecure =
      process.env.AUTH_COOKIE_SECURE !== undefined
        ? readFlag(process.env.AUTH_COOKIE_SECURE)
        : process.env.NODE_ENV !== 'development';
    this.oidc = this.readOidc();
    this.devLoginEnabled = this.readDevLogin();
    // 不设或留空都按默认组名
    this.roleGroups = {
      boss: readList(process.env.AUTH_BOSS_GROUPS?.trim() || DEFAULT_BOSS_GROUPS),
      admin: readList(process.env.AUTH_ADMIN_GROUPS?.trim() || DEFAULT_ADMIN_GROUPS),
    };
    this.autoProvision = readFlagDefaultOn(process.env.AUTH_AUTO_PROVISION);
    this.allowNonErpProvision = readFlag(process.env.AUTH_ALLOW_NON_ERP);
    this.apiKeys = {
      mcp: this.readKeys('MCP_API_KEYS', process.env.MCP_API_KEYS),
      taskReview: this.readKeys(
        'TASK_REVIEW_API_KEYS',
        process.env.TASK_REVIEW_API_KEYS,
      ),
      erpBridge: this.readKeys(
        'ERP_BRIDGE_API_KEYS',
        [
          process.env.ERP_BRIDGE_API_KEYS ?? '',
          // 与 ERP 侧同名的单把 key，名字固定为 erp
          process.env.ERP_BRIDGE_API_KEY ? `erp:${process.env.ERP_BRIDGE_API_KEY}` : '',
        ]
          .filter((part: string) => part !== '')
          .join(','),
      ),
      // 全系统个人 key 验证（POST /openapi/api-keys/verify）：下游系统（ERP 等）拿系统级 key
      // 来验 wk_ 个人 key 换身份；个人 key 本身调不了这个端点
      apiKeysVerify: this.readKeys('APIKEY_VERIFY_API_KEYS', process.env.APIKEY_VERIFY_API_KEYS),
    };
  }

  /** 校验开放接口 key，命中返回那把 key 的名字（常量时间比较） */
  matchApiKey(scope: OpenApiScope, presented: string): ApiKeyEntry | null {
    if (!presented) return null;
    const digest = digestKey(presented);
    let matched: ApiKeyEntry | null = null;
    for (const entry of this.apiKeys[scope]) {
      if (timingSafeEqual(entry.digest, digest) && !matched) {
        matched = entry;
      }
    }
    return matched;
  }

  hasApiKeys(scope: OpenApiScope): boolean {
    return this.apiKeys[scope].length > 0;
  }

  private readSessionSecret(): Buffer {
    const raw = (process.env.AUTH_SESSION_SECRET ?? '').trim();
    if (raw.length >= MIN_SESSION_SECRET_LENGTH) {
      return Buffer.from(raw, 'utf8');
    }
    if (this.isProduction) {
      throw new Error(
        `AUTH_SESSION_SECRET 未配置或短于 ${MIN_SESSION_SECRET_LENGTH} 位：生产环境必须配置（openssl rand -hex 32）`,
      );
    }
    this.logger.warn(
      'AUTH_SESSION_SECRET 未配置，本次用随机值；重启后所有人要重新登录',
    );
    return randomBytes(32);
  }

  private readOidc(): OidcSettings | null {
    const issuer = (process.env.OIDC_ISSUER ?? '').trim();
    const clientId = (process.env.OIDC_CLIENT_ID ?? '').trim();
    const clientSecret = (process.env.OIDC_CLIENT_SECRET ?? '').trim();
    if (!issuer && !clientId && !clientSecret) {
      return null;
    }
    if (!issuer || !clientId || !clientSecret) {
      this.logger.error(
        '统一登录配置不全：OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET 要一起配，本次不启用统一登录',
      );
      return null;
    }
    return {
      issuer,
      clientId,
      clientSecret,
      // Authentik 会默默去掉应用上没配的作用域，没加 erp 作用域也不会报错，只是拿不到 erp_sub
      scopes: (process.env.OIDC_SCOPES ?? '').trim() || DEFAULT_OIDC_SCOPES,
      redirectUri: (process.env.OIDC_REDIRECT_URI ?? '').trim() || null,
      providerName: (process.env.OIDC_PROVIDER_NAME ?? '').trim() || '统一账号',
    };
  }

  private readDevLogin(): boolean {
    if (!readFlag(process.env.AUTH_DEV_LOGIN)) return false;
    // 只认显式的开发模式；NODE_ENV 没设或是 production 一律不开
    if (process.env.NODE_ENV !== 'development') {
      this.logger.error('AUTH_DEV_LOGIN 只在 NODE_ENV=development 下生效，本次忽略');
      return false;
    }
    this.logger.warn(
      'AUTH_DEV_LOGIN 已开启：任何人都能在登录页冒充任意 userId，只能用于本机开发',
    );
    return true;
  }

  /** 「名字:key」逗号分隔；名字缺省时按序号补 */
  private readKeys(envName: string, raw: string | undefined): ApiKeyEntry[] {
    const entries: ApiKeyEntry[] = [];
    const seen = new Set<string>();
    readList(raw).forEach((item: string, index: number) => {
      const colon = item.indexOf(':');
      const name = colon > 0 ? item.slice(0, colon).trim() : `${envName}#${index + 1}`;
      const key = colon > 0 ? item.slice(colon + 1).trim() : item;
      if (key.length < MIN_API_KEY_LENGTH) {
        this.logger.error(
          `${envName} 里「${name}」长度不足 ${MIN_API_KEY_LENGTH} 位，已忽略（openssl rand -hex 24）`,
        );
        return;
      }
      if (seen.has(name)) {
        this.logger.error(`${envName} 里 key 名「${name}」重复，后一把已忽略`);
        return;
      }
      seen.add(name);
      entries.push({ name, digest: digestKey(key) });
    });
    return entries;
  }
}
