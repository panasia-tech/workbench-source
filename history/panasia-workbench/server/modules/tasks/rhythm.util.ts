import type { TaskSummary, TodayProgress } from '@shared/api.interface';

/** 工作时段（上海时区）：9:00-12:00、13:00-18:00，午休 1 小时，共 8 小时 */
const WORK_SEGMENTS: ReadonlyArray<readonly [number, number]> = [
  [540, 720],
  [780, 1080],
];
const TOTAL_WORK_MINUTES = 480;
const WORK_START_MINUTES = 540;
const WORK_END_MINUTES = 1080;
const DAY_END_MINUTES = 23 * 60 + 59;

export function hhmmToMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map((part: string) => Number(part));
  return hour * 60 + minute;
}

export function minutesToHHmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(DAY_END_MINUTES, Math.round(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 从 9:00 起的工作分钟数（跳过午休）→ 当天绝对分钟数 */
function workElapsedToMinutes(elapsed: number): number {
  let remaining = Math.max(0, Math.min(TOTAL_WORK_MINUTES, elapsed));
  for (const [start, end] of WORK_SEGMENTS) {
    const span = end - start;
    if (remaining <= span) return start + remaining;
    remaining -= span;
  }
  return WORK_END_MINUTES;
}

/** 当天绝对分钟数 → 从 9:00 起的工作分钟数（跳过午休） */
function minutesToWorkElapsed(minutes: number): number {
  let elapsed = 0;
  for (const [start, end] of WORK_SEGMENTS) {
    if (minutes <= start) return elapsed;
    if (minutes >= end) {
      elapsed += end - start;
    } else {
      return elapsed + (minutes - start);
    }
  }
  return elapsed;
}

/** 当前上海时区时刻的当天分钟数 */
export function shanghaiNowMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return hhmmToMinutes(parts);
}

/** 上海时区 ISO 时刻 → 当天分钟数（跨日/无效返回 null） */
export function isoToShanghaiMinutes(iso: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return shanghaiNowMinutes(date);
}

/**
 * 按任务等分工作时长生成节奏计划（系统自动均分）。
 * 返回与传入任务同序的「应完成时刻 HH:mm」数组；空列表返回 null。
 */
export function buildRhythmPlan(
  tasks: Pick<TaskSummary, 'deadlineTime'>[],
): string[] | null {
  if (tasks.length === 0) return null;
  const step = TOTAL_WORK_MINUTES / tasks.length;
  return tasks.map(
    (_task: Pick<TaskSummary, 'deadlineTime'>, index: number) =>
      minutesToHHmm(workElapsedToMinutes(step * (index + 1))),
  );
}

export interface ProgressInput {
  /** 今日任务全集（含已完成，不含子任务/取消） */
  tasks: TaskSummary[];
  /** 今日已完成任务在 Plane 的原始 completed_at ISO 时刻 */
  completedIsoList: string[];
  now: Date;
}

/**
 * 今日进度节奏：阶段目标（按系统均分节奏到点应完成数）、
 * 按实际完成速度预测的收工时刻与加班分钟。
 */
export function computeProgress(input: ProgressInput): TodayProgress | null {
  const { tasks, completedIsoList, now } = input;
  const todayTotal = tasks.length;
  if (todayTotal === 0) return null;
  const sorted = [...tasks].sort((a: TaskSummary, b: TaskSummary) => {
    if (a.status === 'DONE' && b.status !== 'DONE') return -1;
    if (b.status === 'DONE' && a.status !== 'DONE') return 1;
    if (a.deadlineTime === null && b.deadlineTime !== null) return 1;
    if (b.deadlineTime === null && a.deadlineTime !== null) return -1;
    return (a.deadlineTime ?? '99:99').localeCompare(b.deadlineTime ?? '99:99');
  });
  const plannedTimes = buildRhythmPlan(sorted) ?? [];
  const nowMinutes = shanghaiNowMinutes(now);
  const rhythmTarget = plannedTimes.filter(
    (planned: string) => hhmmToMinutes(planned) <= nowMinutes,
  ).length;
  const todayDone = completedIsoList.length;
  const behindCount = Math.max(0, rhythmTarget - todayDone);
  const remaining = todayTotal - todayDone;

  const doneMinutes = completedIsoList
    .map((iso: string) => isoToShanghaiMinutes(iso))
    .filter((m: number | null): m is number => m !== null)
    .sort((a: number, b: number) => a - b);
  const plannedStep = TOTAL_WORK_MINUTES / todayTotal;
  let paceMinutes = plannedStep;
  if (doneMinutes.length > 0) {
    const lastDone = doneMinutes[doneMinutes.length - 1];
    const elapsedSinceStart = Math.max(
      1,
      minutesToWorkElapsed(lastDone) ||
        minutesToWorkElapsed(Math.max(nowMinutes, WORK_START_MINUTES)),
    );
    paceMinutes = elapsedSinceStart / doneMinutes.length;
    paceMinutes = Math.max(5, Math.min(TOTAL_WORK_MINUTES, paceMinutes));
  }
  const expectedEndMinutes =
    Math.max(nowMinutes, WORK_START_MINUTES) + remaining * paceMinutes;
  const overtimeMinutes = Math.max(0, expectedEndMinutes - WORK_END_MINUTES);

  return {
    todayTotal,
    todayDone,
    rhythmTarget,
    behindCount,
    expectedEndTime: minutesToHHmm(expectedEndMinutes),
    overtimeMinutes: Math.round(overtimeMinutes),
    warn: behindCount > 0 || overtimeMinutes > 0,
  };
}

/** 给任务列表回填节奏计划时刻（仅今日任务；返回新列表，不改入参） */
export function applyRhythmPlan(
  todayTasks: TaskSummary[],
): TaskSummary[] {
  const plannedTimes = buildRhythmPlan(todayTasks);
  if (plannedTimes === null) return todayTasks;
  return todayTasks.map((task: TaskSummary, index: number) => ({
    ...task,
    plannedTime: plannedTimes[index],
  }));
}
