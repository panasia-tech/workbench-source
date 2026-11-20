import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  SubmitTutorialSkipRequest,
  TutorialSkipVerdictRequest,
} from '@shared/api.interface';

export class SubmitTutorialSkipDto implements SubmitTutorialSkipRequest {
  @IsString()
  @MinLength(5)
  reason!: string;
}

export class TutorialSkipVerdictDto implements TutorialSkipVerdictRequest {
  @IsIn(['approve', 'reject'])
  action!: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
