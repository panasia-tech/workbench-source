import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { tutorialCases } from '@server/database/schema';
import { USER_ID_PATTERN } from '../auth/auth.config';
import { UserDirectoryService } from '../auth/user-directory.service';
import { AuditService } from '../integration/audit.service';
import { NotifyService } from '../integration/notify.service';
import {
  TutorialCaseService,
  composeCaseTitle,
  summarizeCaseProgress,
  type TutorialCaseRow,
  type TutorialSubmissionRow,
} from './tutorial-case.service';
import { TutorialContentService } from './tutorial-content.service';
import type {
  TutorialCaseAdminItem,
  TutorialCaseAdminListResponse,
  TutorialCaseAssignRequest,
  TutorialCaseStatus,
} from '@shared/api.interface';

function caseStatus(raw: string): TutorialCaseStatus {
  return raw === 'completed' || raw === 'cancelled' ? raw : 'in_progress';
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

const DUPLICATE_MESSAGE = '这位员工已经在学这套教程（同一个对象），不用重复分配';

/**
 * 给员工分配教程 = 开案例（10-19 补的入口：以前靠在 NocoBase 后台手工加一行）。
 * 同一个人、同一套教程、同一个对象只能有一个进行中的案例（库里部分唯一索引兜底）；分配错了可以取消。
 */
@Injectable()
export class TutorialAssignService {
  private readonly logger = new Logger(TutorialAssignService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly content: TutorialContentService,
    private readonly tutorialCaseService: TutorialCaseService,
    private readonly userDirectory: UserDirectoryService,
    private readonly notifyService: NotifyService,
    private readonly auditService: AuditService,
  ) {}

  async list(filter: {
    lmsCourse?: string;
    status?: string;
  }): Promise<TutorialCaseAdminListResponse> {
    const conditions = [];
    if (filter.lmsCourse) conditions.push(eq(tutorialCases.lmsCourse, filter.lmsCourse));
    if (filter.status !== undefined) {
      if (!['in_progress', 'completed', 'cancelled'].includes(filter.status)) {
        throw new BadRequestException('status 参数非法');
      }
      conditions.push(eq(tutorialCases.status, filter.status));
    }
    const rows: TutorialCaseRow[] = await this.db
      .select()
      .from(tutorialCases)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tutorialCases.id))
      .limit(200);
    return { items: await this.toItems(rows) };
  }

  async assign(
    operatorId: string,
    input: TutorialCaseAssignRequest,
  ): Promise<TutorialCaseAdminItem> {
    const ownerUserId = input.ownerUserId.trim();
    if (!USER_ID_PATTERN.test(ownerUserId)) {
      throw new BadRequestException('员工 ID 不对（应是 ERP 员工 ID）');
    }
    const outline = await this.content.getOutline(input.lmsCourse);
    if (!outline) throw new NotFoundException('教程不存在（Learning 里没有这门教程课）');
    if (outline.steps.length === 0) {
      throw new BadRequestException('这套教程还没有步骤，先在「教程模板」或豆包里搭好再分配');
    }
    const clientName = input.clientName?.trim() ? input.clientName.trim() : null;

    let inserted: TutorialCaseRow;
    try {
      const rows: TutorialCaseRow[] = await this.db
        .insert(tutorialCases)
        .values({
          lmsCourse: outline.course.name,
          ownerUserId,
          clientName,
          status: 'in_progress',
          assignedBy: operatorId,
        })
        .returning();
      inserted = rows[0];
    } catch (error) {
      if (extractPostgresErrorCode(error) === '23505') {
        throw new ConflictException(DUPLICATE_MESSAGE);
      }
      throw error;
    }

    const title = composeCaseTitle(outline.course.title, clientName);
    await this.notifyService.sendToUsers(
      [ownerUserId],
      '有一套教程分配给你',
      `《${title}》共 ${outline.stages.length} 个阶段 ${outline.steps.length} 个步骤，去学习中心从第一步开始`,
      { category: 'tutorial', link: `/my/learning/case/${inserted.id}` },
    );
    await this.auditService.log({
      action: 'tutorial_case_assign',
      operatorId,
      targetType: 'tutorial_case',
      targetId: String(inserted.id),
      detail: { summary: `分配教程《${title}》给 ${ownerUserId}` },
    });
    this.logger.log(`分配教程 case=${inserted.id} course=${outline.course.name} owner=${ownerUserId}`);
    const [item] = await this.toItems([inserted]);
    return item;
  }

  /** 取消（分配错了）：只从进行中转，已学完的不动；提交记录留着 */
  async cancel(operatorId: string, caseId: number): Promise<TutorialCaseAdminItem> {
    const updated: TutorialCaseRow[] = await this.db
      .update(tutorialCases)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(tutorialCases.id, caseId), eq(tutorialCases.status, 'in_progress')))
      .returning();
    if (updated.length === 0) {
      const exists = await this.db
        .select({ id: tutorialCases.id })
        .from(tutorialCases)
        .where(eq(tutorialCases.id, caseId))
        .limit(1);
      if (exists.length === 0) throw new NotFoundException('教程案例不存在');
      throw new ConflictException('案例已结束，不能取消');
    }
    await this.auditService.log({
      action: 'tutorial_case_cancel',
      operatorId,
      targetType: 'tutorial_case',
      targetId: String(caseId),
      detail: { summary: `取消教程案例 ${caseId}` },
    });
    const [item] = await this.toItems(updated);
    return item;
  }

  private async toItems(rows: TutorialCaseRow[]): Promise<TutorialCaseAdminItem[]> {
    if (rows.length === 0) return [];
    const [outlines, submissions, names] = await Promise.all([
      this.content.getOutlines(rows.map((row: TutorialCaseRow) => row.lmsCourse)),
      this.tutorialCaseService.loadSubmissions(rows.map((row: TutorialCaseRow) => row.id)),
      this.resolveNames(rows.map((row: TutorialCaseRow) => row.ownerUserId)),
    ]);
    return rows.map((row: TutorialCaseRow): TutorialCaseAdminItem => {
      const outline = outlines.get(row.lmsCourse) ?? null;
      const summary = summarizeCaseProgress(
        outline,
        submissions.filter((sub: TutorialSubmissionRow) => sub.caseId === row.id),
      );
      return {
        caseId: row.id,
        lmsCourse: row.lmsCourse,
        courseTitle: outline?.course.title ?? row.lmsCourse,
        ownerUserId: row.ownerUserId,
        ownerName: names.get(row.ownerUserId) ?? '',
        clientName: row.clientName,
        status: caseStatus(row.status),
        progress: summary.progress,
        stepsDone: summary.stepsDone,
        stepsTotal: summary.stepsTotal,
        assignedBy: row.assignedBy,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      };
    });
  }

  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const map = new Map<string, string>();
    try {
      const users = await this.userDirectory.listUsersByIds(unique);
      users.forEach((user, index: number) => {
        const name = user?.name?.zh_cn ?? '';
        if (name) map.set(unique[index], name);
      });
    } catch (error) {
      this.logger.warn(
        '分配列表员工姓名查询失败，保持空展示',
        error instanceof Error ? error.stack : String(error),
      );
    }
    return map;
  }
}
