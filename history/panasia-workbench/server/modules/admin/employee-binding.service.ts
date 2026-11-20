import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { employeeBindings } from '@server/database/schema';
import { PlaneService } from '../integration/plane.service';
import { FrappeService } from '../integration/frappe.service';
import type {
  AdminEmployeeBindingRow,
  AdminEmployeeBindingUpsertRequest,
  AdminEmployeeBindingUpsertResponse,
  BindingOption,
  BindingOptionsResponse,
  HrEmployee,
} from '@shared/api.interface';

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  display_name: string;
}

interface FrappeEmployeeRaw {
  name: string;
  employee_name: string;
  designation: string | null;
  department: string | null;
  status: string | null;
}

/** 管理端员工绑定代管：绑定选项（口径对齐 profile.service.getBindingOptions）+ upsert */
@Injectable()
export class EmployeeBindingService {
  private readonly logger = new Logger(EmployeeBindingService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly frappe: FrappeService,
  ) {}

  /** HR 雇员是可选项：Frappe 连不上时只给 Plane 成员，照样能绑 */
  async getOptions(): Promise<BindingOptionsResponse> {
    const members = await this.loadPlaneMembers();
    let employeesRaw: FrappeEmployeeRaw[] = [];
    try {
      employeesRaw = await this.frappe.list<FrappeEmployeeRaw>('Employee', {
        fields: ['name', 'employee_name', 'designation', 'department', 'status'],
      });
    } catch (error) {
      this.logger.warn(
        `读 Frappe 雇员失败，绑定选项只给 Plane 成员：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const employees: HrEmployee[] = employeesRaw.map(
      (e: FrappeEmployeeRaw) => ({
        id: e.name,
        name: e.employee_name,
        designation: e.designation ?? null,
        department: e.department ?? null,
        status: e.status ?? null,
      }),
    );
    return { members, employees };
  }

  private async loadPlaneMembers(): Promise<BindingOption[]> {
    const membersRes = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    return (Array.isArray(membersRes) ? membersRes : []).map((m: PlaneMemberRaw) => ({
      planeMemberId: m.id,
      planeMemberName: m.first_name || m.display_name || m.id,
    }));
  }

  async upsert(
    dto: AdminEmployeeBindingUpsertRequest,
  ): Promise<AdminEmployeeBindingUpsertResponse> {
    // 只核对 Plane 成员；HR 雇员由下拉选来，不为它去等 Frappe
    const members = await this.loadPlaneMembers();
    const member = members.find(
      (m: BindingOption) => m.planeMemberId === dto.planeMemberId,
    );
    if (!member) {
      throw new BadRequestException('所选 Plane 成员不存在，请刷新后重试');
    }
    const values = {
      miaodaUserId: dto.miaodaUserId,
      planeMemberId: dto.planeMemberId,
      planeMemberName: dto.planeMemberName,
      role: dto.role,
      frappeEmployeeId: dto.frappeEmployeeId ?? null,
      updatedAt: new Date(),
    };
    const rows = await this
      .db.insert(employeeBindings)
      .values(values)
      .onConflictDoUpdate({
        target: employeeBindings.miaodaUserId,
        set: {
          planeMemberId: values.planeMemberId,
          planeMemberName: values.planeMemberName,
          role: values.role,
          frappeEmployeeId: values.frappeEmployeeId,
          updatedAt: values.updatedAt,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new BadRequestException('员工绑定保存失败');
    }
    const item: AdminEmployeeBindingRow = {
      id: row.id,
      miaodaUserId: row.miaodaUserId,
      userName: null,
      planeMemberId: row.planeMemberId,
      planeMemberName: row.planeMemberName,
      role: row.role,
      frappeEmployeeId: row.frappeEmployeeId,
      nocobaseUserId: row.nocobaseUserId,
    };
    return { item };
  }
}
