import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BindingService } from '../integration/binding.service';
import { PlaneService } from '../integration/plane.service';
import {
  isSeverelyBlocked,
  mapStatusByState,
  mapPriority,
  parseDeadlineTime,
  parseEvidenceSummary,
  parseWorkHours,
  resolveTaskType,
  shanghaiDateString,
  TASK_STATUS_LABELS,
  todayDateString,
} from '../integration/plane-mapping';
import type {
  MyProjectsResponse,
  ProjectCycleInfo,
  ProjectDetail,
  ProjectModuleInfo,
  ProjectSummary,
  ProjectTaskRow,
  TaskStatus,
  TaskSummary,
} from '@shared/api.interface';

interface PlaneProjectRaw {
  id: string;
  name: string;
  identifier: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_on: string | null;
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
  state: string;
  priority: string;
  assignees: string[];
  target_date: string | null;
  parent: string | null;
  description_html: string | null;
  sequence_id: number | null;
  completed_at?: string | null;
  labels?: string[];
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

interface PlaneCycleRaw {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
}

interface PlaneModuleRaw {
  id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
}

const OPEN_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'REJECTED',
];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly plane: PlaneService,
    private readonly bindingService: BindingService,
  ) {}

  private async loadProjects(): Promise<PlaneProjectRaw[]> {
    return this.plane.listProjects<PlaneProjectRaw>();
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
  ): string | null {
    if (!memberId) return null;
    const member = members.find((m: PlaneMemberRaw) => m.id === memberId);
    if (!member) return null;
    return member.first_name || member.display_name || null;
  }

  private async loadStates(projectId: string): Promise<PlaneStateRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneStateRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/states/`,
    );
    return res.results ?? [];
  }

  private async loadIssues(projectId: string): Promise<PlaneIssueRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneIssueRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/issues/`,
    );
    return res.results ?? [];
  }

  private async loadLabels(projectId: string): Promise<PlaneLabelRaw[]> {
    const res = await this.plane.cachedGet<
      PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
    >(`${this.plane.workspacePath}/projects/${projectId}/labels/`);
    if (Array.isArray(res)) return res;
    return res.results ?? [];
  }

  private labelNamesOf(
    issue: PlaneIssueRaw,
    labels: PlaneLabelRaw[],
  ): string[] {
    return (issue.labels ?? [])
      .map((id: string) => labels.find((l: PlaneLabelRaw) => l.id === id)?.name)
      .filter((n: string | undefined): n is string => Boolean(n));
  }

  private async loadCycles(
    projectId: string,
  ): Promise<PlaneCycleRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneCycleRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/cycles/`,
    );
    return res.results ?? [];
  }

  private async loadModules(
    projectId: string,
  ): Promise<PlaneModuleRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneModuleRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/modules/`,
    );
    return res.results ?? [];
  }

  private async loadLinkedIssueIds(
    projectId: string,
    kind: 'modules' | 'cycles',
    groupId: string,
  ): Promise<Set<string>> {
    const res = await this.plane.get<{ results: PlaneIssueRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/${kind}/${groupId}/${kind === 'modules' ? 'module' : 'cycle'}-issues/`,
    );
    return new Set((res.results ?? []).map((i: PlaneIssueRaw) => i.id));
  }

  private toSummary(
    issue: PlaneIssueRaw,
    project: PlaneProjectRaw,
    status: TaskStatus,
    labels: PlaneLabelRaw[],
  ): TaskSummary {
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
      currentAction: null,
      evidenceSummary: parseEvidenceSummary(issue.description_html),
      ...parseWorkHours(issue.description_html),
      estimatedEarning: null,
      isToday: Boolean(
        issue.target_date && issue.target_date.startsWith(today),
      ),
      taskType,
      rewardAmount,
      severeBlocked: isSeverelyBlocked(status, issue.target_date, deadlineTime),
      completedAt: issue.completed_at
        ? shanghaiDateString(issue.completed_at)
        : null,
    };
  }

  async getMyProjects(userId: string): Promise<MyProjectsResponse> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding) return { bound: false, projects: [] };
    const projects = await this.loadProjects();
    const members = await this.loadMembers();
    const summaries: ProjectSummary[] = [];
    for (let i = 0; i < projects.length; i += 4) {
      const chunk: PlaneProjectRaw[] = projects.slice(i, i + 4);
      const part = await Promise.all(
        chunk.map(async (project: PlaneProjectRaw) => {
          const [states, labels, issues] = await Promise.all([
            this.loadStates(project.id),
            this.loadLabels(project.id),
            this.loadIssues(project.id),
          ]);
          const hasMineTasks = issues.some(
            (issue: PlaneIssueRaw) =>
              issue.parent == null &&
              (issue.assignees ?? []).includes(binding.planeMemberId),
          );
          let modules: PlaneModuleRaw[] = [];
          let cycles: PlaneCycleRaw[] = [];
          if (hasMineTasks) {
            [modules, cycles] = await Promise.all([
              this.loadModules(project.id),
              this.loadCycles(project.id),
            ]);
          }
          return {
            project,
            states,
            labels,
            issues,
            modules,
            cycles,
          };
        }),
      );
      for (const { project, states, labels, issues, modules, cycles } of part) {
      const stateById = new Map(
        states.map((s: PlaneStateRaw) => [s.id, s] as const),
      );
      const statuses = issues.map(
        (issue: PlaneIssueRaw): TaskStatus =>
          stateById.get(issue.state)
            ? mapStatusByState(stateById.get(issue.state) as PlaneStateRaw)
            : 'TODO',
      );
      const effective = statuses.filter((s: TaskStatus) => s !== 'CANCELLED');
      const done = statuses.filter((s: TaskStatus) => s === 'DONE').length;
      const mineFlags = issues.map(
        (issue: PlaneIssueRaw) =>
          issue.parent == null &&
          (issue.assignees ?? []).includes(binding.planeMemberId),
      );
      const myStatuses = statuses.filter(
        (_s: TaskStatus, index: number) => mineFlags[index],
      );
      if (myStatuses.length === 0) continue;
      const assigneeIds = new Set<string>();
      issues.forEach((issue: PlaneIssueRaw) =>
        (issue.assignees ?? []).forEach((a: string) => assigneeIds.add(a)),
      );
      summaries.push({
        id: project.id,
        name: project.name,
        identifier: project.identifier,
        description: project.description ?? null,
        startDate: project.start_date ?? null,
        endDate: project.end_date ?? null,
        progress:
          effective.length > 0
            ? Math.round((done / effective.length) * 100)
            : 0,
        myTotal: myStatuses.length,
        myDone: myStatuses.filter((s: TaskStatus) => s === 'DONE').length,
        myActive: myStatuses.filter((s: TaskStatus) =>
          OPEN_STATUSES.includes(s),
        ).length,
        myBlocked: myStatuses.filter((s: TaskStatus) => s === 'BLOCKED')
          .length,
        totalTasks: effective.length,
        openTasks: statuses.filter((s: TaskStatus) =>
          OPEN_STATUSES.includes(s),
        ).length,
        blockedTasks: statuses.filter((s: TaskStatus) => s === 'BLOCKED')
          .length,
        moduleCount: modules.length,
        cycleCount: cycles.length,
        memberCount: assigneeIds.size,
        createdOn: project.created_on ?? null,
        myOpenTasks: issues
          .map((issue: PlaneIssueRaw, index: number) => ({
            issue,
            status: statuses[index],
            mine: mineFlags[index],
          }))
          .filter(
            (row: { issue: PlaneIssueRaw; status: TaskStatus; mine: boolean }) =>
              row.mine && OPEN_STATUSES.includes(row.status),
          )
          .map(
            (row: { issue: PlaneIssueRaw; status: TaskStatus; mine: boolean }) =>
              this.toSummary(row.issue, project, row.status, labels),
          )
          .sort((a: TaskSummary, b: TaskSummary) =>
            (a.deadline ?? '9999-99-99').localeCompare(
              b.deadline ?? '9999-99-99',
            ),
          ),
      });
      }
    }
    return { bound: true, projects: summaries };
  }

  /**
   * 项目详情。fullAccess=false（员工）时只开放自己有任务的项目（与 getMyProjects 同口径：
   * 有指派给自己的非子任务），不是就 404，不暴露项目在不在；任务明细与风险只给自己的，
   * 进度、模块、周期等汇总数照旧按全项目算。boss/admin 传 fullAccess=true 看全部。
   */
  async getProjectDetail(
    userId: string,
    projectId: string,
    options: { fullAccess: boolean },
  ): Promise<ProjectDetail> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding) {
      throw new ForbiddenException('请先在「我的」中绑定员工身份');
    }
    const projects = await this.loadProjects();
    const project = projects.find(
      (p: PlaneProjectRaw) => p.id === projectId,
    );
    if (!project) throw new NotFoundException('项目不存在或无法访问');
    const issues = await this.loadIssues(projectId);
    const isMineIssue = (issue: PlaneIssueRaw): boolean =>
      (issue.assignees ?? []).includes(binding.planeMemberId);
    const mine = issues.filter(
      (issue: PlaneIssueRaw) => issue.parent == null && isMineIssue(issue),
    );
    // 先判成员资格再拉模块、周期，不是项目里的人就不多打 Plane
    if (!options.fullAccess && mine.length === 0) {
      throw new NotFoundException('项目不存在或无法访问');
    }
    const [states, labels, cycles, modules, members] = await Promise.all([
      this.loadStates(projectId),
      this.loadLabels(projectId),
      this.loadCycles(projectId),
      this.loadModules(projectId),
      this.loadMembers(),
    ]);
    const stateById = new Map(
      states.map((s: PlaneStateRaw) => [s.id, s] as const),
    );
    const today = todayDateString();
    const statusOf = (issue: PlaneIssueRaw): TaskStatus => {
      const state = stateById.get(issue.state);
      return state ? mapStatusByState(state) : 'TODO';
    };
    const statuses = issues.map(statusOf);
    const effective = statuses.filter((s: TaskStatus) => s !== 'CANCELLED');
    const done = statuses.filter((s: TaskStatus) => s === 'DONE').length;
    const myStatuses = mine.map(statusOf);
    const myDone = myStatuses.filter((s: TaskStatus) => s === 'DONE').length;
    const myActive = myStatuses.filter((s: TaskStatus) =>
      OPEN_STATUSES.includes(s),
    );
    const assigneeIdsForSummary = new Set<string>();
    issues.forEach((issue: PlaneIssueRaw) =>
      (issue.assignees ?? []).forEach((a: string) =>
        assigneeIdsForSummary.add(a),
      ),
    );
    const summary: ProjectSummary = {
      id: project.id,
      name: project.name,
      identifier: project.identifier,
      description: project.description ?? null,
      startDate: project.start_date ?? null,
      endDate: project.end_date ?? null,
      progress:
        effective.length > 0
          ? Math.round((done / effective.length) * 100)
          : 0,
      myTotal: myStatuses.length,
      myDone,
      myActive: myActive.length,
      myBlocked: myStatuses.filter((s: TaskStatus) => s === 'BLOCKED').length,
      totalTasks: effective.length,
      openTasks: statuses.filter((s: TaskStatus) =>
        OPEN_STATUSES.includes(s),
      ).length,
      blockedTasks: statuses.filter((s: TaskStatus) => s === 'BLOCKED')
        .length,
      moduleCount: modules.length,
      cycleCount: cycles.length,
      memberCount: assigneeIdsForSummary.size,
      createdOn: project.created_on ?? null,
    };
    const activeCycle = cycles.find(
      (c: PlaneCycleRaw) =>
        c.start_date !== null &&
        c.end_date !== null &&
        c.start_date <= today &&
        c.end_date >= today,
    );
    const issueById = new Map(
      issues.map((issue: PlaneIssueRaw) => [issue.id, issue] as const),
    );
    const [cycleMembers, moduleMembers] = await Promise.all([
      Promise.all(
        cycles.map((c: PlaneCycleRaw) =>
          this.loadLinkedIssueIds(projectId, 'cycles', c.id).catch(
            () => new Set<string>(),
          ),
        ),
      ),
      Promise.all(
        modules.map((m: PlaneModuleRaw) =>
          this.loadLinkedIssueIds(projectId, 'modules', m.id).catch(
            () => new Set<string>(),
          ),
        ),
      ),
    ]);
    const statusesOfGroup = (ids: Set<string>): TaskStatus[] =>
      [...ids]
        .map((id: string) => issueById.get(id))
        .filter((issue: PlaneIssueRaw | undefined): issue is PlaneIssueRaw =>
          issue !== undefined,
        )
        .map(statusOf)
        .filter((s: TaskStatus) => s !== 'CANCELLED');
    const cycleInfos: ProjectCycleInfo[] = cycles
      .slice()
      .sort((a: PlaneCycleRaw, b: PlaneCycleRaw) =>
        (b.start_date ?? '').localeCompare(a.start_date ?? ''),
      )
      .slice(0, 5)
      .map((c: PlaneCycleRaw, index: number) => {
        const cycleStatuses = statusesOfGroup(cycleMembers[index]);
        const cycleDone = cycleStatuses.filter(
          (s: TaskStatus) => s === 'DONE',
        ).length;
        return {
          id: c.id,
          name: c.name,
          startDate: c.start_date ?? null,
          endDate: c.end_date ?? null,
          isActive: activeCycle?.id === c.id,
          progress:
            cycleStatuses.length > 0
              ? Math.round((cycleDone / cycleStatuses.length) * 100)
              : 0,
          total: cycleStatuses.length,
          done: cycleDone,
        };
      });
    const moduleInfos: ProjectModuleInfo[] = modules.map(
      (m: PlaneModuleRaw, index: number) => {
        const moduleIssues = [...moduleMembers[index]]
          .map((id: string) => issueById.get(id))
          .filter((i: PlaneIssueRaw | undefined): i is PlaneIssueRaw =>
            i !== undefined,
          );
        const moduleStatuses = statusesOfGroup(moduleMembers[index]);
        const moduleDone = moduleStatuses.filter(
          (s: TaskStatus) => s === 'DONE',
        ).length;
        const moduleMemberIds = new Set<string>();
        moduleIssues.forEach((issue: PlaneIssueRaw) =>
          (issue.assignees ?? []).forEach((a: string) =>
            moduleMemberIds.add(a),
          ),
        );
        const moduleMembersByName = [...moduleMemberIds]
          .map((id: string) => this.memberName(members, id))
          .filter((n: string | null): n is string => n !== null);
        return {
          id: m.id,
          name: m.name,
          description: m.description ?? null,
          startDate: m.start_date ?? null,
          endDate: m.end_date ?? null,
          total: moduleStatuses.length,
          done: moduleDone,
          inProgress: moduleStatuses.filter(
            (s: TaskStatus) => s === 'IN_PROGRESS',
          ).length,
          blocked: moduleStatuses.filter(
            (s: TaskStatus) => s === 'BLOCKED',
          ).length,
          review: moduleStatuses.filter(
            (s: TaskStatus) =>
              s === 'READY_FOR_REVIEW' || s === 'REJECTED',
          ).length,
          progress:
            moduleStatuses.length > 0
              ? Math.round((moduleDone / moduleStatuses.length) * 100)
              : 0,
          members: moduleMembersByName,
        };
      },
    );
    const memberNames: string[] = [...assigneeIdsForSummary]
      .map((id: string) => this.memberName(members, id))
      .filter((n: string | null): n is string => n !== null);
    const moduleOfIssue = new Map<string, string>();
    modules.forEach((m: PlaneModuleRaw, index: number) => {
      for (const issueId of moduleMembers[index]) {
        if (!moduleOfIssue.has(issueId)) moduleOfIssue.set(issueId, m.name);
      }
    });
    const moduleOrder = new Map(
      modules.map((m: PlaneModuleRaw, i: number) => [m.name, i] as const),
    );
    // 员工只看自己的任务明细（含自己的子任务）；别人的任务只体现在上面的汇总数里
    const visibleIssues = options.fullAccess
      ? issues
      : issues.filter(isMineIssue);
    const taskRows: ProjectTaskRow[] = visibleIssues
      .filter((issue: PlaneIssueRaw) => statusOf(issue) !== 'CANCELLED')
      .map((issue: PlaneIssueRaw) => {
        const status = statusOf(issue);
        const deadlineTime = parseDeadlineTime(issue.name);
        return {
          id: issue.id,
          title: issue.name,
          sequenceId: issue.sequence_id,
          status,
          statusLabel: TASK_STATUS_LABELS[status],
          priorityLabel: mapPriority(issue.priority ?? 'none').priorityLabel,
          moduleName: moduleOfIssue.get(issue.id) ?? null,
          assigneeName: this.memberName(members, (issue.assignees ?? [])[0]),
          deadline: issue.target_date,
          deadlineTime,
          isMine: isMineIssue(issue),
          ...resolveTaskType(issue.name, this.labelNamesOf(issue, labels)),
          severeBlocked: isSeverelyBlocked(status, issue.target_date, deadlineTime),
        };
      })
      .sort((a: ProjectTaskRow, b: ProjectTaskRow) => {
        const mo = (moduleOrder.get(a.moduleName ?? '') ?? 999) -
          (moduleOrder.get(b.moduleName ?? '') ?? 999);
        if (mo !== 0) return mo;
        return (a.sequenceId ?? 0) - (b.sequenceId ?? 0);
      });
    const myTasks: TaskSummary[] = mine
      .filter((issue: PlaneIssueRaw) =>
        OPEN_STATUSES.includes(statusOf(issue)),
      )
      .map((issue: PlaneIssueRaw) =>
        this.toSummary(issue, project, statusOf(issue), labels),
      );
    const risks = visibleIssues
      .filter((issue: PlaneIssueRaw) => {
        if (issue.parent != null) return false;
        const status = statusOf(issue);
        if (status === 'BLOCKED') return true;
        return (
          OPEN_STATUSES.includes(status) &&
          issue.target_date !== null &&
          issue.target_date < today
        );
      })
      .map((issue: PlaneIssueRaw) =>
        this.toSummary(issue, project, statusOf(issue), labels),
      );
    return {
      project: summary,
      myProgress:
        myStatuses.length > 0
          ? Math.round((myDone / myStatuses.length) * 100)
          : 0,
      currentStage: activeCycle?.name ?? null,
      modules: moduleInfos,
      cycles: cycleInfos,
      myTasks,
      risks,
      taskRows,
      taskScope: options.fullAccess ? 'all' : 'mine',
      memberNames,
    };
  }
}
