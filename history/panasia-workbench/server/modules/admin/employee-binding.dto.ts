import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { AdminEmployeeBindingUpsertRequest } from '@shared/api.interface';

/** 管理端代管新建/编辑员工绑定（role 与 EmployeeRole 五值逐字对齐） */
export class AdminEmployeeBindingUpsertDto
  implements AdminEmployeeBindingUpsertRequest
{
  @IsString()
  @IsNotEmpty()
  miaodaUserId!: string;

  @IsString()
  @IsNotEmpty()
  planeMemberId!: string;

  @IsString()
  @IsNotEmpty()
  planeMemberName!: string;

  @IsString()
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
