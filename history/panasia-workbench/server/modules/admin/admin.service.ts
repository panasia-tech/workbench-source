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
import { and, count, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import {
  blockers,
  employeeBindings,
  improvementProjects,
  problemPool,
  systemConfigs,
  workOrders,
} from '@server/database/schema';
import { PlaneService } from '../integration/plane.service';
import { NotifyService } from '../integration/notify.service';
import { ProblemsService } from '../problems/problems.service';
import {
  mapPriority,
  mapStatusByState,
  shanghaiDateString,
  TASK_STATUS_LABELS,
  todayDateString,
} from '../integration/plane-mapping';
import type {
  AdminAttentionItem,
  AdminExecuteProject,
  AdminExecuteResponse,
  AdminExecuteTaskRow,
  AdminKpiRow,
  AdminOverviewResponse,
  AdminProjectProgress,
  ProblemPoolItem,
  QuickTaskCreateRequest,
  QuickTaskCreateResponse,
  TaskStatus,
} from '@shared/api.interface';

interface PlaneProjectRaw {
  id: string;
  name: string;
  identifier: string;
  lead?: string | null;
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

interface LoadedProjectData {
  project: PlaneProjectRaw;
  states: PlaneStateRaw[];
  labels: PlaneLabelRaw[];
  issues: PlaneIssueRaw[];
}

interface AppDbStats {
  pendingBossWorkOrders: number;
  openBlockerCount: number;
  blockerItems: {
    id: string;
    title: string;
    category: string;
    severity: string;
    waitingFor: string | null;
    createdAt: Date;
  }[];
  overdueWorkOrderItems: {
    id: string;
    code: string;
    title: string;
    status: string;
    createdAt: Date;
  }[];
  problemCandidates: {
    id: string;
    title: string;
    occurrenceCount: number;
    affectedUsers: number;
    totalLossHours: string;
    lastOccurredAt: Date | null;
    createdAt: Date;
  }[];
  problemSummary: {
    candidateCount: number;
    confirmedCount: number;
    observingCount: number;
  };
  slaHours: number;
}

/** system_configs workorder.sla_hours 未配置时的兜底 SLA（小时） */
const DEFAULT_WORK_ORDER_SLA_HOURS = 48;

const EMPTY_APP_STATS: AppDbStats = {
  pendingBossWorkOrders: 0,
  openBlockerCount: 0,
  blockerItems: [],
  overdueWorkOrderItems: [],
  problemCandidates: [],
  problemSummary: { candidateCount: 0, confirmedCount: 0, observingCount: 0 },
  slaHours: DEFAULT_WORK_ORDER_SLA_HOURS,
};

const OPEN_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'REJECTED',
];

const ROUTINE_PROJECT_KEYWORD = '日常执行';
const SNAPSHOT_TTL_MS = 30_000;
const PLANE_CONCURRENCY = 2;
const ATTENTION_LIMIT_PER_KIND = 5;
const WORK_ORDER_SLA_CONFIG_KEY = 'workorder.sla_hours';
const OVERDUE_WORK_ORDER_STATUSES = ['pending', 'executing', 'needs_revision'];
const CRITICAL_BLOCKER_CATEGORIES = ['finance', 'permission', 'policy'];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private snapshot: { at: number; data: LoadedProjectData[] } | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly notify: NotifyService,
    private readonly problemsService: ProblemsService,
  ) {}

  private async loadMembers(): Promise<PlaneMemberRaw[]> {
    const res = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    return Array.isArray(res) ? res : [];
  }

  private memberName(
    members: PlaneMemberRaw[],
    memberId: string | undefined,
  ): string | null {
    if (!memberId) return null;
    const member = members.find((m: PlaneMemberRaw) => m.id === memberId);
    if (!member) return null;
    return member.first_name || member.display_name || null;
  }

  /**
   * 全量加载 Plane 项目/状态/标签/任务（老板视角，不按员工绑定过滤）。
   * 项目间有界并发（≤4），states/labels/members 走 60s 缓存，
   * 整体快照缓存 30s，供 overview / execute 两个 Dock 复用。
   */
  private async loadSnapshot(): Promise<LoadedProjectData[]> {
    if (this.snapshot && Date.now() - this.snapshot.at < SNAPSHOT_TTL_MS) {
      return this.snapshot.data;
    }
    const projects =
      await this.plane.listProjects<PlaneProjectRaw>();
    const data: LoadedProjectData[] = [];
    for (
      let i = 0;
      i < projects.length;
      i += PLANE_CONCURRENCY
    ) {
      const chunk = projects.slice(i, i + PLANE_CONCURRENCY);
      const loaded = await Promise.all(
        chunk.map(async (project: PlaneProjectRaw) => {
          const base = `${this.plane.workspacePath}/projects/${project.id}`;
          const [statesRes, labelsRes, issuesRes] = await Promise.all([
            this.plane.cachedGet<{ results: PlaneStateRaw[] }>(
              `${base}/states/`,
            ),
            this.plane.cachedGet<
              PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
            >(`${base}/labels/`),
            this.plane.cachedGet<{ results: PlaneIssueRaw[] }>(
              `${base}/issues/`,
              SNAPSHOT_TTL_MS,
            ),
          ]);
          return {
            project,
            states: statesRes.results ?? [],
            labels: Array.isArray(labelsRes)
              ? labelsRes
              : labelsRes.results ?? [],
            issues: issuesRes.results ?? [],
          };
        }),
      );
      data.push(...loaded);
    }
    this.snapshot = { at: Date.now(), data };
    return data;
  }

  private statusOf(
    issue: PlaneIssueRaw,
    stateById: Map<string, PlaneStateRaw>,
  ): TaskStatus {
    const state = stateById.get(issue.state);
    return state ? mapStatusByState(state) : 'TODO';
  }

  private labelNamesOf(
    issue: PlaneIssueRaw,
    labels: PlaneLabelRaw[],
  ): string[] {
    return (issue.labels ?? [])
      .map((id: string) => labels.find((l: PlaneLabelRaw) => l.id === id)?.name)
      .filter((n: string | undefined): n is string => Boolean(n));
  }

  private isOverdue(status: TaskStatus, targetDate: string | null): boolean {
    if (!OPEN_STATUSES.includes(status)) return false;
    if (!targetDate) return false;
    return targetDate < todayDateString();
  }

  private async loadAppStats(): Promise<AppDbStats> {
    try {
      const slaHours = await this.resolveWorkOrderSlaHours();
      const slaCutoff = new Date(Date.now() - slaHours * 3_600_000);
      const [pendingBossRow, openBlockerRow] = await Promise.all([
        this.db
          .select({ c: count() })
          .from(workOrders)
          .where(eq(workOrders.status, 'pending_boss')),
        this.db
          .select({ c: count() })
          .from(blockers)
          .where(eq(blockers.status, 'open')),
      ]);
      const [blockerItems, overdueWorkOrderItems, problemCandidates] =
        await Promise.all([
          this.db
            .select({
              id: blockers.id,
              title: blockers.title,
              category: blockers.category,
              severity: blockers.severity,
              waitingFor: blockers.waitingFor,
              createdAt: blockers.createdAt,
            })
            .from(blockers)
            .where(eq(blockers.status, 'open'))
            .orderBy(desc(blockers.createdAt))
            .limit(ATTENTION_LIMIT_PER_KIND),
          this.db
            .select({
              id: workOrders.id,
              code: workOrders.code,
              title: workOrders.title,
              status: workOrders.status,
              createdAt: workOrders.createdAt,
            })
            .from(workOrders)
            .where(
              and(
                inArray(workOrders.status, OVERDUE_WORK_ORDER_STATUSES),
                lt(workOrders.createdAt, slaCutoff),
              ),
            )
            .orderBy(desc(workOrders.createdAt))
            .limit(ATTENTION_LIMIT_PER_KIND),
          this.db
            .select({
              id: problemPool.id,
              title: problemPool.title,
              occurrenceCount: problemPool.occurrenceCount,
              affectedUsers: problemPool.affectedUsers,
              totalLossHours: problemPool.totalLossHours,
              lastOccurredAt: problemPool.lastOccurredAt,
              createdAt: problemPool.createdAt,
            })
            .from(problemPool)
            .where(eq(problemPool.status, 'candidate'))
            .limit(20),
        ]);
      const [candidateRow, confirmedRow, observingRow] = await Promise.all([
        this.db
          .select({ c: count() })
          .from(problemPool)
          .where(eq(problemPool.status, 'candidate')),
        this.db
          .select({ c: count() })
          .from(improvementProjects)
          .where(isNull(improvementProjects.closedAt)),
        this.db
          .select({ c: count() })
          .from(improvementProjects)
          .where(eq(improvementProjects.stage, 'observe')),
      ]);
      const sortedCandidates = [...problemCandidates]
        .sort(
          (a, b) =>
            (b.lastOccurredAt ?? b.createdAt).getTime() -
            (a.lastOccurredAt ?? a.createdAt).getTime(),
        )
        .slice(0, ATTENTION_LIMIT_PER_KIND);
      return {
        pendingBossWorkOrders: pendingBossRow[0]?.c ?? 0,
        openBlockerCount: openBlockerRow[0]?.c ?? 0,
        blockerItems,
        overdueWorkOrderItems,
        problemCandidates: sortedCandidates,
        problemSummary: {
          candidateCount: candidateRow[0]?.c ?? 0,
          confirmedCount: confirmedRow[0]?.c ?? 0,
          observingCount: observingRow[0]?.c ?? 0,
        },
        slaHours,
      };
    } catch (error) {
      this.logger.warn(
        `管理端应用库统计失败（按 0 处理）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { ...EMPTY_APP_STATS };
    }
  }

  async getOverview(): Promise<AdminOverviewResponse> {
    const [snapshot, members, appStats, problemOverdueRows] =
      await Promise.all([
        this.loadSnapshot(),
        this.loadMembers(),
        this.loadAppStats(),
        this.problemsService.listOverdueRespondings().catch(
          (error: unknown): ProblemPoolItem[] => {
            this.logger.warn(
              `问题响应超时项查询失败（总览）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return [];
          },
        ),
      ]);
    const today = todayDateString();
    let startedCount = 0;
    let planeBlockedCount = 0;
    let reviewCount = 0;
    let todayDoneCount = 0;
    const overdueTaskItems: AdminAttentionItem[] = [];
    const projects: AdminProjectProgress[] = [];

    for (const pd of snapshot) {
      const stateById = new Map(
        pd.states.map((s: PlaneStateRaw) => [s.id, s] as const),
      );
      let openCount = 0;
      let effectiveCount = 0;
      let doneCount = 0;
      let risky = false;
      for (const issue of pd.issues) {
        const status = this.statusOf(issue, stateById);
        if (status !== 'CANCELLED') effectiveCount += 1;
        if (status === 'DONE') doneCount += 1;
        if (OPEN_STATUSES.includes(status)) openCount += 1;
        if (this.isOverdue(status, issue.target_date)) risky = true;
        if (issue.parent != null) continue;
        if (status === 'IN_PROGRESS') startedCount += 1;
        else if (status === 'BLOCKED') planeBlockedCount += 1;
        else if (status === 'READY_FOR_REVIEW') reviewCount += 1;
        if (
          issue.completed_at &&
          shanghaiDateString(issue.completed_at) === today
        ) {
          todayDoneCount += 1;
        }
        if (this.isOverdue(status, issue.target_date)) {
          overdueTaskItems.push({
            id: `task-${issue.id}`,
            kind: 'overdue_task',
            title: issue.name,
            detail: `${pd.project.name} · 截止 ${issue.target_date ?? '未设置'}`,
            href: `/tasks/${issue.id}`,
            severity: 'high',
            occurredAt: issue.created_at,
          });
        }
      }
      projects.push({
        projectId: pd.project.id,
        name: pd.project.name,
        progress:
          effectiveCount > 0
            ? Math.round((doneCount / effectiveCount) * 100)
            : 0,
        openTasks: openCount,
        totalTasks: effectiveCount,
        risky,
      });
    }

    const kpis: AdminKpiRow[] = [
      {
        label: '待我确认',
        value: appStats.pendingBossWorkOrders + reviewCount,
        hint: `工单终审 ${appStats.pendingBossWorkOrders} · 任务验收 ${reviewCount}`,
      },
      { label: '执行中', value: startedCount, hint: 'Plane 进行中任务' },
      {
        label: '阻塞',
        value: planeBlockedCount + appStats.openBlockerCount,
        hint: `任务阻塞 ${planeBlockedCount} · 阻塞记录 ${appStats.openBlockerCount}`,
      },
      { label: '待验收', value: reviewCount, hint: 'Plane 待验收任务' },
      { label: '今日完成', value: todayDoneCount, hint: '今日完成（上海）' },
    ];

    const blockerItems: AdminAttentionItem[] = appStats.blockerItems.map(
      (row): AdminAttentionItem => ({
        id: `blocker-${row.id}`,
        kind: 'blocker',
        title: row.title,
        detail: `类别：${row.category}${
          row.waitingFor ? ` · 等待：${row.waitingFor}` : ''
        }`,
        href: '/admin/problems',
        severity: CRITICAL_BLOCKER_CATEGORIES.includes(row.category)
          ? 'critical'
          : row.severity === 'high'
            ? 'high'
            : 'normal',
        occurredAt: row.createdAt.toISOString(),
      }),
    );

    const overdueWorkOrderItems: AdminAttentionItem[] =
      appStats.overdueWorkOrderItems.map(
        (row): AdminAttentionItem => ({
          id: `wo-${row.id}`,
          kind: 'overdue_workorder',
          title: `[${row.code}] ${row.title}`,
          detail: `状态 ${row.status} · 创建超 ${appStats.slaHours} 小时未完结`,
          href: '/admin/review',
          severity: 'high',
          occurredAt: row.createdAt.toISOString(),
        }),
      );

    const problemCandidateItems: AdminAttentionItem[] =
      appStats.problemCandidates.map(
        (row): AdminAttentionItem => ({
          id: `problem-${row.id}`,
          kind: 'problem_candidate',
          title: row.title,
          detail: `发生 ${row.occurrenceCount} 次 · 影响 ${
            row.affectedUsers
          } 人 · 损失 ${Number(row.totalLossHours)}h`,
          href: '/admin/problems',
          severity: 'normal',
          occurredAt: (row.lastOccurredAt ?? row.createdAt).toISOString(),
        }),
      );

    const problemOverdueItems: AdminAttentionItem[] =
      problemOverdueRows.map(
        (row): AdminAttentionItem => ({
          id: `problem-overdue-${row.id}`,
          kind: 'problem_overdue',
          title: row.title,
          detail: `分类 ${row.category ?? '未分类'} · 报告人 ${
            row.reporterName ?? '未记录'
          }`,
          href: '/admin/problems',
          severity: 'critical',
          occurredAt:
            row.responseAt ?? row.lastOccurredAt ?? new Date().toISOString(),
        }),
      );

    const attentionItems = [
      ...blockerItems,
      ...overdueWorkOrderItems,
      ...overdueTaskItems,
      ...problemCandidateItems,
      ...problemOverdueItems,
    ]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 20);

    return {
      kpis,
      attentions: attentionItems,
      projects,
      problemSummary: appStats.problemSummary,
    };
  }

  async getExecute(): Promise<AdminExecuteResponse> {
    const [snapshot, members] = await Promise.all([
      this.loadSnapshot(),
      this.loadMembers(),
    ]);
    const projects: AdminExecuteProject[] = [];
    const tasks: AdminExecuteTaskRow[] = [];

    for (const pd of snapshot) {
      const stateById = new Map(
        pd.states.map((s: PlaneStateRaw) => [s.id, s] as const),
      );
      let openCount = 0;
      let effectiveCount = 0;
      let doneCount = 0;
      for (const issue of pd.issues) {
        const status = this.statusOf(issue, stateById);
        if (status !== 'CANCELLED') effectiveCount += 1;
        if (status === 'DONE') doneCount += 1;
        if (OPEN_STATUSES.includes(status)) openCount += 1;
        if (issue.parent != null) continue;
        const assigneeId = (issue.assignees ?? [])[0];
        tasks.push({
          id: issue.id,
          sequenceId:
            issue.sequence_id === null ? '' : String(issue.sequence_id),
          title: issue.name,
          projectName: pd.project.name,
          assigneeName: this.memberName(members, assigneeId),
          status: TASK_STATUS_LABELS[status],
          stateGroup: status,
          priority: mapPriority(issue.priority ?? 'none').priorityLabel,
          targetDate: issue.target_date,
          isOverdue: this.isOverdue(status, issue.target_date),
          labels: this.labelNamesOf(issue, pd.labels),
        });
      }
      projects.push({
        id: pd.project.id,
        name: pd.project.name,
        leadName: this.memberName(members, pd.project.lead ?? undefined),
        progress:
          effectiveCount > 0
            ? Math.round((doneCount / effectiveCount) * 100)
            : 0,
        openTasks: openCount,
        totalTasks: effectiveCount,
        isRoutine: pd.project.name.includes(ROUTINE_PROJECT_KEYWORD),
      });
    }

    projects.sort((a: AdminExecuteProject, b: AdminExecuteProject) => {
      if (a.isRoutine !== b.isRoutine) return a.isRoutine ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    tasks.sort(
      (a: AdminExecuteTaskRow, b: AdminExecuteTaskRow) =>
        Number(b.isOverdue) - Number(a.isOverdue) ||
        (a.targetDate ?? '9999-99-99').localeCompare(
          b.targetDate ?? '9999-99-99',
        ),
    );

    return { projects, tasks };
  }

  async createQuickTask(
    dto: QuickTaskCreateRequest,
  ): Promise<QuickTaskCreateResponse> {
    const title = dto.title?.trim() ?? '';
    if (!title) throw new BadRequestException('任务标题不能为空');
    if (!dto.projectId) throw new BadRequestException('请选择所属项目');

    const payload: Record<string, unknown> = { name: title };
    if (dto.description && dto.description.trim()) {
      payload.description_html = `<p>${escapeHtml(dto.description.trim())}</p>`;
    }
    if (dto.assigneeMemberId) {
      payload.assignees = [dto.assigneeMemberId];
    }
    if (dto.dueDate) {
      payload.target_date = dto.dueDate;
    }

    let created: { id?: string };
    try {
      created = await this.plane.post<{ id?: string }>(
        `${this.plane.workspacePath}/projects/${dto.projectId}/issues/`,
        payload,
      );
    } catch (error) {
      this.logger.error(
        '快速创建 Plane 任务失败',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        '创建失败，请确认项目与负责人信息后重试',
      );
    }
    if (!created.id) {
      throw new BadRequestException('创建失败：Plane 未返回任务 ID');
    }
    this.snapshot = null;
    if (dto.assigneeMemberId) {
      void this.notifyQuickTaskAssignees(
        dto.assigneeMemberId,
        title,
        `/tasks/${created.id}?projectId=${dto.projectId}`,
      );
    }
    return { taskId: created.id, taskUrl: `/tasks/${created.id}` };
  }

  /** 读工单 SLA 小时数：system_configs workorder.sla_hours（数字直接用；
 * 按状态对象取最大值；未配置/读取失败兜底 48，保持原 48h 行为） */
  private async resolveWorkOrderSlaHours(): Promise<number> {
    try {
      const rows = await this.db
        .select({ configValue: systemConfigs.configValue })
        .from(systemConfigs)
        .where(eq(systemConfigs.configKey, WORK_ORDER_SLA_CONFIG_KEY))
        .limit(1);
      const config = rows[0]?.configValue ?? null;
      if (typeof config === 'number' && config > 0) return config;
      if (
        config !== null &&
        typeof config === 'object' &&
        !Array.isArray(config)
      ) {
        let maxHours = 0;
        for (const value of Object.values(
          config as Record<string, unknown>,
        )) {
          if (typeof value === 'number' && value > maxHours) maxHours = value;
        }
        if (maxHours > 0) return maxHours;
      }
    } catch (error) {
      this.logger.warn(
        `读取 SLA 配置失败，按默认 ${DEFAULT_WORK_ORDER_SLA_HOURS}h 处理：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return DEFAULT_WORK_ORDER_SLA_HOURS;
  }

  /** 快速下任务后通知被指派员工（planeMemberId 反查绑定，未绑定静默跳过） */
  private async notifyQuickTaskAssignees(
    assigneeMemberId: string,
    title: string,
    link: string,
  ): Promise<void> {
    try {
      const rows: { miaodaUserId: string | null }[] = await this.db
        .select({ miaodaUserId: employeeBindings.miaodaUserId })
        .from(employeeBindings)
        .where(eq(employeeBindings.planeMemberId, assigneeMemberId));
      const userIds = rows
        .map((row: { miaodaUserId: string | null }) => row.miaodaUserId)
        .filter((id: string | null): id is string => Boolean(id));
      if (userIds.length === 0) return;
      await this.notify.sendToUsers(
        userIds,
        '你有新任务',
        `《${title}》已指派给你，请及时处理。`,
        { category: 'task', link },
      );
    } catch (error) {
      this.logger.warn(
        `快速任务通知失败（${title}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
