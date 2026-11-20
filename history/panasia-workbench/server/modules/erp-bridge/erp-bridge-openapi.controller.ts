import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ErpBridgeService } from './erp-bridge.service';
import { ErpVerifyDto } from './erp-bridge.dto';
import type { ErpVerifyResponse } from '@shared/api.interface';

/** ERP 系统服务端回调：entry_token 换绑定身份（网关 API Key 鉴权，系统身份） */
@Controller('openapi/erp')
export class ErpBridgeOpenApiController {
  constructor(private readonly erpBridge: ErpBridgeService) {}

  /**
   * ERP 那边（server/app/services/miaoda_entry.py）只认 HTTP 200，Nest 的 POST 默认回 201 会被当成
   * 「工作台暂时不可用」：显式 200
   */
  @Post('verify')
  @HttpCode(200)
  verify(@Body() dto: ErpVerifyDto): Promise<ErpVerifyResponse> {
    return this.erpBridge.verifyToken(dto.token);
  }
}
