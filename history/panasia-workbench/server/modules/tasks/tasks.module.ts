import { Module, forwardRef } from '@nestjs/common';
import { PerformanceModule } from '../performance/performance.module';
import { ProblemsModule } from '../problems/problems.module';
import { ProfileModule } from '../profile/profile.module';
import { DemoModule } from '../demo/demo.module';
import { DevRequestsModule } from '../dev-requests/dev-requests.module';
import { AcceptanceModule } from '../acceptance/acceptance.module';
import { AdminCoordinationController } from './admin-coordination.controller';
import { AdminCoordinationService } from './admin-coordination.service';
import { TasksAutomationService } from './tasks.automation';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskTemplateController } from './task-template.controller';
import { TaskTemplateService } from './task-template.service';
import { TaskDelegateService } from './task-delegate.service';
import { TaskReviewService } from './task-review.service';
import { BlockDeferService } from './block-defer.service';
import { SopService } from './sop.service';
import { TaskReviewOpenApiController } from './task-review.openapi.controller';
import { AgentConfigTaskService } from './agent-config-task.service';
import { AgentTaskController } from './agent-task.controller';
import { EmployeeTasksMcpTools } from '@server/mcp/tools/employee-tasks.tools';
import { TaskDelegateMcpTools } from '@server/mcp/tools/task-delegate.tools';
import { TaskScheduleMcpTools } from '@server/mcp/tools/task-schedule.tools';
import { TaskReviewMcpTools } from '@server/mcp/tools/task-review.tools';
import { AgentTasksMcpTools } from '@server/mcp/tools/agent-tasks.tools';
import { BlockDeferMcpTools } from '@server/mcp/tools/block-defer.tools';

@Module({
  // ProblemsModule 反过来要用 TasksService 判阻塞挂的任务归属，两边都用 forwardRef
  // DevRequestsModule：任务卡通用按钮、豆包审核工具碰到开发需求要改走开发需求流程或拒绝
  imports: [
    PerformanceModule,
    ProfileModule,
    DemoModule,
    DevRequestsModule,
    // 交材料记版本、验收指向具体那一版（11-10 A02）
    AcceptanceModule,
    forwardRef(() => ProblemsModule),
  ],
  controllers: [
    TasksController,
    TaskTemplateController,
    AdminCoordinationController,
    TaskReviewOpenApiController,
    AgentTaskController,
  ],
  providers: [
    TasksService,
    AdminCoordinationService,
    TaskTemplateService,
    TaskDelegateService,
    TaskReviewService,
    BlockDeferService,
    SopService,
    EmployeeTasksMcpTools,
    TaskDelegateMcpTools,
    TaskScheduleMcpTools,
    TaskReviewMcpTools,
    TasksAutomationService,
    AgentConfigTaskService,
    AgentTasksMcpTools,
    BlockDeferMcpTools,
  ],
  // 工单挂任务、提交阻塞带任务前要用 TasksService.assertOperableTask 判任务归属
  exports: [TasksService],
})
export class TasksModule {}
