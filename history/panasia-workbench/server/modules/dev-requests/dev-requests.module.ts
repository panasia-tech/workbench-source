import { Module } from '@nestjs/common';

import { DemoModule } from '../demo/demo.module';
import { AdminDevRequestsController } from './admin-dev-requests.controller';
import { DevRequestDevelopersService } from './dev-request-developers.service';
import { DevRequestLookupService } from './dev-request-lookup.service';
import { DevRequestPlaneService } from './dev-request-plane.service';
import { DevRequestQueryService } from './dev-request-query.service';
import { DevRequestsController } from './dev-requests.controller';
import { DevRequestsService } from './dev-requests.service';

/**
 * 开发需求（2026-10-19）：发布 → 报价 → 发布人确认 → 开发交付 → 发布人验收，状态在 Plane，流程数据在工作台库。
 * 导出给任务模块（任务卡通用按钮碰到开发需求改走这里或拒绝）、工单模块（验收 Dock、工单关联任务）用
 */
@Module({
  imports: [DemoModule],
  controllers: [DevRequestsController, AdminDevRequestsController],
  providers: [
    DevRequestDevelopersService,
    DevRequestLookupService,
    DevRequestPlaneService,
    DevRequestsService,
    DevRequestQueryService,
  ],
  exports: [DevRequestLookupService, DevRequestsService],
})
export class DevRequestsModule {}
