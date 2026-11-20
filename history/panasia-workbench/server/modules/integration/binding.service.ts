import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { employeeBindings } from '@server/database/schema';
import type {
  EmployeeBinding,
  EmployeeRole,
  UpdateBindingRequest,
} from '@shared/api.interface';

export interface BindingUpsertData extends UpdateBindingRequest {
  planeMemberName?: string | null;
}

@Injectable()
export class BindingService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getBinding(userId: string): Promise<EmployeeBinding | null> {
    const rows = await this
      .db.select()
      .from(employeeBindings)
      .where(eq(employeeBindings.miaodaUserId, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      planeMemberId: row.planeMemberId,
      planeMemberName: row.planeMemberName,
      role: row.role as EmployeeRole,
      frappeEmployeeId: row.frappeEmployeeId,
    };
  }

  async upsertBinding(
    userId: string,
    data: BindingUpsertData,
  ): Promise<EmployeeBinding> {
    const values = {
      miaodaUserId: userId,
      planeMemberId: data.planeMemberId,
      planeMemberName: data.planeMemberName ?? null,
      role: data.role,
      frappeEmployeeId: data.frappeEmployeeId ?? null,
    };
    await this
      .db.insert(employeeBindings)
      .values(values)
      .onConflictDoUpdate({
        target: employeeBindings.miaodaUserId,
        set: {
          planeMemberId: values.planeMemberId,
          planeMemberName: values.planeMemberName,
          role: values.role,
          frappeEmployeeId: values.frappeEmployeeId,
          updatedAt: new Date(),
        },
      });
    return {
      planeMemberId: values.planeMemberId,
      planeMemberName: values.planeMemberName,
      role: values.role,
      frappeEmployeeId: values.frappeEmployeeId,
    };
  }
}
