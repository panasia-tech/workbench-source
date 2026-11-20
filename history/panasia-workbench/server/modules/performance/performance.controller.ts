import { Controller, Get, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { PerformanceService } from './performance.service';
import { DemoViewService } from '../demo/demo-view.service';
import type { PerformanceOverview } from '@shared/api.interface';

@Controller('api/performance')
export class PerformanceController {
  constructor(
    private readonly performanceService: PerformanceService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async getOverview(@Req() req: Request): Promise<PerformanceOverview> {
    const view = await this.demoView.resolve(req);
    return this.performanceService.getPerformanceOverview(
      view.userId,
    );
  }
}
