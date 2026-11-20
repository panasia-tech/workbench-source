import { createHmac, timingSafeEqual } from 'crypto';

/** 登录会话 cookie（HttpOnly） */
export const SESSION_COOKIE = 'DEMO_ONLY_REDACTED';
/** OIDC 跳转途中的 state / nonce / PKCE 暂存 cookie，10 分钟有效 */
export const OIDC_STATE_COOKIE = 'DEMO_ONLY_REDACTED';

export const SESSION_TOKEN_TYPE = 'DEMO_ONLY_REDACTED';
export const OIDC_STATE_TOKEN_TYPE = 'DEMO_ONLY_REDACTED';

/** 会话票据：只放认人的最少信息，角色与停用状态每次请求按库里的账号行现算 */
export interface SessionPayload {
  typ: typeof SESSION_TOKEN_TYPE;
  /** oidc：统一登录；dev：开发登录（仅 AUTH_DEV_LOGIN 下认） */
  kind: 'oidc' | 'dev';
  /** 妙搭 userId */
  uid: string;
  /** workbench_login_accounts.id（oidc 才有） */
  aid?: string;
  /** 开发登录时自报的姓名与角色 */
  name?: string;
  roles?: string[];
  /**
   * 统一登录时 Authentik 给的 erp_sub 就是 uid（工作台用户 ID 来自 ERP 身份），登录回调里核对后写入（10-19 起，oidc 会话都带）；
   * 进 ERP 免密要它（见 erp-bridge）。没有这个字段的旧会话按 false
   */
  erp?: boolean;
  iat: number;
  exp: number;
}

export interface OidcStatePayload {
  typ: typeof OIDC_STATE_TOKEN_TYPE;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  redirectUri: string;
  exp: number;
}

function hmac(body: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/** base64url(JSON).base64url(HMAC-SHA256)，自带签名，不落库 */
export function signToken(payload: object, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body, secret).toString('base64url')}`;
}

/** 验签并解出对象；签名不对、格式不对一律 null（过期由调用方按 exp 判） */
export function verifyToken(
  token: unknown,
  secret: Buffer,
): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = hmac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 站内跳转目标：只认本站相对路径，防开放重定向 */
export function safeNextPath(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    // 控制字符（含换行）一律不要，防响应头注入
    [...value].some((char: string) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) ||
    value.length > 2048
  ) {
    return fallback;
  }
  return value;
}
