import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { PlaneService } from '../integration/plane.service';
import { NotifyService } from '../integration/notify.service';
import { DevRequestLookupService } from '../dev-requests/dev-request-lookup.service';
import {
  AcceptanceService,
  type AcceptanceOperator,
} from '../acceptance/acceptance.service';
import { employeeBindings, taskReviewQueue } from '@server/database/schema';
import {
  mapStatusByState,
  parseRewardAmount,
  resolveTaskType,
  stripHtml,
} from '../integration/plane-mapping';
import type {
  OpenApiTaskReviewApproveResult,
  OpenApiTaskReviewItem,
  OpenApiTaskReviewVerdictResult,
} from '@shared/api.interface';

interface PlaneProjectRaw {
  id: string;
  name: string;
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
  assignees: string[];
  target_date: string | null;
  parent: string | null;
  created_at: string;
  sequence_id: number | null;
  labels?: string[];
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  display_name: string;
}

interface PlaneCommentRaw {
  id: string;
  comment_html: string;
  created_at: string;
  created_by: string;
}

export type PendingReviewItem = OpenApiTaskReviewItem;
export type AiVerdictResult = OpenApiTaskReviewVerdictResult;
export type ApproveResult = OpenApiTaskReviewApproveResult;

type QueueRow = typeof taskReviewQueue.$inferSelect;

export interface TaskReviewEnqueueInput {
  taskId: string;
  projectId: string;
  title: string;
  assigneeName: string;
  evidenceUrls: string[];
  evidenceText: string;
  sequenceId: number | null;
  targetDate: string | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class TaskReviewService {
  private readonly logger = new Logger(TaskReviewService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly notify: NotifyService,
    private readonly devRequestLookup: DevRequestLookupService,
    private readonly acceptance: AcceptanceService,
  ) {}

  /** 开发需求不走委派材料审核（豆包 task_review_* 工具、/openapi/task-review 兜底都经这里），一律拒绝 */
  private async refuseDevRequest(taskId: string): Promise<void> {
    if (await this.devRequestLookup.findByIssueId(taskId)) {
      throw new BadRequestException(
        '这是开发需求，不走委派材料审核；报价、交付、验收都在工作台「开发需求」页里做',
      );
    }
  }

  async listPendingReviews(taskId?: string): Promise<PendingReviewItem[]> {
    if (taskId) {
      const queued = await this.findQueuedRow(taskId);
      if (queued) {
        const issue = await this.plane.getOptional<PlaneIssueRaw>(
          `${this.plane.workspacePath}/projects/${queued.projectId}/issues/${taskId}/`,
        );
        if (issue) {
          return await this.buildReviewItemsForIssue(
            queued.projectId,
            queued.projectName,
            issue,
          );
        }
      }
      const { project, issue } = await this.findIssueProject(taskId);
      return await this.buildReviewItemsForIssue(project.id, project.name, issue);
    }
    const rows: QueueRow[] = await this.db
      .select()
      .from(taskReviewQueue)
      .where(inArray(taskReviewQueue.status, ['pending', 'ai_passed']))
      .orderBy(desc(taskReviewQueue.submittedAt))
      .limit(100);
    return rows.map((row: QueueRow) => this.queueRowToItem(row));
  }

  async enqueueReview(input: TaskReviewEnqueueInput): Promise<void> {
    const projectName = await this.resolveProjectName(input.projectId);
    const now = new Date();
    await this.db
      .insert(taskReviewQueue)
      .values({
        taskId: input.taskId,
        projectId: input.projectId,
        projectName,
        title: input.title,
        assigneeName: input.assigneeName,
        evidenceUrls: input.evidenceUrls,
        evidenceText: input.evidenceText,
        sequenceId: input.sequenceId,
        targetDate: input.targetDate,
        status: 'pending',
        submittedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: taskReviewQueue.taskId,
        set: {
          projectId: input.projectId,
          projectName,
          title: input.title,
          assigneeName: input.assigneeName,
          evidenceUrls: input.evidenceUrls,
          evidenceText: input.evidenceText,
          sequenceId: input.sequenceId,
          targetDate: input.targetDate,
          status: 'pending',
          submittedAt: now,
          updatedAt: now,
        },
      });
  }

  async markSettled(
    taskId: string,
    status:
      | 'ai_passed'
      | 'revised'
      | 'approved'
      | 'rejected'
      | 'cancelled',
  ): Promise<void> {
    try {
      await this.db
        .update(taskReviewQueue)
        .set({ status, updatedAt: new Date() })
        .where(eq(taskReviewQueue.taskId, taskId));
    } catch (error) {
      this.logger.warn(
        `审核登记状态更新失败（${taskId} → ${status}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async writeAiVerdict(
    taskId: string,
    verdict: 'pass' | 'revise',
    reason: string,
  ): Promise<AiVerdictResult> {
    const trimmedReason = reason?.trim() ?? '';
    if (verdict === 'revise' && !trimmedReason) {
      throw new BadRequestException('打回必须写明具体原因');
    }
    await this.refuseDevRequest(taskId);
    const { project, issue } = await this.findIssueProject(taskId);
    const issuePath = `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`;

    if (verdict === 'pass') {
      const commentHtml = `<p>【AI初审】通过：${escapeHtml(
        trimmedReason || '材料符合要求',
      )}（待老板终审）</p>`;
      await this.plane.post(`${issuePath}comments/`, { comment_html: commentHtml });
      await this.markSettled(taskId, 'ai_passed');
      return {
        taskId,
        verdict,
        stateChanged: false,
        notified: false,
        message: `AI 初审已通过《${issue.name}》，等老板终审`,
      };
    }

    const commentHtml = `<p>【AI初审打回】${escapeHtml(trimmedReason)}</p>`;
    await this.plane.post(`${issuePath}comments/`, { comment_html: commentHtml });
    const stateChanged = await this.moveToStatus(
      project.id,
      taskId,
      'BLOCKED',
    );
    const notified = await this.notifyRejected(issue, trimmedReason);
    await this.markSettled(taskId, 'revised');
    return {
      taskId,
      verdict,
      stateChanged,
      notified,
      message: stateChanged
        ? `已打回《${issue.name}》，员工已收到通知与原因`
        : `已记录打回评论，但当前项目未配置阻塞状态，状态未流转`,
    };
  }

  async approveTask(
    taskId: string,
    action: 'approve' | 'reject',
    comment?: string,
    operator: AcceptanceOperator = { userId: null, userName: null },
  ): Promise<ApproveResult> {
    await this.refuseDevRequest(taskId);
    // 打回必须写原因（11-10 A02）
    const reason = (comment ?? '').trim();
    if (action === 'reject' && reason === '') {
      throw new BadRequestException('打回要写原因');
    }
    const { project, issue } = await this.findIssueProject(taskId);
    const issuePath = `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`;
    const states = await this.loadStates(project.id);

    if (action === 'approve') {
      const target = states.find(
        (s: PlaneStateRaw) => s.group === 'completed',
      );
      if (!target) {
        throw new BadRequestException(
          `当前项目「${project.name}」没有「完成」状态组，无法通过验收；请先在 Plane 中补充状态`,
        );
      }
      await this.plane.patch(issuePath, { state: target.id });
      if (comment && comment.trim() !== '') {
        await this.postComment(
          project.id,
          taskId,
          `<p>【老板终审】通过：${escapeHtml(comment.trim())}</p>`,
        );
      }
      await this.markSettled(taskId, 'approved');
      await this.acceptance.recordReviewSafe({
        subjectType: 'task',
        subjectId: taskId,
        decision: 'approved',
        reason: reason !== '' ? reason : null,
        operator,
      });
      void this.notify.sendToPlaneMembers(
        issue.assignees ?? [],
        '委派任务验收通过',
        `《${issue.name}》已通过老板终审，奖励已计入钱包。`,
        { category: 'task_review', link: `/tasks/${taskId}?projectId=${project.id}` },
      );
      return {
        taskId,
        action,
        stateChanged: true,
        message: `已通过验收，《${issue.name}》流转为「${target.name}」，奖励进员工钱包`,
      };
    }

    const commentHtml = `<p>【验收打回】${escapeHtml(reason)}（来源任务：${escapeHtml(issue.name)}）</p>`;
    await this.postComment(project.id, taskId, commentHtml);
    // 打回落点与员工侧「提交阻塞」同口径（mapStatusByState），同类取排序最前的
    const target = states
      .filter((s: PlaneStateRaw) => mapStatusByState(s) === 'BLOCKED')
      .sort((a: PlaneStateRaw, b: PlaneStateRaw) => a.sequence - b.sequence)[0];
    if (!target) {
      throw new BadRequestException(
        `当前项目「${project.name}」没有「阻塞」状态（slug 含 block 或名称含「阻塞」），无法打回；请先在 Plane 中补充状态`,
      );
    }
    await this.plane.patch(issuePath, { state: target.id });
    await this.markSettled(taskId, 'rejected');
    await this.acceptance.recordReviewSafe({
      subjectType: 'task',
      subjectId: taskId,
      decision: 'returned',
      reason,
      operator,
    });
    void this.notify.sendToPlaneMembers(
      issue.assignees ?? [],
      '委派任务验收被打回',
      `《${issue.name}》老板终审未通过：${reason}。处理后在任务详情重新提交材料。`,
      { category: 'task_review', link: `/tasks/${taskId}?projectId=${project.id}` },
    );
    return {
      taskId,
      action,
      stateChanged: true,
      message: `已打回，《${issue.name}》流转为「${target.name}》`,
    };
  }

  private async buildReviewItemsForIssue(
    projectId: string,
    projectName: string,
    issue: PlaneIssueRaw,
  ): Promise<PendingReviewItem[]> {
    const project: PlaneProjectRaw = { id: projectId, name: projectName };
    const members = await this.loadMembers();
    const [states, labels] = await Promise.all([
      this.loadStates(project.id),
      this.loadLabels(project.id),
    ]);
    return this.buildReviewItems(project, [issue], members, states, labels);
  }

  private async buildReviewItems(
    project: PlaneProjectRaw,
    issues: PlaneIssueRaw[],
    members: PlaneMemberRaw[],
    states: PlaneStateRaw[],
    labels: PlaneLabelRaw[],
  ): Promise<PendingReviewItem[]> {
    const pending = issues.filter((issue: PlaneIssueRaw) => {
      if (issue.parent !== null) return false;
      const state = states.find(
        (s: PlaneStateRaw) => s.id === issue.state,
      );
      if (!state || mapStatusByState(state) !== 'READY_FOR_REVIEW') {
        return false;
      }
      const labelNames = (issue.labels ?? [])
        .map((id: string) => labels.find((l: PlaneLabelRaw) => l.id === id)?.name)
        .filter((n: string | undefined): n is string => Boolean(n));
      return resolveTaskType(issue.name, labelNames).taskType === 'delegated';
    });

    const items: PendingReviewItem[] = [];
    for (const issue of pending) {
      const comments = await this.loadComments(project.id, issue.id);
      const evidenceComments = comments.filter(
        (c: PlaneCommentRaw) =>
          stripHtml(c.comment_html).startsWith('【验收凭证】'),
      );
      const latest = evidenceComments[evidenceComments.length - 1] ?? null;
      const urls = new Set<string>();
      for (const c of evidenceComments) {
        const text = stripHtml(c.comment_html);
        const matches = text.match(/https?:\/\/[^\s<>"']+/gu) ?? [];
        for (const url of matches) urls.add(url.replace(/&amp;/gu, '&'));
      }
      items.push({
        taskId: issue.id,
        sequenceId: issue.sequence_id,
        title: issue.name,
        projectName: project.name,
        assigneeName: this.memberName(members, (issue.assignees ?? [])[0]),
        rewardAmount: parseRewardAmount(issue.name),
        deadline: issue.target_date,
        submittedAt: latest?.created_at ?? null,
        evidenceText: latest ? stripHtml(latest.comment_html) : null,
        evidenceFileUrls: [...urls],
      });
    }
    return items;
  }

  private async findQueuedRow(taskId: string): Promise<QueueRow | null> {
    const rows: QueueRow[] = await this.db
      .select()
      .from(taskReviewQueue)
      .where(eq(taskReviewQueue.taskId, taskId))
      .limit(1);
    return rows[0] ?? null;
  }

  private queueRowToItem(row: QueueRow): PendingReviewItem {
    const urls = Array.isArray(row.evidenceUrls)
      ? row.evidenceUrls.filter(
          (u: unknown): u is string => typeof u === 'string',
        )
      : [];
    return {
      taskId: row.taskId,
      sequenceId: row.sequenceId,
      title: row.title,
      projectName: row.projectName,
      assigneeName: row.assigneeName,
      rewardAmount: parseRewardAmount(row.title),
      deadline: row.targetDate,
      submittedAt:
        row.submittedAt instanceof Date
          ? row.submittedAt.toISOString()
          : null,
      evidenceText:
        row.evidenceText && row.evidenceText !== '' ? row.evidenceText : null,
      evidenceFileUrls: urls,
    };
  }

  private async resolveProjectName(projectId: string): Promise<string> {
    try {
      const res = await this.plane.cachedGet<{ results: PlaneProjectRaw[] }>(
        `${this.plane.workspacePath}/projects/`,
      );
      const hit = (res.results ?? []).find(
        (p: PlaneProjectRaw) => p.id === projectId,
      );
      return hit?.name ?? projectId;
    } catch {
      return projectId;
    }
  }

  private async findIssueProject(
    taskId: string,
  ): Promise<{ project: PlaneProjectRaw; issue: PlaneIssueRaw }> {
    const projects = await this.plane.listProjects<PlaneProjectRaw>();
    for (let i = 0; i < projects.length; i += 3) {
      const batch = projects.slice(i, i + 3);
      const results = await Promise.all(
        batch.map(
          async (
            project: PlaneProjectRaw,
          ): Promise<{ project: PlaneProjectRaw; issue: PlaneIssueRaw } | null> => {
            const issue = await this.plane.getOptional<PlaneIssueRaw>(
              `${this.plane.workspacePath}/projects/${project.id}/issues/${taskId}/`,
            );
            return issue ? { project, issue } : null;
          },
        ),
      );
      const hit = results.find(
        (r: { project: PlaneProjectRaw; issue: PlaneIssueRaw } | null) =>
          r !== null,
      );
      if (hit) return hit;
    }
    throw new NotFoundException('任务不存在');
  }

  private async loadStates(projectId: string): Promise<PlaneStateRaw[]> {
    const res = await this.plane.cachedGet<{ results: PlaneStateRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/states/`,
    );
    return res.results ?? [];
  }

  private async loadLabels(projectId: string): Promise<PlaneLabelRaw[]> {
    const res = await this.plane.cachedGet<
      PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
    >(`${this.plane.workspacePath}/projects/${projectId}/labels/`);
    return Array.isArray(res) ? res : (res.results ?? []);
  }

  private async loadMembers(): Promise<PlaneMemberRaw[]> {
    const res = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    return Array.isArray(res) ? res : [];
  }

  private async loadComments(
    projectId: string,
    taskId: string,
  ): Promise<PlaneCommentRaw[]> {
    const res = await this.plane.get<{ results: PlaneCommentRaw[] }>(
      `${this.plane.workspacePath}/projects/${projectId}/issues/${taskId}/comments/`,
    );
    return res.results ?? [];
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

  private async moveToStatus(
    projectId: string,
    taskId: string,
    status: 'BLOCKED',
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

  private memberName(
    members: PlaneMemberRaw[],
    memberId: string | undefined,
  ): string {
    if (!memberId) return '未指派';
    const member = members.find((m: PlaneMemberRaw) => m.id === memberId);
    if (!member) return '未知成员';
    return member.first_name || member.display_name || '未知成员';
  }

  private async notifyRejected(
    issue: PlaneIssueRaw,
    reason: string,
  ): Promise<boolean> {
    const planeMemberId = (issue.assignees ?? [])[0];
    if (!planeMemberId) return false;
    try {
      const rows: { miaodaUserId: string | null }[] = await this.db
        .select({ miaodaUserId: employeeBindings.miaodaUserId })
        .from(employeeBindings)
        .where(eq(employeeBindings.planeMemberId, planeMemberId));
      const userIds = rows
        .map((row: { miaodaUserId: string | null }) => row.miaodaUserId)
        .filter((id: string | null): id is string => Boolean(id));
      if (userIds.length === 0) return false;
      return await this.notify.sendToUsers(
        userIds,
        '委派任务材料被打回',
        `《${issue.name}》材料未通过 AI 初审：${reason}。请处理后在任务详情重新提交材料。`,
        {
          category: 'task_review',
          link: `/tasks/${issue.id}?projectId=${issue.project}`,
        },
      );
    } catch (error) {
      this.logger.warn(
        `打回通知发送失败（${issue.name}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
