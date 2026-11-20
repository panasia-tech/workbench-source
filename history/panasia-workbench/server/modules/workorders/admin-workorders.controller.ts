import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { WorkordersService } from './workorders.service';
import { AdminWorkOrderCreateDto } from './workorders.dto';
import type {
  AdminWorkOrderDeleteResponse,
  AdminWorkOrderDraftsResponse,
  AdminWorkOrderPublishResponse,
  AdminWorkOrderQueueResponse,
  CreateWorkOrderResponse,
} from '@shared/api.interface';

@Controller('api/admin/work-orders')
export class AdminWorkOrdersController {
  constructor(private readonly workordersService: WorkordersService) {}

  @Get('drafts')
  @CanRole(['boss'])
  listDrafts(
    @Req() req: Request,
  ): Promise<AdminWorkOrderDraftsResponse> {
    return this.workordersService.listDrafts(req.userContext);
  }

  @Get('queue')
  @CanRole(['boss'])
  listQueue(@Req() req: Request): Promise<AdminWorkOrderQueueResponse> {
    return this.workordersService.listQueue(req.userContext);
  }

  @Post()
  @CanRole(['boss'])
  create(
    @Req() req: Request,
    @Body() dto: AdminWorkOrderCreateDto,
  ): Promise<CreateWorkOrderResponse> {
    return this.workordersService.createFromBoss(req.userContext.userId, dto);
  }

  @Post(':id/publish')
  @CanRole(['boss'])
  publish(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AdminWorkOrderPublishResponse> {
    return this.workordersService.publishDraft(req.userContext.userId, id);
  }

  @Delete(':id')
  @CanRole(['boss'])
  remove(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<AdminWorkOrderDeleteResponse> {
    return this.workordersService.deleteDraft(req.userContext.userId, id);
  }
}
