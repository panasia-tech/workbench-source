import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

import type {
  AdminWorkOrderCreateRequest,
  CreateWorkOrderRequest,
  SubmitEvidenceRequest,
  WorkOrderHandoverRequest,
  WorkOrderSubject,
  WorkOrderTransitionRequest,
} from '@shared/api.interface';
import { WORK_ORDER_PRIORITIES } from './dispatch-fields';
import {
  WORK_ORDER_BUSINESS_LINES,
  WORK_ORDER_SUBJECT_KINDS,
  WORK_ORDER_SUBJECTS_MAX,
} from './workorder-fields';

const BUSINESS_LINE_MESSAGE = '业务线只能是 used_goods（二手实物）/ virtual_goods（虚拟商品）/ tech_service（技术服务）';

export class WorkOrderSubjectDto implements WorkOrderSubject {
  @IsString()
  @IsIn(WORK_ORDER_SUBJECT_KINDS, {
    message: '对象种类只能是 product / peer / customer / study / erp_doc / other',
  })
  kind!: 'product' | 'peer' | 'customer' | 'study' | 'erp_doc' | 'other';

  @IsString()
  @IsNotEmpty({ message: '关联对象要有名字' })
  name!: string;

  @IsOptional()
  @IsString()
  ref?: string;
}

export class AdminWorkOrderCreateDto implements AdminWorkOrderCreateRequest {
  @IsString()
  @IsNotEmpty({ message: '请输入工单标题' })
  title!: string;

  @IsString()
  @IsNotEmpty({ message: '请选择工单种类' })
  catalogCode!: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsBoolean({ message: 'saveAsDraft 必须为布尔值' })
  saveAsDraft!: boolean;

  // 与 shared WorkOrderSource 的 5 个字面量完全一致
  @IsOptional()
  @IsString()
  @IsIn(['manual', 'webhook', 'ai', 'auto_event', 'mcp'])
  source?: 'manual' | 'webhook' | 'ai' | 'auto_event' | 'mcp';

  // 与 shared WorkOrderPriority 的 4 个字面量一致；不传按普通（medium），写进 Plane 任务卡 priority
  @IsOptional()
  @IsString()
  @IsIn(WORK_ORDER_PRIORITIES, {
    message: 'priority 只能是 urgent / high / medium / low',
  })
  priority?: 'urgent' | 'high' | 'medium' | 'low';

  // 当天截止时刻，拼进标题「HH:mm前」；格式细节（全角冒号、补零、是否已过）在服务里统一处理
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d{1,2}[:：]\d{2}\s*$/u, {
    message: 'deadlineTime 格式为 HH:mm（24 小时制，如 18:00）',
  })
  deadlineTime?: string;

  // 跨天的活给截止日期（YYYY-MM-DD），不传 = 当天；细节校验在 resolveDispatchFields
  @IsOptional()
  @IsString()
  deadlineDate?: string;

  @IsOptional()
  @IsIn(WORK_ORDER_BUSINESS_LINES, { message: BUSINESS_LINE_MESSAGE })
  businessLine?: 'used_goods' | 'virtual_goods' | 'tech_service';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORK_ORDER_SUBJECTS_MAX, { message: '关联对象最多 10 个' })
  @ValidateNested({ each: true })
  @Type(() => WorkOrderSubjectDto)
  subjects?: WorkOrderSubjectDto[];
}

export class CreateWorkOrderDto implements CreateWorkOrderRequest {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  catalogCode!: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsObject()
  contactBossFields?: CreateWorkOrderRequest['contactBossFields'];

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsIn(WORK_ORDER_BUSINESS_LINES, { message: BUSINESS_LINE_MESSAGE })
  businessLine?: 'used_goods' | 'virtual_goods' | 'tech_service';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORK_ORDER_SUBJECTS_MAX, { message: '关联对象最多 10 个' })
  @ValidateNested({ each: true })
  @Type(() => WorkOrderSubjectDto)
  subjects?: WorkOrderSubjectDto[];
}

/** 转交：已做了什么、下一步、材料（文字或链接至少一样）都要写 */
export class WorkOrderHandoverDto implements WorkOrderHandoverRequest {
  @IsString()
  @IsNotEmpty({ message: '请选接手人' })
  toUserId!: string;

  @IsString()
  done!: string;

  @IsString()
  next!: string;

  @IsOptional()
  @IsString()
  materials?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20, { message: '材料链接最多 20 个' })
  materialUrls?: string[];
}

class EvidenceItemDto {
  @IsString()
  @IsNotEmpty()
  itemKey!: string;

  @IsArray()
  @IsString({ each: true })
  fileUrls!: string[];

  @IsOptional()
  @IsString()
  note?: string;
}

export class SubmitEvidenceDto implements SubmitEvidenceRequest {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvidenceItemDto)
  items!: EvidenceItemDto[];
}

export class WorkOrderTransitionDto implements WorkOrderTransitionRequest {
  // 与 shared WorkOrderTransitionKind 的 5 个字面量完全一致
  @IsString()
  @IsIn([
    'start',
    'revoke_submit',
    'resubmit',
    'confirm_review',
    'return_revision',
  ])
  action!:
    | 'start'
    | 'revoke_submit'
    | 'resubmit'
    | 'confirm_review'
    | 'return_revision';

  @IsOptional()
  @IsString()
  comment?: string;
}
