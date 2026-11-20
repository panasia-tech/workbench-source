import { Controller, Get, Logger, Options, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthConfig } from '../auth/auth.config';
import { renderConsentPage, renderErrorPage } from './oauth-pages';
import {
  authorizationServerMetadata,
  checkResource,
  describeRedirect,
  isPkceValue,
  parseBasicAuth,
  protectedResourceMetadata,
  withQuery,
} from './oauth-rules';
import { OAuthError, OAuthService, type OAuthClient } from './oauth.service';

const PROTECTED_RESOURCE_PATHS = [
  '.well-known/oauth-protected-resource',
  '.well-known/oauth-protected-resource/openapi/mcp',
];
/** 按 MCP 路径的那个是给把资源路径拼到发现地址上的老客户端兜底，内容一样 */
const AUTHORIZATION_SERVER_PATHS = [
  '.well-known/oauth-authorization-server',
  '.well-known/oauth-authorization-server/openapi/mcp',
];
/** 浏览器里跑的 MCP 客户端（如 MCP Inspector）会跨域调这些；都不带 cookie，放开 * 无妨 */
const CORS_PATHS = [
  ...PROTECTED_RESOURCE_PATHS,
  ...AUTHORIZATION_SERVER_PATHS,
  'oauth/register',
  'oauth/token',
  'oauth/revoke',
];
/** 登录跳转 next 的上限，同 safeNextPath */
const MAX_NEXT_LENGTH = 2048;
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * OAuth 授权服务器的对外端点（2026-10-25）：发现文档、动态注册、授权页、令牌、吊销。
 * 都在登录闸门的 PUBLIC_PATHS 里（不登录也能到）；授权页自己判登录，没登录先跳统一登录再回来。
 */
@Controller()
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(
    private readonly config: AuthConfig,
    private readonly oauth: OAuthService,
  ) {}

  @Get(PROTECTED_RESOURCE_PATHS)
  protectedResource(@Req() req: Request, @Res() res: Response): void {
    this.cors(res);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(protectedResourceMetadata(this.oauth.urls(req)));
  }

  @Get(AUTHORIZATION_SERVER_PATHS)
  authorizationServer(@Req() req: Request, @Res() res: Response): void {
    this.cors(res);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(authorizationServerMetadata(this.oauth.urls(req)));
  }

  @Options(CORS_PATHS)
  preflight(@Res() res: Response): void {
    this.cors(res);
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  }

  @Post('oauth/register')
  async register(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.cors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (!this.oauth.allowRegistration(req.ip ?? '')) {
      res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: '注册太频繁，请稍后再试',
      });
      return;
    }
    try {
      res.status(201).json(await this.oauth.registerClient(req.body));
    } catch (error) {
      this.sendOAuthError(res, error);
    }
  }

  @Get('oauth/authorize')
  async authorize(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.showConsent(req, res);
    } catch (error) {
      this.logger.error(`打开授权页出错：${error instanceof Error ? error.message : String(error)}`);
      this.sendErrorPage(res, 500, '工作台出错了', '请稍后回到 AI 工具里重新连接。');
    }
  }

  @Post('oauth/authorize')
  async decide(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.handleDecision(req, res);
    } catch (error) {
      this.logger.error(`处理授权出错：${error instanceof Error ? error.message : String(error)}`);
      this.sendErrorPage(res, 500, '工作台出错了', '请稍后回到 AI 工具里重新连接。');
    }
  }

  @Post('oauth/token')
  async token(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.cors(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const body = bodyOf(req);
    try {
      const client = await this.clientOf(req, body);
      const resource = checkResource(body.resource, this.origin(req));
      if (!resource.ok) {
        throw new OAuthError('invalid_target', 'resource 不是工作台的地址');
      }
      // RFC 6749 要 200：Nest 的 POST 默认 201，不显式写会回 201（10-19 ERP verify 踩过同样的坑）
      const grantType = str(body.grant_type);
      if (grantType === 'authorization_code') {
        res.status(200).json(
          await this.oauth.exchangeCode({
            client,
            code: str(body.code),
            verifier: str(body.code_verifier),
            redirectUri: str(body.redirect_uri),
            resource: resource.resource,
          }),
        );
        return;
      }
      if (grantType === 'refresh_token') {
        res.status(200).json(await this.oauth.refresh({ client, refreshToken: str(body.refresh_token) }));
        return;
      }
      throw new OAuthError(
        'unsupported_grant_type',
        'grant_type 只支持 authorization_code / refresh_token',
      );
    } catch (error) {
      this.sendOAuthError(res, error);
    }
  }

  @Post('oauth/revoke')
  async revoke(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.cors(res);
    res.setHeader('Cache-Control', 'no-store');
    const body = bodyOf(req);
    try {
      const client = await this.clientOf(req, body);
      await this.oauth.revokeToken(client, str(body.token));
      res.status(200).end();
    } catch (error) {
      this.sendOAuthError(res, error);
    }
  }

  private async showConsent(req: Request, res: Response): Promise<void> {
    const query = req.query as Record<string, unknown>;
    const client = await this.oauth.findClient(str(query.client_id));
    if (!client) {
      this.sendErrorPage(res, 400, '授权链接不对', '发起授权的应用没有在工作台登记，请回到 AI 工具里重新连接。');
      return;
    }
    const redirectUri = this.oauth.resolveRedirectUri(client, str(query.redirect_uri));
    if (!redirectUri) {
      this.sendErrorPage(res, 400, '授权链接不对', '回调地址和应用登记的对不上，请回到 AI 工具里重新连接。');
      return;
    }
    // 应用和回调都认得了：其余参数不对按 OAuth 规矩带回给应用
    const state = str(query.state);
    const fail = (error: string, description: string): void => {
      res.redirect(302, withQuery(redirectUri, { error, error_description: description, state }));
    };
    if (query.response_type !== 'code') {
      fail('unsupported_response_type', 'response_type 只支持 code');
      return;
    }
    const challenge = query.code_challenge;
    if (!isPkceValue(challenge) || query.code_challenge_method !== 'S256') {
      fail('invalid_request', '要用 PKCE（code_challenge_method=S256）');
      return;
    }
    const resource = checkResource(query.resource, this.origin(req));
    if (!resource.ok) {
      fail('invalid_target', 'resource 不是工作台的地址');
      return;
    }
    const userId = req.userContext?.userId;
    if (userId === undefined || userId === null || userId === '') {
      // 没登录：配了统一登录就直接跳过去（少点一下登录页），登录完回到这个地址
      const next = req.originalUrl;
      if (next.length > MAX_NEXT_LENGTH) {
        this.sendErrorPage(res, 400, '授权链接太长', '请先在浏览器里登录工作台，再回到 AI 工具里重新连接。');
        return;
      }
      const loginPath = this.config.oidc ? '/auth/oidc/login' : '/login';
      res.redirect(302, `${this.config.basePath}${loginPath}?next=${encodeURIComponent(next)}`);
      return;
    }
    const request = this.oauth.signConsent({
      userId: String(userId),
      clientId: client.id,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource: resource.resource,
    });
    this.sendHtml(
      res,
      200,
      renderConsentPage({
        appName: client.clientName,
        userName: req.userContext?.userName ?? '',
        redirect: describeRedirect(redirectUri),
        request,
        action: `${this.config.basePath}/oauth/authorize`,
        faviconHref: `${this.config.basePath}/favicon.svg`,
      }),
    );
  }

  private async handleDecision(req: Request, res: Response): Promise<void> {
    const body = bodyOf(req);
    const request = this.oauth.readConsent(body.request);
    if (!request) {
      this.sendErrorPage(res, 400, '授权页过期了', '请回到 AI 工具里重新连接。');
      return;
    }
    // 票据绑定打开授权页的人：换了账号登录、或拿别人的票据来交都不认
    const userId = req.userContext?.userId;
    if (userId === undefined || userId === null || String(userId) !== request.userId) {
      this.sendErrorPage(res, 403, '登录的人变了', '请回到 AI 工具里重新连接。');
      return;
    }
    const client = await this.oauth.findClient(request.clientId);
    if (!client || this.oauth.resolveRedirectUri(client, request.redirectUri) === null) {
      this.sendErrorPage(res, 400, '授权链接不对', '应用的登记变了，请回到 AI 工具里重新连接。');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (body.decision !== 'approve') {
      res.redirect(
        302,
        withQuery(request.redirectUri, {
          error: 'access_denied',
          error_description: '用户拒绝了授权',
          state: request.state,
        }),
      );
      return;
    }
    const code = await this.oauth.issueCode(request);
    this.logger.log(`OAuth 授权：${request.userId} 同意了 ${client.clientName || client.id}`);
    res.redirect(302, withQuery(request.redirectUri, { code, state: request.state }));
  }

  private async clientOf(req: Request, body: Record<string, unknown>): Promise<OAuthClient> {
    const basic = parseBasicAuth(req.headers.authorization);
    const bodyClientId = str(body.client_id);
    if (basic && bodyClientId && bodyClientId !== basic.clientId) {
      throw new OAuthError('invalid_request', 'client_id 前后不一致');
    }
    return this.oauth.authenticateClient(
      basic?.clientId ?? bodyClientId,
      basic?.clientSecret ?? str(body.client_secret),
    );
  }

  private origin(req: Request): string {
    return new URL(this.oauth.urls(req).issuer).origin;
  }

  private cors(res: Response): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  }

  private sendOAuthError(res: Response, error: unknown): void {
    if (error instanceof OAuthError) {
      if (error.status === 401) {
        res.setHeader('WWW-Authenticate', 'Basic realm="panasia-workbench"');
      }
      res.status(error.status).json({ error: error.code, error_description: error.message });
      return;
    }
    this.logger.error(
      `OAuth 端点出错：${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    res.status(500).json({ error: 'server_error', error_description: '工作台出错了，请稍后重试' });
  }

  private sendErrorPage(res: Response, status: number, title: string, message: string): void {
    this.sendHtml(
      res,
      status,
      renderErrorPage({ title, message, faviconHref: `${this.config.basePath}/favicon.svg` }),
    );
  }

  /** 授权页不许被嵌进别人的页面（防点击劫持骗点「同意」），也不缓存 */
  private sendHtml(res: Response, status: number, html: string): void {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(html);
  }
}
