import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { CanRole, NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import {
  TutorialSkipService,
  type SkipUserContextLike,
} from './tutorial-skip.service';
import { TutorialSkipVerdictDto } from './tutorial-skip.dto';
import type {
  TutorialSkipReviewItem,
  TutorialSkipReviewListResponse,
} from '@shared/api.interface';

/** 管理端 · 教程步骤跳过申请审核（boss）：队列查看 + 通过/拒绝终审 */
@Controller('api/admin/tutorial-skips')
export class TutorialSkipAdminController {
  constructor(private readonly tutorialSkipService: TutorialSkipService) {}

  @CanRole(['boss'])
  @Get()
  listSkipRequests(
    @Req() req: Request,
    @Query('status') status: string | undefined,
  ): Promise<TutorialSkipReviewListResponse> {
    return this.tutorialSkipService.listForReview(
      status,
      this.contextOf(req),
    );
  }

  @CanRole(['boss'])
  @NeedLogin()
  @Post(':id/verdict')
  verdictSkipRequest(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: TutorialSkipVerdictDto,
  ): Promise<TutorialSkipReviewItem> {
    return this.tutorialSkipService.bossVerdict(
      id,
      dto.action,
      dto.comment,
      req.userContext.userId,
      this.contextOf(req),
    );
  }

  private contextOf(req: Request): SkipUserContextLike {
    return {
      userId: req.userContext.userId,
      appId: req.userContext.appId,
    };
  }
}
