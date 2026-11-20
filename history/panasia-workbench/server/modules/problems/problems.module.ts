import { Module, forwardRef } from '@nestjs/common';

import { DemoModule } from '../demo/demo.module';
import { TasksModule } from '../tasks/tasks.module';
import { AdminProblemsController } from './admin-problems.controller';
import { ProblemsController } from './problems.controller';
import { ProblemsService } from './problems.service';

@Module({
  // 提交阻塞带 taskId 要用 TasksService.assertOperableTask 判任务归属；TasksModule 也引用本模块
  // （堵塞衍生问题工单），两边都用 forwardRef
  imports: [DemoModule, forwardRef(() => TasksModule)],
  controllers: [ProblemsController, AdminProblemsController],
  providers: [ProblemsService],
  exports: [ProblemsService],
})
export class ProblemsModule {}
