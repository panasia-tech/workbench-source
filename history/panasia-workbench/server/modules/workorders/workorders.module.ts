import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { DemoModule } from '../demo/demo.module';
import { ProfileModule } from '../profile/profile.module';
import { TasksModule } from '../tasks/tasks.module';
import { DevRequestsModule } from '../dev-requests/dev-requests.module';
import { AcceptanceModule } from '../acceptance/acceptance.module';

import { WorkordersController } from './workorders.controller';
import { WorkordersService } from './workorders.service';
import { AdminWorkOrdersController } from './admin-workorders.controller';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { WorkorderDispatchMcpTools } from '@server/mcp/tools/workorder-dispatch.tools';

@Module({
  // DevRequestsModule：验收 Dock、工单关联任务不许绕过开发需求的验收
  imports: [
    HttpModule,
    DemoModule,
    ProfileModule,
    TasksModule,
    DevRequestsModule,
    // 交凭证记版本、终审指向具体那一版（11-10 A02）
    AcceptanceModule,
  ],
  controllers: [
    WorkordersController,
    AdminWorkOrdersController,
    ReviewController,
  ],
  providers: [WorkordersService, ReviewService, WorkorderDispatchMcpTools],
})
export class WorkordersModule {}
