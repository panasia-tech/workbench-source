import { Controller, Get, Param, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { ProjectsService } from './projects.service';
import { DemoViewService } from '../demo/demo-view.service';
import type { MyProjectsResponse, ProjectDetail } from '@shared/api.interface';

@Controller('api/projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async getMyProjects(@Req() req: Request): Promise<MyProjectsResponse> {
    const view = await this.demoView.resolve(req);
    return this.projectsService.getMyProjects(view.userId);
  }

  @NeedLogin()
  @Get(':projectId')
  async getProjectDetail(
    @Req() req: Request,
    @Param('projectId') projectId: string,
  ): Promise<ProjectDetail> {
    const view = await this.demoView.resolve(req);
    // boss/admin 看全项目；员工只看自己有任务的项目、只给自己的任务明细。
    // 演示视角按被演示的员工算，免得老板切过去看到的和员工本人不一样
    const roles: string[] = req.userContext.roles ?? [];
    const fullAccess =
      !view.demoAs && (roles.includes('boss') || roles.includes('admin'));
    return this.projectsService.getProjectDetail(view.userId, projectId, {
      fullAccess,
    });
  }
}
