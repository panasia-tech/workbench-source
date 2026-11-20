import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { WorkordersService } from './workorders.service';
import { DemoViewService } from '../demo/demo-view.service';
import { taskViewerOf } from '../tasks/task-viewer';
import {
  CreateWorkOrderDto,
  SubmitEvidenceDto,
  WorkOrderHandoverDto,
  WorkOrderTransitionDto,
} from './workorders.dto';
import type {
  CreateWorkOrderResponse,
  WorkOrderActionResult,
  WorkOrderCatalogResponse,
  WorkOrderDetailResponse,
  WorkOrderHandoverCandidatesResponse,
  WorkOrdersResponse,
} from '@shared/api.interface';

const MAX_PAGE_SIZE = 50;

@Controller('api/work-orders')
export class WorkordersController {
  constructor(
    private readonly workordersService: WorkordersService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('taskId') taskId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<WorkOrdersResponse> {
    const parsedPage = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const parsedSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(pageSize ?? '20', 10) || 20),
    );
    const view = await this.demoView.resolve(req);
    return this.workordersService.listForUser(view.userId, {
      status: status || undefined,
      taskId: taskId || undefined,
      page: parsedPage,
      pageSize: parsedSize,
    });
  }

  @NeedLogin()
  @Get('catalog')
  catalog(): Promise<WorkOrderCatalogResponse> {
    return this.workordersService.getCatalog();
  }

  /** 转交时能选的接手人（绑过 Plane 成员的员工，不含自己） */
  @NeedLogin()
  @Get('handover-candidates')
  async handoverCandidates(
    @Req() req: Request,
  ): Promise<WorkOrderHandoverCandidatesResponse> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.handoverCandidates(view.userId);
  }

  @NeedLogin()
  @Get(':id')
  async detail(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<WorkOrderDetailResponse> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.getDetail(view.userId, id);
  }

  @NeedLogin()
  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateWorkOrderDto,
  ): Promise<CreateWorkOrderResponse> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.create(taskViewerOf(req, view), dto);
  }

  @NeedLogin()
  @Post(':id/evidence')
  async submitEvidence(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SubmitEvidenceDto,
  ): Promise<WorkOrderDetailResponse> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.submitEvidence(view.userId, id, dto);
  }

  /** 转交给同事：必须写已做了什么、下一步、材料；负责人本人或老板 / 管理员能转 */
  @NeedLogin()
  @Post(':id/handover')
  async handover(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: WorkOrderHandoverDto,
  ): Promise<WorkOrderDetailResponse> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.handover(taskViewerOf(req, view), id, dto);
  }

  @NeedLogin()
  @Post(':id/transitions')
  async transition(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: WorkOrderTransitionDto,
  ): Promise<WorkOrderActionResult> {
    const view = await this.demoView.resolve(req);
    return this.workordersService.transition(view.userId, id, dto);
  }
}
