import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { TasksService } from './tasks.service';
import { taskViewerOf, type TaskViewer } from './task-viewer';
import { DemoViewService } from '../demo/demo-view.service';
import {
  TaskAssistDto,
  TaskBlockDto,
  TaskEvidenceDto,
  TaskStatusUpdateDto,
} from './tasks.dto';
import type {
  TaskActionResult,
  TaskDetail,
  TaskHistoryResponse,
  TasksOverview,
} from '@shared/api.interface';

@Controller('api/tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async getOverview(@Req() req: Request): Promise<TasksOverview> {
    const view = await this.demoView.resolve(req);
    return this.tasksService.getOverview(view.userId);
  }

  @NeedLogin()
  @Get('history')
  async getHistory(
    @Req() req: Request,
    @Query('date') date?: string,
    @Query('scope') scope?: string,
    @Query('keyword') keyword?: string,
  ): Promise<TaskHistoryResponse> {
    const view = await this.demoView.resolve(req);
    return this.tasksService.getHistory(view.userId, {
      date,
      scope,
      keyword,
    });
  }

  // 以下按任务 ID 读写的接口：员工只能看、只能操作指派给自己的任务，不是本人的一律 404（服务层判）

  @NeedLogin()
  @Get(':taskId')
  async getDetail(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Query('projectId') projectId?: string,
  ): Promise<TaskDetail> {
    return this.tasksService.getDetail(
      taskId,
      projectId,
      await this.viewerOf(req),
    );
  }

  @NeedLogin()
  @Post(':taskId/status')
  async updateStatus(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() dto: TaskStatusUpdateDto,
  ): Promise<TaskActionResult> {
    return this.tasksService.updateStatus(
      taskId,
      dto,
      await this.viewerOf(req),
    );
  }

  @NeedLogin()
  @Post(':taskId/block')
  async block(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() dto: TaskBlockDto,
  ): Promise<TaskActionResult> {
    return this.tasksService.block(taskId, dto, await this.viewerOf(req));
  }

  @NeedLogin()
  @Post(':taskId/evidence')
  async submitEvidence(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() dto: TaskEvidenceDto,
  ): Promise<TaskActionResult> {
    return this.tasksService.submitEvidence(
      taskId,
      dto,
      await this.viewerOf(req),
    );
  }

  @NeedLogin()
  @Post(':taskId/assist')
  async requestAssist(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() dto: TaskAssistDto,
  ): Promise<TaskActionResult> {
    return this.tasksService.requestAssist(
      taskId,
      dto,
      await this.viewerOf(req),
    );
  }

  private async viewerOf(req: Request): Promise<TaskViewer> {
    return taskViewerOf(req, await this.demoView.resolve(req));
  }
}
