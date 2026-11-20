import { Controller, Get } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';

import type { OptionalIntegrations } from '@shared/api.interface';
import { optionalFeatureStates } from './optional-features';

/** 飞书 / 豆包可选集成开了哪些：前端据此隐藏没开的按钮、改提示语（不含任何凭证） */
@Controller('api/integrations')
export class IntegrationsController {
  @NeedLogin()
  @Get()
  status(): OptionalIntegrations {
    return optionalFeatureStates();
  }
}
