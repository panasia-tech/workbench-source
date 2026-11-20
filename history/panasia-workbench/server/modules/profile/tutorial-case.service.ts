import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  tutorialCases,
  tutorialSkipRequests,
  tutorialStepSubmissions,
} from '@server/database/schema';
import { ensureStandaloneTable } from '@server/database/ensure-standalone-table';
import {
  TUTORIAL_STEP_SUBMISSION_HISTORY_DDL,
  tutorialStepSubmissionHistory,
} from '@server/database/standalone-schema';
import { getLearningUrl } from '../integration/integration.config';
import { shanghaiDateString, todayDateString } from '../integration/plane-mapping';
import { PerformanceService } from '../performance/performance.service';
import {
  TutorialContentService,
  type TutorialOutline,
  type TutorialStage,
  type TutorialStep,
} from './tutorial-content.service';
import type { TutorialMaterialDef } from './tutorial-lesson-body';
import type {
  LearningCourseProgress,
  SubmitTutorialStepRequest,
  SubmitTutorialStepResponse,
  TutorialCaseDetail,
  TutorialCaseStageDetail,
  TutorialCaseStepDetail,
  TutorialSkipStatus,
  TutorialSubmissionView,
} from '@shared/api.interface';

export const TUTORIAL_REWARD_SCORE = 8;
export const TUTORIAL_OVERDUE_DAYS = 14;

export function tutorialOverdueDays(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const created = createdAt.slice(0, 10);
  const diff = Math.floor(
    (new Date(todayDateString()).getTime() - new Date(created).getTime()) /
      86_400_000,
  );
  const over = diff - TUTORIAL_OVERDUE_DAYS;
  return over > 0 ? over : null;
}

export type TutorialCaseRow = typeof tutorialCases.$inferSelect;
export type TutorialSubmissionRow = typeof tutorialStepSubmissions.$inferSelect;

const TEXT_INPUT_TYPES = new Set<string>([
  'text',
  'textarea',
  'number',
  'select',
  'date',
]);
const FILE_INPUT_TYPES = new Set<string>(['image', 'video', 'file']);

export function parseSubmissionData(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      record[key] = value;
    }
    return record;
  }
  return {};
}

function mapSubmissionView(row: TutorialSubmissionRow): TutorialSubmissionView {
  return {
    status: row.status,
    data: parseSubmissionData(row.data),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewNote: row.reviewNote ?? null,
  };
}

function isHandled(status: string | undefined): boolean {
  return status === 'approved' || status === 'skipped';
}

/** 案例标题统一口径：项目名 · 客户名，缺一侧取另一侧，都缺取兜底文案 */
export function composeCaseTitle(
  projectName: string | null,
  clientName: string | null,
): string {
  if (projectName && clientName) return `${projectName} · ${clientName}`;
  return projectName ?? clientName ?? '教程案例';
}

/** 跳过申请状态收窄：库里只写三个受控字面量，未知值按 pending 处理 */
export function parseSkipStatus(raw: string): TutorialSkipStatus {
  if (raw === 'approved' || raw === 'rejected') return raw;
  return 'pending';
}

/** 一案例一步骤一行（库里 (case_id, step_key) 唯一），按步骤编号索引 */
export function submissionsByStep(
  rows: TutorialSubmissionRow[],
): Map<string, TutorialSubmissionRow> {
  return new Map<string, TutorialSubmissionRow>(
    rows.map((row: TutorialSubmissionRow) => [row.stepKey, row]),
  );
}

export interface CaseProgressSummary {
  stepsTotal: number;
  stepsDone: number;
  progress: number;
  /** 第一个还有没做完步骤的阶段；全做完取最后一个 */
  currentStage: TutorialStage | null;
  completed: boolean;
  hasRejectedStep: boolean;
  /** 最早一次提交时间（判超期的起点，不是建案时间） */
  startedAt: string | null;
}

/** 案例进度：已通过、已跳过都算做完（与 NocoBase 时期同口径） */
export function summarizeCaseProgress(
  outline: TutorialOutline | null,
  rows: TutorialSubmissionRow[],
): CaseProgressSummary {
  const byStep = submissionsByStep(rows);
  const steps = outline?.steps ?? [];
  const stepsDone = steps.filter((step: TutorialStep) =>
    isHandled(byStep.get(step.key)?.status),
  ).length;
  const stages = outline?.stages ?? [];
  const currentStage =
    stages.find((stage: TutorialStage) =>
      stage.steps.some((step: TutorialStep) => !isHandled(byStep.get(step.key)?.status)),
    ) ??
    stages[stages.length - 1] ??
    null;
  let startedAt: string | null = null;
  for (const row of rows) {
    if (!row.submittedAt) continue;
    const ts = row.submittedAt.toISOString();
    if (startedAt === null || ts < startedAt) startedAt = ts;
  }
  return {
    stepsTotal: steps.length,
    stepsDone,
    progress: steps.length > 0 ? Math.round((stepsDone / steps.length) * 100) : 0,
    currentStage,
    completed: steps.length > 0 && stepsDone === steps.length,
    hasRejectedStep: rows.some((row: TutorialSubmissionRow) => row.status === 'rejected'),
    startedAt,
  };
}

function materialView(material: TutorialMaterialDef): TutorialCaseStepDetail['materials'][number] {
  return {
    key: material.key,
    label: material.label,
    inputType: material.inputType,
    required: material.required,
    options: material.options,
    helpText: material.helpText,
  };
}

/**
 * 教程案例与步骤提交（10-19 起：案例、提交存工作台库，有哪些步骤、什么顺序从 Learning 读）。
 * 步骤六态 approved/submitted/rejected/skipped/active/locked 的判定、前序校验、必填校验、确认勾选照旧。
 */
@Injectable()
export class TutorialCaseService implements OnModuleInit {
  private readonly logger = new Logger(TutorialCaseService.name);
  /** 旧版本表建上了才往里存；没建上（启动建表失败）照旧原地覆盖，不挡交材料 */
  private historyReady = false;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly content: TutorialContentService,
    private readonly performanceService: PerformanceService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.historyReady = await ensureStandaloneTable(
      this.db,
      this.logger,
      'tutorial_step_submission_history',
      TUTORIAL_STEP_SUBMISSION_HISTORY_DDL,
      '教程步骤重交时旧版本不留底（当前版本照常）',
    );
  }

  private async loadCase(userId: string, caseId: number): Promise<TutorialCaseRow> {
    const rows: TutorialCaseRow[] = await this.db
      .select()
      .from(tutorialCases)
      .where(and(eq(tutorialCases.id, caseId), eq(tutorialCases.ownerUserId, userId)))
      .limit(1);
    const kase = rows[0];
    if (!kase) throw new NotFoundException('教程案例不存在');
    return kase;
  }

  async loadSubmissions(caseIds: number[]): Promise<TutorialSubmissionRow[]> {
    if (caseIds.length === 0) return [];
    return this.db
      .select()
      .from(tutorialStepSubmissions)
      .where(inArray(tutorialStepSubmissions.caseId, [...new Set(caseIds)]));
  }

  async getTutorialCaseDetail(
    userId: string,
    caseId: number,
  ): Promise<TutorialCaseDetail> {
    const kase = await this.loadCase(userId, caseId);
    const [outline, submissions, skipStatusMap, expectedBonus] = await Promise.all([
      this.content.getOutline(kase.lmsCourse),
      this.loadSubmissions([caseId]),
      this.loadSkipStatusMap(caseId, userId),
      this.performanceService
        .getExpectedBonusForEmployee(userId)
        .catch((): null => null),
    ]);
    const submissionByStep = submissionsByStep(submissions);
    const summary = summarizeCaseProgress(outline, submissions);
    const status = await this.completeIfDone(kase, summary);

    const stagesWithSteps: TutorialCaseStageDetail[] = [];
    let allPrevHandled = true;
    for (const stage of outline?.stages ?? []) {
      const stepDetails = stage.steps.map((step: TutorialStep): TutorialCaseStepDetail => {
        const submission = submissionByStep.get(step.key) ?? null;
        const approved = submission?.status === 'approved';
        const state: TutorialCaseStepDetail['state'] = approved
          ? 'approved'
          : submission?.status === 'skipped'
            ? 'skipped'
            : !allPrevHandled
              ? 'locked'
              : submission?.status === 'submitted'
                ? 'submitted'
                : submission?.status === 'rejected'
                  ? 'rejected'
                  : 'active';
        const handled = approved || submission?.status === 'skipped';
        allPrevHandled = allPrevHandled && handled;
        const skip = skipStatusMap.get(step.key) ?? null;
        return {
          id: step.key,
          title: step.title,
          guide: step.guide,
          warnText: step.warnText,
          deliverNote: step.deliverNote,
          videoUrl: step.videoUrl,
          requireConfirm: step.requireConfirm,
          requireReview: step.requireReview,
          approved,
          submissionStatus: submission?.status ?? null,
          state,
          skipRequestStatus: skip?.status ?? null,
          skipReviewerNote: skip?.note ?? null,
          materials: step.materials.map(materialView),
          submission: submission ? mapSubmissionView(submission) : null,
        };
      });
      stagesWithSteps.push({ id: stage.name, title: stage.title, steps: stepDetails });
    }

    const projectName = outline?.course.title ?? null;
    return {
      caseId,
      title: composeCaseTitle(projectName, kase.clientName),
      projectName,
      clientName: kase.clientName,
      status,
      progress: summary.progress,
      currentStageId: summary.currentStage?.name ?? null,
      completedAt: this.completedDate(kase, status),
      rewardScore: TUTORIAL_REWARD_SCORE,
      rewardAmount:
        expectedBonus !== null
          ? Math.round((expectedBonus / 100) * TUTORIAL_REWARD_SCORE * 10) / 10
          : null,
      overdueDays: tutorialOverdueDays(summary.startedAt),
      hasRejectedStep: summary.hasRejectedStep,
      stages: stagesWithSteps,
      tutorialSiteUrl: getLearningUrl(kase.lmsCourse),
    };
  }

  /** 学习中心列表：本人进行中、已学完的案例（取消的不列）；某门课读不到只少那门的步骤信息 */
  async buildMyLearning(userId: string): Promise<{
    courses: LearningCourseProgress[];
    requiredTotal: number;
    requiredDone: number;
  }> {
    const cases: TutorialCaseRow[] = await this.db
      .select()
      .from(tutorialCases)
      .where(and(eq(tutorialCases.ownerUserId, userId), ne(tutorialCases.status, 'cancelled')))
      .orderBy(asc(tutorialCases.id));
    if (cases.length === 0) return { courses: [], requiredTotal: 0, requiredDone: 0 };
    const [outlines, submissions] = await Promise.all([
      this.content.getOutlines(cases.map((kase: TutorialCaseRow) => kase.lmsCourse)),
      this.loadSubmissions(cases.map((kase: TutorialCaseRow) => kase.id)),
    ]);
    const requiredStepIds = new Set<string>();
    const requiredDoneIds = new Set<string>();
    const courses: LearningCourseProgress[] = [];
    for (const kase of cases) {
      const outline = outlines.get(kase.lmsCourse) ?? null;
      const rows = submissions.filter(
        (row: TutorialSubmissionRow) => row.caseId === kase.id,
      );
      const summary = summarizeCaseProgress(outline, rows);
      const status = await this.completeIfDone(kase, summary);
      const byStep = submissionsByStep(rows);
      for (const step of outline?.steps ?? []) {
        if (!step.requireReview) continue;
        const key = `${kase.lmsCourse}:${step.key}`;
        requiredStepIds.add(key);
        if (byStep.get(step.key)?.status === 'approved') requiredDoneIds.add(key);
      }
      courses.push({
        id: `tutorial_case_${kase.id}`,
        title: composeCaseTitle(outline?.course.title ?? null, kase.clientName),
        category: 'tutorial',
        progress: summary.progress,
        completedAt: this.completedDate(kase, status),
        currentStageTitle: summary.currentStage?.title ?? null,
        stagesTotal: outline?.stages.length ?? 0,
        stepsTotal: summary.stepsTotal,
        stepsDone: summary.stepsDone,
        startedAt: summary.startedAt,
        hasRejectedStep: summary.hasRejectedStep,
      });
    }
    return {
      courses,
      requiredTotal: requiredStepIds.size,
      requiredDone: requiredDoneIds.size,
    };
  }

  /** 公共前置：案例是本人的、还在学，步骤在大纲里，前序都已通过或跳过 */
  private async prepareStep(
    userId: string,
    caseId: number,
    stepKey: string,
  ): Promise<{
    kase: TutorialCaseRow;
    outline: TutorialOutline;
    step: TutorialStep;
    latest: TutorialSubmissionRow | undefined;
  }> {
    const kase = await this.loadCase(userId, caseId);
    if (kase.status !== 'in_progress') {
      throw new BadRequestException('案例已结束');
    }
    const outline = await this.content.getOutline(kase.lmsCourse);
    const steps = outline?.steps ?? [];
    const targetIndex = steps.findIndex((step: TutorialStep) => step.key === stepKey);
    if (!outline || targetIndex < 0) throw new NotFoundException('步骤不存在');
    const latestByStep = submissionsByStep(await this.loadSubmissions([caseId]));
    for (const prev of steps.slice(0, targetIndex)) {
      if (!isHandled(latestByStep.get(prev.key)?.status)) {
        throw new BadRequestException('请先完成前序步骤');
      }
    }
    return { kase, outline, step: steps[targetIndex], latest: latestByStep.get(stepKey) };
  }

  /** 校验步骤当前可申请跳过（active/rejected），供跳过申请流程使用；不写 submission */
  async assertStepSkippable(
    userId: string,
    caseId: number,
    stepKey: string,
  ): Promise<{ kase: TutorialCaseRow; step: TutorialStep; outline: TutorialOutline }> {
    const { kase, step, outline, latest } = await this.prepareStep(userId, caseId, stepKey);
    if (latest?.status === 'approved') {
      throw new BadRequestException('步骤已完成，无需跳过');
    }
    if (latest?.status === 'submitted') {
      throw new BadRequestException('步骤审核中，无法申请跳过');
    }
    if (latest?.status === 'skipped') {
      throw new BadRequestException('步骤已跳过');
    }
    return { kase, step, outline };
  }

  /** 该用户该案例每步骤最新一条跳过申请（详情回填；直查库避免与 TutorialSkipService 循环引用） */
  private async loadSkipStatusMap(
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
    const map = new Map<string, { status: TutorialSkipStatus; note: string | null }>();
    for (const row of rows) {
      map.set(row.stepId, {
        status: parseSkipStatus(row.status),
        note: row.reviewerNote,
      });
    }
    return map;
  }

  async submitTutorialStep(
    userId: string,
    caseId: number,
    stepKey: string,
    body: SubmitTutorialStepRequest,
  ): Promise<SubmitTutorialStepResponse> {
    const { kase, outline, step } = await this.prepareStep(userId, caseId, stepKey);

    const missingLabels: string[] = [];
    for (const material of step.materials) {
      if (!material.required) continue;
      const value = body.data[material.key];
      if (FILE_INPUT_TYPES.has(material.inputType)) {
        if (!Array.isArray(value) || value.length === 0) {
          missingLabels.push(material.label || material.key);
        }
      } else if (TEXT_INPUT_TYPES.has(material.inputType)) {
        const valid =
          (typeof value === 'string' && value.trim() !== '') ||
          (typeof value === 'number' && Number.isFinite(value));
        if (!valid) missingLabels.push(material.label || material.key);
      }
    }
    if (missingLabels.length > 0) {
      throw new BadRequestException(`缺少必填材料：${missingLabels.join('、')}`);
    }
    if (step.requireConfirm && body.confirmed !== true) {
      throw new BadRequestException('需勾选确认后提交');
    }

    const saved = await this.saveSubmission(caseId, stepKey, userId, {
      data: body.data ?? {},
      status: step.requireReview ? 'submitted' : 'approved',
    });
    const caseState = await this.syncCaseProgress(kase, outline);
    return {
      submission: mapSubmissionView(saved),
      caseProgress: caseState.progress,
      caseStatus: caseState.status,
    };
  }

  async skipTutorialStep(
    userId: string,
    caseId: number,
    stepKey: string,
  ): Promise<SubmitTutorialStepResponse> {
    const { kase, outline, latest } = await this.prepareStep(userId, caseId, stepKey);
    if (latest?.status === 'approved') {
      throw new BadRequestException('步骤已完成，无需跳过');
    }
    if (latest?.status === 'submitted') {
      throw new BadRequestException('步骤审核中，无法跳过');
    }
    if (latest?.status === 'skipped') {
      throw new BadRequestException('步骤已跳过');
    }
    const saved = await this.saveSubmission(caseId, stepKey, userId, {
      data: {},
      status: 'skipped',
    });
    const caseState = await this.syncCaseProgress(kase, outline);
    return {
      submission: mapSubmissionView(saved),
      caseProgress: caseState.progress,
      caseStatus: caseState.status,
    };
  }

  /**
   * 一案例一步骤一行：没有就插，有了原地覆盖（重交 / 被打回再交都走这里），审核结论清空。
   * 覆盖前把旧的那一版（连同当时的审核结论）原样存进 tutorial_step_submission_history（11-10 A02：重提不覆盖），
   * 当前版本照旧从 tutorial_step_submissions 读，审核、进度、超期判断都不变。
   */
  private async saveSubmission(
    caseId: number,
    stepKey: string,
    userId: string,
    input: { data: Record<string, unknown>; status: string },
  ): Promise<TutorialSubmissionRow> {
    const now = new Date();
    const values = {
      data: input.data,
      status: input.status,
      reviewNote: null,
      reviewedBy: null,
      reviewedAt: null,
      submittedAt: now,
      submittedBy: userId,
      updatedAt: now,
    };
    return this.db.transaction(async (tx) => {
      if (this.historyReady) {
        const previous: TutorialSubmissionRow[] = await tx
          .select()
          .from(tutorialStepSubmissions)
          .where(
            and(
              eq(tutorialStepSubmissions.caseId, caseId),
              eq(tutorialStepSubmissions.stepKey, stepKey),
            ),
          )
          .for('update');
        const old = previous[0];
        if (old) {
          await tx.insert(tutorialStepSubmissionHistory).values({
            submissionId: old.id,
            caseId: old.caseId,
            stepKey: old.stepKey,
            data: old.data ?? {},
            status: old.status,
            reviewNote: old.reviewNote,
            reviewedBy: old.reviewedBy,
            reviewedAt: old.reviewedAt,
            submittedBy: old.submittedBy,
            submittedAt: old.submittedAt,
          });
        }
      }
      const rows: TutorialSubmissionRow[] = await tx
        .insert(tutorialStepSubmissions)
        .values({ caseId, stepKey, ...values })
        .onConflictDoUpdate({
          target: [tutorialStepSubmissions.caseId, tutorialStepSubmissions.stepKey],
          set: values,
        })
        .returning();
      return rows[0];
    });
  }

  /** 重算进度；步骤全部通过或跳过 → 案例置 completed（只从 in_progress 转，取消的不动） */
  async syncCaseProgress(
    kase: TutorialCaseRow,
    outline?: TutorialOutline | null,
  ): Promise<{ progress: number; status: string }> {
    const resolved = outline ?? (await this.content.getOutline(kase.lmsCourse));
    const summary = summarizeCaseProgress(
      resolved,
      await this.loadSubmissions([kase.id]),
    );
    const status = await this.completeIfDone(kase, summary);
    return { progress: summary.progress, status };
  }

  /** 读的时候也顺手补：审核通过那一下 Learning 正好读不到时，下次打开照样会转成已完成 */
  private async completeIfDone(
    kase: TutorialCaseRow,
    summary: CaseProgressSummary,
  ): Promise<string> {
    if (!summary.completed || kase.status !== 'in_progress') return kase.status;
    const now = new Date();
    try {
      await this.db
        .update(tutorialCases)
        .set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(and(eq(tutorialCases.id, kase.id), eq(tutorialCases.status, 'in_progress')));
      kase.status = 'completed';
      kase.completedAt = now;
    } catch (error) {
      this.logger.warn(
        `案例 ${kase.id} 置为已完成失败，下次再补：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return kase.status;
  }

  private completedDate(kase: TutorialCaseRow, status: string): string | null {
    if (status !== 'completed' || !kase.completedAt) return null;
    return shanghaiDateString(kase.completedAt.toISOString());
  }
}
