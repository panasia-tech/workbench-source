import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { BlockDeferVerdictRequest } from '@shared/api.interface';

export class BlockDeferVerdictDto implements BlockDeferVerdictRequest {
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
