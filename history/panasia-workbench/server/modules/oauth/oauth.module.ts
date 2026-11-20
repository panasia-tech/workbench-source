import { Module } from '@nestjs/common';

import { OAuthGrantsController } from './oauth-grants.controller';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

/**
 * OAuth 授权（2026-10-25）：工作台自己当授权服务器，给 ChatGPT 网页版这类只能 OAuth 的 MCP 客户端用；
 * 令牌校验由 auth-gate 调 OAuthService（AuthModule 引入本模块）。AuthConfig / LoginAccountService 来自全局 AuthModule
 */
@Module({
  controllers: [OAuthController, OAuthGrantsController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
