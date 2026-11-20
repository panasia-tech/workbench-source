import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';

import { TutorialAssignService } from '@server/modules/profile/tutorial-assign.service';
import type {
  TutorialCaseAdminItem,
  TutorialCaseAdminListResponse,
  TutorialCaseAssignRequest,
} from '@shared/api.interface';

class TutorialCaseAssignDto implements TutorialCaseAssignRequest {
  @IsString()
  @IsNotEmpty({ message: '请选择教程' })
  @MaxLength(140)
  lmsCourse!: string;

  @IsString()
  @IsNotEmpty({ message: '请选择员工' })
  @MaxLength(64)
  ownerUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientName?: string;
}

/** 管理端 · 给员工分配教程（开案例）：boss / admin；同一人同一教程同一对象只能有一个进行中的 */
@Controller('api/admin/tutorial-cases')
export class TutorialCasesController {
  constructor(private readonly assignService: TutorialAssignService) {}

  @Get()
  @CanRole(['boss', 'admin'])
  list(
    @Query('lmsCourse') lmsCourse: string | undefined,
    @Query('status') status: string | undefined,
  ): Promise<TutorialCaseAdminListResponse> {
    return this.assignService.list({ lmsCourse, status });
  }

  @Post()
  @CanRole(['boss', 'admin'])
  assign(
    @Req() req: Request,
    @Body() dto: TutorialCaseAssignDto,
  ): Promise<TutorialCaseAdminItem> {
    return this.assignService.assign(String(req.userContext.userId), dto);
  }

  @Post(':caseId/cancel')
  @CanRole(['boss', 'admin'])
  cancel(
    @Req() req: Request,
    @Param('caseId', ParseIntPipe) caseId: number,
  ): Promise<TutorialCaseAdminItem> {
    return this.assignService.cancel(String(req.userContext.userId), caseId);
  }
}
