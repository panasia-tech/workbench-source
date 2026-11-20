import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';

import { TutorialReviewService } from './tutorial-review.service';
import type {
  TutorialReviewListResponse,
  TutorialReviewVerdictRequest,
  TutorialReviewVerdictResponse,
} from '@shared/api.interface';

class TutorialReviewVerdictDto implements TutorialReviewVerdictRequest {
  @IsString()
  @IsIn(['approved', 'rejected'])
  action!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  comment?: string;
}

@Controller('api/admin/tutorial-review')
export class TutorialReviewController {
  constructor(private readonly tutorialReviewService: TutorialReviewService) {}

  @Get('pending')
  @CanRole(['boss', 'admin'])
  listPending(): Promise<TutorialReviewListResponse> {
    return this.tutorialReviewService.listPending();
  }

  @Post(':submissionId/verdict')
  @CanRole(['boss', 'admin'])
  submitVerdict(
    @Req() req: Request,
    @Param('submissionId', ParseIntPipe) submissionId: number,
    @Body() dto: TutorialReviewVerdictDto,
  ): Promise<TutorialReviewVerdictResponse> {
    return this.tutorialReviewService.submitVerdict(
      req.userContext.userId,
      submissionId,
      dto,
    );
  }
}
