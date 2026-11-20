import type { DevRequestStage } from '@shared/api.interface';

/** 环节配色沿用状态色口径：待处理灰、进行中琥珀、阻塞红、待验收蓝紫、完成绿 */
export const STAGE_TONE: Record<DevRequestStage, string> = {
  submitted: 'bg-muted text-muted-foreground',
  clarifying: 'bg-muted text-muted-foreground',
  quoted: 'bg-muted text-muted-foreground',
  developing: 'bg-amber-100 text-amber-800',
  blocked: 'bg-red-100 text-red-700',
  reviewing: 'bg-violet-100 text-violet-800',
  done: 'bg-green-100 text-green-700',
  cancelled: 'bg-muted text-muted-foreground line-through',
  other: 'bg-orange-100 text-orange-800',
  missing: 'bg-orange-100 text-orange-800',
};

/** 流程五步（进度条用） */
export const FLOW_STEPS: { stage: DevRequestStage; label: string }[] = [
  { stage: 'submitted', label: '需求提交' },
  { stage: 'quoted', label: '工时报价' },
  { stage: 'developing', label: '开发交付' },
  { stage: 'reviewing', label: '结果验收' },
  { stage: 'done', label: '完成' },
];

/** 当前环节在五步里排第几（需求评审算第一步、阻塞算开发交付）；不在流程里返回 -1 */
export function flowIndexOf(stage: DevRequestStage): number {
  switch (stage) {
    case 'submitted':
    case 'clarifying':
      return 0;
    case 'quoted':
      return 1;
    case 'developing':
    case 'blocked':
      return 2;
    case 'reviewing':
      return 3;
    case 'done':
      return 4;
    default:
      return -1;
  }
}

/** ¥1200 / ¥1200.50 */
export function formatYuan(amount: number): string {
  return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

export function formatHours(hours: number): string {
  return `${Number(hours.toFixed(2))} 小时`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** MM-DD HH:mm（跨年带年份） */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`;
}

/** 上海今天 YYYY-MM-DD（承诺交付日期的下限） */
export function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** 金额输入：非负、最多两位小数；不合法返回 null */
export function parseAmountInput(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/u.test(value)) return null;
  return Number(value);
}
