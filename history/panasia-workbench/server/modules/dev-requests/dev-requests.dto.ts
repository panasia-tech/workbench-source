import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  CreateDevRequestRequest,
  DevRequestAcceptRequest,
  DevRequestClarifyRequest,
  DevRequestDeliverRequest,
  DevRequestQuoteRequest,
  DevRequestReasonRequest,
} from '@shared/api.interface';

// 这里只卡类型和上限；必填、长度下限、金额两位小数、日期这些在服务层查，报错是中文原话

export class CreateDevRequestDto implements CreateDevRequestRequest {
  @IsString()
  @MaxLength(64)
  projectId!: string;

  @IsString()
  @MaxLength(64)
  developerId!: string;

  @IsString()
  @MaxLength(500)
  title!: string;

  @IsString()
  @MaxLength(20000)
  description!: string;

  @IsString()
  @MaxLength(2000)
  acceptance!: string;
}

export class DevRequestQuoteDto implements DevRequestQuoteRequest {
  @IsNumber()
  hours!: number;

  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  promisedDate?: string;
}

export class DevRequestReasonDto implements DevRequestReasonRequest {
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class DevRequestClarifyDto implements DevRequestClarifyRequest {
  @IsString()
  @MaxLength(20000)
  description!: string;

  @IsString()
  @MaxLength(2000)
  acceptance!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class DevRequestDeliverDto implements DevRequestDeliverRequest {
  @IsString()
  @MaxLength(5000)
  note!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  links?: string[];
}

export class DevRequestAcceptDto implements DevRequestAcceptRequest {
  @IsOptional()
  @IsNumber()
  finalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adjustReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
