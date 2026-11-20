import type { TaskStatus, TaskType } from '@shared/api.interface';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: '待处理',
  IN_PROGRESS: '进行中',
  WAITING: '等待他人',
  BLOCKED: '阻塞',
  READY_FOR_REVIEW: '待验收',
  REJECTED: '验收失败',
  DONE: '完成',
  CANCELLED: '取消',
};

export const OPEN_TASK_STATUSES: TaskStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'REJECTED',
];

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

const PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  medium: '普通',
  low: '低',
  none: '普通',
};

export function mapPriority(priority: string): {
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  priorityLabel: string;
  rank: number;
} {
  const normalized = priority in PRIORITY_RANK ? priority : 'none';
  return {
    priority: normalized as 'urgent' | 'high' | 'medium' | 'low' | 'none',
    priorityLabel: PRIORITY_LABELS[normalized],
    rank: PRIORITY_RANK[normalized],
  };
}

/**
 * 中文状态名的关键词，按顺序取第一个命中。Plane 每次保存状态都按名字重算 slug，中文名的 slug 永远是空的，
 * 只能认名字。「驳回/打回/失败」排在「验收」前、「等待」排最后：「验收打回」「验收失败」算验收失败，
 * 「等待验收」算待验收。
 */
const STATE_NAME_RULES: { keywords: string[]; status: TaskStatus }[] = [
  { keywords: ['阻塞'], status: 'BLOCKED' },
  { keywords: ['驳回', '打回', '失败'], status: 'REJECTED' },
  { keywords: ['验收', '待审'], status: 'READY_FOR_REVIEW' },
  { keywords: ['等待'], status: 'WAITING' },
];

/**
 * Plane 状态 → 工作台状态：先看 slug 里的英文关键词（原规则，优先），再看状态名里的中文关键词，最后按分组。
 * 名字规则不管 completed / cancelled 两组：那里的「已验收」「已驳回」照旧按分组算完成、取消。
 */
export function mapStatusByState(state: {
  group: string;
  slug: string;
  name?: string | null;
}): TaskStatus {
  const slug = (state.slug ?? '').toLowerCase();
  if (slug.includes('block')) return 'BLOCKED';
  if (slug.includes('review')) return 'READY_FOR_REVIEW';
  if (slug.includes('wait')) return 'WAITING';
  if (slug.includes('reject')) return 'REJECTED';
  if (state.group !== 'completed' && state.group !== 'cancelled') {
    const name = state.name ?? '';
    const rule = STATE_NAME_RULES.find((r: { keywords: string[] }) =>
      r.keywords.some((keyword: string) => name.includes(keyword)),
    );
    if (rule) return rule.status;
  }
  switch (state.group) {
    case 'started':
      return 'IN_PROGRESS';
    case 'completed':
      return 'DONE';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'TODO';
  }
}

export function todayDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function stripHtml(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function deriveCurrentAction(descriptionHtml: string | null): string | null {
  const text = stripHtml(descriptionHtml);
  if (!text) return null;
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return null;
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

export function parseEvidenceSummary(
  descriptionHtml: string | null,
): string | null {
  const text = stripHtml(descriptionHtml);
  if (!text) return null;
  const line = text
    .split('\n')
    .find((l: string) => l.startsWith('验收条件='));
  if (!line) return null;
  const materials = line
    .replace('验收条件=', '')
    .split(/[+＋]/u)
    .map((name: string) => name.trim())
    .filter((name: string) => name.length > 0);
  return materials.length > 0 ? materials.join('、') : null;
}

/** 一段「数字 + 单位」：单位缺省按小时；天按 8 小时工作日折算（与节奏系统 9:00-18:00 扣午休一致） */
const WORK_HOURS_SEGMENT_RE =
  /(\d+(?:\.\d+)?)\s*(个小时|小时|个钟头|钟头|hours?|hrs?|h|分钟|minutes?|mins?|m|分|个工作日|工作日|人天|天|days?|d)?\s*/iuy;
const HOURS_PER_WORK_DAY = 8;

function workHoursUnitFactor(unit: string): number {
  if (/^(个小时|小时|个钟头|钟头|hours?|hrs?|h)$/iu.test(unit)) return 1;
  if (/^(分钟|minutes?|mins?|m|分)$/iu.test(unit)) return 1 / 60;
  return HOURS_PER_WORK_DAY;
}

/** 「6h」「1.5天」「90分钟」「2h30m」→ 小时数；认不出（「两天」「4-6h」）返回 null */
function workHoursOf(value: string): number | null {
  const body = value.replace(/^(?:约|大约|预计|预估|~|≈)\s*/u, '');
  WORK_HOURS_SEGMENT_RE.lastIndex = 0;
  let total = 0;
  let segments = 0;
  let unitless = false;
  for (;;) {
    const start = WORK_HOURS_SEGMENT_RE.lastIndex;
    const match = WORK_HOURS_SEGMENT_RE.exec(body);
    if (!match) {
      WORK_HOURS_SEGMENT_RE.lastIndex = start;
      break;
    }
    const unit = match[2] ?? '';
    if (unit === '') unitless = true;
    total += Number(match[1]) * (unit === '' ? 1 : workHoursUnitFactor(unit));
    segments += 1;
    if (WORK_HOURS_SEGMENT_RE.lastIndex >= body.length) break;
  }
  const rest = body.slice(WORK_HOURS_SEGMENT_RE.lastIndex).trim();
  // 裸数字只在整行就是一个数时按小时算；后面接着「-」「到」是区间，不猜
  if (segments === 0 || (unitless && (segments > 1 || rest !== ''))) return null;
  if (/^[-~～到至—–]/u.test(rest)) return null;
  return Math.round(total * 100) / 100;
}

/**
 * 描述里「工时=」一行（照「验收条件=」的写法）：工时报价写在这里，统一换算成小时，另留原文。
 * 没有这一行两个字段都是 null；有但认不出数（如「两天」）只留原文。
 */
export function parseWorkHours(descriptionHtml: string | null): {
  workHours: number | null;
  workHoursText: string | null;
} {
  // 行内加粗、高亮等标签先去掉，免得「工时=<strong>6h</strong>」被 stripHtml 拆成两行
  const text = stripHtml(
    (descriptionHtml ?? '').replace(
      /<\/?(?:strong|b|em|i|u|s|span|code|mark|a)(?:\s[^>]*)?>/giu,
      '',
    ),
  );
  for (const raw of text.split('\n')) {
    const match = /^工时\s*[=＝]\s*(.*)$/u.exec(raw.trim());
    if (!match) continue;
    const value = match[1].trim();
    if (value === '') break;
    return { workHours: workHoursOf(value), workHoursText: value };
  }
  return { workHours: null, workHoursText: null };
}

export function parseRewardAmount(title: string): number | null {
  const match = /\+\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?/u.exec(title);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

const SEVERE_BLOCK_MS = 48 * 3_600_000;

export function parseDeadlineTime(title: string): string | null {
  const match = /(\d{1,2})[:：](\d{2})/u.exec(title);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 「9:30」「09:30」「9：30」→「09:30」；不是合法的 24 小时制时刻返回 null */
export function normalizeClockTime(raw: string): string | null {
  const match = /^\s*(\d{1,2})[:：](\d{2})\s*$/u.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export type InlineDeadlineResult =
  | { kind: 'ok'; title: string }
  | { kind: 'empty_title' }
  | { kind: 'time_in_title'; clash: string };

/**
 * 按「标题 HH:mm前」约定把截止时刻拼进标题：标题里原有的「HH:mm前」先去掉，再拼到末尾。
 * parseDeadlineTime 只认标题里的第一个时刻，剩下的标题里还有别的时刻（如「接 9:30 到站的客户」）
 * 就会被当成截止时刻，这时不拼，返回 time_in_title 让人把那个时刻改成文字。
 */
export function withInlineDeadline(
  title: string,
  deadlineTime: string,
): InlineDeadlineResult {
  const base = title.replace(/\s*\d{1,2}[:：]\d{2}前\s*/gu, ' ').trim();
  if (base === '') return { kind: 'empty_title' };
  const clash = /\d{1,2}[:：]\d{2}/u.exec(base);
  if (clash) return { kind: 'time_in_title', clash: clash[0] };
  return { kind: 'ok', title: `${base} ${deadlineTime}前` };
}

export function isSeverelyBlocked(
  status: TaskStatus,
  deadline: string | null,
  deadlineTime: string | null,
): boolean {
  if (deadline === null) return false;
  if (!OPEN_TASK_STATUSES.includes(status)) return false;
  const dueMs = new Date(
    `${deadline}T${deadlineTime ?? '23:59'}:00+08:00`,
  ).getTime();
  return Date.now() - dueMs > SEVERE_BLOCK_MS;
}

export function resolveTaskType(
  title: string,
  labelNames: string[],
): { taskType: TaskType; rewardAmount: number | null } {
  const joined = labelNames.join(' ');
  let taskType: TaskType = 'standard';
  if (joined.includes('委派')) taskType = 'delegated';
  else if (joined.includes('定时')) taskType = 'scheduled';
  else if (joined.includes('日常')) taskType = 'daily';
  else if (joined.includes('工单')) taskType = 'workorder';
  return {
    taskType,
    rewardAmount:
      taskType === 'delegated' ? parseRewardAmount(title) : null,
  };
}

export function shanghaiDateString(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
