import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { UserDirectoryService } from '../auth/user-directory.service';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  blockers,
  improvementProjects,
  problemPool,
  rewardLedger,
  systemConfigs,
} from '@server/database/schema';
import { AxiosError } from 'axios';
import { PlaneService } from '../integration/plane.service';
import { integrationConfig } from '../integration/integration.config';
import type {
  BlockerCategory,
  BlockerItem,
  BlockerSeverity,
  BlockerListResponse,
  ImprovementProjectItem,
  ImprovementProjectsResponse,
  ImprovementStage,
  MyBlockersResponse,
  ProblemPoolActionRequest,
  ProblemPoolActionResponse,
  ProblemLampConfig,
  ProblemPoolItem,
  ProblemPoolResponse,
  ProblemThresholds,
  SubmitBlockerRequest,
  SubmitBlockerResponse,
} from '@shared/api.interface';

type BlockerRow = typeof blockers.$inferSelect;
type ProblemPoolRow = typeof problemPool.$inferSelect;
type ImprovementRow = typeof improvementProjects.$inferSelect;
/** db.transaction 回调拿到的事务句柄 */
type DbTransaction = Parameters<
  Parameters<PostgresJsDatabase['transaction']>[0]
>[0];

export interface UserContextLike {
  userId: string;
  appId?: string;
}

interface RecurrenceStats {
  days7Count: number;
  distinctUsers: number;
  overdueCount: number;
}

const DEFAULT_THRESHOLDS: ProblemThresholds = {
  days: 7,
  count: 3,
  users: 2,
  lossHours: 4,
  overdue: 2,
};

const OBSERVE_DAYS = 14;

const BLOCKER_LIST_LIMIT = 200;

function parseThresholds(value: unknown): ProblemThresholds {
  const thresholds: ProblemThresholds = { ...DEFAULT_THRESHOLDS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return thresholds;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['days', 'count', 'users', 'lossHours', 'overdue'] as const) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      thresholds[key] = raw;
    }
  }
  return thresholds;
}

function buildRecurrenceKey(category: string, title: string): string {
  const normalized = title.replace(/\s+/g, '').toLowerCase();
  return `${category}:${normalized}`.slice(0, 255);
}

function planeSiteUrl(): string {
  return integrationConfig.planeBaseUrl.replace(/\/api\/v1\/?$/, '');
}

function readConfigNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function clampConfigNumber(
  value: number | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const base = value === null || value <= 0 ? fallback : value;
  return Math.min(max, Math.max(min, base));
}

@Injectable()
export class ProblemsService {
  private readonly logger = new Logger(ProblemsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly userDirectory: UserDirectoryService,
  ) {}

  private toBlockerItem(row: BlockerRow, reporterName: string | null): BlockerItem {
    return {
      id: row.id,
      reporterId: row.reporterId,
      reporterName,
      title: row.title,
      description: row.description,
      category: row.category as BlockerCategory,
      severity: row.severity as BlockerSeverity,
      waitingFor: row.waitingFor,
      status: row.status,
      taskId: row.taskId,
      lossHours: row.lossHours === null ? null : Number(row.lossHours),
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    };
  }

  private toPoolItem(
    row: ProblemPoolRow,
    opts?: { slaHours?: number; reporterName?: string | null },
  ): ProblemPoolItem {
    const slaHours: number | undefined = opts?.slaHours;
    const responseAt: Date | null = row.responseAt ?? null;
    const slaExceeded: boolean =
      row.status === 'pending_response' &&
      responseAt !== null &&
      slaHours !== undefined &&
      Date.now() - responseAt.getTime() > slaHours * 3_600_000;
    return {
      id: row.id,
      recurrenceKey: row.recurrenceKey,
      title: row.title,
      category: row.category,
      occurrenceCount: row.occurrenceCount,
      affectedUsers: row.affectedUsers,
      totalLossHours: Number(row.totalLossHours),
      overdueCount: row.overdueCount,
      lastOccurredAt: row.lastOccurredAt
        ? row.lastOccurredAt.toISOString()
        : null,
      status: row.status as ProblemPoolItem['status'],
      thresholdMet: row.thresholdMet as ProblemPoolItem['thresholdMet'],
      manualFlagged: row.manualFlagged,
      reporterId: row.reporterId,
      reporterName: opts?.reporterName ?? null,
      responseAt: row.responseAt ? row.responseAt.toISOString() : null,
      respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
      rejectReason: row.rejectReason,
      bountyAmount: Number(row.bountyAmount),
      sourceTaskId: row.sourceTaskId,
      repairedAt: row.repairedAt ? row.repairedAt.toISOString() : null,
      slaExceeded,
    };
  }

  private toImprovementItem(
    row: ImprovementRow,
    ownerName: string | null,
  ): ImprovementProjectItem {
    return {
      id: row.id,
      problemId: row.problemId,
      planeProjectId: row.planeProjectId,
      planeProjectName: row.planeProjectName,
      planeProjectUrl: row.planeProjectUrl,
      title: row.title,
      stage: row.stage as ImprovementStage,
      ownerName,
      expectedBenefit: row.expectedBenefit,
      observeStartedAt: row.observeStartedAt
        ? row.observeStartedAt.toISOString()
        : null,
      observeUntil: row.observeUntil ? row.observeUntil.toISOString() : null,
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async resolveUserNames(
    userContext: UserContextLike,
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const uniqueIds = [
      ...new Set(ids.filter((id: string | null): id is string => !!id)),
    ];
    if (uniqueIds.length === 0) {
      return new Map<string, string>();
    }
    try {
      const users = await this.userDirectory.listUsersByIds(uniqueIds);
      const map = new Map<string, string>();
      users.forEach((user, index: number) => {
        if (!user) return;
        const name = user.name?.zh_cn ?? user.name?.en_us ?? '';
        if (name) map.set(uniqueIds[index], name);
      });
      return map;
    } catch (error) {
      this.logger.warn('用户姓名查询失败，保持空展示', (error as Error).stack);
      return new Map<string, string>();
    }
  }

  private async readThresholds(): Promise<ProblemThresholds> {
    const rows = await this.db
      .select({ configValue: systemConfigs.configValue })
      .from(systemConfigs)
      .where(eq(systemConfigs.configKey, 'problem_thresholds'))
      .limit(1);
    return parseThresholds(rows[0]?.configValue);
  }

  /** 安灯链路配置：奖励金额（兕底 20，clamp 1-500）与响应 SLA 小时（兕底 4，clamp 1-48）。 */
  async readLampConfig(): Promise<ProblemLampConfig> {
    const [amountRow, slaRow] = await Promise.all([
      this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(eq(systemConfigs.configKey, 'problem.bounty_amount'))
        .limit(1),
      this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(eq(systemConfigs.configKey, 'problem.response_sla_hours'))
        .limit(1),
    ]);
    return {
      bountyAmount: clampConfigNumber(
        readConfigNumber(amountRow[0]?.configValue, 'amount'),
        20,
        1,
        500,
      ),
      slaHours: clampConfigNumber(
        readConfigNumber(slaRow[0]?.configValue, 'hours'),
        4,
        1,
        48,
      ),
    };
  }

  /** 员工任务卡衍生的安灯问题工单：记 blockers 明细 + 问题池 upsert 进 pending_response。 */
  async deriveProblem(
    userId: string,
    input: {
      title: string;
      category: string;
      taskId: string | null;
      description?: string | null;
      waitingFor?: string | null;
    },
  ): Promise<{ poolId: string }> {
    const recurrenceKey = buildRecurrenceKey(input.category, input.title);
    await this.db.insert(blockers).values({
      reporterId: userId,
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      severity: 'normal',
      recurrenceKey,
      waitingFor: input.waitingFor ?? null,
      taskId: input.taskId,
      status: 'open',
    });

    const now = new Date();
    const upserted = await this.db
      .insert(problemPool)
      .values({
        recurrenceKey,
        title: input.title,
        category: input.category,
        occurrenceCount: 1,
        affectedUsers: 1,
        totalLossHours: '0',
        lastOccurredAt: now,
        status: 'pending_response',
        reporterId: userId,
        responseAt: now,
        sourceTaskId: input.taskId,
      })
      .onConflictDoUpdate({
        target: problemPool.recurrenceKey,
        set: {
          occurrenceCount: sql`${problemPool.occurrenceCount} + 1`,
          lastOccurredAt: sql`now()`,
          status: sql`CASE WHEN ${problemPool.status} IN ('candidate') THEN 'pending_response' ELSE ${problemPool.status} END`,
          responseAt: sql`CASE WHEN ${problemPool.status} IN ('candidate') THEN now() ELSE ${problemPool.responseAt} END`,
          reporterId: sql`COALESCE(${problemPool.reporterId}, ROW(${userId})::user_profile)`,
        },
      })
      .returning({ id: problemPool.id });
    return { poolId: upserted[0].id };
  }

  async submitBlocker(
    userId: string,
    dto: SubmitBlockerRequest,
  ): Promise<SubmitBlockerResponse> {
    const category: BlockerCategory = dto.category ?? 'other';
    const severity: BlockerSeverity = dto.severity ?? 'normal';
    const lossHours: number | null = dto.lossHours ?? null;
    const recurrenceKey = buildRecurrenceKey(category, dto.title);

    const inserted = await this.db
      .insert(blockers)
      .values({
        reporterId: userId,
        title: dto.title,
        description: dto.description ?? null,
        category,
        severity,
        recurrenceKey,
        taskId: dto.taskId ?? null,
        lossHours: lossHours === null ? null : String(lossHours),
        status: 'open',
      })
      .returning();
    const blockerRow = inserted[0];

    // 原子聚类：occurrence_count / total_loss_hours / last_occurred_at 原子累加
    const lossAdd: string = String(lossHours ?? 0);
    await this.db
      .insert(problemPool)
      .values({
        recurrenceKey,
        title: dto.title,
        category,
        occurrenceCount: 1,
        affectedUsers: 1,
        totalLossHours: lossAdd,
        lastOccurredAt: new Date(),
        status: 'candidate',
      })
      .onConflictDoUpdate({
        target: problemPool.recurrenceKey,
        set: {
          occurrenceCount: sql`${problemPool.occurrenceCount} + 1`,
          totalLossHours: sql`${problemPool.totalLossHours} + ${lossAdd}`,
          lastOccurredAt: sql`now()`,
        },
      });

    await this.evaluatePool(recurrenceKey, severity);
    return { blocker: this.toBlockerItem(blockerRow, null) };
  }

  /** 每次提交后重算 7 天窗口统计并评估立项阈值。 */
  private async evaluatePool(
    recurrenceKey: string,
    severity: BlockerSeverity,
  ): Promise<void> {
    const thresholds = await this.readThresholds();
    const sinceIso = new Date(
      Date.now() - thresholds.days * 86_400_000,
    ).toISOString();

    const statRows = await this.db
      .select({
        days7Count: sql<number>`cast(count(*) filter (where ${blockers.createdAt} >= ${sinceIso}) as int)`,
        distinctUsers: sql<number>`cast(count(distinct (${blockers.reporterId}).user_id) filter (where ${blockers.createdAt} >= ${sinceIso}) as int)`,
        overdueCount: sql<number>`cast(count(*) filter (where ${blockers.status} in ('open', 'waiting') and ${blockers.createdAt} < ${sinceIso}) as int)`,
      })
      .from(blockers)
      .where(eq(blockers.recurrenceKey, recurrenceKey));
    const stats: RecurrenceStats = {
      days7Count: Number(statRows[0]?.days7Count ?? 0),
      distinctUsers: Number(statRows[0]?.distinctUsers ?? 0),
      overdueCount: Number(statRows[0]?.overdueCount ?? 0),
    };

    const poolRows = await this.db
      .select()
      .from(problemPool)
      .where(eq(problemPool.recurrenceKey, recurrenceKey))
      .limit(1);
    const pool = poolRows[0];
    if (!pool) {
      this.logger.warn(`问题池记录缺失：${recurrenceKey}`);
      return;
    }

    const totalLoss = Number(pool.totalLossHours);
    const met =
      stats.days7Count >= thresholds.count ||
      stats.distinctUsers >= thresholds.users ||
      totalLoss >= thresholds.lossHours ||
      stats.overdueCount >= thresholds.overdue;
    const critical = severity === 'critical';

    const patch: Partial<typeof problemPool.$inferInsert> = {
      affectedUsers: Math.max(stats.distinctUsers, 1),
      overdueCount: stats.overdueCount,
      updatedAt: new Date(),
    };
    // dismissed 再命中阈值重新置 candidate；confirmed/projected 不回退
    if ((met || critical) && ['candidate', 'dismissed'].includes(pool.status)) {
      patch.status = 'candidate';
      patch.thresholdMet = {
        days7Count: stats.days7Count,
        users: stats.distinctUsers,
        lossHours: totalLoss,
        overdueCount: stats.overdueCount,
      };
    }
    await this.db
      .update(problemPool)
      .set(patch)
      .where(eq(problemPool.id, pool.id));
  }

  async listForUser(userId: string): Promise<MyBlockersResponse> {
    const rows = await this.db
      .select()
      .from(blockers)
      .where(eq(blockers.reporterId, userId))
      .orderBy(desc(blockers.createdAt));
    const keys: string[] = rows.map(
      (row: BlockerRow) => row.recurrenceKey,
    );
    const poolRows: ProblemPoolRow[] =
      keys.length > 0
        ? await this.db
            .select()
            .from(problemPool)
            .where(inArray(problemPool.recurrenceKey, keys))
        : [];
    const config = await this.readLampConfig();
    const poolByKey = new Map<string, ProblemPoolRow>();
    for (const pool of poolRows) {
      poolByKey.set(pool.recurrenceKey, pool);
    }
    const items: BlockerItem[] = rows.map((row: BlockerRow) => {
      const item = this.toBlockerItem(row, null);
      const pool = poolByKey.get(row.recurrenceKey) ?? null;
      if (pool === null) {
        item.derivedProblem = null;
        return item;
      }
      item.derivedProblem = {
        poolId: pool.id,
        poolStatus: pool.status as ProblemPoolItem['status'],
        bountyAmount: Number(pool.bountyAmount),
        rejectReason: pool.rejectReason,
        respondedAt: pool.respondedAt
          ? pool.respondedAt.toISOString()
          : null,
        repairedAt: pool.repairedAt ? pool.repairedAt.toISOString() : null,
        slaExceeded:
          pool.status === 'pending_response' &&
          pool.responseAt !== null &&
          Date.now() - pool.responseAt.getTime() >
            config.slaHours * 3_600_000,
      };
      return item;
    });
    return { items };
  }

  /** 安灯链路：待响应且已超出 SLA 的问题清单（管理端总览超时升红用）。 */
  async listOverdueRespondings(): Promise<ProblemPoolItem[]> {
    const config = await this.readLampConfig();
    const cutoff = new Date(Date.now() - config.slaHours * 3_600_000);
    const rows = await this.db
      .select()
      .from(problemPool)
      .where(
        and(
          eq(problemPool.status, 'pending_response'),
          lt(problemPool.responseAt, cutoff),
        ),
      )
      .orderBy(problemPool.responseAt);
    return rows.map(
      (row: ProblemPoolRow) =>
        this.toPoolItem(row, { slaHours: config.slaHours }),
    );
  }

  async listAllBlockers(
    userContext: UserContextLike,
  ): Promise<BlockerListResponse> {
    const rows = await this.db
      .select()
      .from(blockers)
      .orderBy(desc(blockers.createdAt))
      .limit(BLOCKER_LIST_LIMIT);
    const names = await this.resolveUserNames(
      userContext,
      rows.map((row: BlockerRow) => row.reporterId),
    );
    return {
      items: rows.map((row: BlockerRow) =>
        this.toBlockerItem(row, names.get(row.reporterId ?? '') ?? null),
      ),
    };
  }

  async getPool(userContext?: UserContextLike): Promise<ProblemPoolResponse> {
    const [rows, thresholds, config] = await Promise.all([
      this.db
        .select()
        .from(problemPool)
        .orderBy(desc(problemPool.lastOccurredAt)),
      this.readThresholds(),
      this.readLampConfig(),
    ]);
    const names =
      userContext !== undefined
        ? await this.resolveUserNames(
            userContext,
            rows.map((row: ProblemPoolRow) => row.reporterId),
          )
        : new Map<string, string>();
    return {
      items: rows.map((row: ProblemPoolRow) =>
        this.toPoolItem(row, {
          slaHours: config.slaHours,
          reporterName: names.get(row.reporterId ?? '') ?? null,
        }),
      ),
      thresholds,
      config,
    };
  }

  /**
   * 事务里锁住问题行（SELECT … FOR UPDATE）再判状态、判奖励发没发过：确认有效、立项两条路并发或连点时，
   * 后到的要等前一个提交，读到的是它改完的状态，不会两边都以为「还没发」各发一笔
   */
  private async lockPoolRow(
    tx: DbTransaction,
    poolId: string,
  ): Promise<ProblemPoolRow> {
    const rows = await tx
      .select()
      .from(problemPool)
      .where(eq(problemPool.id, poolId))
      .limit(1)
      .for('update');
    if (!rows[0]) {
      throw new NotFoundException('问题不存在');
    }
    return rows[0];
  }

  /**
   * 给首位衍生报告人记一笔问题奖励（确认有效、立项共用），调用方已在同一事务里锁住问题行、判过没发过。
   * reward_ledger 上的部分唯一索引 uq_reward_ledger_problem_bounty（奖励类型 + 来源问题 + 收款人）兜底：
   * 撞上说明这题已经给这个人发过，跳过不再记
   */
  private async insertBounty(
    tx: DbTransaction,
    pool: ProblemPoolRow,
    amount: number,
  ): Promise<void> {
    if (pool.reporterId === null) return;
    await tx
      .insert(rewardLedger)
      .values({
        beneficiary: pool.reporterId,
        amount: String(amount),
        type: 'problem_bounty',
        sourceId: pool.id,
        note: `问题确认有效奖励：${pool.title}`.slice(0, 500),
      })
      .onConflictDoNothing();
  }

  async poolAction(
    userContext: UserContextLike,
    poolId: string,
    dto: ProblemPoolActionRequest,
  ): Promise<ProblemPoolActionResponse> {
    const rows = await this.db
      .select()
      .from(problemPool)
      .where(eq(problemPool.id, poolId))
      .limit(1);
    const pool = rows[0];
    if (!pool) {
      throw new NotFoundException('问题不存在');
    }

    if (dto.action === 'confirm') {
      return this.confirmProject(userContext, pool);
    }

    if (dto.action === 'ack') {
      if (pool.status !== 'pending_response') {
        throw new BadRequestException('仅待响应状态的问题可确认有效');
      }
      const config = await this.readLampConfig();
      const updated = await this.db.transaction(async (tx) => {
        // 以锁住后读到的为准：并发、连点时后到的读到「已确认」直接 400，奖励不会再发
        const locked = await this.lockPoolRow(tx, pool.id);
        if (locked.status !== 'pending_response') {
          throw new BadRequestException('仅待响应状态的问题可确认有效');
        }
        const grantBounty =
          locked.reporterId !== null && Number(locked.bountyAmount) === 0;
        const patch: Partial<typeof problemPool.$inferInsert> = {
          status: 'confirmed',
          respondedAt: new Date(),
          respondedBy: userContext.userId,
          updatedAt: new Date(),
        };
        if (grantBounty) {
          patch.bountyAmount = String(config.bountyAmount);
        }
        const rows = await tx
          .update(problemPool)
          .set(patch)
          .where(eq(problemPool.id, pool.id))
          .returning();
        if (grantBounty) {
          await this.insertBounty(tx, locked, config.bountyAmount);
        }
        return rows;
      });
      return {
        poolItem: this.toPoolItem(updated[0], {
          slaHours: config.slaHours,
        }),
      };
    }

    if (dto.action === 'reject') {
      if (pool.status !== 'pending_response') {
        throw new BadRequestException('仅待响应状态的问题可驳回');
      }
      const reason = (dto.reason ?? '').trim();
      if (!reason) {
        throw new BadRequestException('驳回必须填写原因');
      }
      const config = await this.readLampConfig();
      const updated = await this.db
        .update(problemPool)
        .set({
          status: 'dismissed',
          respondedAt: new Date(),
          respondedBy: userContext.userId,
          rejectReason: reason,
          updatedAt: new Date(),
        })
        // 带上状态条件：和确认有效、立项同时点时别人先改了（可能已发奖励），就不再覆盖成驳回
        .where(
          and(
            eq(problemPool.id, pool.id),
            eq(problemPool.status, 'pending_response'),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new BadRequestException('仅待响应状态的问题可驳回');
      }
      return {
        poolItem: this.toPoolItem(updated[0], {
          slaHours: config.slaHours,
        }),
      };
    }

    if (dto.action === 'dismiss') {
      if (pool.status === 'pending_response') {
        throw new BadRequestException('待响应问题请先确认有效或驳回');
      }
      const updated = await this.db
        .update(problemPool)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(eq(problemPool.id, pool.id))
        .returning();
      return { poolItem: this.toPoolItem(updated[0]) };
    }

    if (dto.action === 'flag') {
      const existing =
        pool.thresholdMet && typeof pool.thresholdMet === 'object'
          ? (pool.thresholdMet as Record<string, unknown>)
          : {};
      const updated = await this.db
        .update(problemPool)
        .set({
          manualFlagged: true,
          status: ['dismissed', 'candidate'].includes(pool.status)
            ? 'candidate'
            : (pool.status as ProblemPoolItem['status']),
          thresholdMet: { ...existing, manual: true },
          updatedAt: new Date(),
        })
        .where(eq(problemPool.id, pool.id))
        .returning();
      return { poolItem: this.toPoolItem(updated[0]) };
    }

    const updated = await this.db
      .update(problemPool)
      .set({ manualFlagged: false, updatedAt: new Date() })
      .where(eq(problemPool.id, pool.id))
      .returning();
    return { poolItem: this.toPoolItem(updated[0]) };
  }

  /** Plane 项目名只允许汉字/字母/数字/空格，其余字符转空格并折叠。 */
  private sanitizeProjectName(title: string): string {
    const cleaned = title.replace(/[^\p{Script=Han}\p{L}\p{N}\s]/gu, ' ');
    return cleaned.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /** boss 确认立项：建 Plane 项目 + improvement_projects 记录 + 池状态 projected。 */
  private async confirmProject(
    userContext: UserContextLike,
    pool: ProblemPoolRow,
  ): Promise<ProblemPoolActionResponse> {
    if (!['candidate', 'pending_response'].includes(pool.status)) {
      throw new BadRequestException('仅候选或待响应状态的问题可确认立项');
    }
    const config = await this.readLampConfig();

    let created: { id: string; name: string } | null = null;
    let lastError: unknown = null;
    const projectName = this.sanitizeProjectName(pool.title);
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
      const identifier = `IM${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      try {
        created = await this.plane.post<{ id: string; name: string }>(
          `${this.plane.workspacePath}/projects/`,
          { name: projectName, identifier },
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (!created) {
      const detail =
        lastError instanceof AxiosError
          ? JSON.stringify(lastError.response?.data)
          : lastError instanceof Error
            ? lastError.message
            : String(lastError);
      throw new InternalServerErrorException(
        `Plane 项目创建失败：${detail}`,
        { cause: lastError },
      );
    }
    const projectUrl =
      `${planeSiteUrl()}/workspace/${integrationConfig.planeWorkspaceSlug}` +
      `/projects/${created.id}`;

    const { inserted, updated } = await this.db.transaction(async (tx) => {
      // Plane 项目建好才进事务，这期间别人可能已经确认有效或立项：以锁住后读到的为准再判状态、判奖励
      const locked = await this.lockPoolRow(tx, pool.id);
      if (!['candidate', 'pending_response'].includes(locked.status)) {
        this.logger.warn(
          `问题 ${pool.id} 立项前已被处理（${locked.status}），刚建的 Plane 项目「${created.name}」（${created.id}）没用上，可在 Plane 里删掉`,
        );
        throw new BadRequestException('仅候选或待响应状态的问题可确认立项');
      }
      const grantBounty =
        locked.reporterId !== null &&
        Number(locked.bountyAmount) === 0 &&
        locked.responseAt !== null;
      const insertedRows = await tx
        .insert(improvementProjects)
        .values({
          problemId: pool.id,
          planeProjectId: created.id,
          planeProjectName: created.name,
          title: pool.title,
          stage: 'define',
          ownerId: userContext.userId,
          planeProjectUrl: projectUrl,
        })
        .returning();
      const poolPatch: Partial<typeof problemPool.$inferInsert> = {
        status: 'projected',
        updatedAt: new Date(),
      };
      if (grantBounty) {
        poolPatch.bountyAmount = String(config.bountyAmount);
        if (locked.respondedAt === null) {
          poolPatch.respondedAt = new Date();
          poolPatch.respondedBy = userContext.userId;
        }
      }
      const updatedRows = await tx
        .update(problemPool)
        .set(poolPatch)
        .where(eq(problemPool.id, pool.id))
        .returning();
      if (grantBounty) {
        await this.insertBounty(tx, locked, config.bountyAmount);
      }
      return { inserted: insertedRows, updated: updatedRows };
    });

    const ownerNames = await this.resolveUserNames(userContext, [
      userContext.userId,
    ]);
    return {
      poolItem: this.toPoolItem(updated[0], {
        slaHours: config.slaHours,
      }),
      improvement: this.toImprovementItem(
        inserted[0],
        ownerNames.get(userContext.userId) ?? null,
      ),
    };
  }

  async listImprovements(
    userContext: UserContextLike,
  ): Promise<ImprovementProjectsResponse> {
    const rows = await this.db
      .select()
      .from(improvementProjects)
      .orderBy(desc(improvementProjects.createdAt));
    const names = await this.resolveUserNames(
      userContext,
      rows.map((row: ImprovementRow) => row.ownerId),
    );
    return {
      items: rows.map((row: ImprovementRow) =>
        this.toImprovementItem(row, names.get(row.ownerId ?? '') ?? null),
      ),
    };
  }

  async updateStage(
    userContext: UserContextLike,
    improvementId: string,
    stage: ImprovementStage,
  ): Promise<ImprovementProjectItem> {
    const rows = await this.db
      .select()
      .from(improvementProjects)
      .where(eq(improvementProjects.id, improvementId))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundException('改进项目不存在');
    }

    const patch: Partial<typeof improvementProjects.$inferInsert> = {
      stage,
      updatedAt: new Date(),
    };
    if (stage === 'observe') {
      patch.observeStartedAt = new Date();
      patch.observeUntil = new Date(Date.now() + OBSERVE_DAYS * 86_400_000);
    }
    if (stage === 'closed') {
      patch.closedAt = new Date();
    }

    const updated = await this.db
      .update(improvementProjects)
      .set(patch)
      .where(eq(improvementProjects.id, improvementId))
      .returning();

    // 结项回访：改进项目闭环时回写问题池 repairedAt，失败仅告警不阻断流转
    const problemId = rows[0].problemId;
    if (stage === 'closed' && problemId !== null) {
      try {
        await this.db
          .update(problemPool)
          .set({ repairedAt: new Date(), updatedAt: new Date() })
          .where(eq(problemPool.id, problemId));
      } catch (error) {
        this.logger.warn(
          `问题修复回访时间回写失败（问题 ${problemId}）：${
            error instanceof Error ? error.stack : String(error)
          }`,
        );
      }
    }
    const names = await this.resolveUserNames(
      userContext,
      updated.map((row: ImprovementRow) => row.ownerId),
    );
    return this.toImprovementItem(
      updated[0],
      names.get(updated[0].ownerId ?? '') ?? null,
    );
  }
}
