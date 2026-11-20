import { Module } from '@nestjs/common';

import { DemoModule } from '../demo/demo.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysOpenApiController } from './api-keys-openapi.controller';
import { ApiKeysService } from './api-keys.service';

/** 个人 API Key（2026-10-22）：管理接口 + 供 auth-gate 鉴权反查身份 + 全系统验证端点 */
@Module({
  imports: [DemoModule],
  controllers: [ApiKeysController, ApiKeysOpenApiController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
