import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  CanRole,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { count, desc } from 'drizzle-orm';

import { adminAuditLogs } from '@server/database/schema';
import { UserDirectoryService } from '../auth/user-directory.service';
import type {
  AdminAuditLogItem,
  AdminAuditLogListResponse,
} from '@shared/api.interface';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type AuditDetail = { summary?: string; changes?: Record<string, unknown> } | null;

type AuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  createdBy: string | null;
  createdAt: Date;
};

function toDetail(value: unknown): AuditDetail {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const detail: { summary?: string; changes?: Record<string, unknown> } = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'summary' && typeof val === 'string') {
      detail.summary = val;
    }
    if (
      key === 'changes' &&
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      detail.changes = Object.fromEntries(Object.entries(val));
    }
  }
  return detail;
}

@Controller('api/admin/audit-logs')
export class AuditLogController {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly userDirectory: UserDirectoryService,
  ) {}

  @Get()
  @CanRole(['boss', 'admin'])
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AdminAuditLogListResponse> {
    const parsedPage = page !== undefined ? Number.parseInt(page, 10) : NaN;
    const parsedPageSize =
      pageSize !== undefined ? Number.parseInt(pageSize, 10) : NaN;
    const currentPage =
      Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
    const requestedSize =
      Number.isFinite(parsedPageSize) && parsedPageSize >= 1
        ? parsedPageSize
        : DEFAULT_PAGE_SIZE;
    const currentPageSize = Math.min(requestedSize, MAX_PAGE_SIZE);

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(adminAuditLogs);

    const rows: AuditRow[] = await this.db
      .select({
        id: adminAuditLogs.id,
        action: adminAuditLogs.action,
        targetType: adminAuditLogs.targetType,
        targetId: adminAuditLogs.targetId,
        detail: adminAuditLogs.detail,
        createdBy: adminAuditLogs.createdBy,
        createdAt: adminAuditLogs.createdAt,
      })
      .from(adminAuditLogs)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(currentPageSize)
      .offset((currentPage - 1) * currentPageSize);

    // 操作人姓名在服务端回填（前端原来用平台通讯录组件查，独立部署后查不到）
    const operatorIds = [
      ...new Set(
        rows
          .map((row: AuditRow) => row.createdBy)
          .filter((id: string | null): id is string => Boolean(id)),
      ),
    ];
    const operators = await this.userDirectory
      .listUsersByIds(operatorIds)
      .catch(() => operatorIds.map(() => null));
    const operatorNames = new Map<string, string>();
    operators.forEach((user, index: number) => {
      if (user) operatorNames.set(operatorIds[index], user.name.zh_cn);
    });

    const items: AdminAuditLogItem[] = rows.map((row: AuditRow) => ({
      id: row.id,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: toDetail(row.detail),
      operatorUserId: row.createdBy,
      operatorName: row.createdBy ? (operatorNames.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      items,
      total,
      page: currentPage,
      pageSize: currentPageSize,
    };
  }
}
