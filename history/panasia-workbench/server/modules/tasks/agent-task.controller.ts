import { Body, Controller, Post } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { CreateAgentTaskRequest } from '@shared/api.interface';
import { AgentConfigTaskService } from './agent-config-task.service';

export class CreateAgentTaskDto implements CreateAgentTaskRequest {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsOptional()
  @IsString()
  @IsIn(['config', 'verify'])
  taskType?: 'config' | 'verify';

  @IsString()
  @MinLength(1)
  instruction!: string;
}

@Controller('api/agent-tasks')
export class AgentTaskController {
  constructor(private readonly service: AgentConfigTaskService) {}

  @CanRole(['boss', 'admin'])
  @Post()
  async create(@Body() dto: CreateAgentTaskDto) {
    return this.service.createTask(dto);
  }
}
