import { Controller, Get, Param } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { AdminPerformanceService } from './admin-performance.service';
import type {
  AdminPerformanceDetailResponse,
  AdminPerformanceEmployeeListResponse,
} from '@shared/api.interface';

@Controller('api/admin/performance')
export class AdminPerformanceController {
  constructor(
    private readonly adminPerformanceService: AdminPerformanceService,
  ) {}

  @Get('employees')
  @CanRole(['boss', 'admin'])
  listEmployees(): Promise<AdminPerformanceEmployeeListResponse> {
    return this.adminPerformanceService.listEmployees();
  }

  @Get('employees/:userId')
  @CanRole(['boss', 'admin'])
  getEmployeeDetail(
    @Param('userId') userId: string,
  ): Promise<AdminPerformanceDetailResponse> {
    return this.adminPerformanceService.getDetail(userId);
  }
}
