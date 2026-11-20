import { Body, Controller, Get, Post } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { AdminService } from './admin.service';
import { QuickTaskDraftService } from './quick-task-draft.service';
import { QuickTaskCreateDto, QuickTaskDraftDto } from './admin.dto';
import type {
  AdminExecuteResponse,
  AdminOverviewResponse,
  QuickTaskCreateResponse,
  QuickTaskDraftResponse,
} from '@shared/api.interface';

@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly quickTaskDraftService: QuickTaskDraftService,
  ) {}

  @Get('overview')
  @CanRole(['boss'])
  getOverview(): Promise<AdminOverviewResponse> {
    return this.adminService.getOverview();
  }

  @Get('execute')
  @CanRole(['boss'])
  getExecute(): Promise<AdminExecuteResponse> {
    return this.adminService.getExecute();
  }

  @Post('quick-task/draft')
  @CanRole(['boss'])
  generateDraft(@Body() dto: QuickTaskDraftDto): Promise<QuickTaskDraftResponse> {
    return this.quickTaskDraftService.generateDraft(dto);
  }

  @Post('quick-task')
  @CanRole(['boss'])
  createQuickTask(@Body() dto: QuickTaskCreateDto): Promise<QuickTaskCreateResponse> {
    return this.adminService.createQuickTask(dto);
  }
}
