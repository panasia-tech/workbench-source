import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  DEV_REQUESTS_DDL,
  DEV_REQUEST_EVENTS_DDL,
  DEV_REQUEST_LEDGER_DDL,
  devRequests,
} from '@server/database/standalone-schema';

export type DevRequestRow = typeof devRequests.$inferSelect;

/** 表还没建（启动时建表失败）：一条开发需求都不可能有，按「不是开发需求」放行 */
const UNDEFINED_TABLE = '42P01';

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

/**
 * 「这条 Plane 任务是不是开发需求」：任务卡通用按钮、验收 Dock、豆包审核工具、工单关联任务
 * 碰到开发需求都要先问这里，改走开发需求的流程或拒绝，不许绕过报价确认和验收。
 * 开发需求三张表也在这里启动时建（ensureStandaloneTable，幂等，自动给数据层三个角色授权，不用人工迁移）。
 */
@Injectable()
export class DevRequestLookupService implements OnModuleInit {
  private readonly logger = new Logger(DevRequestLookupService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    // 有外键，按顺序建：主表 → 事件 → 台账
    const ok = await ensureStandaloneTable(
      this.db,
      this.logger,
      'dev_requests',
      DEV_REQUESTS_DDL,
      '开发需求不可用',
    );
    if (!ok) return;
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'dev_request_events',
      DEV_REQUEST_EVENTS_DDL,
      '开发需求的事件历史写不进去',
    );
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'dev_request_ledger',
      DEV_REQUEST_LEDGER_DDL,
      '开发需求台账写不进去，验收会失败',
    );
  }

  async findById(id: string): Promise<DevRequestRow | null> {
    const rows: DevRequestRow[] = await this.db
      .select()
      .from(devRequests)
      .where(eq(devRequests.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 按 Plane 任务 ID 找开发需求；不是开发需求返回 null */
  async findByIssueId(issueId: string): Promise<DevRequestRow | null> {
    try {
      const rows: DevRequestRow[] = await this.db
        .select()
        .from(devRequests)
        .where(eq(devRequests.planeIssueId, issueId))
        .limit(1);
      return rows[0] ?? null;
    } catch (error) {
      if (postgresErrorCode(error) === UNDEFINED_TABLE) {
        this.logger.warn('dev_requests 表不存在（启动时建表失败？），按不是开发需求处理');
        return null;
      }
      throw error;
    }
  }

  /** 一批 Plane 任务 ID → 开发需求 ID（任务列表打标用，查不到的不在 Map 里；出错只记日志、不打标） */
  async idMapByIssueIds(issueIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(issueIds.filter((id: string) => Boolean(id)))];
    const result = new Map<string, string>();
    if (unique.length === 0) return result;
    try {
      const rows: { id: string; issueId: string }[] = await this.db
        .select({ id: devRequests.id, issueId: devRequests.planeIssueId })
        .from(devRequests)
        .where(inArray(devRequests.planeIssueId, unique));
      for (const row of rows) result.set(row.issueId, row.id);
    } catch (error) {
      this.logger.warn(
        `开发需求打标失败（任务列表照常显示）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return result;
  }
}
