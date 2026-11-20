import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { PlaneService } from '../integration/plane.service';
import { NotifyService } from '../integration/notify.service';
import { employeeBindings, taskTemplates } from '@server/database/schema';
import { todayDateString } from '../integration/plane-mapping';
import type {
  TaskSummary,
  TaskTemplateSchedule,
  TaskTemplateSummary,
  TaskTemplateUpsertRequest,
} from '@shared/api.interface';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface PlaneIssueRaw {
  id: string;
  name: string;
  target_date: string | null;
}

interface PlaneLabelRaw {
  id: string;
  name: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shanghaiWeekday(dateStr: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(new Date(`${dateStr}T12:00:00+08:00`));
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? -1;
}

function validateSchedule(schedule: unknown): TaskTemplateSchedule {
  if (schedule === null || typeof schedule !== 'object') {
    throw new BadRequestException('schedule 格式非法');
  }
  const { kind } = schedule as { kind?: unknown };
  if (
    kind !== 'every_day' &&
    kind !== 'workdays' &&
    kind !== 'weekly'
  ) {
    throw new BadRequestException('schedule.kind 只支持 every_day/workdays/weekly');
  }
  let weekdays: number[] | undefined;
  const raw = (schedule as { weekdays?: unknown }).weekdays;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new BadRequestException('schedule.weekdays 必须是数字数组');
    }
    const normalized = raw
      .map((w: unknown): number => Number(w))
      .filter((w: number) => Number.isInteger(w) && w >= 1 && w <= 7);
    if (new Set(normalized).size !== raw.length) {
      throw new BadRequestException('schedule.weekdays 存在重复或非法值');
    }
    weekdays = [...new Set(normalized)].sort((a: number, b: number) => a - b);
  }
  if (kind === 'weekly' && (weekdays === undefined || weekdays.length === 0)) {
    throw new BadRequestException('定时任务需指定每周几执行（weekdays）');
  }
  return { kind, ...(weekdays !== undefined ? { weekdays } : {}) };
}

function scheduleLabel(schedule: TaskTemplateSchedule): string {
  if (schedule.kind === 'every_day') return '每天';
  if (schedule.kind === 'workdays') return '工作日（周一至周五）';
  const weekdays = schedule.weekdays ?? [];
  return `每周${weekdays.map((w: number) => WEEKDAY_LABELS[w % 7]).join('、')}`;
}

function runsOnDate(schedule: TaskTemplateSchedule, dateStr: string): boolean {
  const weekday = shanghaiWeekday(dateStr);
  if (weekday < 0) return false;
  if (schedule.kind === 'every_day') return true;
  if (schedule.kind === 'workdays') return weekday >= 1 && weekday <= 5;
  return (schedule.weekdays ?? []).includes(weekday);
}

type TemplateRow = typeof taskTemplates.$inferSelect;

function coerceSchedule(raw: unknown): TaskTemplateSchedule {
  if (raw !== null && typeof raw === 'object' && 'kind' in raw) {
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === 'every_day' || kind === 'workdays' || kind === 'weekly') {
      const weekdays = (raw as { weekdays?: unknown }).weekdays;
      if (
        weekdays === undefined ||
        (Array.isArray(weekdays) &&
          weekdays.every((w: unknown): boolean => Number.isInteger(Number(w))))
      ) {
        return {
          kind,
          ...(Array.isArray(weekdays)
            ? { weekdays: weekdays.map((w: unknown): number => Number(w)) }
            : {}),
        };
      }
    }
  }
  return { kind: 'every_day' };
}

function toSummary(
  row: TemplateRow,
  runsToday: boolean,
  todayTaskId: string | null,
): TaskTemplateSummary {
  const schedule = coerceSchedule(row.schedule);
  return {
    id: row.id,
    title: row.title,
    templateType: row.templateType === 'scheduled' ? 'scheduled' : 'daily',
    schedule,
    scheduleLabel: scheduleLabel(schedule),
    planeProjectId: row.planeProjectId,
    planeProjectName: row.planeProjectName,
    assigneeMemberId: row.assigneeMemberId,
    enabled: row.enabled,
    runsToday,
    todayTaskId,
  };
}

@Injectable()
export class TaskTemplateService {
  private readonly logger = new Logger(TaskTemplateService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly plane: PlaneService,
    private readonly notify: NotifyService,
  ) {}

  async listForOverview(
    planeMemberId: string,
    summaries: TaskSummary[],
  ): Promise<TaskTemplateSummary[]> {
    const today = todayDateString();
    const rows = await this.db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.enabled, true));
    return rows
      .filter(
        (row: TemplateRow) =>
          row.assigneeMemberId === null ||
          row.assigneeMemberId === planeMemberId,
      )
      .sort((a: TemplateRow, b: TemplateRow) => a.sort - b.sort)
      .map((row: TemplateRow): TaskTemplateSummary => {
        const todayTask =
          summaries.find(
            (task: TaskSummary) =>
              task.title === row.title &&
              task.projectId === row.planeProjectId &&
              task.deadline === today &&
              task.status !== 'CANCELLED',
          ) ?? null;
        return toSummary(
      row,
      runsOnDate(coerceSchedule(row.schedule), today),
      todayTask?.id ?? null,
    );
      });
  }

  async listAll(): Promise<TaskTemplateSummary[]> {
    const today = todayDateString();
    const rows = await this.db.select().from(taskTemplates);
    return rows
      .sort((a: TemplateRow, b: TemplateRow) => a.sort - b.sort)
      .map((row: TemplateRow) =>
        toSummary(row, runsOnDate(coerceSchedule(row.schedule), today), null),
      );
  }

  async create(dto: TaskTemplateUpsertRequest): Promise<TaskTemplateSummary> {
    const title = dto.title?.trim() ?? '';
    if (!title) throw new BadRequestException('模板标题不能为空');
    if (!dto.planeProjectId?.trim()) {
      throw new BadRequestException('请选择所属项目');
    }
    const schedule = validateSchedule(dto.schedule);
    const templateType =
      dto.templateType === 'scheduled' ? 'scheduled' : 'daily';
    const [row] = await this.db
      .insert(taskTemplates)
      .values({
        title,
        templateType,
        schedule,
        planeProjectId: dto.planeProjectId.trim(),
        planeProjectName: dto.planeProjectName?.trim() || dto.planeProjectId.trim(),
        assigneeMemberId: dto.assigneeMemberId || null,
        description: dto.description || null,
        enabled: dto.enabled ?? true,
      })
      .returning();
    if (!row) throw new BadRequestException('模板创建失败');
    return toSummary(row, runsOnDate(schedule, todayDateString()), null);
  }

  async update(
    id: string,
    dto: Partial<TaskTemplateUpsertRequest>,
  ): Promise<TaskTemplateSummary> {
    const patch: Partial<TemplateRow> = {};
    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('模板标题不能为空');
      patch.title = title;
    }
    if (dto.templateType !== undefined) {
      patch.templateType =
        dto.templateType === 'scheduled' ? 'scheduled' : 'daily';
    }
    if (dto.schedule !== undefined) {
      patch.schedule = validateSchedule(dto.schedule);
    }
    if (dto.planeProjectId !== undefined) {
      if (!dto.planeProjectId.trim()) {
        throw new BadRequestException('所属项目不能为空');
      }
      patch.planeProjectId = dto.planeProjectId.trim();
    }
    if (dto.planeProjectName !== undefined) {
      patch.planeProjectName = dto.planeProjectName.trim();
    }
    if (dto.assigneeMemberId !== undefined) {
      patch.assigneeMemberId = dto.assigneeMemberId || null;
    }
    if (dto.description !== undefined) {
      patch.description = dto.description || null;
    }
    if (dto.enabled !== undefined) {
      patch.enabled = dto.enabled;
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('未提供可更新字段');
    }
    patch.updatedAt = new Date();
    const [row] = await this.db
      .update(taskTemplates)
      .set(patch)
      .where(eq(taskTemplates.id, id))
      .returning();
    if (!row) throw new NotFoundException('模板不存在');
    return toSummary(
      row,
      runsOnDate(coerceSchedule(row.schedule), todayDateString()),
      null,
    );
  }

  async remove(id: string): Promise<void> {
    const removed = await this.db
      .delete(taskTemplates)
      .where(eq(taskTemplates.id, id))
      .returning({ id: taskTemplates.id });
    if (removed.length === 0) throw new NotFoundException('模板不存在');
  }

  /** 到点自动生成开没开（开关在 tasks.automation.ts，读同一组环境变量），给 MCP 说清楚 */
  autoGenerateNote(): string {
    if (process.env.TASK_TEMPLATE_DAILY_ENABLED !== 'true') {
      return '每日自动生成没开（TASK_TEMPLATE_DAILY_ENABLED），定时单要管理员在「任务模板」里点「立即生成今日任务」才会出任务';
    }
    return `每天 ${process.env.TASK_TEMPLATE_DAILY_AT ?? '08:00'}（上海时间）按周期自动生成当天任务`;
  }

  async generateTodayTasks(): Promise<{
    created: number;
    skipped: number;
    details: string[];
  }> {
    const today = todayDateString();
    const rows = await this.db
      .select()
      .from(taskTemplates)
      .where(eq(taskTemplates.enabled, true));
    const due = rows.filter((row: TemplateRow) =>
      runsOnDate(coerceSchedule(row.schedule), today),
    );
    const issuesCache = new Map<string, PlaneIssueRaw[]>();
    const labelCache = new Map<string, string | null>();
    const labelKey = (projectId: string, name: string): string =>
      `${projectId}:${name}`;
    let created = 0;
    let skipped = 0;
    const details: string[] = [];
    for (const row of due) {
      try {
        let issues = issuesCache.get(row.planeProjectId);
        if (issues === undefined) {
          const res = await this.plane.get<{ results?: PlaneIssueRaw[] }>(
            `${this.plane.workspacePath}/projects/${row.planeProjectId}/issues/`,
          );
          issues = res.results ?? [];
          issuesCache.set(row.planeProjectId, issues);
        }
        const exists = issues.some(
          (issue: PlaneIssueRaw) =>
            issue.name === row.title && issue.target_date === today,
        );
        if (exists) {
          skipped += 1;
          details.push(`跳过「${row.title}」：今日任务已存在`);
          continue;
        }
        const labelName = row.templateType === 'scheduled' ? '定时' : '日常';
        let labelId = labelCache.get(labelKey(row.planeProjectId, labelName));
        if (labelId === undefined) {
          labelId = await this.findLabelId(row.planeProjectId, labelName);
          labelCache.set(labelKey(row.planeProjectId, labelName), labelId);
        }
        const payload: Record<string, unknown> = {
          name: row.title,
          target_date: today,
        };
        if (row.description) {
          payload.description_html = `<p>${escapeHtml(row.description)}</p>`;
        }
        if (row.assigneeMemberId) {
          payload.assignees = [row.assigneeMemberId];
        }
        if (labelId) {
          payload.labels = [labelId];
        }
        const createdIssue = await this.plane.post<{ id?: string }>(
          `${this.plane.workspacePath}/projects/${row.planeProjectId}/issues/`,
          payload,
        );
        issues.push({
          id: `generated-${row.id}`,
          name: row.title,
          target_date: today,
        });
        created += 1;
        details.push(`已生成「${row.title}」`);
        if (row.assigneeMemberId) {
          void this.notifyGeneratedTaskAssignees(
            row.assigneeMemberId,
            row.title,
            createdIssue?.id
              ? `/tasks/${createdIssue.id}?projectId=${row.planeProjectId}`
              : '/tasks',
          );
        }
      } catch (error) {
        this.logger.error(
          `模板生成任务失败：${row.title}`,
          error instanceof Error ? error.stack : String(error),
        );
        details.push(
          `失败「${row.title}」：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { created, skipped, details };
  }

  /** 模板生成今日任务后通知绑定员工（未绑定则静默跳过） */
  private async notifyGeneratedTaskAssignees(
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
        '你有新的今日任务',
        `《${title}》已按模板生成，请在今天完成。`,
        { category: 'task', link },
      );
    } catch (error) {
      this.logger.warn(
        `模板任务通知失败（${title}）：${
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
