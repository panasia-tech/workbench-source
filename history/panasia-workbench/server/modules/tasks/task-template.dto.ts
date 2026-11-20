import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class ScheduleDto {
  @IsIn(['every_day', 'workdays', 'weekly'])
  kind!: 'every_day' | 'workdays' | 'weekly';

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];
}

export class TaskTemplateUpsertDto {
  @IsString()
  title!: string;

  @IsIn(['daily', 'scheduled'])
  templateType!: 'daily' | 'scheduled';

  @IsObject()
  @ValidateNested()
  @Type(() => ScheduleDto)
  schedule!: ScheduleDto;

  @IsString()
  planeProjectId!: string;

  @IsString()
  planeProjectName!: string;

  @IsOptional()
  @IsString()
  assigneeMemberId?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  enabled?: boolean;
}
