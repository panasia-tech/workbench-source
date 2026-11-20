import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { DemoViewService } from '../demo/demo-view.service';
import type {
  DevRequestActionResponse,
  DevRequestDetail,
  DevRequestDevelopersResponse,
  DevRequestListResponse,
  DevRequestOptionsResponse,
} from '@shared/api.interface';
import {
  CreateDevRequestDto,
  DevRequestAcceptDto,
  DevRequestClarifyDto,
  DevRequestDeliverDto,
  DevRequestQuoteDto,
  DevRequestReasonDto,
} from './dev-requests.dto';
import { DevRequestsService } from './dev-requests.service';
import {
  DevRequestQueryService,
  type DevRequestListScope,
} from './dev-request-query.service';
import { devRequestViewerOf, type DevRequestViewer } from './dev-request-viewer';

/**
 * 开发需求（员工端，谁登录都能发）。按 ID 的接口：发布人、开发者、boss/admin 本人能看，
 * 别人的与不存在的同样 404；能看但身份不对的动作 403；环节不对 400。演示视角按被演示的员工算
 */
@Controller('api/dev-requests')
export class DevRequestsController {
  constructor(
    private readonly devRequests: DevRequestsService,
    private readonly query: DevRequestQueryService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async list(
    @Req() req: Request,
    @Query('scope') scope?: string,
  ): Promise<DevRequestListResponse> {
    const resolved: DevRequestListScope =
      scope === 'assigned' || scope === 'all' ? scope : 'mine';
    return this.query.list(await this.viewerOf(req), resolved);
  }

  // 固定路径要写在 :id 前面，不然会被当成 ID

  @NeedLogin()
  @Get('options')
  options(): Promise<DevRequestOptionsResponse> {
    return this.query.options();
  }

  @NeedLogin()
  @Get('options/developers')
  async developers(
    @Req() req: Request,
    @Query('projectId') projectId?: string,
  ): Promise<DevRequestDevelopersResponse> {
    return this.query.developers(await this.viewerOf(req), projectId ?? '');
  }

  /** 「我的」页入口的角标：轮到我处理的条数 */
  @NeedLogin()
  @Get('todo-count')
  async todoCount(@Req() req: Request): Promise<{ count: number }> {
    return { count: await this.query.countNeedsMe(await this.viewerOf(req)) };
  }

  @NeedLogin()
  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateDevRequestDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.create(await this.viewerOf(req), dto);
  }

  @NeedLogin()
  @Get(':id')
  async detail(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<DevRequestDetail> {
    return this.query.detail(await this.viewerOf(req), id);
  }

  @NeedLogin()
  @Post(':id/quote')
  async quote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestQuoteDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.quote(await this.viewerOf(req), id, dto);
  }

  @NeedLogin()
  @Post(':id/return')
  async returnForClarification(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestReasonDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.returnForClarification(
      await this.viewerOf(req),
      id,
      dto.reason,
    );
  }

  @NeedLogin()
  @Post(':id/clarify')
  async clarify(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestClarifyDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.clarify(await this.viewerOf(req), id, dto);
  }

  @NeedLogin()
  @Post(':id/confirm-quote')
  async confirmQuote(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.confirmQuote(await this.viewerOf(req), id);
  }

  @NeedLogin()
  @Post(':id/reject-quote')
  async rejectQuote(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestReasonDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.rejectQuote(await this.viewerOf(req), id, dto.reason);
  }

  @NeedLogin()
  @Post(':id/deliver')
  async deliver(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestDeliverDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.deliver(await this.viewerOf(req), id, dto);
  }

  @NeedLogin()
  @Post(':id/accept')
  async accept(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestAcceptDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.accept(await this.viewerOf(req), id, dto);
  }

  @NeedLogin()
  @Post(':id/reject-delivery')
  async rejectDelivery(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestReasonDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.rejectDelivery(await this.viewerOf(req), id, dto.reason);
  }

  @NeedLogin()
  @Post(':id/cancel')
  async cancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DevRequestReasonDto,
  ): Promise<DevRequestActionResponse> {
    return this.devRequests.cancel(await this.viewerOf(req), id, dto.reason);
  }

  private async viewerOf(req: Request): Promise<DevRequestViewer> {
    return devRequestViewerOf(req, await this.demoView.resolve(req));
  }
}
