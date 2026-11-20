import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { ProblemsService } from './problems.service';
import { DemoViewService } from '../demo/demo-view.service';
import { TasksService } from '../tasks/tasks.service';
import { taskViewerOf } from '../tasks/task-viewer';
import { SubmitBlockerDto } from './problems.dto';
import type {
  MyBlockersResponse,
  SubmitBlockerResponse,
} from '@shared/api.interface';

@Controller('api/problems')
export class ProblemsController {
  constructor(
    private readonly problemsService: ProblemsService,
    private readonly demoView: DemoViewService,
    private readonly tasksService: TasksService,
  ) {}

  @NeedLogin()
  @Post()
  async submit(
    @Req() req: Request,
    @Body() dto: SubmitBlockerDto,
  ): Promise<SubmitBlockerResponse> {
    const view = await this.demoView.resolve(req);
    // 关联任务只能挂指派给自己的（「按日期看」按它把阻塞记到任务上），不是本人的与不存在同样 404，
    // boss/admin 本人不限，不带任务照旧。在这里判而不在 ProblemsService：TasksService 本身依赖它，互相注入会成环
    if (dto.taskId) {
      await this.tasksService.assertOperableTask(
        dto.taskId,
        taskViewerOf(req, view),
      );
    }
    return this.problemsService.submitBlocker(view.userId, dto);
  }

  @NeedLogin()
  @Get('my')
  async listMy(@Req() req: Request): Promise<MyBlockersResponse> {
    const view = await this.demoView.resolve(req);
    return this.problemsService.listForUser(view.userId);
  }
}
