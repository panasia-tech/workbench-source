import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { UserDirectoryService } from '../auth/user-directory.service';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { tutorialCases, tutorialSkipRequests } from '@server/database/schema';
import {
  TutorialCaseService,
  composeCaseTitle,
  parseSkipStatus,
  type TutorialCaseRow,
} from './tutorial-case.service';
import { TutorialContentService } from './tutorial-content.service';
import type {
  MyTutorialSkipListResponse,
  TutorialSkipRequestInfo,
  TutorialSkipReviewItem,
  TutorialSkipReviewListResponse,
  TutorialSkipStatus,
} from '@shared/api.interface';

type TutorialSkipRow = typeof tutorialSkipRequests.$inferSelect;

/** 管理端审核上下文（与 problems 模块 UserContextLike 同款） */
export interface SkipUserContextLike {
  userId: string;
  appId?: string;
}

/** 从 cause 链中提取 PostgreSQL SQLSTATE（Drizzle 可能把原始错误包在 cause 里） */
function extractPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth += 1
  ) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

@Injectable()
export class TutorialSkipService {
  private readonly logger = new Logger(TutorialSkipService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly content: TutorialContentService,
    private readonly tutorialCaseService: TutorialCaseService,
    private readonly userDirectory: UserDirectoryService,
  ) {}

  /** 员工提交跳过申请：仅 active/rejected 步骤可申请，同步骤同时仅一条 pending */
  async submitSkipRequest(
    userId: string,
    caseId: number,
    stepId: string,
    reason: string,
  ): Promise<TutorialSkipRequestInfo> {
    const { kase, step, outline } = await this.tutorialCaseService.assertStepSkippable(
      userId,
      caseId,
      stepId,
    );

    const existing = await this.db
      .select({ id: tutorialSkipRequests.id })
      .from(tutorialSkipRequests)
      .where(
        and(
          eq(tutorialSkipRequests.caseId, caseId),
          eq(tutorialSkipRequests.stepId, stepId),
          eq(tutorialSkipRequests.status, 'pending'),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('该步骤已有待审核的跳过申请');
    }

    let inserted: TutorialSkipRow;
    try {
      const rows: TutorialSkipRow[] = await this.db
        .insert(tutorialSkipRequests)
        .values({ caseId, stepId, userId, reason, status: 'pending' })
        .returning();
      inserted = rows[0];
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException('该步骤已有待审核的跳过申请');
      }
      throw error;
    }

    return this.toInfo(
      inserted,
      composeCaseTitle(outline.course.title, kase.clientName),
      step.title,
    );
  }

  /** 本人申请列表，createdAt 倒序 */
  async listByUser(userId: string): Promise<MyTutorialSkipListResponse> {
    const rows: TutorialSkipRow[] = await this.db
      .select()
      .from(tutorialSkipRequests)
      .where(eq(tutorialSkipRequests.userId, userId))
      .orderBy(desc(tutorialSkipRequests.createdAt));
    const { caseTitles, stepTitles } = await this.loadTitleMaps(
      rows.map((row: TutorialSkipRow) => row.caseId),
    );
    return {
      items: rows.map((row: TutorialSkipRow) =>
        this.toInfo(
          row,
          caseTitles.get(row.caseId) ?? '',
          stepTitles.get(row.stepId) ?? '',
        ),
      ),
    };
  }

  /** boss 审核队列，默认 pending，回填 employeeName */
  async listForReview(
    status: string | undefined,
    context: SkipUserContextLike,
  ): Promise<TutorialSkipReviewListResponse> {
    const target = this.normalizeStatus(status);
    const rows: TutorialSkipRow[] = await this.db
      .select()
      .from(tutorialSkipRequests)
      .where(eq(tutorialSkipRequests.status, target))
      .orderBy(desc(tutorialSkipRequests.createdAt));
    const { caseTitles, stepTitles } = await this.loadTitleMaps(
      rows.map((row: TutorialSkipRow) => row.caseId),
    );
    const names = await this.resolveEmployeeNames(
      rows.map((row: TutorialSkipRow) => row.userId),
    );
    return {
      items: rows.map((row: TutorialSkipRow) =>
        this.toReviewItem(
          row,
          caseTitles.get(row.caseId) ?? '',
          stepTitles.get(row.stepId) ?? '',
          names.get(row.userId) ?? '',
        ),
      ),
    };
  }

  /** boss 终审：approve → 真跳过（写 skipped submission + 重算进度）再置 approved；reject → 置 rejected */
  async bossVerdict(
    id: string,
    action: 'approve' | 'reject',
    comment: string | undefined,
    bossUserId: string,
    context: SkipUserContextLike,
  ): Promise<TutorialSkipReviewItem> {
    const rows: TutorialSkipRow[] = await this.db
      .select()
      .from(tutorialSkipRequests)
      .where(eq(tutorialSkipRequests.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('跳过申请不存在');
    if (row.status !== 'pending') {
      throw new ConflictException('该申请已被处理');
    }

    if (action === 'approve') {
      // 复用既有跳过逻辑执行真跳过；步骤状态已变化时其 BadRequestException 原样透传
      await this.tutorialCaseService.skipTutorialStep(
        row.userId,
        row.caseId,
        row.stepId,
      );
    }

    const updated: TutorialSkipRow[] = await this.db
      .update(tutorialSkipRequests)
      .set({
        status: action === 'approve' ? 'approved' : 'rejected',
        reviewerNote: comment ?? null,
        reviewedBy: bossUserId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: bossUserId,
      })
      .where(
        and(
          eq(tutorialSkipRequests.id, id),
          eq(tutorialSkipRequests.status, 'pending'),
        ),
      )
      .returning();
    if (updated.length === 0) {
      throw new ConflictException('该申请已被处理');
    }
    const finalRow = updated[0];
    const { caseTitles, stepTitles } = await this.loadTitleMaps([
      finalRow.caseId,
    ]);
    const names = await this.resolveEmployeeNames([finalRow.userId]);
    return this.toReviewItem(
      finalRow,
      caseTitles.get(finalRow.caseId) ?? '',
      stepTitles.get(finalRow.stepId) ?? '',
      names.get(finalRow.userId) ?? '',
    );
  }

  /** 该用户该案例每步骤最新一条跳过申请（供详情回填） */
  async getSkipStatusMap(
    caseId: number,
    userId: string,
  ): Promise<Map<string, { status: TutorialSkipStatus; note: string | null }>> {
    const rows = await this.db
      .select({
        stepId: tutorialSkipRequests.stepId,
        status: tutorialSkipRequests.status,
        reviewerNote: tutorialSkipRequests.reviewerNote,
      })
      .from(tutorialSkipRequests)
      .where(
        and(
          eq(tutorialSkipRequests.caseId, caseId),
          eq(tutorialSkipRequests.userId, userId),
        ),
      )
      .orderBy(asc(tutorialSkipRequests.createdAt));
    const map = new Map<
      string,
      { status: TutorialSkipStatus; note: string | null }
    >();
    for (const row of rows) {
      map.set(row.stepId, {
        status: parseSkipStatus(row.status),
        note: row.reviewerNote,
      });
    }
    return map;
  }

  /** status 查询参数收窄：不传默认 pending，非法值 400 */
  private normalizeStatus(status: string | undefined): TutorialSkipStatus {
    if (status === 'approved' || status === 'rejected') return status;
    if (status === undefined || status === 'pending') return 'pending';
    throw new BadRequestException('status 参数非法');
  }

  /** 批量回填案例/步骤标题：案例从工作台库一次查，标题从 Learning 大纲取（60 秒缓存），禁止 N+1 */
  private async loadTitleMaps(caseIds: number[]): Promise<{
    caseTitles: Map<number, string>;
    stepTitles: Map<string, string>;
  }> {
    const caseTitles = new Map<number, string>();
    const stepTitles = new Map<string, string>();
    const uniqueCaseIds = [...new Set(caseIds)];
    if (uniqueCaseIds.length === 0) return { caseTitles, stepTitles };

    const cases: TutorialCaseRow[] = await this.db
      .select()
      .from(tutorialCases)
      .where(inArray(tutorialCases.id, uniqueCaseIds));
    const outlines = await this.content.getOutlines(
      cases.map((kase: TutorialCaseRow) => kase.lmsCourse),
    );
    for (const kase of cases) {
      const outline = outlines.get(kase.lmsCourse);
      caseTitles.set(kase.id, composeCaseTitle(outline?.course.title ?? null, kase.clientName));
      for (const step of outline?.steps ?? []) {
        stepTitles.set(step.key, step.title);
      }
    }
    return { caseTitles, stepTitles };
  }

  /** 按妙搭 userId 批量查展示名；查询失败保持空展示 */
  private async resolveEmployeeNames(
    ids: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(ids)];
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
      this.logger.warn(
        '跳过申请员工姓名查询失败，保持空展示',
        error instanceof Error ? error.stack : String(error),
      );
      return new Map<string, string>();
    }
  }

  private toInfo(
    row: TutorialSkipRow,
    caseTitle: string,
    stepTitle: string,
  ): TutorialSkipRequestInfo {
    return {
      id: row.id,
      caseId: row.caseId,
      caseTitle,
      stepId: row.stepId,
      stepTitle,
      reason: row.reason,
      status: parseSkipStatus(row.status),
      reviewerNote: row.reviewerNote,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toReviewItem(
    row: TutorialSkipRow,
    caseTitle: string,
    stepTitle: string,
    employeeName: string,
  ): TutorialSkipReviewItem {
    return {
      id: row.id,
      caseId: row.caseId,
      caseTitle,
      stepId: row.stepId,
      stepTitle,
      userId: row.userId,
      employeeName,
      reason: row.reason,
      status: parseSkipStatus(row.status),
      reviewerNote: row.reviewerNote,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
