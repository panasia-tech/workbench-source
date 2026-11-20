import React from 'react';
import dayjs from 'dayjs';
import {
  CheckCircle2,
  Gavel,
  Phone,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import EvidenceThumbnails from '@/components/EvidenceThumbnails';
import {
  SubjectChips,
  SubmissionVersionList,
} from '@client/src/pages/tasks/WorkOrderAcceptance';
import {
  formatDueAt,
  WORK_ORDER_BUSINESS_LINE_LABELS,
} from '@client/src/pages/tasks/workorder-status';
import type {
  ReviewWorkOrderRow,
  WorkOrderAiVerdict,
  WorkOrderComplexity,
  WorkOrderType,
} from '@shared/api.interface';
import AcceptancePanel from './AcceptancePanel';

export type WorkOrderVerdictResult = 'approved' | 'refused' | 'returned';

interface WorkOrderReviewCardProps {
  order: ReviewWorkOrderRow;
  onVerdict: (result: WorkOrderVerdictResult) => void;
  /** 记了研究通过 / 经营批准 / 上架确认之后刷新 */
  onChanged: () => void;
}

const ORDER_TYPE_LABELS: Record<WorkOrderType, string> = {
  purchase: '采购',
  sales: '销售',
  special_delegation: '特殊委派',
  other: '其他',
};

const COMPLEXITY_LABELS: Record<WorkOrderComplexity, string> = {
  simple: '简单',
  medium: '中等',
  complex: '复杂',
};

const AI_VERDICT_LABELS: Record<
  NonNullable<WorkOrderAiVerdict['verdict']>,
  string
> = {
  pass: '初审通过',
  reject: '初审驳回',
  revise: '需修改',
  need_human: '需人工',
};

/** 工单终审卡：凭证缩略 + 规则闸结果 + 联系老板字段 + 通过/驳回 */
const WorkOrderReviewCard: React.FC<WorkOrderReviewCardProps> = ({
  order,
  onVerdict,
  onChanged,
}) => {
  const isPending = order.status === 'pending_boss';
  const contact = order.contactBossFields;
  const latestVersion = order.versions[0]?.version ?? null;

  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{order.code}</span>
            <span className="text-base font-semibold">{order.title}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {order.catalogName && (
              <Badge variant="secondary" className="text-xs">
                {order.catalogName}
              </Badge>
            )}
            <Badge variant="secondary" className="text-xs">
              {ORDER_TYPE_LABELS[order.orderType]}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {COMPLEXITY_LABELS[order.complexity]}
            </Badge>
            {order.businessLine && (
              <Badge variant="secondary" className="text-xs">
                {WORK_ORDER_BUSINESS_LINE_LABELS[order.businessLine]}
              </Badge>
            )}
            {order.assigneeName && (
              <span className="text-xs text-muted-foreground">
                负责人 {order.assigneeName}
              </span>
            )}
            {order.dueAt && (
              <span className="text-xs text-muted-foreground">
                截止 {formatDueAt(order.dueAt)}
              </span>
            )}
          </div>
          {order.subjects.length > 0 && (
            <div className="mt-1.5">
              <SubjectChips subjects={order.subjects} />
            </div>
          )}
        </div>
        {isPending ? (
          <Badge className="bg-purple-500/10 text-purple-600">
            待老板终审
          </Badge>
        ) : order.status === 'approved' ? (
          <Badge className="bg-green-500/10 text-green-600">已通过</Badge>
        ) : (
          <Badge className="bg-red-500/10 text-red-600">已拒绝</Badge>
        )}
      </div>

      {contact && (contact.contact || contact.urgency || (contact.reportPoints ?? []).length > 0) && (
        <div className="space-y-1.5 rounded-lg bg-muted/50 p-3">
          {contact.contact && (
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>联系：{contact.contact}</span>
            </div>
          )}
          {contact.urgency && (
            <div className="flex items-center gap-2 text-sm">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>紧急度：{contact.urgency}</span>
            </div>
          )}
          {(contact.reportPoints ?? []).length > 0 && (
            <div className="text-xs text-muted-foreground">
              汇报要点：
              {(contact.reportPoints ?? []).map((point: string) => (
                <span key={point} className="ml-1">
                  「{point}」
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {order.evidence.length > 0 && (
        <div className="space-y-2">
          {latestVersion !== null && (
            <p className="text-xs font-medium">
              第 {latestVersion} 版
              {order.versions.length > 1 ? `（交过 ${order.versions.length} 版）` : ''}
            </p>
          )}
          {order.evidence.map((item) => (
            <div key={item.id} className="space-y-1.5">
              <span className="text-xs text-muted-foreground">
                {item.itemName ?? item.itemKey}
              </span>
              <EvidenceThumbnails
                urls={item.fileUrls}
                label={item.itemName ?? '凭证'}
              />
            </div>
          ))}
          <SubmissionVersionList versions={order.versions} showLatest={false} />
        </div>
      )}

      {order.aiVerdict && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Gavel className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">规则闸：</span>
          {order.aiVerdict.verdict && (
            <Badge
              variant="secondary"
              className={
                order.aiVerdict.verdict === 'pass'
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-amber-500/10 text-amber-600'
              }
            >
              {AI_VERDICT_LABELS[order.aiVerdict.verdict]}
            </Badge>
          )}
          {(order.aiVerdict.checkedItems ?? []).map((checked) => (
            <Badge
              key={checked.name}
              variant="secondary"
              className={
                checked.pass
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-red-500/10 text-red-600'
              }
            >
              {checked.pass ? '✓' : '✗'} {checked.name}
            </Badge>
          ))}
        </div>
      )}

      {!isPending && order.humanVerdict && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2 text-xs text-muted-foreground">
          {order.humanVerdict.result === 'approved' ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-red-600" />
          )}
          <span>
            老板终审：
            {order.humanVerdict.result === 'approved' ? '通过' : '拒绝'}
            {order.humanVerdict.version !== undefined
              ? `（第 ${order.humanVerdict.version} 版）`
              : ''}
          </span>
          {order.humanVerdict.at &&
            dayjs(order.humanVerdict.at).format('MM-DD HH:mm')}
          {order.humanVerdict.comment && (
            <span className="break-words">「{order.humanVerdict.comment}」</span>
          )}
          {order.erpDocName && (
            <span className="text-green-600">
              已落 ERP {order.erpDocType}：{order.erpDocName}
            </span>
          )}
        </div>
      )}

      <AcceptancePanel
        subjectType="work_order"
        subjectId={order.id}
        versions={order.versions}
        records={order.acceptanceRecords}
        onChanged={onChanged}
      />

      {isPending && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onVerdict('returned')}>
            退回修改
          </Button>
          <Button variant="outline" onClick={() => onVerdict('refused')}>
            拒绝
          </Button>
          <Button onClick={() => onVerdict('approved')}>通过</Button>
        </div>
      )}
    </div>
  );
};

export default WorkOrderReviewCard;
