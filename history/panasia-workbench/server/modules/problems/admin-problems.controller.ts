import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';
import { ProblemsService, type UserContextLike } from './problems.service';
import {
  ProblemPoolActionDto,
  UpdateImprovementStageDto,
} from './problems.dto';
import type {
  BlockerListResponse,
  ImprovementProjectItem,
  ImprovementProjectsResponse,
  ProblemPoolActionResponse,
  ProblemPoolResponse,
} from '@shared/api.interface';

@Controller('api/admin/problems')
export class AdminProblemsController {
  constructor(private readonly problemsService: ProblemsService) {}

  @CanRole(['boss'])
  @Get('blockers')
  listBlockers(@Req() req: Request): Promise<BlockerListResponse> {
    return this.problemsService.listAllBlockers(this.contextOf(req));
  }

  @CanRole(['boss'])
  @Get('pool')
  getPool(@Req() req: Request): Promise<ProblemPoolResponse> {
    return this.problemsService.getPool(this.contextOf(req));
  }

  @CanRole(['boss'])
  @Post('pool/:id/action')
  poolAction(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ProblemPoolActionDto,
  ): Promise<ProblemPoolActionResponse> {
    return this.problemsService.poolAction(this.contextOf(req), id, dto);
  }

  @CanRole(['boss'])
  @Get('improvements')
  listImprovements(@Req() req: Request): Promise<ImprovementProjectsResponse> {
    return this.problemsService.listImprovements(this.contextOf(req));
  }

  @CanRole(['boss'])
  @Patch('improvements/:id/stage')
  updateStage(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateImprovementStageDto,
  ): Promise<ImprovementProjectItem> {
    return this.problemsService.updateStage(
      this.contextOf(req),
      id,
      dto.stage,
    );
  }

  private contextOf(req: Request): UserContextLike {
    return {
      userId: req.userContext.userId,
      appId: req.userContext.appId,
    };
  }
}
