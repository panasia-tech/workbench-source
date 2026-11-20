import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';

import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import { workOrders } from '@server/database/schema';
import {
  ACCEPTANCE_RECORDS_DDL,
  SUBMISSION_VERSIONS_DDL,
  acceptanceRecords,
  submissionVersions,
} from '@server/database/standalone-schema';
import type {
  AcceptanceDecision,
  AcceptanceOverviewResponse,
  AcceptanceRecordCreateRequest,
  AcceptanceRecordKind,
  AcceptanceRecordStateRequest,
  AcceptanceRecordView,
  AcceptanceSubjectType,
  BusinessApprovalState,
  SubmissionVersionView,
} from '@shared/api.interface';

type VersionRow = typeof submissionVersions.$inferSelect;
type RecordRow = typeof acceptanceRecords.$inferSelect;

/** 事务或库本身都行：工单交凭证在事务里记版本 */
export type AcceptanceExecutor = Pick<PostgresJsDatabase, 'select' | 'insert'>;

export interface SubmissionItem {
  name: string;
  fileUrls: string[];
  note: string | null;
}

export interface AcceptanceOperator {
  userId: string | null;
  userName: string | null;
}

const SUBJECT_TYPES: readonly AcceptanceSubjectType[] = ['work_order', 'task'];
const RECORD_KINDS: readonly AcceptanceRecordKind[] = [
  'review',
  'research_pass',
  'business_approval',
  'listing_confirm',
];
const DECISIONS: readonly AcceptanceDecision[] = ['approved', 'returned', 'refused'];
const APPROVAL_STATES: readonly BusinessApprovalState[] = ['active', 'paused', 'exited'];

/** 详情里带的版本数上限（更早的不列，库里都在） */
const VERSION_LIST_LIMIT = 20;
const TEXT_MAX = 2000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const KIND_LABELS: Record<AcceptanceRecordKind, string> = {
  review: '验收',
  research_pass: '研究通过',
  business_approval: '经营批准',
  listing_confirm: '上架确认',
};

function pick<T extends string>(values: readonly T[], value: unknown): T | null {
  return values.find((item: T) => item === value) ?? null;
}

function cleanText(value: unknown, max = TEXT_MAX): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseItems(content: unknown): SubmissionItem[] {
  if (!isRecord(content) || !Array.isArray(content.items)) return [];
  const items: SubmissionItem[] = [];
  for (const raw of content.items) {
    if (!isRecord(raw) || typeof raw.name !== 'string') continue;
    items.push({
      name: raw.name,
      fileUrls: Array.isArray(raw.fileUrls)
        ? raw.fileUrls.filter((url: unknown): url is string => typeof url === 'string')
        : [],
      note: typeof raw.note === 'string' ? raw.note : null,
    });
  }
  return items;
}

function parseHistory(value: unknown): AcceptanceRecordView['history'] {
  if (!Array.isArray(value)) return [];
  const list: AcceptanceRecordView['history'] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.action !== 'string' || typeof raw.at !== 'string') {
      continue;
    }
    list.push({
      action: raw.action,
      at: raw.at,
      by: typeof raw.by === 'string' ? raw.by : null,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
    });
  }
  return list;
}

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

export function toVersionView(row: VersionRow): SubmissionVersionView {
  const summary = row.summary;
  return {
    id: row.id,
    version: row.version,
    items: parseItems(row.content),
    summary: summary !== null && summary !== '' ? summary : null,
    submittedBy: row.submittedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRecordView(row: RecordRow): AcceptanceRecordView {
  return {
    id: row.id,
    subjectType: pick(SUBJECT_TYPES, row.subjectType) ?? 'work_order',
    subjectId: row.subjectId,
    kind: pick(RECORD_KINDS, row.kind) ?? 'review',
    decision: pick(DECISIONS, row.decision) ?? 'approved',
    version: row.version,
    reason: row.reason,
    scope: row.scope,
    state: pick(APPROVAL_STATES, row.state),
    history: parseHistory(row.history),
    operatorId: row.operatorId,
    operatorName: row.operatorName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 提交版本与验收记录（销售工作台 A02，11-10）。
 * - 每交一次记一版（submission_versions），重提不覆盖；
 * - 验收（review）指向具体那一版，退回 / 拒绝必须写原因；
 * - 研究通过、经营批准、上架确认各是一条独立记录，经营批准只有管理员给，可暂停 / 恢复 / 退出。
 * 两张表启动时自建（同站内消息那套），不用人工迁移。
 */
@Injectable()
export class AcceptanceService implements OnModuleInit {
  private readonly logger = new Logger(AcceptanceService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'submission_versions',
      SUBMISSION_VERSIONS_DDL,
      '提交版本记不下来（交凭证照常，只是没有版本）',
    );
    await ensureStandaloneTable(
      this.db,
      this.logger,
      'acceptance_records',
      ACCEPTANCE_RECORDS_DDL,
      '验收记录、经营批准不可用',
    );
  }

  // ==================== 版本 ====================

  /**
   * 记一版：版本号 = 已有最大 + 1。并发撞号（23505）重试一次。
   * 工单在事务里调用（工单行已锁），任务直接用库。
   */
  async recordVersion(
    executor: AcceptanceExecutor,
    input: {
      subjectType: AcceptanceSubjectType;
      subjectId: string;
      items: SubmissionItem[];
      summary?: string | null;
      submittedBy: string | null;
    },
  ): Promise<{ id: string; version: number }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rows = await executor
        .select({ top: max(submissionVersions.version) })
        .from(submissionVersions)
        .where(
          and(
            eq(submissionVersions.subjectType, input.subjectType),
            eq(submissionVersions.subjectId, input.subjectId),
          ),
        );
      const next = (rows[0]?.top ?? 0) + 1;
      try {
        const inserted = await executor
          .insert(submissionVersions)
          .values({
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            version: next,
            content: { items: input.items },
            summary: input.summary ?? null,
            submittedBy: input.submittedBy,
          })
          .returning({ id: submissionVersions.id, version: submissionVersions.version });
        return inserted[0];
      } catch (error) {
        if (attempt === 0 && pgCode(error) === '23505') continue;
        throw error;
      }
    }
    throw new ConflictException('提交太快了，请再交一次');
  }

  /** 任务交材料记一版：失败只记日志，不挡交材料（Plane 评论里那份还在） */
  async recordTaskVersion(input: {
    taskId: string;
    notes: string;
    materials: string[];
    links: string[];
    submittedBy: string | null;
  }): Promise<number | null> {
    try {
      const saved = await this.recordVersion(this.db, {
        subjectType: 'task',
        subjectId: input.taskId,
        items: [
          {
            name: '说明',
            fileUrls: input.links,
            note: input.notes,
          },
          ...(input.materials.length > 0
            ? [{ name: '已提交材料', fileUrls: [], note: input.materials.join('；') }]
            : []),
        ],
        summary: input.notes.slice(0, 200),
        submittedBy: input.submittedBy,
      });
      return saved.version;
    } catch (error) {
      this.logger.warn(
        `任务 ${input.taskId} 记提交版本失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async latestVersion(
    executor: AcceptanceExecutor,
    subjectType: AcceptanceSubjectType,
    subjectId: string,
  ): Promise<{ id: string; version: number } | null> {
    const rows = await executor
      .select({ id: submissionVersions.id, version: submissionVersions.version })
      .from(submissionVersions)
      .where(
        and(
          eq(submissionVersions.subjectType, subjectType),
          eq(submissionVersions.subjectId, subjectId),
        ),
      )
      .orderBy(desc(submissionVersions.version))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 一批对象各自的最新版本号（验收列表用） */
  async latestVersionNumbers(
    subjectType: AcceptanceSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const ids = [...new Set(subjectIds)].filter((id: string) => id !== '');
    if (ids.length === 0) return map;
    try {
      const rows = await this.db
        .select({ subjectId: submissionVersions.subjectId, top: max(submissionVersions.version) })
        .from(submissionVersions)
        .where(
          and(
            eq(submissionVersions.subjectType, subjectType),
            inArray(submissionVersions.subjectId, ids),
          ),
        )
        .groupBy(submissionVersions.subjectId);
      for (const row of rows) {
        if (row.top !== null) map.set(row.subjectId, row.top);
      }
    } catch (error) {
      this.logger.warn(
        `读提交版本失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return map;
  }

  /** 一批对象的版本（新的在前，每个最多 20 版）与验收记录（按时间） */
  async overviewMany(
    subjectType: AcceptanceSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, AcceptanceOverviewResponse>> {
    const map = new Map<string, AcceptanceOverviewResponse>();
    const ids = [...new Set(subjectIds)].filter((id: string) => id !== '');
    for (const id of ids) map.set(id, { versions: [], records: [] });
    if (ids.length === 0) return map;
    try {
      const [versionRows, recordRows] = await Promise.all([
        this.db
          .select()
          .from(submissionVersions)
          .where(
            and(
              eq(submissionVersions.subjectType, subjectType),
              inArray(submissionVersions.subjectId, ids),
            ),
          )
          .orderBy(desc(submissionVersions.version)),
        this.db
          .select()
          .from(acceptanceRecords)
          .where(
            and(
              eq(acceptanceRecords.subjectType, subjectType),
              inArray(acceptanceRecords.subjectId, ids),
            ),
          )
          .orderBy(asc(acceptanceRecords.createdAt)),
      ]);
      for (const row of versionRows) {
        const entry = map.get(row.subjectId);
        if (entry && entry.versions.length < VERSION_LIST_LIMIT) {
          entry.versions.push(toVersionView(row));
        }
      }
      for (const row of recordRows) {
        map.get(row.subjectId)?.records.push(toRecordView(row));
      }
    } catch (error) {
      // 表没建上（启动建表失败）时详情照常出，只是没有版本和记录
      this.logger.warn(
        `读提交版本 / 验收记录失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return map;
  }

  async overview(
    subjectType: AcceptanceSubjectType,
    subjectId: string,
  ): Promise<AcceptanceOverviewResponse> {
    const map = await this.overviewMany(subjectType, [subjectId]);
    return map.get(subjectId) ?? { versions: [], records: [] };
  }

  // ==================== 验收（通过 / 退回 / 拒绝） ====================

  /**
   * 验收结论落一条 review 记录，指向最新那一版。
   * expectedVersion：审的人看到的是第几版；对不上（员工这期间又交了）就拒，免得审 A 版记成 B 版。
   */
  async recordReview(
    executor: AcceptanceExecutor,
    input: {
      subjectType: AcceptanceSubjectType;
      subjectId: string;
      decision: AcceptanceDecision;
      reason: string | null;
      expectedVersion?: number;
      operator: AcceptanceOperator;
    },
  ): Promise<RecordRow> {
    const reason = cleanText(input.reason);
    if (input.decision !== 'approved' && reason === '') {
      throw new BadRequestException(
        input.decision === 'returned' ? '退回要写原因' : '拒绝要写原因',
      );
    }
    const latest = await this.latestVersion(executor, input.subjectType, input.subjectId);
    if (
      input.expectedVersion !== undefined &&
      latest !== null &&
      latest.version !== input.expectedVersion
    ) {
      throw new ConflictException(
        `员工又交了第 ${latest.version} 版，刷新后看最新那版再审`,
      );
    }
    const rows = await executor
      .insert(acceptanceRecords)
      .values({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: 'review',
        decision: input.decision,
        version: latest?.version ?? null,
        submissionId: latest?.id ?? null,
        reason: reason !== '' ? reason : null,
        operatorId: input.operator.userId,
        operatorName: input.operator.userName?.slice(0, 100) ?? null,
      })
      .returning();
    return rows[0];
  }

  /** 不在事务里的验收（任务）：表出问题只记日志，不挡验收本身 */
  async recordReviewSafe(input: {
    subjectType: AcceptanceSubjectType;
    subjectId: string;
    decision: AcceptanceDecision;
    reason: string | null;
    operator: AcceptanceOperator;
  }): Promise<void> {
    try {
      await this.recordReview(this.db, input);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.warn(
        `验收记录没记上（${input.subjectType} ${input.subjectId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 任务验收前核对版本：审的人看到的版本和最新的对不上就拒 */
  async assertLatestVersion(
    subjectType: AcceptanceSubjectType,
    subjectId: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) return;
    const latest = await this.latestVersion(this.db, subjectType, subjectId);
    if (latest !== null && latest.version !== expectedVersion) {
      throw new ConflictException(
        `员工又交了第 ${latest.version} 版，刷新后看最新那版再审`,
      );
    }
  }

  // ==================== 研究通过 / 经营批准 / 上架确认 ====================

  async createRecord(
    operator: AcceptanceOperator,
    dto: AcceptanceRecordCreateRequest,
  ): Promise<AcceptanceRecordView> {
    const subjectType = pick(SUBJECT_TYPES, dto.subjectType);
    if (!subjectType) throw new BadRequestException('对象类型不对');
    const subjectId = cleanText(dto.subjectId, 64);
    if (subjectId === '') throw new BadRequestException('缺对象');
    const kind = pick(
      ['research_pass', 'business_approval', 'listing_confirm'] as const,
      dto.kind,
    );
    if (!kind) throw new BadRequestException('记录类型不对');
    if (subjectType === 'work_order') {
      if (!UUID_RE.test(subjectId)) throw new NotFoundException('工单不存在');
      const found = await this.db
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(eq(workOrders.id, subjectId))
        .limit(1);
      if (found.length === 0) throw new NotFoundException('工单不存在');
    }
    const scope = cleanText(dto.scope);
    if (kind === 'business_approval' && scope === '') {
      throw new BadRequestException('经营批准要写清批准的范围');
    }

    let target: { id: string; version: number } | null;
    if (dto.version !== undefined) {
      const rows = await this.db
        .select({ id: submissionVersions.id, version: submissionVersions.version })
        .from(submissionVersions)
        .where(
          and(
            eq(submissionVersions.subjectType, subjectType),
            eq(submissionVersions.subjectId, subjectId),
            eq(submissionVersions.version, dto.version),
          ),
        )
        .limit(1);
      target = rows[0] ?? null;
      if (!target) throw new BadRequestException(`没有第 ${dto.version} 版`);
    } else {
      target = await this.latestVersion(this.db, subjectType, subjectId);
    }

    const note = cleanText(dto.note);
    const at = new Date().toISOString();
    const rows = await this.db
      .insert(acceptanceRecords)
      .values({
        subjectType,
        subjectId,
        kind,
        decision: 'approved',
        version: target?.version ?? null,
        submissionId: target?.id ?? null,
        reason: note !== '' ? note : null,
        scope: kind === 'business_approval' ? scope : scope !== '' ? scope : null,
        state: kind === 'business_approval' ? 'active' : null,
        history:
          kind === 'business_approval'
            ? [{ action: 'grant', at, by: operator.userName ?? operator.userId, reason: note || null }]
            : [],
        operatorId: operator.userId,
        operatorName: operator.userName?.slice(0, 100) ?? null,
      })
      .returning();
    return toRecordView(rows[0]);
  }

  /** 经营批准暂停 / 恢复 / 退出；暂停和退出必须写原因，退出后不能再恢复 */
  async changeApprovalState(
    operator: AcceptanceOperator,
    id: string,
    dto: AcceptanceRecordStateRequest,
  ): Promise<AcceptanceRecordView> {
    if (!UUID_RE.test(id)) throw new NotFoundException('记录不存在');
    const rows = await this.db
      .select()
      .from(acceptanceRecords)
      .where(eq(acceptanceRecords.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('记录不存在');
    if (row.kind !== 'business_approval') {
      throw new BadRequestException('只有经营批准能暂停、恢复、退出');
    }
    const reason = cleanText(dto.reason);
    const current = pick(APPROVAL_STATES, row.state) ?? 'active';
    let next: BusinessApprovalState;
    if (dto.action === 'pause') {
      if (current !== 'active') throw new BadRequestException('只有生效中的能暂停');
      next = 'paused';
    } else if (dto.action === 'resume') {
      if (current !== 'paused') throw new BadRequestException('只有暂停的能恢复');
      next = 'active';
    } else if (dto.action === 'exit') {
      if (current === 'exited') throw new BadRequestException('已经退出了');
      next = 'exited';
    } else {
      throw new BadRequestException('操作不对');
    }
    if (dto.action !== 'resume' && reason === '') {
      throw new BadRequestException(dto.action === 'pause' ? '暂停要写原因' : '退出要写原因');
    }
    const history = [
      ...parseHistory(row.history),
      {
        action: dto.action,
        at: new Date().toISOString(),
        by: operator.userName ?? operator.userId,
        reason: reason !== '' ? reason : null,
      },
    ];
    const updated = await this.db
      .update(acceptanceRecords)
      .set({ state: next, history, updatedAt: new Date() })
      .where(and(eq(acceptanceRecords.id, id), eq(acceptanceRecords.state, current)))
      .returning();
    if (updated.length === 0) {
      throw new ConflictException('别人刚改过，刷新后再试');
    }
    return toRecordView(updated[0]);
  }
}
