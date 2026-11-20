import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq } from 'drizzle-orm';
import { rewardLedger } from '@server/database/schema';
import { BindingService } from '../integration/binding.service';
import { PlaneService } from '../integration/plane.service';
import { AilyWebhookService } from '../integration/aily-webhook.service';
import { PerformanceService } from '../performance/performance.service';
import { ProfileService } from '../profile/profile.service';
import { TutorialOutputService } from '../profile/tutorial-output.service';
import { TaskTemplateService } from './task-template.service';
import { TaskReviewService } from './task-review.service';
import { BlockDeferService } from './block-defer.service';
import { SopService } from './sop.service';
import type { TaskViewer } from './task-viewer';
import { ProblemsService } from '../problems/problems.service';
import { DevRequestLookupService } from '../dev-requests/dev-request-lookup.service';
import { DevRequestsService } from '../dev-requests/dev-requests.service';
import { AcceptanceService } from '../acceptance/acceptance.service';
import { applyRhythmPlan, computeProgress } from './rhythm.util';
import {
  TUTORIAL_REWARD_SCORE,
  tutorialOverdueDays,
} from '../profile/tutorial-case.service';
import {
  deriveCurrentAction,
  isSeverelyBlocked,
  mapPriority,
  mapStatusByState,
  OPEN_TASK_STATUSES,
  parseDeadlineTime,
  parseEvidenceSummary,
  parseWorkHours,
  resolveTaskType,
  shanghaiDateString,
  stripHtml,
  TASK_STATUS_LABELS,
  todayDateString,
} from '../integration/plane-mapping';
import type {
  LearningCourseProgress,
  TaskActionResult,
  TutorialTask,
  TaskBlockedInfo,
  TaskDetail,
  TaskEvidenceItem,
  TaskGamification,
  TaskHistoryResponse,
  TaskStatus,
  TaskStatusCounts,
  TaskSummary,
  TaskTemplateSummary,
  TaskTimelineEntry,
  TasksOverview,
} from '@shared/api.interface';
import type {
  TaskAssistRequest,
  TaskBlockRequest,
  TaskEvidenceRequest,
  TaskStatusUpdateRequest,
} from '@shared/api.interface';

interface PlaneProjectRaw {
  id: string;
  name: string;
  identifier: string;
}

interface PlaneStateRaw {
  id: string;
  name: string;
  slug: string;
  group: string;
  sequence: number;
}

interface PlaneIssueRaw {
  id: string;
  name: string;
  project: string;
  state: string;
  priority: string;
  assignees: string[];
  target_date: string | null;
  parent: string | null;
  description_html: string | null;
  created_at: string;
  sequence_id: number | null;
  labels?: string[];
  completed_at?: string | null;
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
}

interface PlaneCommentRaw {
  id: string;
  comment_html: string;
  created_at: string;
  created_by: string;
}

/** 按负责人分组的一条任务：员工端同款摘要 + Plane 原始完成时刻（判逾期完成要精确到分钟） */
export interface AssignedTaskRecord {
  task: TaskSummary;
  completedAtIso: string | null;
}

const EMPTY_COUNTS: TaskStatusCounts = {
  todo: 0,
  inProgress: 0,
  waiting: 0,
  blocked: 0,
  readyForReview: 0,
  rejected: 0,
  done: 0,
  cancelled: 0,
};

const EMPTY_GAMIFICATION: TaskGamification = {
  streakDays: 0,
  todayTotal: 0,
  todayDone: 0,
  walletMonth: 0,
  walletTotal: 0,
  walletPending: 0,
};

/** 任务不存在与不是本人的任务同一句话、同一个 404，不暴露存在与否 */
const TASK_NOT_FOUND = '任务不存在';

/**
 * Plane 的项目、任务 ID 都是 UUID。拼进 Plane 路径前先校验，
 * 防止在 ID 里塞 ?、#、../ 改写请求路径，让归属判断看的和实际读写的不是同一个任务
 */
const PLANE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 子任务往上找父任务最多几层，防脏数据成环 */
const MAX_PARENT_DEPTH = 5;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly bindingService: BindingService,
    private readonly performanceService: PerformanceService,
    private readonly profileService: ProfileService,
    private readonly tutorialOutputService: TutorialOutputService,
    private readonly taskTemplateService: TaskTemplateService,
    private readonly taskReviewService: TaskReviewService,
    private readonly blockDeferService: BlockDeferService,
    private readonly sopService: SopService,
    private readonly problemsService: ProblemsService,
    private readonly ailyWebhook: AilyWebhookService,
    private readonly devRequestLookup: DevRequestLookupService,
    private readonly devRequests: DevRequestsService,
    private readonly acceptance: AcceptanceService,
  ) {}

  private async loadProjects(): Promise<PlaneProjectRaw[]> {
    return this.plane.listProjects<PlaneProjectRaw>();
  }

  private async loadStates(projectId: string): Promise<PlaneStateRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneStateRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/states/`,
    );
    return res.results ?? [];
  }

  private readonly historyIssuesCache = new Map<
    string,
    { at: number; issues: PlaneIssueRaw[] }
  >();

  private async loadHistoryIssues(projectId: string): Promise<PlaneIssueRaw[]> {
    const hit = this.historyIssuesCache.get(projectId);
    if (hit && Date.now() - hit.at < 15_000) return hit.issues;
    const issues = await this.loadIssues(projectId);
    this.historyIssuesCache.set(projectId, { at: Date.now(), issues });
    return issues;
  }

  private async loadIssues(projectId: string): Promise<PlaneIssueRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneIssueRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/issues/`,
      15_000,
    );
    return res.results ?? [];
  }

  private async loadProjectIssuesBatch(
    projects: PlaneProjectRaw[],
    issuesLoader: (projectId: string) => Promise<PlaneIssueRaw[]>,
  ): Promise<
    Array<{
      project: PlaneProjectRaw;
      states: PlaneStateRaw[];
      labels: PlaneLabelRaw[];
      issues: PlaneIssueRaw[];
    }>
  > {
    const loaded: Array<{
      project: PlaneProjectRaw;
      states: PlaneStateRaw[];
      labels: PlaneLabelRaw[];
      issues: PlaneIssueRaw[];
    }> = [];
    for (let i = 0; i < projects.length; i += 4) {
      const chunk: PlaneProjectRaw[] = projects.slice(i, i + 4);
      const part = await Promise.all(
        chunk.map(async (project: PlaneProjectRaw) => ({
          project,
          states: await this.loadStates(project.id),
          labels: await this.loadLabels(project.id),
          issues: await issuesLoader(project.id),
        })),
      );
      loaded.push(...part);
    }
    return loaded;
  }

  private async loadLabels(projectId: string): Promise<PlaneLabelRaw[]> {
    const res = await this.plane.cachedGet<
      PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
    >(`${this.plane.workspacePath}/projects/${projectId}/labels/`);
    if (Array.isArray(res)) return res;
    return res.results ?? [];
  }

  private async loadMembers(): Promise<PlaneMemberRaw[]> {
    const res = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    return Array.isArray(res) ? res : [];
  }

  private memberName(
    members: PlaneMemberRaw[],
    memberId: string | undefined,
  ): string {
    if (!memberId) return '未指派';
    const member = members.find((m: PlaneMemberRaw) => m.id === memberId);
    if (!member) return '未知成员';
    return member.first_name || member.display_name || '未知成员';
  }

  private labelNamesOf(
    issue: PlaneIssueRaw,
    labels: PlaneLabelRaw[],
  ): string[] {
    return (issue.labels ?? [])
      .map((id: string) => labels.find((l: PlaneLabelRaw) => l.id === id)?.name)
      .filter((n: string | undefined): n is string => Boolean(n));
  }

  private buildSummary(
    issue: PlaneIssueRaw,
    project: PlaneProjectRaw,
    states: PlaneStateRaw[],
    labels: PlaneLabelRaw[],
  ): TaskSummary {
    const state = states.find((s: PlaneStateRaw) => s.id === issue.state);
    const status: TaskStatus = state
      ? mapStatusByState(state)
      : 'TODO';
    const { priority, priorityLabel } = mapPriority(issue.priority ?? 'none');
    const { taskType, rewardAmount } = resolveTaskType(
      issue.name,
      this.labelNamesOf(issue, labels),
    );
    const today = todayDateString();
    const deadlineTime = parseDeadlineTime(issue.name);
    return {
      id: issue.id,
      projectId: project.id,
      projectName: project.name,
      sequenceId: issue.sequence_id,
      title: issue.name,
      status,
      statusLabel: TASK_STATUS_LABELS[status],
      priority,
      priorityLabel,
      deadline: issue.target_date,
      deadlineTime,
      currentAction: deriveCurrentAction(issue.description_html),
      isToday: Boolean(issue.target_date && issue.target_date.startsWith(today)),
      taskType,
      rewardAmount,
      evidenceSummary: parseEvidenceSummary(issue.description_html),
      ...parseWorkHours(issue.description_html),
      estimatedEarning: null,
      severeBlocked: isSeverelyBlocked(status, issue.target_date, deadlineTime),
      completedAt: issue.completed_at
        ? shanghaiDateString(issue.completed_at)
        : null,
      stateName: state?.name ?? null,
    };
  }

  /**
   * 开发需求打标：报价、交付、验收都去开发需求页（任务卡点进去也引导过去）。
   * 开发需求的钱只记账（开发需求台账），不出「绩效估算」、不进钱包，也不摊进当月任务数
   */
  private async markDevRequests(summaries: TaskSummary[]): Promise<void> {
    const idMap = await this.devRequestLookup.idMapByIssueIds(
      summaries.map((t: TaskSummary) => t.id),
    );
    for (const task of summaries) {
      const devRequestId = idMap.get(task.id);
      if (devRequestId) {
        task.devRequestId = devRequestId;
        task.estimatedEarning = null;
      }
    }
  }

  async getOverview(userId: string): Promise<TasksOverview> {
    const [binding, learning, monthlyBonus] = await Promise.all([
      this.bindingService.getBinding(userId),
      this.profileService.getMyLearning(userId).catch((): null => null),
      this.performanceService
        .getExpectedBonusForEmployee(userId)
        .catch((): null => null),
    ]);
    const tutorialTasks: TutorialTask[] = (learning?.courses ?? [])
      .filter(
        (c: LearningCourseProgress) =>
          c.category === 'tutorial' && c.completedAt === null,
      )
      .sort(
        (a: LearningCourseProgress, b: LearningCourseProgress) =>
          a.progress - b.progress,
      )
      .map((c: LearningCourseProgress): TutorialTask => {
        const overdueDays = tutorialOverdueDays(c.startedAt ?? null);
        return {
          ...c,
          caseId: Number(c.id.replace('tutorial_case_', '')),
          rewardScore: TUTORIAL_REWARD_SCORE,
          rewardAmount:
            monthlyBonus !== null
              ? Math.round((monthlyBonus / 100) * TUTORIAL_REWARD_SCORE * 10) /
                10
              : null,
          severeBlocked: overdueDays !== null,
          blockedReason:
            c.hasRejectedStep === true
              ? 'step_rejected'
              : overdueDays !== null
                ? 'overdue'
                : null,
          overdueDays,
        };
      });
    if (!binding) {
      return {
        bound: false,
        counts: EMPTY_COUNTS,
        gamification: EMPTY_GAMIFICATION,
        topTask: null,
        todayTasks: [],
        openTasks: [],
        doneTasks: [],
        tutorialTasks,
        templates: [],
        progress: null,
        deferMinutes: 30,
      };
    }
    const projects = await this.loadProjects();
    const summaries: TaskSummary[] = [];
    const isSubtaskOf: boolean[] = [];
    const completedAtList: (string | null)[] = [];
    const loadedProjects = await this.loadProjectIssuesBatch(
      projects,
      (projectId: string) => this.loadIssues(projectId),
    );
    for (const { project, states, labels, issues } of loadedProjects) {
      for (const issue of issues) {
        if (!(issue.assignees ?? []).includes(binding.planeMemberId)) continue;
        summaries.push(this.buildSummary(issue, project, states, labels));
        isSubtaskOf.push(issue.parent != null);
        completedAtList.push(issue.completed_at ?? null);
      }
    }
    await this.markDevRequests(summaries);
    this.applyMonthlyEarning(summaries, isSubtaskOf, monthlyBonus);
    const counts: TaskStatusCounts = { ...EMPTY_COUNTS };
    for (const [index, task] of summaries.entries()) {
      if (isSubtaskOf[index]) continue;
      if (task.status === 'TODO') counts.todo += 1;
      else if (task.status === 'IN_PROGRESS') counts.inProgress += 1;
      else if (task.status === 'WAITING') counts.waiting += 1;
      else if (task.status === 'BLOCKED') counts.blocked += 1;
      else if (task.status === 'READY_FOR_REVIEW') counts.readyForReview += 1;
      else if (task.status === 'REJECTED') counts.rejected += 1;
      else if (task.status === 'DONE') counts.done += 1;
      else counts.cancelled += 1;
    }
    const openTasks = summaries
      .filter((t: TaskSummary) => OPEN_TASK_STATUSES.includes(t.status))
      .sort((a: TaskSummary, b: TaskSummary) => {
        const rankA = mapPriority(a.priority).rank;
        const rankB = mapPriority(b.priority).rank;
        if (rankA !== rankB) return rankA - rankB;
        return (a.deadline ?? '9999-99-99').localeCompare(
          b.deadline ?? '9999-99-99',
        );
      });
    const todayAllTasks = summaries.filter(
      (t: TaskSummary, index: number) => !isSubtaskOf[index] && t.isToday,
    );
    const todayTasks = applyRhythmPlan(
      openTasks.filter((t: TaskSummary) => t.isToday),
    );
    const doneTasks = summaries
      .filter(
        (t: TaskSummary, index: number) =>
          !isSubtaskOf[index] && t.status === 'DONE',
      )
      .sort(
        (a: TaskSummary, b: TaskSummary) =>
          (b.completedAt ?? '').localeCompare(a.completedAt ?? ''),
      );
    const templates = await this.taskTemplateService
      .listForOverview(binding.planeMemberId, summaries)
      .catch((): TaskTemplateSummary[] => []);
    const progress = computeProgress({
      tasks: todayAllTasks,
      completedIsoList: todayAllTasks
        .filter((t: TaskSummary) => t.status === 'DONE')
        .map((t: TaskSummary) => t.completedAt)
        .filter((iso: string | null): iso is string => iso !== null),
      now: new Date(),
    });
    const deferMinutes = await this.blockDeferService
      .getDeferMinutes()
      .catch((): number => 30);
    const gamification = await this.buildGamification(
      userId,
      summaries,
      isSubtaskOf,
      completedAtList,
    );
    return {
      bound: true,
      counts,
      gamification,
      topTask: openTasks[0] ?? null,
      todayTasks,
      openTasks,
      doneTasks,
      tutorialTasks,
      templates,
      progress,
      deferMinutes,
    };
  }

  /**
   * 管理端任务统筹取数：按绑定成员返回今日全部任务（含已完成，排除取消）。
   * 复用员工端同款 Plane 解析与逾期/severe 口径（buildSummary / loadHistoryIssues）。
   */
  async getTodayTasksForMember(userId: string): Promise<TaskSummary[] | null> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding) return null;
    const projects = await this.loadProjects();
    const summaries: TaskSummary[] = [];
    const loadedProjects = await this.loadProjectIssuesBatch(
      projects,
      (projectId: string) => this.loadHistoryIssues(projectId),
    );
    for (const { project, states, labels, issues } of loadedProjects) {
      for (const issue of issues) {
        if (!(issue.assignees ?? []).includes(binding.planeMemberId)) continue;
        const task = this.buildSummary(issue, project, states, labels);
        if (!task.isToday || task.status === 'CANCELLED') continue;
        summaries.push(task);
      }
    }
    return summaries;
  }

  /**
   * 管理端「按日期看」取数：全部项目的任务只拉一遍（与 getTodayTasksForMember 同一套缓存与解析口径），
   * 按负责人的 Plane 成员 ID 分组，排除取消；多人负责的任务每人各算一份。调用方按员工绑定归人，
   * 不用每个员工各扫一遍全部项目。
   */
  async getTasksByAssignee(): Promise<Map<string, AssignedTaskRecord[]>> {
    const projects = await this.loadProjects();
    const loadedProjects = await this.loadProjectIssuesBatch(
      projects,
      (projectId: string) => this.loadHistoryIssues(projectId),
    );
    const byMember = new Map<string, AssignedTaskRecord[]>();
    for (const { project, states, labels, issues } of loadedProjects) {
      for (const issue of issues) {
        const assignees = new Set(issue.assignees ?? []);
        if (assignees.size === 0) continue;
        const task = this.buildSummary(issue, project, states, labels);
        if (task.status === 'CANCELLED') continue;
        const record: AssignedTaskRecord = {
          task,
          completedAtIso: issue.completed_at ?? null,
        };
        for (const memberId of assignees) {
          const list = byMember.get(memberId);
          if (list) list.push(record);
          else byMember.set(memberId, [record]);
        }
      }
    }
    return byMember;
  }

  async getHistory(
    userId: string,
    query: { date?: string; scope?: string; keyword?: string },
  ): Promise<TaskHistoryResponse> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding) {
      return { bound: false, items: [], total: 0 };
    }
    const date = query.date ?? todayDateString();
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    ) {
      throw new BadRequestException('date 格式应为 YYYY-MM-DD');
    }
    const scope =
      query.scope === 'week' || query.scope === 'month'
        ? query.scope
        : 'day';
    const keyword = query.keyword?.trim() ?? '';
    const summaries: TaskSummary[] = [];
    const allSummaries: TaskSummary[] = [];
    const projects = await this.loadProjects();
    const loadedProjects = await this.loadProjectIssuesBatch(
      projects,
      (projectId: string) => this.loadHistoryIssues(projectId),
    );
    for (const { project, states, labels, issues } of loadedProjects) {
      for (const issue of issues) {
        if (!(issue.assignees ?? []).includes(binding.planeMemberId)) continue;
        if (issue.parent != null) continue;
        const task = this.buildSummary(issue, project, states, labels);
        allSummaries.push(task);
        if (task.status !== 'DONE') continue;
        summaries.push(task);
      }
    }
    const monthlyBonus: number | null = await this.performanceService
      .getExpectedBonusForEmployee(userId)
      .catch((): null => null);
    await this.markDevRequests(allSummaries);
    this.applyMonthlyEarning(allSummaries, null, monthlyBonus);
    let items: TaskSummary[] = summaries;
    if (keyword) {
      items = items.filter((t: TaskSummary) =>
        /^\d+$/u.test(keyword)
          ? t.sequenceId === Number(keyword)
          : t.title.includes(keyword),
      );
    } else if (scope === 'day') {
      items = items.filter((t: TaskSummary) => t.completedAt === date);
    } else if (scope === 'week') {
      const base = Date.parse(`${date}T00:00:00Z`);
      const dow = new Date(base).getUTCDay();
      const mondayMs = base - ((dow + 6) % 7) * 86_400_000;
      const weekStart = new Date(mondayMs).toISOString().slice(0, 10);
      const weekEnd = new Date(
        mondayMs + 6 * 86_400_000,
      ).toISOString().slice(0, 10);
      items = items.filter(
        (t: TaskSummary) =>
          t.completedAt !== null &&
          t.completedAt >= weekStart &&
          t.completedAt <= weekEnd,
      );
    } else {
      const month = date.slice(0, 7);
      items = items.filter((t: TaskSummary) =>
        (t.completedAt ?? '').startsWith(month),
      );
    }
    const sorted = [...items].sort(
      (a: TaskSummary, b: TaskSummary) =>
        (b.completedAt ?? '').localeCompare(a.completedAt ?? ''),
    );
    return { bound: true, items: sorted, total: sorted.length };
  }

  private async buildGamification(
    userId: string,
    summaries: TaskSummary[],
    isSubtaskOf: boolean[],
    completedAtList: (string | null)[],
  ): Promise<TaskGamification> {
    const today = todayDateString();
    const month = today.slice(0, 7);
    const completedDays = new Set<string>();
    let walletTotal = 0;
    let walletMonth = 0;
    let walletPending = 0;
    let todayTotal = 0;
    let todayDone = 0;
    for (const [index, task] of summaries.entries()) {
      if (isSubtaskOf[index]) continue;
      const completedAt = completedAtList[index] ?? null;
      const doneDay = completedAt ? shanghaiDateString(completedAt) : null;
      if (task.status === 'DONE') {
        if (doneDay) completedDays.add(doneDay);
        if (
          task.taskType === 'delegated' &&
          task.rewardAmount !== null &&
          !task.devRequestId
        ) {
          walletTotal += task.rewardAmount;
          if (doneDay && doneDay.slice(0, 7) === month) {
            walletMonth += task.rewardAmount;
          }
        }
        if (task.isToday) {
          todayTotal += 1;
          todayDone += 1;
        }
      } else if (task.status !== 'CANCELLED') {
        if (
          task.taskType === 'delegated' &&
          task.rewardAmount !== null &&
          !task.devRequestId
        ) {
          walletPending += task.rewardAmount;
        }
        if (task.isToday) todayTotal += 1;
      }
    }
    // 安灯链路：问题发现奖励流水累加进钱包（总额 + 上海日历月），失败不阻断
    try {
      const ledgerRows = await this.db
        .select({
          amount: rewardLedger.amount,
          createdAt: rewardLedger.createdAt,
        })
        .from(rewardLedger)
        .where(
          and(
            eq(rewardLedger.beneficiary, userId),
            eq(rewardLedger.type, 'problem_bounty'),
          ),
        );
      for (const ledger of ledgerRows) {
        const amount = Number(ledger.amount);
        if (!Number.isFinite(amount)) continue;
        walletTotal += amount;
        if (
          shanghaiDateString(ledger.createdAt.toISOString()).slice(0, 7) ===
          month
        ) {
          walletMonth += amount;
        }
      }
    } catch (error) {
      this.logger.warn(
        `问题奖励钱包累加失败（用户 ${userId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let streakDays = 0;
    let cursor = new Date(`${today}T00:00:00Z`);
    if (!completedDays.has(today)) {
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    while (completedDays.has(cursor.toISOString().slice(0, 10))) {
      streakDays += 1;
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    return {
      streakDays,
      todayTotal,
      todayDone,
      walletMonth,
      walletTotal,
      walletPending,
    };
  }

  private applyMonthlyEarning(
    summaries: TaskSummary[],
    isSubtaskOf: boolean[] | null,
    bonus: number | null,
  ): void {
    if (bonus === null || bonus <= 0) return;
    const month = todayDateString().slice(0, 7);
    let monthlyCount = 0;
    for (const [index, task] of summaries.entries()) {
      if (isSubtaskOf !== null && isSubtaskOf[index]) continue;
      if (task.taskType === 'delegated') continue;
      if (task.devRequestId) continue;
      if (task.status === 'CANCELLED') continue;
      if (!(task.deadline ?? '').startsWith(month)) continue;
      monthlyCount += 1;
    }
    if (monthlyCount === 0) return;
    const share = Math.round((bonus / monthlyCount) * 10) / 10;
    for (const task of summaries) {
      if (
        task.taskType !== 'delegated' &&
        !task.devRequestId &&
        task.status !== 'CANCELLED'
      ) {
        task.estimatedEarning = share;
      }
    }
  }

  private async findIssueProjectId(
    taskId: string,
    projectId?: string,
  ): Promise<string> {
    if (projectId) return projectId;
    return (await this.locateIssue(taskId)).projectId;
  }

  /** 不知道项目时按任务 ID 找：先翻各项目任务列表缓存，翻不到再逐个项目直取 */
  private async locateIssue(
    taskId: string,
  ): Promise<{ projectId: string; issue: PlaneIssueRaw }> {
    const projects = await this.loadProjects();
    for (const project of projects) {
      const issues = await this.loadIssues(project.id);
      const issue = issues.find((i: PlaneIssueRaw) => i.id === taskId);
      if (issue) return { projectId: project.id, issue };
    }
    for (const project of projects) {
      const issue = await this.plane.getOptional<PlaneIssueRaw>(
        `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`,
      );
      if (issue) return { projectId: project.id, issue };
    }
    throw new NotFoundException(TASK_NOT_FOUND);
  }

  /**
   * 员工端任务权限：boss/admin 本人不限；其他人（含演示视角）只认指派给本人绑定 Plane 成员的任务，
   * 没绑定的什么都碰不了。返回判断函数，只看已经拉到的 assignees，不为校验多打 Plane
   */
  private async assigneeMatcher(
    viewer: TaskViewer,
  ): Promise<(issue: PlaneIssueRaw) => boolean> {
    if (viewer.fullAccess) return () => true;
    const binding = await this.bindingService.getBinding(viewer.userId);
    if (!binding) return () => false;
    return (issue: PlaneIssueRaw) =>
      (issue.assignees ?? []).includes(binding.planeMemberId);
  }

  /**
   * 子任务沿用详情页原有口径：父任务详情本来就列出全部子任务（不论指派给谁），
   * 所以往上任一层父任务是自己的，这条子任务也能看——只能看，操作仍只认它自己的指派。
   * 父任务先在已经拉到的项目任务列表里找，列表里没有（超出首页）才单取，单取走 15 秒缓存
   */
  private async hasAncestorMatching(
    issue: PlaneIssueRaw,
    projectId: string,
    projectIssues: PlaneIssueRaw[],
    matches: (issue: PlaneIssueRaw) => boolean,
  ): Promise<boolean> {
    let parentId: string | null = issue.parent;
    for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth += 1) {
      const currentId: string = parentId;
      const parent =
        projectIssues.find((i: PlaneIssueRaw) => i.id === currentId) ??
        (await this.plane.getOptionalCached<PlaneIssueRaw>(
          `${this.plane.workspacePath}/projects/${projectId}/issues/${currentId}/`,
        ));
      if (!parent) return false;
      if (matches(parent)) return true;
      parentId = parent.parent;
    }
    return false;
  }

  /**
   * 员工端写操作统一取任务：每次实读 Plane（状态要准，不走缓存），同时判归属，
   * 不是指派给自己的（boss/admin 本人除外）与任务不存在同样 404
   */
  private async loadOperableIssue(
    projectId: string,
    taskId: string,
    viewer: TaskViewer,
  ): Promise<PlaneIssueRaw> {
    if (!PLANE_ID_RE.test(projectId) || !PLANE_ID_RE.test(taskId)) {
      throw new NotFoundException(TASK_NOT_FOUND);
    }
    const [issue, isMine] = await Promise.all([
      this.plane.getOptional<PlaneIssueRaw>(
        `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/`,
      ),
      this.assigneeMatcher(viewer),
    ]);
    if (!issue || !isMine(issue)) throw new NotFoundException(TASK_NOT_FOUND);
    return issue;
  }

  /**
   * 员工把工单挂到任务上（POST /api/work-orders 带 taskId）之前调：只能挂自己的任务，boss/admin 本人不限。
   * 工单终审通过会把关联任务置完成，不校验就能借工单改别人的任务；不是本人的同样 404
   */
  async assertOperableTask(taskId: string, viewer: TaskViewer): Promise<void> {
    if (viewer.fullAccess) return;
    if (!PLANE_ID_RE.test(taskId)) throw new NotFoundException(TASK_NOT_FOUND);
    const [isMine, { issue }] = await Promise.all([
      this.assigneeMatcher(viewer),
      this.locateIssue(taskId),
    ]);
    if (!isMine(issue)) throw new NotFoundException(TASK_NOT_FOUND);
  }

  private parseBlockedInfo(
    comments: PlaneCommentRaw[],
    members: PlaneMemberRaw[],
  ): TaskBlockedInfo | null {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const text = stripHtml(comments[i].comment_html);
      if (!text.includes('【阻塞】')) continue;
      const reasonMatch = /原因：(.+?)(；|$)/u.exec(text);
      const waitMatch = /等待：(.+?)(；|$)/u.exec(text);
      const nextMatch = /下一步：(.+?)(；|$)/u.exec(text);
      return {
        reason: reasonMatch?.[1] ?? '未知原因',
        waitingFor: waitMatch?.[1] ?? '未说明',
        nextAction: nextMatch?.[1] ?? '未说明',
        since: comments[i].created_at,
      };
    }
    return null;
  }

  private async moveToStatus(
    projectId: string,
    taskId: string,
    status: TaskStatus,
  ): Promise<boolean> {
    const states = await this.loadStates(projectId);
    const candidates = states
      .filter((s: PlaneStateRaw) => mapStatusByState(s) === status)
      .sort((a: PlaneStateRaw, b: PlaneStateRaw) => a.sequence - b.sequence);
    const target = candidates[0];
    if (!target) return false;
    await this.plane.patch(
      `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/`,
      { state: target.id },
    );
    return true;
  }

  /**
   * 任务详情。viewer：员工端必传，只能看指派给自己的任务（及父任务是自己的子任务），
   * 不是的与不存在同样 404；不传 = 系统身份（豆包 MCP 走 /openapi/mcp，key 即老板），不做本人校验
   */
  async getDetail(
    taskId: string,
    projectId?: string,
    viewer?: TaskViewer,
  ): Promise<TaskDetail> {
    if (
      !PLANE_ID_RE.test(taskId) ||
      (projectId && !PLANE_ID_RE.test(projectId))
    ) {
      throw new NotFoundException(TASK_NOT_FOUND);
    }
    const resolvedProjectId = await this.findIssueProjectId(taskId, projectId);
    const [issue, isMine] = await Promise.all([
      this.plane.getOptionalCached<PlaneIssueRaw>(
        `${this.plane.workspacePath}/projects/${resolvedProjectId}/issues/${taskId}/`,
      ),
      viewer ? this.assigneeMatcher(viewer) : null,
    ]);
    if (!issue) throw new NotFoundException(TASK_NOT_FOUND);
    // 项目任务列表下面列子任务要用，先拉，判父任务归属直接复用；没权限就不再往下拉状态、评论
    const allIssues = await this.loadIssues(resolvedProjectId);
    let readOnly = false;
    if (isMine && !isMine(issue)) {
      const viaParent = await this.hasAncestorMatching(
        issue,
        resolvedProjectId,
        allIssues,
        isMine,
      );
      if (!viaParent) throw new NotFoundException(TASK_NOT_FOUND);
      readOnly = true;
    }
    const projects = await this.loadProjects();
    const project = projects.find(
      (p: PlaneProjectRaw) => p.id === resolvedProjectId,
    );
    const projectForName: PlaneProjectRaw =
      project ?? { id: resolvedProjectId, name: '未知项目', identifier: '' };
    const states = await this.loadStates(resolvedProjectId);
    const labels = await this.loadLabels(resolvedProjectId);
    const members = await this.loadMembers();
    const task = this.buildSummary(issue, projectForName, states, labels);
    const objective = stripHtml(issue.description_html) || null;
    const ownerName = this.memberName(members, (issue.assignees ?? [])[0]);
    const subTasks = allIssues
      .filter((i: PlaneIssueRaw) => i.parent === taskId)
      .map((i: PlaneIssueRaw) =>
        this.buildSummary(i, projectForName, states, labels),
      );
    const commentsRes = await this.plane.cachedGet<{
      results: PlaneCommentRaw[];
    }>(
      `${this.plane.workspacePath}/projects/${resolvedProjectId}/issues/${taskId}/comments/`,
      15_000,
    );
    const comments = commentsRes.results ?? [];
    const timeline: TaskTimelineEntry[] = [
      {
        id: 'created',
        actorName: this.memberName(members, (issue.assignees ?? [])[0]),
        content: '任务创建',
        createdAt: issue.created_at,
      },
      ...comments.map((c: PlaneCommentRaw) => ({
        id: c.id,
        actorName: this.memberName(members, c.created_by),
        content: stripHtml(c.comment_html) || '（空）',
        createdAt: c.created_at,
      })),
    ];
    const tutorialMatch = /教程：(.+?)｜预计\s*(\d+)\s*分钟/u.exec(
      objective ?? '',
    );
    return {
      task,
      objective,
      ownerName,
      subTasks,
      timeline,
      blockedInfo: this.parseBlockedInfo(comments, members),
      relatedTutorial: tutorialMatch
        ? { title: tutorialMatch[1], durationMinutes: Number(tutorialMatch[2]) }
        : null,
      evidenceChecklist: this.parseEvidenceChecklist(objective, comments),
      evidenceFileUrls: this.extractEvidenceFileUrls(comments),
      tutorialOutput: await this.tutorialOutputService.getByTaskId(taskId),
      blockDefer: await this.blockDeferService
        .getLatestByTask(taskId)
        .catch((): null => null),
      readOnly,
      devRequestId:
        (await this.devRequestLookup.idMapByIssueIds([taskId])).get(taskId) ?? null,
    };
  }

  private extractEvidenceFileUrls(comments: PlaneCommentRaw[]): string[] {
    const urls = new Set<string>();
    for (const c of comments) {
      const text = stripHtml(c.comment_html);
      if (!text.startsWith('【验收凭证】')) continue;
      const matches = text.match(/https?:\/\/[^\s<>"']+/gu) ?? [];
      for (const url of matches) {
        urls.add(url.replace(/&amp;/gu, '&'));
      }
    }
    return [...urls];
  }

  private parseEvidenceChecklist(
    objective: string | null,
    comments: PlaneCommentRaw[],
  ): TaskEvidenceItem[] {
    const acceptanceLine = (objective ?? '')
      .split('\n')
      .find((line: string) => line.startsWith('验收条件='));
    if (!acceptanceLine) return [];
    const materials = acceptanceLine
      .replace('验收条件=', '')
      .split(/[+＋]/u)
      .map((name: string) => name.trim())
      .filter((name: string) => name.length > 0);
    if (materials.length === 0) return [];
    const submitted = new Set<string>();
    for (const c of comments) {
      const text = stripHtml(c.comment_html);
      const match = /已提交材料：(.+)/u.exec(text);
      if (!match) continue;
      for (const name of match[1].split(/[；;]/u)) {
        const trimmed = name.trim();
        if (trimmed) submitted.add(trimmed);
      }
    }
    return materials.map((name: string) => ({
      name,
      submitted: submitted.has(name),
    }));
  }

  async updateStatus(
    taskId: string,
    dto: TaskStatusUpdateRequest,
    viewer: TaskViewer,
  ): Promise<TaskActionResult> {
    await this.loadOperableIssue(dto.projectId, taskId, viewer);
    // 开发需求：开始 / 完成 / 取消都不许从任务卡绕过报价确认和验收，只放行「解除阻塞」
    const devRequest = await this.devRequestLookup.findByIssueId(taskId);
    if (devRequest) {
      return this.devRequests.handleGenericStatus(devRequest, dto.status, viewer);
    }
    const changed = await this.moveToStatus(dto.projectId, taskId, dto.status);
    if (!changed) {
      throw new BadRequestException(
        '当前项目没有配置对应的状态，无法流转。请联系管理员在 Plane 中补充状态。',
      );
    }
    if (dto.status === 'DONE') {
      void this.taskReviewService.markSettled(taskId, 'approved');
      void this.blockDeferService.cancelByTask(taskId);
    } else if (dto.status === 'CANCELLED') {
      void this.taskReviewService.markSettled(taskId, 'cancelled');
      void this.blockDeferService.cancelByTask(taskId);
    }
    return {
      ok: true,
      stateChanged: true,
      message: `状态已更新为「${TASK_STATUS_LABELS[dto.status]}」`,
    };
  }

  private async postComment(
    projectId: string,
    taskId: string,
    commentHtml: string,
  ): Promise<void> {
    await this.plane.post(
      `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/comments/`,
      { comment_html: commentHtml },
    );
  }

  async block(
    taskId: string,
    dto: TaskBlockRequest,
    viewer: TaskViewer,
  ): Promise<TaskActionResult> {
    const issue = await this.loadOperableIssue(dto.projectId, taskId, viewer);
    // 开发需求：只有开发中能报阻塞（原有语义不变），解除阻塞回到「开发交付」
    const devRequest = await this.devRequestLookup.findByIssueId(taskId);
    if (devRequest) {
      await this.devRequests.assertGenericBlockAllowed(devRequest);
    }
    const userId = viewer.userId;
    const category = dto.category ?? 'other';
    const commentHtml =
      `<p>【阻塞】原因：${escapeHtml(dto.reason)}；` +
      `等待：${escapeHtml(dto.waitingFor)}；` +
      `下一步：${escapeHtml(dto.nextAction)}；` +
      `分类：${escapeHtml(category)}；` +
      `解决情况和方案：${escapeHtml(dto.resolution)}</p>`;
    await this.postComment(dto.projectId, taskId, commentHtml);
    const changed = await this.moveToStatus(
      dto.projectId,
      taskId,
      'BLOCKED',
    );
    let message = changed
      ? '阻塞已提交，任务已标记为阻塞'
      : '阻塞已记录（当前项目未配置阻塞状态，状态未流转）';
    if (devRequest) {
      void this.devRequests.recordGenericBlock(devRequest, viewer, dto.reason, changed);
    }
    const members = await this.loadMembers();
    const assigneeName = this.memberName(
      members,
      (issue.assignees ?? [])[0],
    );
    void this.sopService
      .generateForBlock({
        taskId,
        taskTitle: issue.name,
        sequenceId: issue.sequence_id ?? null,
        category,
        reason: dto.reason,
        resolution: dto.resolution,
        authorName: assigneeName,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `SOP 自动生成入库失败（任务 ${taskId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    if (dto.deferRequested) {
      try {
        const projects = await this.loadProjects();
        const projectName =
          projects.find((p: PlaneProjectRaw) => p.id === dto.projectId)
            ?.name ?? '';
        const deferInfo = await this.blockDeferService.submitBlockDefer({
          taskId,
          projectId: dto.projectId,
          projectName,
          title: issue.name,
          sequenceId: issue.sequence_id ?? null,
          assigneeName,
          userId,
          reason: dto.reason,
          resolution: dto.resolution,
          category,
          originalDeadline: parseDeadlineTime(issue.name),
        });
        message += `；已提交顺延申请（${deferInfo.originalDeadline} → ${deferInfo.requestedDeadline}），${
          deferInfo.status === 'pending' ? '等待 AI 初审与老板终审' : '等待老板终审'
        }`;
      } catch (error) {
        this.logger.warn(
          `顺延申请提交失败（任务 ${taskId}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        message += `；顺延申请提交失败：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (dto.deriveProblem) {
      try {
        await this.problemsService.deriveProblem(userId, {
          title: dto.reason.slice(0, 255),
          category,
          taskId,
          description: `等待：${dto.waitingFor}；下一步：${dto.nextAction}；解决情况和方案：${dto.resolution}`,
          waitingFor: dto.waitingFor.slice(0, 100),
        });
        message += '；已衍生问题工单，等待响应';
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`衍生问题工单失败（任务 ${taskId}）：${detail}`);
        message += `；衍生问题工单失败：${detail}`;
      }
    }
    return {
      ok: true,
      stateChanged: changed,
      message,
    };
  }

  async submitEvidence(
    taskId: string,
    dto: TaskEvidenceRequest,
    viewer: TaskViewer,
  ): Promise<TaskActionResult> {
    const issue = await this.loadOperableIssue(dto.projectId, taskId, viewer);
    // 开发需求：开发交付中交凭证 = 交付（同样只有开发者、报价确认过），别的环节拒绝
    const devRequest = await this.devRequestLookup.findByIssueId(taskId);
    if (devRequest) {
      return this.devRequests.handleGenericEvidence(devRequest, dto, viewer);
    }
    const linksHtml = (dto.links ?? [])
      .map((l: string) => `<br/>${escapeHtml(l)}`)
      .join('');
    const materialsHtml =
      dto.materials && dto.materials.length > 0
        ? `<br/>已提交材料：${dto.materials.map((m: string) => escapeHtml(m)).join('；')}`
        : '';
    const commentHtml = `<p>【验收凭证】${escapeHtml(dto.notes)}${materialsHtml}${linksHtml}</p>`;
    const evidenceText = [
      `【验收凭证】${dto.notes}`,
      dto.materials && dto.materials.length > 0
        ? `已提交材料：${dto.materials.join('；')}`
        : '',
      ...(dto.links ?? []),
    ]
      .filter((part: string) => part !== '')
      .join(' ');
    await this.postComment(dto.projectId, taskId, commentHtml);
    // 每交一次记一版（11-10 A02）：Plane 评论里那份照旧，工作台库里另存一版，验收指向具体那一版
    const version = await this.acceptance.recordTaskVersion({
      taskId,
      notes: dto.notes,
      materials: dto.materials ?? [],
      links: dto.links ?? [],
      submittedBy: viewer.userId,
    });
    const changed = await this.moveToStatus(
      dto.projectId,
      taskId,
      'READY_FOR_REVIEW',
    );
    if (changed) {
      void this.maybeDispatchAiReview(dto.projectId, issue, {
        evidenceUrls: dto.links ?? [],
        evidenceText,
      });
    }
    return {
      ok: true,
      stateChanged: changed,
      message: changed
        ? `验收凭证已提交${version !== null ? `（第 ${version} 版）` : ''}，等待验收`
        : '验收凭证已记录（当前项目未配置待验收状态，状态未流转）',
    };
  }

  private async maybeDispatchAiReview(
    projectId: string,
    issue: PlaneIssueRaw,
    evidence: { evidenceUrls: string[]; evidenceText: string },
  ): Promise<void> {
    try {
      const labels = await this.loadLabels(projectId);
      const { taskType } = resolveTaskType(
        issue.name,
        this.labelNamesOf(issue, labels),
      );
      if (taskType !== 'delegated') return;
      const members = await this.loadMembers();
      const assigneeName = this.memberName(
        members,
        (issue.assignees ?? [])[0],
      );
      try {
        await this.taskReviewService.enqueueReview({
          taskId: issue.id,
          projectId,
          title: issue.name,
          assigneeName,
          evidenceUrls: evidence.evidenceUrls,
          evidenceText: evidence.evidenceText,
          sequenceId: issue.sequence_id ?? null,
          targetDate: issue.target_date ?? null,
        });
      } catch (error) {
        this.logger.warn(
          `审核队列入库失败（任务 #${issue.sequence_id ?? issue.id}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // 委派材料 AI 审核是可选集成（AILY_TASK_REVIEW_ENABLED，默认开）：关着就等老板在「验收」里直接验
      const result = await this.ailyWebhook.notifyTaskEvidenceSubmitted(
        issue.id,
        issue.name,
        assigneeName,
      );
      if (!result.dispatched && !result.disabled) {
        this.logger.warn(
          `委派材料审核未自动触发（任务 #${issue.sequence_id ?? issue.id}）：${result.detail}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `委派材料审核触发异常（任务 #${issue.sequence_id ?? issue.id}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async requestAssist(
    taskId: string,
    dto: TaskAssistRequest,
    viewer: TaskViewer,
  ): Promise<TaskActionResult> {
    await this.loadOperableIssue(dto.projectId, taskId, viewer);
    const commentHtml = `<p>【申请协助】${escapeHtml(dto.message)}</p>`;
    await this.postComment(dto.projectId, taskId, commentHtml);
    return {
      ok: true,
      stateChanged: false,
      message: '协助申请已提交，负责人与老板可在任务动态中看到',
    };
  }
}
