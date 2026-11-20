import dayjs from 'dayjs';
import type {
  PerformanceCycle,
  PerformanceOverview,
  TaskSummary,
  TasksOverview,
} from '@shared/api.interface';

/**
 * 补救中心金额演示口径（已与用户确认，勿改动）：
 * - B = expectedBonus（预计绩效奖金），1 绩效分 ≈ B/100 元
 * - 逾期任务完成（已过截止时刻（截止日 + 标题内 HH:mm，无时刻按当天 23:59）、非委派、非阻塞、未完成）→ 绩效 +2 分 ≈ round(2B/100) 元
 * - 低分 KRA 补到满分（rating < 5）→ +(weight − earned) 分 ≈ round(B × (weight − earned) / 100) 元
 */

/** 逾期任务完成可补的绩效分（演示口径固定值） */
export const OVERDUE_TASK_RESCUE_POINTS = 2;

export interface RescueItem {
  kind: 'overdueTask' | 'kra';
  title: string;
  points: number;
  yuan: number;
  taskId?: string;
  projectId?: string;
}

export interface RescueResult {
  items: RescueItem[];
  totalYuan: number;
}

function pickCurrentCycle(
  performance: PerformanceOverview,
): PerformanceCycle | undefined {
  const cycles = performance.cycles ?? [];
  const active = cycles.find(
    (c: PerformanceCycle) => c.active === true,
  );
  if (active) return active;
  if (performance.currentCycleId) {
    const byId = cycles.find(
      (c: PerformanceCycle) => c.id === performance.currentCycleId,
    );
    if (byId) return byId;
  }
  return cycles[0];
}

function collectOverdueTasks(
  openTasks: TaskSummary[],
): TaskSummary[] {
  return openTasks.filter(
    (t: TaskSummary) =>
      t.deadline !== null &&
      t.status !== 'BLOCKED' &&
      t.status !== 'DONE' &&
      t.status !== 'CANCELLED' &&
      t.taskType !== 'delegated' &&
      dayjs(
        `${t.deadline}T${t.deadlineTime ?? '23:59'}:00+08:00`,
      ).isBefore(dayjs()),
  );
}

function roundYuan(value: number): number {
  return Math.round(value);
}

function formatPoints(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeRescue(
  performance: PerformanceOverview,
  tasks: TasksOverview,
): RescueResult {
  const bonus = performance.expectedBonus ?? null;
  if (bonus === null || bonus <= 0) {
    return { items: [], totalYuan: 0 };
  }

  const items: RescueItem[] = [];

  for (const task of collectOverdueTasks(tasks.openTasks ?? [])) {
    items.push({
      kind: 'overdueTask',
      title: task.title,
      points: OVERDUE_TASK_RESCUE_POINTS,
      yuan: roundYuan((OVERDUE_TASK_RESCUE_POINTS * bonus) / 100),
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  const cycle = pickCurrentCycle(performance);
  const kras = cycle?.kras ?? [];
  for (const kra of kras) {
    if (kra.rating >= 5) continue;
    const points = formatPoints(kra.weight - kra.earned);
    if (points <= 0) continue;
    items.push({
      kind: 'kra',
      title: kra.name,
      points,
      yuan: roundYuan((bonus * points) / 100),
    });
  }

  const totalYuan = items.reduce(
    (sum: number, item: RescueItem) => sum + item.yuan,
    0,
  );
  return { items, totalYuan };
}
