import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { TaskReviewService } from './task-review.service';
import type {
  OpenApiTaskReviewApproveRequest,
  OpenApiTaskReviewApproveResult,
  OpenApiTaskReviewListResponse,
  OpenApiTaskReviewVerdictRequest,
  OpenApiTaskReviewVerdictResult,
} from '@shared/api.interface';

const VERDICT_VALUES = ['pass', 'revise'] as const;
const APPROVE_ACTIONS = ['approve', 'reject'] as const;

function requireTaskId(taskId: unknown): string {
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new BadRequestException('taskId 必填（Plane 任务 ID，来自 reviews 列表)');
  }
  return taskId.trim();
}

@Controller('openapi/task-review')
export class TaskReviewOpenApiController {
  constructor(private readonly review: TaskReviewService) {}

  @Get('reviews')
  async listReviews(
    @Query('taskId') taskId?: string,
  ): Promise<OpenApiTaskReviewListResponse> {
    const trimmed = taskId?.trim() || undefined;
    const items = await this.review.listPendingReviews(trimmed);
    return { items };
  }

  @Post('verdict')
  async writeVerdict(
    @Body() dto: OpenApiTaskReviewVerdictRequest,
  ): Promise<OpenApiTaskReviewVerdictResult> {
    const taskId = requireTaskId(dto?.taskId);
    const verdict = dto?.verdict;
    if (!VERDICT_VALUES.includes(verdict)) {
      throw new BadRequestException(
        `verdict 只能是 ${VERDICT_VALUES.join(' 或 ')}`,
      );
    }
    if (typeof dto.reason !== 'string') {
      throw new BadRequestException('reason 必填（审核意见一句话）');
    }
    return this.review.writeAiVerdict(taskId, verdict, dto.reason);
  }

  @Post('approve')
  async approve(
    @Body() dto: OpenApiTaskReviewApproveRequest,
  ): Promise<OpenApiTaskReviewApproveResult> {
    const taskId = requireTaskId(dto?.taskId);
    const action = dto?.action;
    if (!APPROVE_ACTIONS.includes(action)) {
      throw new BadRequestException(
        `action 只能是 ${APPROVE_ACTIONS.join(' 或 ')}`,
      );
    }
    const comment =
      typeof dto?.comment === 'string' ? dto.comment : undefined;
    return this.review.approveTask(taskId, action, comment);
  }
}
