import { Controller, Get, Query, Req } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import type {
  DevRequestLedgerResponse,
  DevRequestListResponse,
} from '@shared/api.interface';
import { DevRequestQueryService } from './dev-request-query.service';
import { adminDevRequestViewerOf } from './dev-request-viewer';

/** 管理端开发需求：全部需求（可按环节筛）+ 开发需求台账（boss / admin 只读；动作在详情页按身份做） */
@Controller('api/admin/dev-requests')
export class AdminDevRequestsController {
  constructor(private readonly query: DevRequestQueryService) {}

  @Get()
  @CanRole(['boss', 'admin'])
  list(
    @Req() req: Request,
    @Query('stage') stage?: string,
  ): Promise<DevRequestListResponse> {
    return this.query.adminList(adminDevRequestViewerOf(req), stage);
  }

  @Get('ledger')
  @CanRole(['boss', 'admin'])
  ledger(
    @Query('month') month?: string,
    @Query('developerId') developerId?: string,
    @Query('projectId') projectId?: string,
  ): Promise<DevRequestLedgerResponse> {
    return this.query.ledger({ month, developerId, projectId });
  }
}
