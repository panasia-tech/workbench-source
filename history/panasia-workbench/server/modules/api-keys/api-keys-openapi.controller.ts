import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';

import { LoginAccountService } from '../auth/login-account.service';
import { ApiKeysService } from './api-keys.service';

interface VerifyRequest {
  key?: string;
}

interface VerifyResponse {
  userId: string;
  name: string;
  roles: string[];
}

/**
 * 全系统个人 key 验证（2026-10-22）：下游系统（ERP 等）拿系统级 key（APIKEY_VERIFY_API_KEYS，
 * auth-gate 校验）来验 wk_ 个人 key 换身份。有效回 {userId, name, roles}（工作台用户 ID = ERP 员工 ID，
 * 角色为工作台平台角色）；无效 / 已吊销 / 账号停用一律 401，不区分原因（防枚举）。
 */
@Controller('openapi/api-keys')
export class ApiKeysOpenApiController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly accounts: LoginAccountService,
  ) {}

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: VerifyRequest): Promise<VerifyResponse> {
    const raw = typeof body?.key === 'string' ? body.key.trim() : '';
    const apiKey = raw === '' ? null : await this.apiKeys.findActiveByKey(raw);
    const account = apiKey
      ? await this.accounts.findByMiaodaUserId(apiKey.userId)
      : null;
    if (!apiKey || !account || !account.enabled) {
      throw new UnauthorizedException('API Key 无效');
    }
    return {
      userId: account.miaodaUserId,
      name: account.displayName ?? account.loginName ?? '',
      roles: this.accounts.resolveRoles(account),
    };
  }
}
