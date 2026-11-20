import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DemoModule } from '../demo/demo.module';
import { WorkController } from './work.controller';
import { ErpOverviewService } from './erp-overview.service';
import { WorkService } from './work.service';

@Module({
  imports: [DemoModule, HttpModule],
  controllers: [WorkController],
  providers: [WorkService, ErpOverviewService],
})
export class WorkModule {}
