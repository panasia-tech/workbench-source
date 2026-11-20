import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import type { OAuthGrantListResponse } from '@shared/api.interface';
import { OAuthService } from './oauth.service';

/**
 * 「我的」页：用 OAuth 授权过的 AI 应用（ChatGPT 等），看和收回。
 * 授权是登录的人本人在授权页点的，这里也按本人算，不接演示视角。
 */
@Controller('api/my/oauth-grants')
export class OAuthGrantsController {
  constructor(private readonly oauth: OAuthService) {}

  @NeedLogin()
  @Get()
  async list(@Req() req: Request): Promise<OAuthGrantListResponse> {
    return this.oauth.listGrants(String(req.userContext.userId));
  }

  @NeedLogin()
  @Post(':id/revoke')
  async revoke(@Req() req: Request, @Param('id') id: string): Promise<{ ok: true }> {
    return this.oauth.revokeGrantOfUser(String(req.userContext.userId), id);
  }
}
