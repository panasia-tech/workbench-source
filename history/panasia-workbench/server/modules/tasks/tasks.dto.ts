import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  TaskAssistRequest,
  TaskBlockRequest,
  TaskEvidenceRequest,
  TaskStatusUpdateRequest,
} from '@shared/api.interface';

const ALL_TASK_STATUSES = [
  'TODO',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'REJECTED',
  'DONE',
  'CANCELLED',
] as const;

export class TaskStatusUpdateDto implements TaskStatusUpdateRequest {
  @IsString()
  projectId!: string;

  @IsIn(ALL_TASK_STATUSES)
  status!:
    | 'TODO'
    | 'IN_PROGRESS'
    | 'WAITING'
    | 'BLOCKED'
    | 'READY_FOR_REVIEW'
    | 'REJECTED'
    | 'DONE'
    | 'CANCELLED';
}

export class TaskBlockDto implements TaskBlockRequest {
  @IsString()
  projectId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  waitingFor!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nextAction!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  resolution!: string;

  @IsOptional()
  @IsIn([
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
  ])
  category?: string;

  @IsOptional()
  @IsBoolean()
  deferRequested?: boolean;

  @IsOptional()
  @IsBoolean()
  deriveProblem?: boolean;
}

export class TaskEvidenceDto implements TaskEvidenceRequest {
  @IsString()
  projectId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  notes!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  links?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  materials?: string[];
}

export class TaskAssistDto implements TaskAssistRequest {
  @IsString()
  projectId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message!: string;
}
