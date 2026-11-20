import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import type { Request } from 'express';
import { ReviewService } from './review.service';
import type {
  ReviewPlaneTaskActionRequest,
  ReviewPlaneTaskActionResponse,
  ReviewPlaneTasksResponse,
  ReviewVerdictRequest,
  ReviewVerdictResponse,
  ReviewWorkOrdersResponse,
} from '@shared/api.interface';

export class ReviewVerdictDto implements ReviewVerdictRequest {
  // 与 shared ReviewVerdictRequest.result 的 3 个字面量完全一致；refused / returned 要写 comment
  @IsString()
  @IsIn(['approved', 'refused', 'returned'])
  result!: 'approved' | 'refused' | 'returned';

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsNumber()
  performanceAmount?: number;
}

export class ReviewPlaneTaskActionDto implements ReviewPlaneTaskActionRequest {
  // 与 shared ReviewPlaneTaskActionRequest.action 的 2 个字面量完全一致
  @IsString()
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  // 打回必填
  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

@Controller('api/admin/review')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}

  @Get('work-orders')
  @CanRole(['boss'])
  listWorkOrders(
    @Req() req: Request,
  ): Promise<ReviewWorkOrdersResponse> {
    return this.reviewService.listWorkOrders(req.userContext);
  }

  @Post('work-orders/:id/verdict')
  @CanRole(['boss'])
  submitVerdict(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ReviewVerdictDto,
  ): Promise<ReviewVerdictResponse> {
    return this.reviewService.submitVerdict(req.userContext, id, dto);
  }

  @Get('plane-tasks')
  @CanRole(['boss'])
  listPlaneTasks(): Promise<ReviewPlaneTasksResponse> {
    return this.reviewService.listPlaneTasks();
  }

  @Post('plane-tasks/:taskId/action')
  @CanRole(['boss'])
  planeTaskAction(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() dto: ReviewPlaneTaskActionDto,
  ): Promise<ReviewPlaneTaskActionResponse> {
    return this.reviewService.planeTaskAction(req.userContext, taskId, dto);
  }
}
