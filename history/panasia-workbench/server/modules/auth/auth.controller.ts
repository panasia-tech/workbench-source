import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AuthMeResponse, AuthOptionsResponse } from '@shared/api.interface';
import { AuthConfig, KNOWN_ROLES, USER_ID_PATTERN } from './auth.config';
import { AuthGateService } from './auth-gate.service';
import { LoginAccountService, type LoginResolution } from './login-account.service';
import { OidcService, type AuthorizeRequest, type OidcIdentity } from './oidc.service';
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_TOKEN_TYPE,
  safeNextPath,
  signToken,
  verifyToken,
  type OidcStatePayload,
} from './session.util';

const STATE_TTL_SECONDS = 600;

/** 登录跳转（浏览器整页导航，不走 /api，不受 CSRF 中间件约束） */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly config: AuthConfig,
    private readonly gate: AuthGateService,
    private readonly oidc: OidcService,
    private readonly accounts: LoginAccountService,
  ) {}

  @Get('oidc/login')
  async login(
    @Req() req: Request,
    @Res() res: Response,
    @Query('next') next?: string,
  ): Promise<void> {
    const target = safeNextPath(next, this.gate.appPath('/'));
    if (!this.oidc.enabled) {
      res.redirect(302, this.gate.loginPath(target, { error: 'not_configured' }));
      return;
    }
    const redirectUri = this.callbackUri(req);
    let authorize: AuthorizeRequest;
    try {
      authorize = await this.oidc.buildAuthorizeRequest(redirectUri);
    } catch (error) {
      this.logger.error(`发起统一登录失败：${error instanceof Error ? error.message : String(error)}`);
      res.redirect(302, this.gate.loginPath(target, { error: 'idp' }));
      return;
    }
    const state: OidcStatePayload = {
      typ: OIDC_STATE_TOKEN_TYPE,
      state: authorize.state,
      nonce: authorize.nonce,
      verifier: authorize.verifier,
      next: target,
      redirectUri,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    res.cookie(OIDC_STATE_COOKIE, signToken(state, this.config.sessionSecret), {
      ...this.gate.cookieOptions(),
      maxAge: STATE_TTL_SECONDS * 1000,
    });
    res.redirect(302, authorize.url);
  }

  @Get('oidc/callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') idpError?: string,
  ): Promise<void> {
    const cookies = (req.cookies ?? {}) as Record<string, unknown>;
    const saved = verifyToken(
      cookies[OIDC_STATE_COOKIE],
      this.config.sessionSecret,
    ) as Partial<OidcStatePayload> | null;
    res.clearCookie(OIDC_STATE_COOKIE, this.gate.cookieOptions());
    const fallback = this.gate.appPath('/');
    const next = safeNextPath(saved?.next, fallback);
    if (idpError) {
      this.logger.warn(`统一登录返回错误：${idpError} ${String(req.query.error_description ?? '')}`);
      res.redirect(302, this.gate.loginPath(next, { error: 'idp' }));
      return;
    }
    const stateValid =
      saved !== null &&
      saved.typ === OIDC_STATE_TOKEN_TYPE &&
      typeof saved.exp === 'number' &&
      saved.exp > Math.floor(Date.now() / 1000) &&
      typeof state === 'string' &&
      state === saved.state &&
      typeof code === 'string' &&
      code !== '';
    if (!stateValid) {
      res.redirect(302, this.gate.loginPath(next, { error: 'expired' }));
      return;
    }
    let identity: OidcIdentity;
    try {
      identity = await this.oidc.resolveIdentity({
        code: code as string,
        verifier: saved.verifier as string,
        nonce: saved.nonce as string,
        redirectUri: saved.redirectUri as string,
      });
    } catch (error) {
      this.logger.error(`统一登录回调失败：${error instanceof Error ? error.message : String(error)}`);
      res.redirect(302, this.gate.loginPath(next, { error: 'idp' }));
      return;
    }
    let result: LoginResolution;
    try {
      result = await this.accounts.resolveOidcLogin(identity);
    } catch (error) {
      this.logger.error(`统一登录查对照表失败：${error instanceof Error ? error.message : String(error)}`);
      res.redirect(302, this.gate.loginPath(next, { error: 'server' }));
      return;
    }
    if (result.status !== 'ok') {
      this.logger.warn(
        `统一账号登录被拒（${result.status}）：sub=${identity.subject} username=${identity.username ?? ''} email=${identity.email ?? ''}`,
      );
      const extra: Record<string, string> = { error: result.status };
      if (result.status === 'not_provisioned') extra.who = result.hint;
      res.redirect(302, this.gate.loginPath(next, extra));
      return;
    }
    await this.accounts.recordLogin(result.account, identity).catch((error: unknown) => {
      // 只是刷新组/邮箱，失败不挡登录
      this.logger.warn(`记录登录信息失败：${error instanceof Error ? error.message : String(error)}`);
    });
    // 工作台用户 ID 是不是来自 ERP 身份：这次登录 Authentik 给的 erp_sub 就是对照行的用户 ID。
    // 管理员按登录名预建、映射到别的 ID 的行不算；记进会话票据，进 ERP 免密要它（见 erp-bridge）
    const erpIdentity =
      identity.erpSub !== null && identity.erpSub === result.account.miaodaUserId;
    this.gate.issueSession(res, {
      kind: 'oidc',
      userId: result.account.miaodaUserId,
      accountId: result.account.id,
      erpIdentity,
    });
    this.logger.log(
      `统一账号登录：${identity.username ?? identity.subject} → ${result.account.miaodaUserId}${
        erpIdentity ? '（ERP 身份）' : ''
      }`,
    );
    res.redirect(302, next);
  }

  @Get('logout')
  logout(@Res() res: Response): void {
    this.gate.clearSession(res);
    res.redirect(302, this.gate.loginPath(undefined, { logged_out: '1' }));
  }

  /** 开发登录：仅 AUTH_DEV_LOGIN=true 且非生产环境；userId 直接当妙搭 userId 用 */
  @Get('dev-login')
  devLogin(
    @Res() res: Response,
    @Query('userId') userId?: string,
    @Query('name') name?: string,
    @Query('roles') roles?: string,
    @Query('next') next?: string,
  ): void {
    if (!this.config.devLoginEnabled) {
      throw new NotFoundException();
    }
    const target = safeNextPath(next, this.gate.appPath('/'));
    const uid = (userId ?? '').trim();
    if (!USER_ID_PATTERN.test(uid)) {
      res.redirect(302, this.gate.loginPath(target, { error: 'dev_user' }));
      return;
    }
    const grantedRoles = (roles ?? '')
      .split(',')
      .map((role: string) => role.trim())
      .filter((role: string) => (KNOWN_ROLES as readonly string[]).includes(role));
    this.gate.issueSession(res, {
      kind: 'dev',
      userId: uid,
      name: (name ?? '').trim().slice(0, 50) || `开发-${uid}`,
      roles: [...new Set(grantedRoles)],
    });
    this.logger.warn(`开发登录：${uid} roles=[${grantedRoles.join(',')}]`);
    res.redirect(302, target);
  }

  private callbackUri(req: Request): string {
    if (this.config.oidc?.redirectUri) return this.config.oidc.redirectUri;
    const origin = this.config.publicBaseUrl ?? `${req.protocol}://${req.get('host') ?? ''}`;
    return `${origin}${this.gate.appPath('/auth/oidc/callback')}`;
  }
}

/** 登录页与前端取当前登录人用（/api 下，走 CSRF 校验） */
@Controller('api/auth')
export class AuthApiController {
  constructor(
    private readonly config: AuthConfig,
    private readonly oidc: OidcService,
  ) {}

  @Get('options')
  options(): AuthOptionsResponse {
    return {
      oidcEnabled: this.oidc.enabled,
      oidcProviderName: this.config.oidc?.providerName ?? '统一账号',
      devLoginEnabled: this.config.devLoginEnabled,
    };
  }

  @Get('me')
  me(@Req() req: Request): AuthMeResponse {
    const { userId, userName, roles } = req.userContext ?? {};
    if (userId === undefined || userId === null || userId === '') {
      throw new UnauthorizedException('未登录');
    }
    return {
      userId: String(userId),
      name: userName ?? '',
      roles: roles ?? [],
    };
  }
}
