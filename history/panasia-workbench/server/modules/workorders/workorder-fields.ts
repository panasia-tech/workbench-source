import type {
  WorkOrderBusinessLine,
  WorkOrderChecklistItem,
  WorkOrderSubject,
  WorkOrderSubjectKind,
} from '@shared/api.interface';

/**
 * 工单上的几样结构化字段（11-10 销售工作台 A01）：业务线、关联对象、凭证清单的「需现场」。
 * 工单服务、终审服务、MCP 发单共用，解析口径只在这一处。
 */

export const WORK_ORDER_BUSINESS_LINES = [
  'used_goods',
  'virtual_goods',
  'tech_service',
] as const;

export const WORK_ORDER_BUSINESS_LINE_LABELS: Record<WorkOrderBusinessLine, string> = {
  used_goods: '二手实物',
  virtual_goods: '虚拟商品',
  tech_service: '技术服务',
};

export const WORK_ORDER_SUBJECT_KINDS = [
  'product',
  'peer',
  'customer',
  'study',
  'erp_doc',
  'other',
] as const;

/** 一张工单最多挂几个对象 */
export const WORK_ORDER_SUBJECTS_MAX = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBusinessLine(value: unknown): WorkOrderBusinessLine | null {
  return (
    WORK_ORDER_BUSINESS_LINES.find((line: WorkOrderBusinessLine) => line === value) ??
    null
  );
}

/** 关联对象：认不出的种类按「其他」，没名字的丢掉，最多 10 个 */
export function parseSubjects(value: unknown): WorkOrderSubject[] {
  if (!Array.isArray(value)) return [];
  const items: WorkOrderSubject[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 255) : '';
    if (name === '') continue;
    const kind: WorkOrderSubjectKind =
      WORK_ORDER_SUBJECT_KINDS.find((k: WorkOrderSubjectKind) => k === raw.kind) ?? 'other';
    const ref = typeof raw.ref === 'string' ? raw.ref.trim().slice(0, 500) : '';
    items.push(ref !== '' ? { kind, name, ref } : { kind, name });
    if (items.length >= WORK_ORDER_SUBJECTS_MAX) break;
  }
  return items;
}

export function parseChecklist(value: unknown): WorkOrderChecklistItem[] {
  if (!Array.isArray(value)) return [];
  const items: WorkOrderChecklistItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.key !== 'string' || typeof raw.name !== 'string') continue;
    const item: WorkOrderChecklistItem = { key: raw.key, name: raw.name };
    if (typeof raw.required === 'boolean') item.required = raw.required;
    if (typeof raw.type === 'string') item.type = raw.type;
    if (raw.onSite === true) item.onSite = true;
    items.push(item);
  }
  return items;
}
