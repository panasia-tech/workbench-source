/**
 * 开发需求的环节、权限、和 Plane 对不上时的提示：纯函数，不碰库、不连 Plane
 * （scripts/checks/dev-request.check.mjs 离线自检）。
 *
 * 环节以 Plane 状态为准：开发类项目的五步状态按名字认（10-18 建的，中文名 slug 恒为空），
 * 完成 / 取消按状态分组，阻塞按 mapStatusByState 同口径。
 */
import type {
  DevRequestAction,
  DevRequestStage,
} from '@shared/api.interface';
import { mapStatusByState } from '../integration/plane-mapping';

/** Plane 开发类项目的五步状态名 */
export const DEV_FLOW_STATE_NAMES = {
  submitted: '需求提交',
  clarifying: '需求评审',
  quoted: '工时报价',
  developing: '开发交付',
  reviewing: '结果验收',
} as const;

export type DevFlowStage = keyof typeof DEV_FLOW_STATE_NAMES;

export const DEV_FLOW_STAGES: DevFlowStage[] = [
  'submitted',
  'clarifying',
  'quoted',
  'developing',
  'reviewing',
];

export interface PlaneStateLike {
  id: string;
  name: string;
  group: string;
  slug?: string | null;
  sequence?: number;
}

/** 五步状态名都在（按名字）才算开发类项目，不写死项目名单 */
export function isDevProjectStates(states: PlaneStateLike[]): boolean {
  const names = new Set(states.map((s: PlaneStateLike) => (s.name ?? '').trim()));
  return DEV_FLOW_STAGES.every((stage: DevFlowStage) =>
    names.has(DEV_FLOW_STATE_NAMES[stage]),
  );
}

export function findFlowState(
  states: PlaneStateLike[],
  stage: DevFlowStage,
): PlaneStateLike | undefined {
  return states.find(
    (s: PlaneStateLike) => (s.name ?? '').trim() === DEV_FLOW_STATE_NAMES[stage],
  );
}

/** 完成 / 取消组里排序最前的状态 */
export function findGroupState(
  states: PlaneStateLike[],
  group: 'completed' | 'cancelled',
): PlaneStateLike | undefined {
  return states
    .filter((s: PlaneStateLike) => s.group === group)
    .sort(
      (a: PlaneStateLike, b: PlaneStateLike) =>
        (a.sequence ?? 0) - (b.sequence ?? 0),
    )[0];
}

/** Plane 当前状态 → 开发需求环节；先认五步状态名，再看分组，最后看是不是阻塞 */
export function stageOfState(
  state: PlaneStateLike | null | undefined,
): DevRequestStage {
  if (!state) return 'missing';
  const name = (state.name ?? '').trim();
  for (const stage of DEV_FLOW_STAGES) {
    if (DEV_FLOW_STATE_NAMES[stage] === name) return stage;
  }
  if (state.group === 'completed') return 'done';
  if (state.group === 'cancelled') return 'cancelled';
  if (
    mapStatusByState({
      group: state.group,
      slug: state.slug ?? '',
      name: state.name,
    }) === 'BLOCKED'
  ) {
    return 'blocked';
  }
  return 'other';
}

/** 流程判断要用到的那几列（库里一行开发需求的子集） */
export interface DevRequestFlowRecord {
  publisherId: string;
  developerId: string;
  expectedStage: string;
  quotedAt: Date | null;
  quoteConfirmedAt: Date | null;
  deliveredAt: Date | null;
  acceptedAt: Date | null;
  cancelledAt: Date | null;
}

export interface DevRequestActor {
  userId: string;
  /** 平台角色 boss 本人（演示视角不算） */
  isBoss: boolean;
}

const STAGE_TEXT: Record<DevRequestStage, string> = {
  submitted: DEV_FLOW_STATE_NAMES.submitted,
  clarifying: DEV_FLOW_STATE_NAMES.clarifying,
  quoted: DEV_FLOW_STATE_NAMES.quoted,
  developing: DEV_FLOW_STATE_NAMES.developing,
  reviewing: DEV_FLOW_STATE_NAMES.reviewing,
  done: '完成',
  cancelled: '已撤销',
  blocked: '阻塞',
  other: '流程外',
  missing: 'Plane 里找不到',
};

export function stageText(stage: string): string {
  return STAGE_TEXT[stage as DevRequestStage] ?? stage;
}

/** 显示用的环节名：五步用 Plane 状态名；完成组看有没有验收过 */
export function stageLabelOf(
  stage: DevRequestStage,
  stateName: string | null,
  record: Pick<DevRequestFlowRecord, 'acceptedAt'>,
): string {
  if (stage === 'done') return record.acceptedAt ? '已验收' : '完成';
  if (stage === 'cancelled') return '已撤销';
  if (stage === 'missing') return STAGE_TEXT.missing;
  if (stage === 'blocked') return `阻塞（${stateName ?? '阻塞'}）`;
  return stateName ?? STAGE_TEXT[stage];
}

/** 下一步轮到谁做什么 */
export function nextStepOf(
  stage: DevRequestStage,
  record: DevRequestFlowRecord,
): string {
  switch (stage) {
    case 'submitted':
      return '等开发者报价';
    case 'clarifying':
      return '等发布人补充需求';
    case 'quoted':
      return record.quotedAt ? '等发布人确认报价' : '还没有报价';
    case 'developing':
      return '开发中，等开发者交付';
    case 'blocked':
      return '开发中报了阻塞';
    case 'reviewing':
      return '等发布人验收';
    case 'done':
      return record.acceptedAt ? '已验收，已记账' : '未经验收，没有记账';
    case 'cancelled':
      return '已撤销';
    case 'other':
      return '不在开发需求流程里';
    default:
      return '流程没法继续';
  }
}

/**
 * 和流程对不上的情况（Plane 里直接拖了状态拦不住，只能如实标出来）；正常返回 null。
 * expectedStage 是工作台最后一次把它挪到的环节。
 */
export function flowWarningOf(
  stage: DevRequestStage,
  stateName: string | null,
  record: DevRequestFlowRecord,
): string | null {
  const name = stateName ?? stageText(stage);
  if (stage === 'missing') {
    return 'Plane 里找不到这条任务（可能被删除或归档了），流程没法继续';
  }
  if (record.acceptedAt) {
    return stage === 'done' ? null : `已验收记账，但在 Plane 里被改成了「${name}」`;
  }
  if (record.cancelledAt) {
    return stage === 'cancelled' ? null : `已撤销，但在 Plane 里被改成了「${name}」`;
  }
  if (stage === 'done') return '在 Plane 里直接改成完成，未经验收，没有记账';
  if (stage === 'cancelled') return '在 Plane 里直接取消了，没走撤销';
  if (stage === 'other') {
    return `在 Plane 里改成了「${name}」，不在开发需求流程里；请在 Plane 里改回，或撤销这条需求`;
  }
  if (stage === 'blocked') {
    return record.quoteConfirmedAt
      ? null
      : `在 Plane 里改成了「${name}」，但报价还没确认`;
  }
  // 阻塞后在 Plane 里直接改回「开发交付」不算问题
  const expected =
    record.expectedStage === 'blocked' ? 'developing' : record.expectedStage;
  if (stage === expected) return null;
  if (stage === 'developing' && !record.quoteConfirmedAt) {
    return '在 Plane 里直接改成「开发交付」，报价还没确认，交付不了；请在 Plane 里改回「需求提交」走报价，或撤销';
  }
  if (stage === 'reviewing' && !record.deliveredAt) {
    return '在 Plane 里直接改成「结果验收」，还没有交付；可以打回让开发者交付';
  }
  if (stage === 'quoted' && !record.quotedAt) {
    return '在 Plane 里直接改成「工时报价」，还没有报价；请在 Plane 里改回「需求提交」';
  }
  return `在 Plane 里直接改成了「${name}」（按流程应在「${stageText(expected)}」）`;
}

/** 只看身份（不看环节）：这个人能不能做这个动作。不能 → 403 */
export function rolePermits(
  action: DevRequestAction,
  actor: DevRequestActor,
  record: Pick<DevRequestFlowRecord, 'publisherId' | 'developerId'>,
): boolean {
  const isPublisher = actor.userId === record.publisherId;
  const isDeveloper = actor.userId === record.developerId;
  switch (action) {
    case 'quote':
      // 老板可以替开发者报价，但不能给自己发的需求报价（自己报、自己确认）
      return isDeveloper || (actor.isBoss && !isPublisher);
    case 'return':
    case 'deliver':
    case 'block':
      return isDeveloper;
    case 'clarify':
      return isPublisher;
    case 'confirm_quote':
    case 'reject_quote':
    case 'accept':
    case 'reject_delivery':
      // 开发者不能确认自己的报价、验收自己的交付，是老板也不行
      return (isPublisher || actor.isBoss) && !isDeveloper;
    case 'unblock':
      return isDeveloper || actor.isBoss;
    case 'cancel':
      return isPublisher || actor.isBoss;
    default:
      return false;
  }
}

/** 动作要求的 Plane 环节 */
export const ACTION_STAGES: Record<DevRequestAction, DevRequestStage[] | 'open'> = {
  quote: ['submitted'],
  return: ['submitted'],
  clarify: ['clarifying'],
  confirm_quote: ['quoted'],
  reject_quote: ['quoted'],
  deliver: ['developing'],
  block: ['developing'],
  unblock: ['blocked'],
  accept: ['reviewing'],
  reject_delivery: ['reviewing'],
  // 完成之前哪一步都能撤（含在 Plane 里拖到流程外的）
  cancel: 'open',
};

export function stagePermits(
  action: DevRequestAction,
  stage: DevRequestStage,
): boolean {
  const allowed = ACTION_STAGES[action];
  if (allowed === 'open') {
    return stage !== 'done' && stage !== 'cancelled' && stage !== 'missing';
  }
  return allowed.includes(stage);
}

/** 环节对了还要满足的流程数据；不满足返回原因（400），满足返回 null */
export function preconditionError(
  action: DevRequestAction,
  record: DevRequestFlowRecord,
): string | null {
  if (record.acceptedAt) return '这条需求已经验收过了';
  if (record.cancelledAt) return '这条需求已经撤销了';
  switch (action) {
    case 'confirm_quote':
    case 'reject_quote':
      return record.quotedAt ? null : '还没有报价';
    case 'deliver':
    case 'block':
    case 'unblock':
      return record.quoteConfirmedAt ? null : '报价还没确认，不能开工';
    case 'accept':
      if (!record.quoteConfirmedAt) return '报价还没确认，不能验收';
      return record.deliveredAt ? null : '开发者还没交付，不能验收';
    default:
      return null;
  }
}

const ALL_ACTIONS: DevRequestAction[] = [
  'quote',
  'return',
  'clarify',
  'confirm_quote',
  'reject_quote',
  'deliver',
  'block',
  'unblock',
  'accept',
  'reject_delivery',
  'cancel',
];

/** 当前用户此刻能做的动作（身份、环节、流程数据三样都满足） */
export function allowedActionsOf(
  actor: DevRequestActor,
  record: DevRequestFlowRecord,
  stage: DevRequestStage,
): DevRequestAction[] {
  return ALL_ACTIONS.filter(
    (action: DevRequestAction) =>
      rolePermits(action, actor, record) &&
      stagePermits(action, stage) &&
      preconditionError(action, record) === null,
  );
}

// ───────── 金额与工时 ─────────

/** 元 → 分；不是有限数、负数或超过两位小数返回 null */
export function toCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) return null;
  return cents;
}

/** 分 → 写库用的 numeric 文本 */
export function centsToNumeric(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** numeric 文本 → 数字（元 / 小时） */
export function numericToNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 金额显示：整数不带小数，否则两位小数 */
export function yuanText(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** 工时显示：去掉多余的 0 */
export function hoursText(hours: number): string {
  return String(Number(hours.toFixed(2)));
}
