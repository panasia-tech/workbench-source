import { BadRequestException } from '@nestjs/common';

import type { WorkOrderPriority } from '@shared/api.interface';
import {
  normalizeClockTime,
  todayDateString,
  withInlineDeadline,
} from '../integration/plane-mapping';
import { minutesToHHmm, shanghaiNowMinutes } from '../tasks/rhythm.util';

/**
 * 发单的优先级与时效（2026-10-18 C2）：
 * - 时效按任务约定拼进标题「HH:mm前」，工单标题与 Plane 任务卡标题一致，草稿发布时原样带过去；
 * - 跨天的活（11-10 销售工作台 A01）再给截止日期：Plane 任务卡 target_date 跟着日期走，
 *   日期 + 时刻存进工单 due_at，草稿发布时按它定 target_date；
 * - 优先级立即发布时直接写 Plane 任务卡的 priority；存草稿时记在建单事件的备注里，发布时读回。
 */

export const WORK_ORDER_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

export const WORK_ORDER_PRIORITY_LABELS: Record<WorkOrderPriority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '普通',
  low: '低',
};

const TITLE_MAX_LENGTH = 255;

export type DispatchInputCode =
  | 'TITLE_INVALID'
  | 'TITLE_HAS_TIME'
  | 'DEADLINE_INVALID'
  | 'DEADLINE_PASSED'
  | 'DATE_INVALID';

/** 截止日期最远能排到多少天后（防「2027」被听成「2072」） */
const MAX_DEADLINE_DAYS_AHEAD = 366;

/** 发单入参不对（标题、时效），code 原样交给 MCP 工具转给豆包，让它照提示问老板 */
export class DispatchInputException extends BadRequestException {
  constructor(
    readonly code: DispatchInputCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DispatchFields {
  /** 拼好截止时刻的标题；没给时效就是原标题 */
  title: string;
  deadlineTime: string | null;
  /** 截止日期 YYYY-MM-DD（上海）；没给日期但给了时刻 = 今天；都没给为 null */
  deadlineDate: string | null;
  /** 日期 + 时刻（上海时区）；没给时效为 null */
  dueAt: Date | null;
  priority: WorkOrderPriority;
}

/** 「2026-11-12」「2026/11/12」→「2026-11-12」；不是真实存在的日期返回 null */
export function normalizeDateString(raw: string): string | null {
  const match = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/u.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 两个 YYYY-MM-DD 相差几天（b - a） */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 上海时区的日期 + 时刻 → 时间点 */
export function shanghaiDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+08:00`);
}

/** 时间点 → 上海日期 YYYY-MM-DD */
export function shanghaiDateOf(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/**
 * 规整发单的标题 / 时效 / 优先级。checkPassed=true（立即发布）时截止时刻必须晚于现在：
 * 当天任务过了点再发出去就是一张生下来就逾期的卡，多半是「下午 3 点」被听成了 03:00。
 */
export function resolveDispatchFields(
  input: {
    title: string;
    deadlineTime?: string;
    deadlineDate?: string;
    priority?: WorkOrderPriority;
  },
  options: { checkPassed: boolean; now?: Date },
): DispatchFields {
  const priority = input.priority ?? 'medium';
  const rawTitle = input.title.trim();
  if (rawTitle === '') {
    throw new DispatchInputException('TITLE_INVALID', '工单标题不能为空');
  }
  const rawDeadline = input.deadlineTime?.trim() ?? '';
  const rawDate = input.deadlineDate?.trim() ?? '';
  if (rawDeadline === '') {
    if (rawDate !== '') {
      throw new DispatchInputException(
        'DEADLINE_INVALID',
        '给了截止日期还要给几点前（HH:mm，如 18:00）',
      );
    }
    return { title: rawTitle, deadlineTime: null, deadlineDate: null, dueAt: null, priority };
  }
  const deadlineTime = normalizeClockTime(rawDeadline);
  if (deadlineTime === null) {
    throw new DispatchInputException(
      'DEADLINE_INVALID',
      `截止时刻「${rawDeadline}」看不懂：请用 24 小时制 HH:mm，如 18:00`,
    );
  }
  const now = options.now ?? new Date();
  const today = shanghaiDateOf(now);
  let deadlineDate = today;
  if (rawDate !== '') {
    const normalized = normalizeDateString(rawDate);
    if (normalized === null) {
      throw new DispatchInputException(
        'DATE_INVALID',
        `截止日期「${rawDate}」看不懂：请用 YYYY-MM-DD，如 ${today}`,
      );
    }
    const ahead = daysBetween(today, normalized);
    if (ahead < 0 && options.checkPassed) {
      throw new DispatchInputException(
        'DEADLINE_PASSED',
        `截止日期 ${normalized} 已经过了（今天 ${today}）`,
      );
    }
    if (ahead > MAX_DEADLINE_DAYS_AHEAD) {
      throw new DispatchInputException(
        'DATE_INVALID',
        `截止日期 ${normalized} 太远了（超过一年），请确认年份`,
      );
    }
    deadlineDate = normalized;
  }
  const inline = withInlineDeadline(rawTitle, deadlineTime);
  if (inline.kind === 'empty_title') {
    throw new DispatchInputException(
      'TITLE_INVALID',
      '工单标题不能只有截止时刻，请写清要做什么',
    );
  }
  if (inline.kind === 'time_in_title') {
    throw new DispatchInputException(
      'TITLE_HAS_TIME',
      `标题里已有时刻「${inline.clash}」，会被当成截止时刻；请改成文字（如「9点半」）或去掉后再发`,
    );
  }
  if (inline.title.length > TITLE_MAX_LENGTH) {
    throw new DispatchInputException(
      'TITLE_INVALID',
      `工单标题太长（加上截止时刻共 ${inline.title.length} 字，上限 ${TITLE_MAX_LENGTH}）`,
    );
  }
  if (options.checkPassed && deadlineDate === today) {
    const nowTime = minutesToHHmm(shanghaiNowMinutes(now));
    if (deadlineTime <= nowTime) {
      throw new DispatchInputException(
        'DEADLINE_PASSED',
        `截止时刻 ${deadlineTime} 已经过了（现在 ${nowTime}）；今天的活截止要晚于现在，跨天的活请给截止日期`,
      );
    }
  }
  return {
    title: inline.title,
    deadlineTime,
    deadlineDate,
    dueAt: shanghaiDateTime(deadlineDate, deadlineTime),
    priority,
  };
}

/** Plane 任务卡的 target_date：有截止就按截止日期，过了的按今天；没截止按今天 */
export function planeTargetDate(dueAt: Date | null): string {
  const today = todayDateString();
  if (!dueAt) return today;
  const due = shanghaiDateOf(dueAt);
  return due < today ? today : due;
}

/** 建单事件备注里的优先级片段，如「优先级：紧急」 */
export function priorityNote(priority: WorkOrderPriority): string {
  return `优先级：${WORK_ORDER_PRIORITY_LABELS[priority]}`;
}

/** 从建单事件备注读回优先级；老草稿没记就返回 null（按普通发） */
export function priorityFromNote(comment: string | null): WorkOrderPriority | null {
  const match = /优先级：(紧急|高|普通|低)/u.exec(comment ?? '');
  if (!match) return null;
  const hit = WORK_ORDER_PRIORITIES.find(
    (value: WorkOrderPriority) => WORK_ORDER_PRIORITY_LABELS[value] === match[1],
  );
  return hit ?? null;
}
