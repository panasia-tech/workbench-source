import { Body, Controller, Get, Post } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { EmployeeBindingService } from './employee-binding.service';
import { AdminEmployeeBindingUpsertDto } from './employee-binding.dto';
import type {
  AdminEmployeeBindingUpsertResponse,
  BindingOptionsResponse,
} from '@shared/api.interface';

/** 管理端 · 员工绑定代管：绑定选项 + 新建/编辑绑定 */
@Controller('api/admin/employees')
export class EmployeeBindingController {
  constructor(
    private readonly bindingService: EmployeeBindingService,
  ) {}

  @Get('options')
  @CanRole(['boss', 'admin'])
  getOptions(): Promise<BindingOptionsResponse> {
    return this.bindingService.getOptions();
  }

  @Post('binding')
  @CanRole(['admin'])
  upsert(
    @Body() dto: AdminEmployeeBindingUpsertDto,
  ): Promise<AdminEmployeeBindingUpsertResponse> {
    return this.bindingService.upsert(dto);
  }
}
