import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';

import { AdminCoordinationService } from './admin-coordination.service';
import { BlockDeferService } from './block-defer.service';
import { BlockDeferVerdictDto } from './admin-defer.dto';
import { todayDateString } from '../integration/plane-mapping';
import type {
  AdminDayActivityResponse,
  AdminExecuteMembersResponse,
  AdminMemberDetailResponse,
  AdminTaskCoordinationResponse,
  BlockDeferReviewResponse,
} from '@shared/api.interface';

/** 管理端 · 任务统筹与执行 Dock（boss）：员工槽位、员工详情四视图、顺延审核与终审 */
@Controller('api/admin/tasks')
export class AdminCoordinationController {
  constructor(
    private readonly coordinationService: AdminCoordinationService,
    private readonly blockDeferService: BlockDeferService,
  ) {}

  @Get('coordination')
  @CanRole(['boss'])
  getCoordination(): Promise<AdminTaskCoordinationResponse> {
    return this.coordinationService.getCoordination();
  }

  /** 执行 Dock 改版：员工槽位卡片列表 */
  @Get('execute-members')
  @CanRole(['boss'])
  getExecuteMembers(): Promise<AdminExecuteMembersResponse> {
    return this.coordinationService.getExecuteMembers();
  }

  /** 按日期看：date=YYYY-MM-DD（上海时区，缺省今天），当天每人完成 / 截止 / 提交堵塞的任务 */
  @Get('day-activity')
  @CanRole(['boss'])
  getDayActivity(
    @Query('date') date?: string,
  ): Promise<AdminDayActivityResponse> {
    const day = date?.trim() || todayDateString();
    const parsed = new Date(`${day}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day
    ) {
      throw new BadRequestException('date 格式应为 YYYY-MM-DD');
    }
    return this.coordinationService.getDayActivity(day);
  }

  /** 员工详情四视图：今日任务 / 在途堵塞与顺延 / 历史完成 / 计划模式 */
  @Get('execute-members/:userId')
  @CanRole(['boss'])
  getMemberDetail(
    @Param('userId') userId: string,
  ): Promise<AdminMemberDetailResponse> {
    return this.coordinationService.getMemberDetail(userId);
  }

  /** 顺延审核列表：AI 初审中 + 待老板终审 */
  @Get('block-defers')
  @CanRole(['boss'])
  async listBlockDefers(): Promise<BlockDeferReviewResponse> {
    return { items: await this.blockDeferService.listForReview() };
  }

  /** 老板终审顺延：approve=批准并改写任务截止时刻，reject=拒绝 */
  @Post('block-defers/:id/verdict')
  @CanRole(['boss'])
  verdictBlockDefer(
    @Param('id') id: string,
    @Body() dto: BlockDeferVerdictDto,
  ) {
    return this.blockDeferService.bossVerdict(id, dto.action, dto.comment);
  }
}
