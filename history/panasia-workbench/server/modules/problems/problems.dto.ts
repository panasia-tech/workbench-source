import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  BlockerCategory,
  BlockerSeverity,
  ProblemPoolActionRequest,
  SubmitBlockerRequest,
  UpdateImprovementStageRequest,
} from '@shared/api.interface';

const BLOCKER_CATEGORIES = [
  'tool',
  'system',
  'permission',
  'process',
  'external_supplier',
  'logistics',
  'customer',
  'resource',
  'knowledge',
  'coordination',
  'quality',
  'policy',
  'finance',
  'data',
  'other',
] as const;

const BLOCKER_SEVERITIES = ['normal', 'high', 'critical'] as const;

const POOL_ACTIONS = [
  'confirm',
  'dismiss',
  'flag',
  'unflag',
  'ack',
  'reject',
] as const;

const IMPROVEMENT_STAGES = [
  'define',
  'root_cause',
  'design',
  'implement',
  'verify',
  'standardize',
  'observe',
  'closed',
] as const;

export class SubmitBlockerDto implements SubmitBlockerRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(BLOCKER_CATEGORIES)
  category!:
    | 'tool'
    | 'system'
    | 'permission'
    | 'process'
    | 'external_supplier'
    | 'logistics'
    | 'customer'
    | 'resource'
    | 'knowledge'
    | 'coordination'
    | 'quality'
    | 'policy'
    | 'finance'
    | 'data'
    | 'other';

  @IsOptional()
  @IsIn(BLOCKER_SEVERITIES)
  severity!: 'normal' | 'high' | 'critical';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taskId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  lossHours?: number;
}

export class ProblemPoolActionDto implements ProblemPoolActionRequest {
  @IsIn(POOL_ACTIONS)
  action!:
    | 'confirm'
    | 'dismiss'
    | 'flag'
    | 'unflag'
    | 'ack'
    | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}

export class UpdateImprovementStageDto
  implements UpdateImprovementStageRequest
{
  @IsIn(IMPROVEMENT_STAGES)
  stage!:
    | 'define'
    | 'root_cause'
    | 'design'
    | 'implement'
    | 'verify'
    | 'standardize'
    | 'observe'
    | 'closed';
}
