import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import type {
  CreateHostedCustomerRequest,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';

/** hosted_customers.started_at 为 date 列，契约约定 YYYY-MM-DD 字符串 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** 主邮箱必须是腾讯邮箱：运营商邮箱随号码停用有失效风险 */
const TENCENT_MAIL_PATTERN = /@(qq\.com|foxmail\.com)$/u;
const TENCENT_MAIL_MESSAGE =
  '主邮箱请使用腾讯邮箱（@qq.com / @foxmail.com），运营商邮箱有停用风险';

export class CreateHostedCustomerDto implements CreateHostedCustomerRequest {
  @IsString()
  @MaxLength(200)
  customerName!: string;

  @IsIn(['enterprise_alipay', 'xianyu', 'phone_card', 'other'])
  dimension!: 'enterprise_alipay' | 'xianyu' | 'phone_card' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  legalPersonName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  mainDevicePhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(TENCENT_MAIL_PATTERN, { message: TENCENT_MAIL_MESSAGE })
  mainEmail?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsIn(['hosting', 'paused', 'returned'])
  status?: 'hosting' | 'paused' | 'returned';

  /** 管理端可指定；员工端由服务端固定为本人，忽略此字段 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  ownerUserId?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'startedAt 需为 YYYY-MM-DD 格式' })
  startedAt?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateHostedCustomerDto implements UpdateHostedCustomerRequest {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @IsOptional()
  @IsIn(['enterprise_alipay', 'xianyu', 'phone_card', 'other'])
  dimension?: 'enterprise_alipay' | 'xianyu' | 'phone_card' | 'other';

  /** null 表示清空，undefined 表示不改 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string | null;

  /** null 表示清空，undefined 表示不改 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  legalPersonName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  mainDevicePhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(TENCENT_MAIL_PATTERN, { message: TENCENT_MAIL_MESSAGE })
  mainEmail?: string | null;

  @IsOptional()
  @IsString()
  content?: string | null;

  @IsOptional()
  @IsIn(['hosting', 'paused', 'returned'])
  status?: 'hosting' | 'paused' | 'returned';

  /** 仅管理端生效；员工端忽略（不可转交自己的档案） */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  ownerUserId?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: 'startedAt 需为 YYYY-MM-DD 格式或 null' })
  startedAt?: string | null;

  @IsOptional()
  @IsString()
  remark?: string | null;
}
