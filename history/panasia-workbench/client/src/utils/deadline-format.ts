import dayjs from 'dayjs';
import type { TaskStatus } from '@shared/api.interface';

const OPEN_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'REJECTED',
];

export type DeadlineTone = 'today' | 'overdue' | 'severe' | 'plain';

export interface DeadlineDisplay {
  text: string;
  tone: DeadlineTone;
}

export interface DeadlineInput {
  deadline: string | null;
  deadlineTime: string | null;
  status: TaskStatus;
  severeBlocked: boolean;
}

function dueAt(deadline: string, deadlineTime: string | null): dayjs.Dayjs {
  return dayjs(`${deadline}T${deadlineTime ?? '23:59'}:00+08:00`);
}

export function isOverdueTask(input: DeadlineInput): boolean {
  if (input.deadline === null) return false;
  if (!OPEN_STATUSES.includes(input.status)) return false;
  return dueAt(input.deadline, input.deadlineTime).isBefore(dayjs());
}

function dayLabel(deadline: string): string {
  const today = dayjs().format('YYYY-MM-DD');
  if (deadline === today) return '今天';
  if (deadline === dayjs().add(1, 'day').format('YYYY-MM-DD')) {
    return '明天';
  }
  return dayjs(deadline).format('MM-DD');
}

function countdownText(
  due: dayjs.Dayjs,
  deadlineTime: string | null,
): string {
  const diffMinutes = due.diff(dayjs(), 'minute');
  if (diffMinutes < 60) {
    return deadlineTime
      ? `${Math.max(diffMinutes, 1)}分钟内 (${deadlineTime}前)`
      : `${Math.max(diffMinutes, 1)}分钟内`;
  }
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  const hm = minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  return deadlineTime ? `${hm} (${deadlineTime}前)` : hm;
}

export function formatTaskDeadline(
  input: DeadlineInput,
): DeadlineDisplay | null {
  const { deadline, deadlineTime } = input;
  if (deadline === null) return null;
  const isToday = deadline === dayjs().format('YYYY-MM-DD');
  if (!isOverdueTask(input)) {
    if (isToday) {
      return {
        text: countdownText(dueAt(deadline, deadlineTime), deadlineTime),
        tone: 'today',
      };
    }
    const label = dayLabel(deadline);
    const text = deadlineTime
      ? `${label} ${deadlineTime}`
      : label;
    return { text, tone: 'plain' };
  }
  const diffMinutes = dayjs().diff(
    dueAt(deadline, deadlineTime),
    'minute',
  );
  if (input.severeBlocked) {
    return {
      text: `逾期 ${Math.floor(diffMinutes / 1440)} 天`,
      tone: 'severe',
    };
  }
  if (diffMinutes < 60) {
    return { text: `逾期 ${Math.max(diffMinutes, 1)} 分钟`, tone: 'overdue' };
  }
  return { text: `逾期 ${Math.floor(diffMinutes / 60)} 小时`, tone: 'overdue' };
}
