import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, gte, isNotNull, lt } from 'drizzle-orm';
import {
  blockDeferRequests,
  blockers,
  employeeBindings,
  sops,
} from '@server/database/schema';
import { OPEN_TASK_STATUSES, todayDateString } from '../integration/plane-mapping';
import { TasksService, type AssignedTaskRecord } from './tasks.service';
import { BlockDeferService } from './block-defer.service';
import { SopService } from './sop.service';
import {
  applyRhythmPlan,
  computeProgress,
  isoToShanghaiMinutes,
  minutesToHHmm,
} from './rhythm.util';
import type {
  AdminCoordinationEmployee,
  AdminCoordinationTask,
  AdminDayActivityResponse,
  AdminDayDueState,
  AdminDayMemberActivity,
  AdminDayTaskItem,
  AdminExecuteMembersResponse,
  AdminMemberDetailResponse,
  AdminMemberSlot,
  AdminTaskCoordinationResponse,
  BlockDeferStatus,
  EmployeeRole,
  TaskSummary,
} from '@shared/api.interface';

/** 今日未完成且超截止（含 severe 口径）：对齐员工端 deadlineTime/severeBlocked 字段 */
function isTaskOverdue(task: TaskSummary): boolean {
  if (!OPEN_TASK_STATUSES.includes(task.status)) return false;
  if (task.severeBlocked) return true;
  if (!task.deadline) return false;
  const today = todayDateString();
  if (task.deadline < today) return true;
  if (task.deadline === today) {
    const dueMs = new Date(
      `${task.deadline}T${task.deadlineTime ?? '23:59'}:00+08:00`,
    ).getTime();
    return Date.now() > dueMs;
  }
  return false;
}

/** 当天一次堵塞提交：时刻 + 阻塞分类 */
interface BlockMark {
  at: Date;
  category: string | null;
}

function shanghaiClock(iso: string): string | null {
  const minutes = isoToShanghaiMinutes(iso);
  return minutes === null ? null : minutesToHHmm(minutes);
}

/** 截止口径：完成看完成时刻有没有过截止，没完成按统筹同款 isTaskOverdue 判逾期 */
function dueStateOf(record: AssignedTaskRecord): AdminDayDueState | null {
  const { task, completedAtIso } = record;
  if (!task.deadline) return null;
  if (task.status === 'DONE') {
    const dueMs = new Date(
      `${task.deadline.slice(0, 10)}T${task.deadlineTime ?? '23:59'}:00+08:00`,
    ).getTime();
    const doneMs = completedAtIso ? Date.parse(completedAtIso) : Number.NaN;
    return Number.isFinite(doneMs) && doneMs > dueMs ? 'done_late' : 'done';
  }
  return isTaskOverdue(task) ? 'overdue' : 'open';
}

function toDayItem(
  record: AssignedTaskRecord,
  mark: BlockMark | null,
): AdminDayTaskItem {
  const { task } = record;
  return {
    taskId: task.id,
    projectId: task.projectId,
    sequenceId: task.sequenceId,
    title: task.title,
    projectName: task.projectName,
    status: task.status,
    statusLabel: task.statusLabel,
    deadline: task.deadline,
    deadlineTime: task.deadlineTime,
    completedAt: task.status === 'DONE' ? task.completedAt : null,
    completedTime:
      task.status === 'DONE' && record.completedAtIso
        ? shanghaiClock(record.completedAtIso)
        : null,
    dueState: dueStateOf(record),
    blockedAt: mark ? shanghaiClock(mark.at.toISOString()) : null,
    blockCategory: mark?.category ?? null,
    workHours: task.workHours,
    workHoursText: task.workHoursText,
  };
}

@Injectable()
export class AdminCoordinationService {
  private readonly logger = new Logger(AdminCoordinationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly tasksService: TasksService,
    private readonly blockDeferService: BlockDeferService,
    private readonly sopService: SopService,
  ) {}

  /** 全员今日任务统筹：employee_bindings 全员 × 每人今日任务，Plane 失败按员工降级 */
  async getCoordination(): Promise<AdminTaskCoordinationResponse> {
    const rows = await this
      .db.select()
      .from(employeeBindings)
      .orderBy(employeeBindings.planeMemberName);
    const items: AdminCoordinationEmployee[] = [];
    for (const row of rows) {
      const displayName = row.planeMemberName ?? row.miaodaUserId;
      let tasks: TaskSummary[] = [];
      try {
        tasks =
          (await this.tasksService.getTodayTasksForMember(row.miaodaUserId)) ??
          [];
      } catch (error) {
        this.logger.warn(
          `任务统筹：员工 ${displayName} 今日任务获取失败，已降级跳过`,
          (error as Error).stack,
        );
        tasks = [];
      }
      const sortedTasks: TaskSummary[] = [...tasks].sort(
        (a: TaskSummary, b: TaskSummary) =>
          Number(a.status === 'DONE') - Number(b.status === 'DONE'),
      );
      const coordinationTasks: AdminCoordinationTask[] = sortedTasks
        .map((task: TaskSummary): AdminCoordinationTask => ({
          taskId: task.id,
          sequenceId: task.sequenceId,
          title: task.title,
          projectName: task.projectName,
          statusLabel: task.statusLabel,
          targetDate: task.deadline,
          overdue: isTaskOverdue(task),
        }));
      const todayDone = tasks.filter(
        (task: TaskSummary) => task.status === 'DONE',
      ).length;
      const overdueCount = coordinationTasks.filter(
        (task: AdminCoordinationTask) => task.overdue,
      ).length;
      items.push({
        userId: row.miaodaUserId,
        name: displayName,
        role: row.role,
        todayTotal: coordinationTasks.length,
        todayDone,
        overdueCount,
        tasks: coordinationTasks,
      });
    }
    return { items, generatedAt: new Date().toISOString() };
  }

  /** 执行 Dock 改版：员工槽位卡片列表（进度节奏 + 堵塞/顺延概览） */
  async getExecuteMembers(): Promise<AdminExecuteMembersResponse> {
    const rows = await this.db
      .select()
      .from(employeeBindings)
      .orderBy(employeeBindings.planeMemberName);
    const members: AdminMemberSlot[] = [];
    for (const row of rows) {
      const displayName = row.planeMemberName ?? row.miaodaUserId;
      let tasks: TaskSummary[] = [];
      try {
        tasks =
          (await this.tasksService.getTodayTasksForMember(row.miaodaUserId)) ??
          [];
      } catch (error) {
        this.logger.warn(
          `员工槽位：${displayName} 今日任务获取失败，已降级`,
          (error as Error).stack,
        );
        tasks = [];
      }
      const progress = computeProgress({
        tasks,
        completedIsoList: tasks
          .filter((t: TaskSummary) => t.status === 'DONE')
          .map((t: TaskSummary) => t.completedAt)
          .filter((iso: string | null): iso is string => iso !== null),
        now: new Date(),
      });
      let deferPending = 0;
      try {
        const defers = await this.blockDeferService.listByUser(
          row.miaodaUserId,
          50,
        );
        deferPending = defers.filter(
          (item) => item.status === 'pending' || item.status === 'ai_passed',
        ).length;
      } catch {
        deferPending = 0;
      }
      members.push({
        userId: row.miaodaUserId,
        name: displayName,
        planeMemberId: row.planeMemberId,
        role: row.role as EmployeeRole,
        todayTotal: tasks.length,
        todayDone: tasks.filter((t: TaskSummary) => t.status === 'DONE').length,
        openCount: tasks.filter((t: TaskSummary) =>
          OPEN_TASK_STATUSES.includes(t.status),
        ).length,
        blockedCount: tasks.filter((t: TaskSummary) => t.status === 'BLOCKED')
          .length,
        deferPending,
        rhythmTarget: progress?.rhythmTarget ?? 0,
        behindCount: progress?.behindCount ?? 0,
        expectedEndTime: progress?.expectedEndTime ?? null,
      });
    }
    return { members };
  }

  /**
   * 按日期看「某天谁做了什么」（上海时区）：每个绑定员工当天完成的、当天截止的（是否完成 / 逾期）、
   * 当天提交过堵塞的任务。Plane 任务一次拉全按负责人分组，不按员工逐个扫。
   */
  async getDayActivity(date: string): Promise<AdminDayActivityResponse> {
    const [rows, byMember, marks] = await Promise.all([
      this.db
        .select()
        .from(employeeBindings)
        .orderBy(employeeBindings.planeMemberName),
      this.tasksService.getTasksByAssignee(),
      this.loadBlockMarks(date),
    ]);
    const byDeadline = (a: AdminDayTaskItem, b: AdminDayTaskItem): number =>
      (a.deadlineTime ?? '99:99').localeCompare(b.deadlineTime ?? '99:99');
    const members: AdminDayMemberActivity[] = rows.map(
      (row: typeof employeeBindings.$inferSelect): AdminDayMemberActivity => {
        const completed: AdminDayTaskItem[] = [];
        const due: AdminDayTaskItem[] = [];
        const blocked: AdminDayTaskItem[] = [];
        for (const record of byMember.get(row.planeMemberId) ?? []) {
          const { task } = record;
          const mark = marks.get(task.id) ?? null;
          const item = toDayItem(record, mark);
          if (task.status === 'DONE' && task.completedAt === date) {
            completed.push(item);
          }
          if ((task.deadline ?? '').startsWith(date)) due.push(item);
          if (mark) blocked.push(item);
        }
        completed.sort((a: AdminDayTaskItem, b: AdminDayTaskItem) =>
          (a.completedTime ?? '').localeCompare(b.completedTime ?? ''),
        );
        due.sort(byDeadline);
        blocked.sort((a: AdminDayTaskItem, b: AdminDayTaskItem) =>
          (a.blockedAt ?? '').localeCompare(b.blockedAt ?? ''),
        );
        return {
          userId: row.miaodaUserId,
          name: row.planeMemberName ?? row.miaodaUserId,
          role: row.role as EmployeeRole,
          completed,
          due,
          blocked,
        };
      },
    );
    return { date, members, generatedAt: new Date().toISOString() };
  }

  /**
   * 当天提交过堵塞的任务 → 当天第一次提交的时刻与分类。堵塞没有单独的登记表：员工每次
   * POST /api/tasks/:id/block 都会先落一行 sops（source_task_id + _created_at），勾了顺延的
   * 另落 block_defer_requests，衍生问题的另落 blockers.task_id；三处合并按任务去重。
   */
  private async loadBlockMarks(date: string): Promise<Map<string, BlockMark>> {
    const start = new Date(`${date}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 86_400_000);
    const [sopRows, deferRows, blockerRows] = await Promise.all([
      this.db
        .select({
          taskId: sops.sourceTaskId,
          category: sops.category,
          at: sops.createdAt,
        })
        .from(sops)
        .where(
          and(
            isNotNull(sops.sourceTaskId),
            gte(sops.createdAt, start),
            lt(sops.createdAt, end),
          ),
        ),
      this.db
        .select({
          taskId: blockDeferRequests.taskId,
          category: blockDeferRequests.category,
          at: blockDeferRequests.createdAt,
        })
        .from(blockDeferRequests)
        .where(
          and(
            gte(blockDeferRequests.createdAt, start),
            lt(blockDeferRequests.createdAt, end),
          ),
        ),
      this.db
        .select({
          taskId: blockers.taskId,
          category: blockers.category,
          at: blockers.createdAt,
        })
        .from(blockers)
        .where(
          and(
            isNotNull(blockers.taskId),
            gte(blockers.createdAt, start),
            lt(blockers.createdAt, end),
          ),
        ),
    ]);
    const marks = new Map<string, BlockMark>();
    for (const row of [...sopRows, ...deferRows, ...blockerRows]) {
      if (!row.taskId) continue;
      const existing = marks.get(row.taskId);
      if (!existing || row.at.getTime() < existing.at.getTime()) {
        marks.set(row.taskId, { at: row.at, category: row.category });
      }
    }
    return marks;
  }

  /** 员工详情四视图：今日任务（含节奏计划）/ 在途堵塞与顺延 / 历史完成 / 计划模式 */
  async getMemberDetail(userId: string): Promise<AdminMemberDetailResponse> {
    const bindingRows = await this.db
      .select()
      .from(employeeBindings)
      .where(eq(employeeBindings.miaodaUserId, userId))
      .limit(1);
    const binding = bindingRows[0];
    if (!binding) throw new NotFoundException('员工不存在或未绑定');
    const displayName = binding.planeMemberName ?? userId;
    const tasks =
      (await this.tasksService.getTodayTasksForMember(userId).catch(
        (): null => null,
      )) ?? [];
    const sorted = [...tasks].sort((a: TaskSummary, b: TaskSummary) => {
      if (a.status === 'DONE' && b.status !== 'DONE') return -1;
      if (b.status === 'DONE' && a.status !== 'DONE') return 1;
      return (a.deadlineTime ?? '99:99').localeCompare(
        b.deadlineTime ?? '99:99',
      );
    });
    const todayTasks = applyRhythmPlan(sorted);
    const progress = computeProgress({
      tasks: sorted,
      completedIsoList: sorted
        .filter((t: TaskSummary) => t.status === 'DONE')
        .map((t: TaskSummary) => t.completedAt)
        .filter((iso: string | null): iso is string => iso !== null),
      now: new Date(),
    });
    const deferRequests = await this.blockDeferService
      .listByUser(userId, 20)
      .catch((): [] => []);
    const deferPending = deferRequests.filter(
      (item) => item.status === 'pending' || item.status === 'ai_passed',
    ).length;
    const history = await this.tasksService
      .getHistory(userId, { scope: 'week' })
      .catch((): { bound: boolean; items: TaskSummary[]; total: number } => ({
        bound: true,
        items: [],
        total: 0,
      }));
    const sops = await this.sopService
      .listSops({ authorName: displayName })
      .catch((): [] => []);
    const member: AdminMemberSlot = {
      userId,
      name: displayName,
      planeMemberId: binding.planeMemberId,
      role: binding.role as EmployeeRole,
      todayTotal: sorted.length,
      todayDone: sorted.filter((t: TaskSummary) => t.status === 'DONE').length,
      openCount: sorted.filter((t: TaskSummary) =>
        OPEN_TASK_STATUSES.includes(t.status),
      ).length,
      blockedCount: sorted.filter((t: TaskSummary) => t.status === 'BLOCKED')
        .length,
      deferPending,
      rhythmTarget: progress?.rhythmTarget ?? 0,
      behindCount: progress?.behindCount ?? 0,
      expectedEndTime: progress?.expectedEndTime ?? null,
    };
    return {
      member,
      progress,
      todayTasks,
      blockers: sorted.filter((t: TaskSummary) => t.status === 'BLOCKED'),
      deferRequests,
      history: history.items,
      historyTotal: history.total,
      sops,
    };
  }
}
