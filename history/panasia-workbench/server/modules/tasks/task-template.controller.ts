import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { TaskTemplateService } from './task-template.service';
import { TaskTemplateUpsertDto } from './task-template.dto';
import type {
  TaskTemplateGenerateResponse,
  TaskTemplateSummary,
} from '@shared/api.interface';

@Controller('api/admin/task-templates')
export class TaskTemplateController {
  constructor(private readonly taskTemplateService: TaskTemplateService) {}

  @Get()
  @CanRole(['boss'])
  list(): Promise<TaskTemplateSummary[]> {
    return this.taskTemplateService.listAll();
  }

  @Post()
  @CanRole(['boss'])
  create(@Body() dto: TaskTemplateUpsertDto): Promise<TaskTemplateSummary> {
    return this.taskTemplateService.create(dto);
  }

  @Patch(':id')
  @CanRole(['boss'])
  update(
    @Param('id') id: string,
    @Body() dto: TaskTemplateUpsertDto,
  ): Promise<TaskTemplateSummary> {
    return this.taskTemplateService.update(id, dto);
  }

  @Delete(':id')
  @CanRole(['boss'])
  async remove(@Param('id') id: string): Promise<{ ok: boolean }> {
    await this.taskTemplateService.remove(id);
    return { ok: true };
  }

  @Post('generate')
  @CanRole(['boss'])
  generate(): Promise<TaskTemplateGenerateResponse> {
    return this.taskTemplateService.generateTodayTasks();
  }
}
