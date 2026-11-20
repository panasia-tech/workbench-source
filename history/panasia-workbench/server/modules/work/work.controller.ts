import { Controller, Get, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { WorkService } from './work.service';
import { DemoViewService } from '../demo/demo-view.service';
import type { WorkOverview } from '@shared/api.interface';

@Controller('api/work')
export class WorkController {
  constructor(
    private readonly workService: WorkService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async getWorkOverview(@Req() req: Request): Promise<WorkOverview> {
    const view = await this.demoView.resolve(req);
    return this.workService.getWorkOverview(view.userId);
  }
}
