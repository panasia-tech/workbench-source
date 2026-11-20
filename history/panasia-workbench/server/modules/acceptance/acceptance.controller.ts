import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { Request } from 'express';

import { AcceptanceService } from './acceptance.service';
import type {
  AcceptanceOverviewResponse,
  AcceptanceRecordCreateRequest,
  AcceptanceRecordResponse,
  AcceptanceRecordStateRequest,
  AcceptanceSubjectType,
} from '@shared/api.interface';

export class AcceptanceRecordCreateDto implements AcceptanceRecordCreateRequest {
  @IsString()
  @IsIn(['work_order', 'task'], { message: '对象类型只能是 work_order / task' })
  subjectType!: 'work_order' | 'task';

  @IsString()
  subjectId!: string;

  @IsString()
  @IsIn(['research_pass', 'business_approval', 'listing_confirm'], {
    message: '记录类型只能是 research_pass / business_approval / listing_confirm',
  })
  kind!: 'research_pass' | 'business_approval' | 'listing_confirm';

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AcceptanceRecordStateDto implements AcceptanceRecordStateRequest {
  @IsString()
  @IsIn(['pause', 'resume', 'exit'], { message: '操作只能是 pause / resume / exit' })
  action!: 'pause' | 'resume' | 'exit';

  @IsOptional()
  @IsString()
  reason?: string;
}

function operatorOf(req: Request): { userId: string | null; userName: string | null } {
  const ctx = req.userContext as { userId?: string; userName?: string } | undefined;
  return { userId: ctx?.userId ?? null, userName: ctx?.userName ?? null };
}

/**
 * 研究通过 / 经营批准 / 上架确认（销售工作台 A02，11-10）。只有老板、管理员能记；
 * 经营批准是管理员给的，员工、豆包都给不了（没有对应的员工接口和 MCP 工具）。
 */
@Controller('api/admin/acceptance')
export class AcceptanceController {
  constructor(private readonly acceptance: AcceptanceService) {}

  @Get(':subjectType/:subjectId')
  @CanRole(['boss', 'admin'])
  overview(
    @Param('subjectType') subjectType: string,
    @Param('subjectId') subjectId: string,
  ): Promise<AcceptanceOverviewResponse> {
    const type: AcceptanceSubjectType = subjectType === 'task' ? 'task' : 'work_order';
    return this.acceptance.overview(type, subjectId);
  }

  @Post('records')
  @CanRole(['boss', 'admin'])
  async create(
    @Req() req: Request,
    @Body() dto: AcceptanceRecordCreateDto,
  ): Promise<AcceptanceRecordResponse> {
    return { record: await this.acceptance.createRecord(operatorOf(req), dto) };
  }

  @Post('records/:id/state')
  @CanRole(['boss', 'admin'])
  async changeState(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AcceptanceRecordStateDto,
  ): Promise<AcceptanceRecordResponse> {
    return {
      record: await this.acceptance.changeApprovalState(operatorOf(req), id, dto),
    };
  }
}
