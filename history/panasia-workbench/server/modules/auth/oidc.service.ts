import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

import { AuthConfig, type OidcSettings } from './auth.config';

const DISCOVERY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** ID Token 时间校验允许的时钟偏差 */
const CLOCK_SKEW_SECONDS = 120;

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

interface TokenResponse {
  id_token?: unknown;
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** 一次统一登录拿到的身份（ID Token + userinfo 合并） */
export interface OidcIdentity {
  subject: string;
  /** Authentik 用户名（preferred_username） */
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  groups: string[];
  /**
   * ERP 员工 ID：ERP 同步来的号在 Authentik 用户 attributes.erp_sub 里，靠工作台应用上加的 erp 作用域发出来
   * （deploy/README.md「Authentik」）。非 ERP 号没有
   */
  erpSub: string | null;
}

export interface AuthorizeRequest {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 只解 payload：ID Token 由服务端直连 token 端点（TLS）取得，按 OIDC Core 3.1.3.7 可不验签 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('ID Token 格式不对');
  }
  const parsed: unknown = JSON.parse(
    Buffer.from(parts[1], 'base64url').toString('utf8'),
  );
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ID Token 内容不是对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Authentik（或任意标准 OIDC）授权码 + PKCE 登录。
 * 不引第三方库：发现文档、换 token、userinfo 都是一次 fetch。
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private discovery: { doc: DiscoveryDocument; expiresAt: number } | null = null;

  constructor(private readonly config: AuthConfig) {}

  get enabled(): boolean {
    return this.config.oidc !== null;
  }

  async buildAuthorizeRequest(redirectUri: string): Promise<AuthorizeRequest> {
    const settings = this.requireSettings();
    const doc = await this.getDiscovery();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', settings.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, nonce, verifier };
  }

  /** 授权码换 token → 校验 ID Token → 读 userinfo，合成身份 */
  async resolveIdentity(input: {
    code: string;
    verifier: string;
    nonce: string;
    redirectUri: string;
  }): Promise<OidcIdentity> {
    const settings = this.requireSettings();
    const doc = await this.getDiscovery();
    const tokens = await this.exchangeCode(settings, doc, input);
    const claims = this.checkIdToken(settings, doc, tokens.idToken, input.nonce);
    const subject = readString(claims.sub);
    if (!subject) {
      throw new Error('ID Token 缺 sub');
    }
    let info: Record<string, unknown> = {};
    if (doc.userinfo_endpoint && tokens.accessToken) {
      info = await this.fetchUserInfo(doc.userinfo_endpoint, tokens.accessToken);
      if (readString(info.sub) && readString(info.sub) !== subject) {
        throw new Error('userinfo 的 sub 与 ID Token 不一致');
      }
    }
    const pick = (key: string): unknown =>
      info[key] !== undefined ? info[key] : claims[key];
    const groupsRaw = pick('groups');
    return {
      subject,
      username: readString(pick('preferred_username')) ?? readString(pick('nickname')),
      email: readString(pick('email')),
      emailVerified: pick('email_verified') !== false,
      displayName: readString(pick('name')),
      groups: Array.isArray(groupsRaw)
        ? groupsRaw.filter((group: unknown): group is string => typeof group === 'string')
        : [],
      erpSub: readString(pick('erp_sub')),
    };
  }

  private requireSettings(): OidcSettings {
    if (!this.config.oidc) {
      throw new Error('统一登录未配置（OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET）');
    }
    return this.config.oidc;
  }

  private async getDiscovery(): Promise<DiscoveryDocument> {
    if (this.discovery && this.discovery.expiresAt > Date.now()) {
      return this.discovery.doc;
    }
    const settings = this.requireSettings();
    const url = `${settings.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`读 OIDC 发现文档失败：HTTP ${response.status}（${url}）`);
    }
    const doc = (await response.json()) as Partial<DiscoveryDocument>;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error('OIDC 发现文档缺 issuer / authorization_endpoint / token_endpoint');
    }
    if (doc.issuer.replace(/\/+$/, '') !== settings.issuer.replace(/\/+$/, '')) {
      this.logger.warn(
        `OIDC_ISSUER（${settings.issuer}）与发现文档 issuer（${doc.issuer}）不一致，以发现文档为准`,
      );
    }
    this.discovery = {
      doc: doc as DiscoveryDocument,
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
    };
    return this.discovery.doc;
  }

  private async exchangeCode(
    settings: OidcSettings,
    doc: DiscoveryDocument,
    input: { code: string; verifier: string; redirectUri: string },
  ): Promise<{ idToken: string; accessToken: string | null }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code_verifier: input.verifier,
    });
    const response = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok) {
      throw new Error(
        `换 token 失败：HTTP ${response.status} ${String(data.error ?? '')} ${String(data.error_description ?? '')}`.trim(),
      );
    }
    const idToken = readString(data.id_token);
    if (!idToken) {
      throw new Error('token 响应没有 id_token（scope 里要有 openid）');
    }
    return { idToken, accessToken: readString(data.access_token) };
  }

  private checkIdToken(
    settings: OidcSettings,
    doc: DiscoveryDocument,
    idToken: string,
    nonce: string,
  ): Record<string, unknown> {
    const claims = decodeJwtPayload(idToken);
    if (claims.iss !== doc.issuer) {
      throw new Error(`ID Token iss 不符：${String(claims.iss)}`);
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(settings.clientId)) {
      throw new Error('ID Token aud 不含本应用 client_id');
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
      throw new Error('ID Token 已过期');
    }
    if (claims.nonce !== nonce) {
      throw new Error('ID Token nonce 不符');
    }
    return claims;
  }

  private async fetchUserInfo(
    endpoint: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`读 userinfo 失败：HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  }
}
