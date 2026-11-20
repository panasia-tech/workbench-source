import { Module } from '@nestjs/common';

import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { DemoViewService } from './demo-view.service';

@Module({
  controllers: [AccountController],
  providers: [DemoViewService, AccountService],
  exports: [DemoViewService],
})
export class DemoModule {}
