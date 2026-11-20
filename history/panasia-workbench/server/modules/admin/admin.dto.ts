import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import type {
  AdminCatalogUpsertRequest,
  QuickTaskCreateRequest,
  QuickTaskDraftRequest,
  TutorialAuthoringCreateRequest,
  TutorialAuthoringMaterialInput,
  TutorialAuthoringStageInput,
  TutorialAuthoringStepInput,
  UpdateSystemConfigRequest,
  WorkOrderChecklistItem,
} from '@shared/api.interface';

export class QuickTaskDraftDto implements QuickTaskDraftRequest {
  @IsString()
  @IsNotEmpty({ message: '请输入一句话需求' })
  input!: string;
}

export class QuickTaskCreateDto implements QuickTaskCreateRequest {
  @IsString()
  @IsNotEmpty({ message: '任务标题不能为空' })
  title!: string;

  @IsString()
  @IsNotEmpty({ message: '请选择所属项目' })
  projectId!: string;

  @IsOptional()
  @IsString()
  assigneeMemberId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u, { message: '截止日期格式应为 YYYY-MM-DD' })
  dueDate?: string;
}

export class UpdateSystemConfigDto implements UpdateSystemConfigRequest {
  @IsString()
  @IsNotEmpty({ message: '配置键不能为空' })
  configKey!: string;

  @IsObject({ message: '配置值必须为对象' })
  configValue!: Record<string, unknown>;
}

export class WorkOrderChecklistItemDto implements WorkOrderChecklistItem {
  @IsString()
  @IsNotEmpty({ message: '检查项 key 不能为空' })
  key!: string;

  @IsString()
  @IsNotEmpty({ message: '检查项名称不能为空' })
  name!: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsString()
  type?: string;

  // 要人到现场做的项，员工端单独标出（11-10 A01）
  @IsOptional()
  @IsBoolean()
  onSite?: boolean;
}

export class AdminTutorialMaterialDto implements TutorialAuthoringMaterialInput {
  @IsString()
  @IsNotEmpty({ message: '材料名称不能为空' })
  label!: string;

  @IsString()
  @IsIn(
    ['text', 'textarea', 'number', 'select', 'date', 'image', 'video', 'file'],
    { message: '材料类型不合法' },
  )
  inputType!:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'date'
    | 'image'
    | 'video'
    | 'file';

  @IsBoolean()
  required!: boolean;

  @IsOptional()
  @IsString()
  helpText?: string;
}

export class AdminTutorialStepDto implements TutorialAuthoringStepInput {
  @IsString()
  @IsNotEmpty({ message: '步骤标题不能为空' })
  title!: string;

  @IsOptional()
  @IsString()
  guide?: string;

  @IsOptional()
  @IsString()
  warnText?: string;

  @IsOptional()
  @IsString()
  deliverNote?: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;

  @IsBoolean()
  requireConfirm!: boolean;

  @IsBoolean()
  requireReview!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTutorialMaterialDto)
  materials!: AdminTutorialMaterialDto[];
}

export class AdminTutorialStageDto implements TutorialAuthoringStageInput {
  @IsString()
  @IsNotEmpty({ message: '阶段标题不能为空' })
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  durationNote?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTutorialStepDto)
  steps!: AdminTutorialStepDto[];
}

export class AdminTutorialCreateDto implements TutorialAuthoringCreateRequest {
  @IsString()
  @IsNotEmpty({ message: '教程名称不能为空' })
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTutorialStageDto)
  stages!: AdminTutorialStageDto[];
}

export class AdminCatalogUpsertDto implements AdminCatalogUpsertRequest {
  @IsString()
  @IsNotEmpty({ message: '目录编码不能为空' })
  code!: string;

  @IsString()
  @IsNotEmpty({ message: '目录名称不能为空' })
  name!: string;

  @IsString()
  @IsIn(['purchase', 'sales', 'special_delegation', 'other'], {
    message: '任务类型不合法',
  })
  orderType!: 'purchase' | 'sales' | 'special_delegation' | 'other';

  @IsString()
  @IsIn(['simple', 'medium', 'complex'], { message: '复杂度不合法' })
  complexity!: 'simple' | 'medium' | 'complex';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkOrderChecklistItemDto)
  checklistTemplate?: WorkOrderChecklistItem[];

  @IsOptional()
  @IsIn(['used_goods', 'virtual_goods', 'tech_service', null], {
    message: '业务线只能是 used_goods / virtual_goods / tech_service',
  })
  businessLine?: 'used_goods' | 'virtual_goods' | 'tech_service' | null;

  @IsOptional()
  @IsString()
  promptTemplate?: string;

  @IsOptional()
  @IsString()
  erpAction?: string;

  @IsOptional()
  @IsObject({ message: '通知目标必须为对象' })
  notifyTargets?: { roles?: string[]; userIds?: string[] } | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  sort?: number;
}

/** shared 契约未定义 PATCH 请求体，按 AdminCatalogUpsertRequest 全字段可选实现 */
export class AdminCatalogPatchDto implements Partial<AdminCatalogUpsertRequest> {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '目录编码不能为空' })
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '目录名称不能为空' })
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['purchase', 'sales', 'special_delegation', 'other'], {
    message: '任务类型不合法',
  })
  orderType?: 'purchase' | 'sales' | 'special_delegation' | 'other';

  @IsOptional()
  @IsString()
  @IsIn(['simple', 'medium', 'complex'], { message: '复杂度不合法' })
  complexity?: 'simple' | 'medium' | 'complex';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkOrderChecklistItemDto)
  checklistTemplate?: WorkOrderChecklistItem[];

  @IsOptional()
  @IsIn(['used_goods', 'virtual_goods', 'tech_service', null], {
    message: '业务线只能是 used_goods / virtual_goods / tech_service',
  })
  businessLine?: 'used_goods' | 'virtual_goods' | 'tech_service' | null;

  @IsOptional()
  @IsString()
  promptTemplate?: string;

  @IsOptional()
  @IsString()
  erpAction?: string;

  @IsOptional()
  @IsObject({ message: '通知目标必须为对象' })
  notifyTargets?: { roles?: string[]; userIds?: string[] } | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  sort?: number;
}
