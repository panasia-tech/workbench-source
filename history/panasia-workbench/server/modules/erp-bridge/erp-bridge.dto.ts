import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  ErpVerifyRequest,
  UpdateErpBindingRequest,
} from '@shared/api.interface';

export class UpdateErpBindingDto implements UpdateErpBindingRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  erpUserId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  erpUsername?: string;
}

export class ErpVerifyDto implements ErpVerifyRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  token!: string;
}
