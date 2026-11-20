import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { DemoViewService } from '../demo/demo-view.service';
import { ApiKeysService } from './api-keys.service';
import type {
  ApiKeyIssueResponse,
  ApiKeyListResponse,
} from '@shared/api.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 个人 API Key 管理（只看、只操作自己的；演示视角按被演示的账号算） */
@Controller('api/my/api-keys')
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async list(@Req() req: Request): Promise<ApiKeyListResponse> {
    const view = await this.demoView.resolve(req);
    return this.apiKeys.list(view.userId);
  }

  @NeedLogin()
  @Post()
  async issue(
    @Req() req: Request,
    @Body() body: { name?: string },
  ): Promise<ApiKeyIssueResponse> {
    const view = await this.demoView.resolve(req);
    return this.apiKeys.issue(view.userId, body?.name);
  }

  @NeedLogin()
  @Post(':id/revoke')
  async revoke(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const view = await this.demoView.resolve(req);
    // 不是 UUID 直接 404，别让库报类型错变 500；别人的 key 同样 404
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException('key 不存在');
    }
    return this.apiKeys.revoke(view.userId, id);
  }
}
