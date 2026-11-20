import { Module } from '@nestjs/common';

import { AcceptanceController } from './acceptance.controller';
import { AcceptanceService } from './acceptance.service';

/** 提交版本与验收记录（销售工作台 A02，11-10）：工单、任务验收都用它记版本和结论 */
@Module({
  controllers: [AcceptanceController],
  providers: [AcceptanceService],
  exports: [AcceptanceService],
})
export class AcceptanceModule {}
