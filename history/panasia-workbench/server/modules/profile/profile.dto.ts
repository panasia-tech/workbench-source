import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import type {
  SubmitTutorialStepRequest,
  UpdateBindingRequest,
} from '@shared/api.interface';

export class SubmitTutorialStepDto implements SubmitTutorialStepRequest {
  @IsObject()
  data!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}


export class UpdateBindingDto implements UpdateBindingRequest {
  @IsString()
  planeMemberId!: string;

  @IsIn(['procurement', 'sales', 'warehouse', 'general', 'admin'])
  role!:
    | 'procurement'
    | 'sales'
    | 'warehouse'
    | 'general'
    | 'admin';

  @IsOptional()
  @IsString()
  frappeEmployeeId?: string | null;
}
