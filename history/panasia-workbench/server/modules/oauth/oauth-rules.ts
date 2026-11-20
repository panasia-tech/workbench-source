import { createHash } from 'crypto';

/**
 * OAuth 授权服务器的纯规则（不碰库、不碰 Nest），离线自检 scripts/checks/oauth.check.mjs 直接测这里。
 * 协议口径：MCP 授权规范（OAuth 2.1 + PKCE S256）、RFC 9728 受保护资源元数据、RFC 8414 授权服务器元数据、
 * RFC 7591 动态注册、RFC 8707 resource、RFC 7009 吊销。
 */

/** 只发一种权限：以本人身份调工作台 MCP（能用哪些工具按本人角色分档，同个人 API Key） */
export const OAUTH_SCOPE = 'mcp';

/** 访问令牌 wkat_（签名自带、不落库，靠授权行吊销）；刷新令牌 wkrt_（库里只存 sha256） */
export const ACCESS_TOKEN_PREFIX = 'wkat_';
export const REFRESH_TOKEN_PREFIX = 'wkrt_';

export const TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
  'none',
] as const;
export type TokenEndpointAuthMethod = (typeof TOKEN_ENDPOINT_AUTH_METHODS)[number];

export const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
/** 不许当回调的协议：会在浏览器里执行脚本或读本机文件 */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'filesystem:',
  'ftp:',
  'ws:',
  'wss:',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** 授权页上不额外提醒的回调站点（常用 AI 工具）；本机程序也不提醒——授权码只回到本人电脑 */
const KNOWN_REDIRECT_HOSTS = ['chatgpt.com', 'openai.com', 'claude.ai', 'claude.com', 'anthropic.com'];
const PKCE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:$/;

/**
 * 注册时校验回调地址，返回不合格的原因（合格返回 null）：https 任意站点；http 只许本机回环（桌面工具）；
 * 其余协议按 RFC 8252 当原生应用的私有协议放行（cursor:// 之类），会执行脚本的协议一律拒。
 * 不规整、不改写：授权时按原样逐字比对（本机回环端口除外，见 redirectUriMatches）。
 */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return '回调地址为空';
  }
  if (
    raw.length > MAX_URI_LENGTH ||
    [...raw].some((char: string) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    return '回调地址过长或含空白字符';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `回调地址不是合法 URL：${raw}`;
  }
  if (raw.includes('#')) {
    return '回调地址不能带 #';
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === 'https:') {
    return url.hostname ? null : '回调地址缺主机名';
  }
  if (scheme === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? null
      : 'http 回调只许本机（localhost / 127.0.0.1），其余要 https';
  }
  if (FORBIDDEN_SCHEMES.has(scheme) || !SCHEME_PATTERN.test(scheme)) {
    return `不支持的回调协议：${scheme}`;
  }
  return null;
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** 授权请求里的回调对不对得上注册的：逐字相等；本机回环按 RFC 8252 7.3 不比端口（桌面工具每次随机端口） */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    return (
      isLoopbackHttp(a) &&
      isLoopbackHttp(b) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

/** 授权页上给人看的「授权后回到哪里」：站点名才是可信的（应用名是对方自报的） */
export function describeRedirect(uri: string): { label: string; known: boolean } {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { label: uri, known: false };
  }
  if (isLoopbackHttp(url)) {
    return { label: '本机程序', known: true };
  }
  if (url.protocol !== 'https:') {
    return { label: `${url.protocol}// 应用`, known: false };
  }
  const host = url.hostname.toLowerCase();
  const known = KNOWN_REDIRECT_HOSTS.some(
    (item: string) => host === item || host.endsWith(`.${item}`),
  );
  return { label: host, known };
}

export function isPkceValue(value: unknown): value is string {
  return typeof value === 'string' && PKCE_PATTERN.test(value);
}

/** S256：BASE64URL(SHA256(code_verifier)) */
export function pkceChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export type ResourceCheck = { ok: true; resource: string | null } | { ok: false };

/**
 * RFC 8707 resource：这台授权服务器只给本站发令牌（受保护的只有 MCP 端点），
 * 带了就必须是本站地址（ChatGPT 会带 MCP 地址）；没带算默认 MCP。重复参数逐个查、留第一个。
 */
export function checkResource(raw: unknown, origin: string): ResourceCheck {
  const values = (Array.isArray(raw) ? raw : [raw]).filter(
    (item: unknown) => item !== undefined && item !== '',
  );
  if (values.length === 0) return { ok: true, resource: null };
  for (const value of values) {
    if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return { ok: false };
    try {
      if (new URL(value).origin !== origin) return { ok: false };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, resource: values[0] as string };
}

/** client_secret_basic：Basic base64(urlencode(id):urlencode(secret))（RFC 6749 2.3.1） */
export function parseBasicAuth(
  header: unknown,
): { clientId: string; clientSecret: string } | null {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header.trim());
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  const unescape = (value: string): string => {
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return value;
    }
  };
  return {
    clientId: unescape(decoded.slice(0, colon)),
    clientSecret: unescape(decoded.slice(colon + 1)),
  };
}

/** 往回调地址上加 code / state / error，保留它原有的查询参数 */
export function withQuery(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface OAuthUrls {
  issuer: string;
  /** 受保护资源 = MCP 端点 */
  resource: string;
  resourceMetadata: string;
  authorize: string;
  token: string;
  register: string;
  revoke: string;
}

/** origin 形如 http://127.0.0.1:8000 是 CLIENT_BASE_PATH（生产为空，发现文档按根路径部署算） */
export function oauthUrls(origin: string, basePath: string): OAuthUrls {
  const base = `${origin}${basePath}`;
  return {
    issuer: base,
    resource: `${base}/openapi/mcp`,
    resourceMetadata: `${base}/.well-known/oauth-protected-resource/openapi/mcp`,
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    register: `${base}/oauth/register`,
    revoke: `${base}/oauth/revoke`,
  };
}

/** RFC 9728：根路径和按 MCP 路径的两个位置出同一份（资源只有 MCP 端点一个） */
export function protectedResourceMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: '泛亚员工工作台',
  };
}

/** RFC 8414；code_challenge_methods_supported 必须有 S256，ChatGPT 靠它确认支持 PKCE */
export function authorizationServerMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    code_challenge_methods_supported: ['S256'],
  };
}
