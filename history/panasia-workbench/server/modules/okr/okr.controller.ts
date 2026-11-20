import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { CanRole } from '@lark-apaas/fullstack-nestjs-core';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';

import { OkrService } from './okr.service';
import type {
  AdminOkrListResponse,
  OkrKeyResultCreateRequest,
  OkrKeyResultPatchRequest,
  OkrMutationResponse,
  OkrObjectiveCreateRequest,
  OkrObjectivePatchRequest,
} from '@shared/api.interface';

export class OkrObjectiveCreateDto implements OkrObjectiveCreateRequest {
  @IsString()
  @IsNotEmpty()
  period!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;
}

export class OkrObjectivePatchDto implements OkrObjectivePatchRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  @IsIn(['on_track', 'at_risk', 'behind', 'completed'])
  status!: 'on_track' | 'at_risk' | 'behind' | 'completed';

  @IsOptional()
  @IsInt()
  sort?: number;
}

export class OkrKeyResultCreateDto implements OkrKeyResultCreateRequest {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  unit?: string | null;

  @IsOptional()
  @IsString()
  targetValue?: string;
}

export class OkrKeyResultPatchDto implements OkrKeyResultPatchRequest {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  unit?: string | null;

  @IsOptional()
  @IsString()
  targetValue?: string;

  @IsOptional()
  @IsString()
  currentValue?: string;
}

@Controller('api/admin/okr')
export class OkrController {
  constructor(private readonly okrService: OkrService) {}

  @Get()
  @CanRole(['boss', 'admin'])
  list(): Promise<AdminOkrListResponse> {
    return this.okrService.list();
  }

  @Post('objectives')
  @CanRole(['boss', 'admin'])
  createObjective(
    @Req() req: Request,
    @Body() dto: OkrObjectiveCreateDto,
  ): Promise<OkrMutationResponse> {
    return this.okrService.createObjective(req.userContext.userId, dto);
  }

  @Patch('objectives/:id')
  @CanRole(['boss', 'admin'])
  patchObjective(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: OkrObjectivePatchDto,
  ): Promise<OkrMutationResponse> {
    return this.okrService.patchObjective(req.userContext.userId, id, dto);
  }

  @Delete('objectives/:id')
  @CanRole(['boss', 'admin'])
  deleteObjective(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<OkrMutationResponse> {
    return this.okrService.deleteObjective(req.userContext.userId, id);
  }

  @Post('objectives/:objectiveId/key-results')
  @CanRole(['boss', 'admin'])
  createKeyResult(
    @Req() req: Request,
    @Param('objectiveId') objectiveId: string,
    @Body() dto: OkrKeyResultCreateDto,
  ): Promise<OkrMutationResponse> {
    return this.okrService.createKeyResult(
      req.userContext.userId,
      objectiveId,
      dto,
    );
  }

  @Patch('key-results/:id')
  @CanRole(['boss', 'admin'])
  patchKeyResult(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: OkrKeyResultPatchDto,
  ): Promise<OkrMutationResponse> {
    return this.okrService.patchKeyResult(req.userContext.userId, id, dto);
  }

  @Delete('key-results/:id')
  @CanRole(['boss', 'admin'])
  deleteKeyResult(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<OkrMutationResponse> {
    return this.okrService.deleteKeyResult(req.userContext.userId, id);
  }
}
