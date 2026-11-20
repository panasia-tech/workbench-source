import { Module } from '@nestjs/common';
import { DemoModule } from '../demo/demo.module';
import { AdminPerformanceController } from './admin-performance.controller';
import { AdminPerformanceService } from './admin-performance.service';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';

@Module({
  imports: [DemoModule],
  controllers: [PerformanceController, AdminPerformanceController],
  providers: [PerformanceService, AdminPerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
