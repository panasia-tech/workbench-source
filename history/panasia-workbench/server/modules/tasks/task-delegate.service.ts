import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { PlaneService } from '../integration/plane.service';
import { NotifyService } from '../integration/notify.service';
import { employeeBindings } from '@server/database/schema';
import { parseRewardAmount, todayDateString } from '../integration/plane-mapping';

const ROUTINE_PROJECT_KEYWORD = '日常执行';
const DELEGATE_LABEL_KEYWORD = '委派';

interface PlaneProjectRaw {
  id: string;
  name: string;
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

export interface DelegateEmployeeOption {
  userId: string;
  name: string;
}

export interface DelegateProjectOption {
  projectId: string;
  name: string;
}

export interface DelegationContext {
  employees: DelegateEmployeeOption[];
  projects: DelegateProjectOption[];
}

export interface DelegateTaskInput {
  title: string;
  assigneeId: string;
  projectId?: string;
  rewardAmount?: number;
  dueDate?: string;
  remark?: string;
}

export interface DelegatedTaskResult {
  taskId: string;
  taskUrl: string;
  title: string;
  assigneeName: string;
  projectName: string;
  rewardAmount: number | null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class TaskDelegateService {
  private readonly logger = new Logger(TaskDelegateService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly notify: NotifyService,
  ) {}

  async getDelegationContext(): Promise<DelegationContext> {
    const employees = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .orderBy(asc(employeeBindings.planeMemberName));
    return {
      employees: employees.map(
        (row: { userId: string; name: string | null }) => ({
          userId: row.userId,
          name: row.name ?? row.userId,
        }),
      ),
      projects: await this.listProjects(),
    };
  }

  private async listProjects(): Promise<DelegateProjectOption[]> {
    const res = await this.plane.cachedGet<
      PlaneProjectRaw[] | { results?: PlaneProjectRaw[] }
    >(`${this.plane.workspacePath}/projects/`);
    const list = Array.isArray(res) ? res : (res.results ?? []);
    return list.map((row: PlaneProjectRaw) => ({
      projectId: row.id,
      name: row.name,
    }));
  }

  /** Plane 成员 ID → 员工名（定时单列表显示指派给谁） */
  async memberNames(): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        planeMemberId: employeeBindings.planeMemberId,
        name: employeeBindings.planeMemberName,
      })
      .from(employeeBindings);
    return new Map(
      rows.map((row: { planeMemberId: string; name: string | null }) => [
        row.planeMemberId,
        row.name ?? row.planeMemberId,
      ]),
    );
  }

  /** delegate_info 给出的员工 userId → 员工绑定（带 Plane 成员 ID）；不存在就报错。定时单也用它 */
  async resolveAssignee(userId: string): Promise<{
    userId: string;
    planeMemberId: string;
    planeMemberName: string | null;
  }> {
    const found = await this.db
      .select({
        userId: employeeBindings.miaodaUserId,
        planeMemberId: employeeBindings.planeMemberId,
        planeMemberName: employeeBindings.planeMemberName,
      })
      .from(employeeBindings)
      .where(eq(employeeBindings.miaodaUserId, userId))
      .limit(1);
    const binding = found[0];
    if (!binding) {
      throw new BadRequestException(
        '指派员工不存在：请先调用 delegate_info 获取有效员工列表',
      );
    }
    return binding;
  }

  /** 所属项目：传了就核对存在，没传默认「日常执行」。定时单也用它 */
  async resolveProject(projectId?: string): Promise<DelegateProjectOption> {
    const wanted = projectId?.trim() ?? '';
    const projects = await this.listProjects();
    if (wanted) {
      const hit = projects.find(
        (row: DelegateProjectOption) => row.projectId === wanted,
      );
      if (!hit) {
        throw new BadRequestException(
          '所属项目不存在：请从 delegate_info 返回的 projects 里选择',
        );
      }
      return hit;
    }
    const hit = projects.find((row: DelegateProjectOption) =>
      row.name.includes(ROUTINE_PROJECT_KEYWORD),
    );
    if (!hit) {
      throw new BadRequestException(
        '未指定所属项目且找不到默认的「日常执行」项目，请明确指定项目',
      );
    }
    return hit;
  }

  async createDelegatedTask(input: DelegateTaskInput): Promise<DelegatedTaskResult> {
    const title = input.title?.trim() ?? '';
    if (!title) throw new BadRequestException('任务标题不能为空');

    const binding = await this.resolveAssignee(input.assigneeId);
    const project = await this.resolveProject(input.projectId);
    const projectId = project.projectId;
    const projectName = project.name;

    if (
      input.rewardAmount !== undefined &&
      (!Number.isFinite(input.rewardAmount) ||
        input.rewardAmount <= 0 ||
        input.rewardAmount > 100000)
    ) {
      throw new BadRequestException('奖励金额必须是不超过 100000 的正数（单位：元）');
    }

    const dueDate = input.dueDate?.trim() || todayDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(dueDate)) {
      throw new BadRequestException('截止日期格式必须是 YYYY-MM-DD');
    }

    let finalTitle = title;
    if (input.rewardAmount !== undefined && parseRewardAmount(title) === null) {
      finalTitle = `${title} +${input.rewardAmount}元`;
    }
    const effectiveReward = parseRewardAmount(finalTitle);

    const labelId = await this.findLabelId(projectId, DELEGATE_LABEL_KEYWORD);

    const payload: Record<string, unknown> = {
      name: finalTitle,
      assignees: [binding.planeMemberId],
      target_date: dueDate,
    };
    if (input.remark?.trim()) {
      payload.description_html = `<p>${escapeHtml(input.remark.trim())}</p>`;
    }
    if (labelId) {
      payload.labels = [labelId];
    }

    let created: { id?: string };
    try {
      created = await this.plane.post<{ id?: string }>(
        `${this.plane.workspacePath}/projects/${projectId}/issues/`,
        payload,
      );
    } catch (error) {
      this.logger.error(
        '委派任务创建失败',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException('创建失败，请确认项目与员工信息后重试');
    }
    if (!created.id) {
      throw new BadRequestException('创建失败：Plane 未返回任务 ID');
    }

    void this.notifyAssignee(binding.planeMemberId, finalTitle, projectName, {
      taskId: created.id,
      projectId,
    });

    return {
      taskId: created.id,
      taskUrl: `/tasks/${created.id}`,
      title: finalTitle,
      assigneeName: binding.planeMemberName ?? binding.planeMemberId,
      projectName,
      rewardAmount: effectiveReward,
    };
  }

  private async notifyAssignee(
    planeMemberId: string,
    title: string,
    projectName: string,
    target: { taskId: string; projectId: string },
  ): Promise<void> {
    try {
      const rows: { miaodaUserId: string | null }[] = await this.db
        .select({ miaodaUserId: employeeBindings.miaodaUserId })
        .from(employeeBindings)
        .where(eq(employeeBindings.planeMemberId, planeMemberId));
      const userIds = rows
        .map((row: { miaodaUserId: string | null }) => row.miaodaUserId)
        .filter((id: string | null): id is string => Boolean(id));
      if (userIds.length === 0) return;
      await this.notify.sendToUsers(
        userIds,
        '你有新的委派任务',
        `《${title}》（${projectName}）已委派给你，完成后额外奖励计入钱包。`,
        {
          category: 'task',
          link: `/tasks/${target.taskId}?projectId=${target.projectId}`,
        },
      );
    } catch (error) {
      this.logger.warn(
        `委派任务通知失败（${title}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async findLabelId(
    projectId: string,
    labelName: string,
  ): Promise<string | null> {
    try {
      const res = await this.plane.cachedGet<
        PlaneLabelRaw[] | { results?: PlaneLabelRaw[] }
      >(`${this.plane.workspacePath}/projects/${projectId}/labels/`);
      const labels = Array.isArray(res) ? res : (res.results ?? []);
      const hit = labels.find((label: PlaneLabelRaw) =>
        label.name.includes(labelName),
      );
      return hit?.id ?? null;
    } catch {
      return null;
    }
  }
}
