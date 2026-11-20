import dayjs from 'dayjs';
import type {
  AcceptanceRecordView,
  BusinessApprovalState,
  WorkOrderBusinessLine,
  WorkOrderComplexity,
  WorkOrderStatus,
  WorkOrderSubjectKind,
  WorkOrderType,
} from '@shared/api.interface';

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  draft: '草稿',
  pending: '待执行',
  executing: '执行中',
  pending_submit: '待提交',
  ai_reviewing: 'AI初审中',
  needs_revision: '需修改',
  rejected: '已驳回',
  pending_boss: '待老板终审',
  approved: '已通过',
  refused: '已拒绝',
};

// 状态色：待执行灰、执行中琥珀、待提交/AI初审蓝、需修改红、
// 待老板终审紫、已通过绿、已驳回/已拒绝红灰
export const WORK_ORDER_STATUS_BADGE_CLASS: Record<WorkOrderStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground',
  executing: 'bg-amber-100 text-amber-700',
  pending_submit: 'bg-blue-100 text-blue-700',
  ai_reviewing: 'bg-blue-100 text-blue-700',
  needs_revision: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700/80',
  pending_boss: 'bg-purple-100 text-purple-700',
  approved: 'bg-green-100 text-green-700',
  refused: 'bg-red-100 text-red-700/80',
};

export const WORK_ORDER_TYPE_LABELS: Record<WorkOrderType, string> = {
  purchase: '采购',
  sales: '销售',
  special_delegation: '特殊委派',
  other: '其他',
};

export const WORK_ORDER_COMPLEXITY_LABELS: Record<WorkOrderComplexity, string> =
  {
    simple: '简单',
    medium: '中等',
    complex: '复杂',
  };

export function workOrderBadge(status: WorkOrderStatus): string {
  return `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${WORK_ORDER_STATUS_BADGE_CLASS[status]}`;
}

export const WORK_ORDER_BUSINESS_LINE_LABELS: Record<WorkOrderBusinessLine, string> = {
  used_goods: '二手实物',
  virtual_goods: '虚拟商品',
  tech_service: '技术服务',
};

export const WORK_ORDER_SUBJECT_KIND_LABELS: Record<WorkOrderSubjectKind, string> = {
  product: '商品',
  peer: '同行',
  customer: '客户',
  study: '学习对象',
  erp_doc: 'ERP 单据',
  other: '其他',
};

/** 截止：今年的不写年份，跨天看得出是哪天 */
export function formatDueAt(iso: string): string {
  const due = dayjs(iso);
  return due.year() === dayjs().year() ? due.format('MM-DD HH:mm') : due.format('YYYY-MM-DD HH:mm');
}

export const ACCEPTANCE_KIND_LABELS: Record<AcceptanceRecordView['kind'], string> = {
  review: '验收',
  research_pass: '研究通过',
  business_approval: '经营批准',
  listing_confirm: '上架确认',
};

export const ACCEPTANCE_DECISION_LABELS: Record<AcceptanceRecordView['decision'], string> = {
  approved: '通过',
  returned: '退回',
  refused: '拒绝',
};

export const BUSINESS_APPROVAL_STATE_LABELS: Record<BusinessApprovalState, string> = {
  active: '生效中',
  paused: '已暂停',
  exited: '已退出',
};

/** 一条验收记录的短标题，如「经营批准 · 已暂停」「验收 · 退回」 */
export function acceptanceRecordTitle(record: AcceptanceRecordView): string {
  if (record.kind === 'business_approval') {
    return `经营批准 · ${BUSINESS_APPROVAL_STATE_LABELS[record.state ?? 'active']}`;
  }
  if (record.kind === 'review') {
    return `验收 · ${ACCEPTANCE_DECISION_LABELS[record.decision]}`;
  }
  return ACCEPTANCE_KIND_LABELS[record.kind];
}
