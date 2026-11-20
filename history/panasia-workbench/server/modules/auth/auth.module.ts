import { Global, Module } from '@nestjs/common';

import { ApiKeysModule } from '../api-keys/api-keys.module';
import { OAuthModule } from '../oauth/oauth.module';
import { AuthConfig } from './auth.config';
import { AuthApiController, AuthController } from './auth.controller';
import { AuthGateService } from './auth-gate.service';
import { LoginAccountService } from './login-account.service';
import { OidcService } from './oidc.service';
import { UserDirectoryService } from './user-directory.service';

/**
 * 独立部署的登录：Authentik 统一登录 + 自签会话 + 开放接口 key（+ 个人 key / OAuth 令牌，闸门要反查身份）。
 * 闸门本身在 main.ts 以 Express 中间件挂载（见 standalone-http.ts），这里只提供服务与登录路由。
 */
@Global()
@Module({
  imports: [ApiKeysModule, OAuthModule],
  controllers: [AuthController, AuthApiController],
  providers: [
    AuthConfig,
    OidcService,
    LoginAccountService,
    AuthGateService,
    UserDirectoryService,
  ],
  exports: [AuthConfig, LoginAccountService, AuthGateService, UserDirectoryService],
})
export class AuthModule {}
