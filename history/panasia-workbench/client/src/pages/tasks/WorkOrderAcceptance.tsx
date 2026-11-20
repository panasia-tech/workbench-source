import React, { useState } from 'react';
import dayjs from 'dayjs';
import { ArrowRightLeft, ChevronDown, History } from 'lucide-react';

import { Button } from '@/components/ui/button';
import EvidenceThumbnails from '@/components/EvidenceThumbnails';
import type {
  AcceptanceRecordView,
  SubmissionVersionView,
  WorkOrderHandoverView,
  WorkOrderSubject,
} from '@shared/api.interface';
import {
  ACCEPTANCE_DECISION_LABELS,
  acceptanceRecordTitle,
  WORK_ORDER_SUBJECT_KIND_LABELS,
} from './workorder-status';

/** 关联对象：「商品 · iPhone 15 Pro」，有链接的可点 */
export function SubjectChips({ subjects }: { subjects: WorkOrderSubject[] }) {
  if (subjects.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {subjects.map((subject: WorkOrderSubject, index: number) => {
        const text = `${WORK_ORDER_SUBJECT_KIND_LABELS[subject.kind]} · ${subject.name}`;
        const isLink = subject.ref !== undefined && /^https?:\/\//i.test(subject.ref);
        return isLink ? (
          <a
            key={`${subject.kind}-${index}`}
            href={subject.ref}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border px-2 py-0.5 text-xs text-primary hover:bg-muted"
          >
            {text}
          </a>
        ) : (
          <span
            key={`${subject.kind}-${index}`}
            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
            title={subject.ref}
          >
            {text}
            {subject.ref ? ` · ${subject.ref}` : ''}
          </span>
        );
      })}
    </div>
  );
}

function VersionBody({ version }: { version: SubmissionVersionView }) {
  return (
    <div className="space-y-2">
      {version.items.map((item, index: number) => (
        <div key={`${item.name}-${index}`} className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {item.name}
            {item.note ? `：${item.note}` : ''}
          </p>
          {item.fileUrls.length > 0 ? (
            <EvidenceThumbnails urls={item.fileUrls} label={item.name} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 交过的每一版：最新一版直接展开，更早的折起来点开看。重交不覆盖，每版都在。
 * showLatest=false 时只列更早的（最新那版在外面已经按凭证清单展示了）。
 */
export function SubmissionVersionList({
  versions,
  showLatest = true,
}: {
  versions: SubmissionVersionView[];
  showLatest?: boolean;
}) {
  const [openOlder, setOpenOlder] = useState(false);
  if (versions.length === 0) return null;
  const [latest, ...older] = versions;
  return (
    <div className="space-y-2">
      {showLatest ? (
        <div className="rounded-md border px-3 py-2">
          <p className="mb-1.5 text-xs font-medium">
            第 {latest.version} 版 · {dayjs(latest.createdAt).format('MM-DD HH:mm')}
          </p>
          <VersionBody version={latest} />
        </div>
      ) : null}
      {older.length > 0 ? (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpenOlder((prev: boolean) => !prev)}
          >
            <History className="h-3.5 w-3.5" />
            之前的 {older.length} 版
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${openOlder ? 'rotate-180' : ''}`}
            />
          </button>
          {openOlder ? (
            <div className="mt-2 space-y-2">
              {older.map((version: SubmissionVersionView) => (
                <div key={version.id} className="rounded-md border border-dashed px-3 py-2">
                  <p className="mb-1.5 text-xs text-muted-foreground">
                    第 {version.version} 版 · {dayjs(version.createdAt).format('MM-DD HH:mm')}
                  </p>
                  <VersionBody version={version} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const RECORD_TONE: Record<AcceptanceRecordView['kind'], string> = {
  review: 'bg-muted text-foreground',
  research_pass: 'bg-blue-100 text-blue-700',
  business_approval: 'bg-green-100 text-green-700',
  listing_confirm: 'bg-purple-100 text-purple-700',
};

function recordTone(record: AcceptanceRecordView): string {
  if (record.kind === 'review' && record.decision !== 'approved') {
    return 'bg-red-100 text-red-700';
  }
  if (record.kind === 'business_approval' && record.state !== 'active') {
    return 'bg-amber-100 text-amber-700';
  }
  return RECORD_TONE[record.kind];
}

/**
 * 验收记录：验收、研究通过、经营批准、上架确认各一条，指向第几版。
 * 传了 onApprovalAction（老板 / 管理员）时，经营批准后面有暂停 / 恢复 / 退出。
 */
export function AcceptanceRecordList({
  records,
  onApprovalAction,
}: {
  records: AcceptanceRecordView[];
  onApprovalAction?: (record: AcceptanceRecordView, action: 'pause' | 'resume' | 'exit') => void;
}) {
  if (records.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {records.map((record: AcceptanceRecordView) => (
        <li key={record.id} className="rounded-md border px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 font-medium ${recordTone(record)}`}>
              {acceptanceRecordTitle(record)}
            </span>
            {record.version !== null ? (
              <span className="text-muted-foreground">第 {record.version} 版</span>
            ) : null}
            <span className="text-muted-foreground">
              {record.operatorName ?? ''} {dayjs(record.createdAt).format('MM-DD HH:mm')}
            </span>
            {onApprovalAction && record.kind === 'business_approval' && record.state !== 'exited' ? (
              <span className="ml-auto flex gap-1">
                {record.state === 'active' ? (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onApprovalAction(record, 'pause')}>
                    暂停
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onApprovalAction(record, 'resume')}>
                    恢复
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onApprovalAction(record, 'exit')}>
                  退出
                </Button>
              </span>
            ) : null}
          </div>
          {record.scope ? <p className="mt-1">范围：{record.scope}</p> : null}
          {record.reason ? (
            <p className="mt-1 text-muted-foreground">
              {record.kind === 'review' && record.decision !== 'approved'
                ? `${ACCEPTANCE_DECISION_LABELS[record.decision]}原因：`
                : '备注：'}
              {record.reason}
            </p>
          ) : null}
          {record.kind === 'business_approval' && record.history.length > 1 ? (
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {record.history.slice(1).map((entry, index: number) => (
                <li key={`${entry.at}-${index}`}>
                  {dayjs(entry.at).format('MM-DD HH:mm')}{' '}
                  {entry.action === 'pause' ? '暂停' : entry.action === 'resume' ? '恢复' : '退出'}
                  {entry.by ? `（${entry.by}）` : ''}
                  {entry.reason ? `：${entry.reason}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** 转交记录：接手人看得到上一手做了什么、下一步、材料在哪 */
export function HandoverList({ handovers }: { handovers: WorkOrderHandoverView[] }) {
  if (handovers.length === 0) return null;
  return (
    <ul className="space-y-2">
      {[...handovers].reverse().map((item: WorkOrderHandoverView) => (
        <li key={item.id} className="rounded-md border bg-amber-50/60 px-3 py-2 text-xs">
          <p className="flex items-center gap-1 font-medium">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            {item.fromName ?? '原负责人'} → {item.toName ?? '接手人'}
            <span className="font-normal text-muted-foreground">
              {dayjs(item.createdAt).format('MM-DD HH:mm')}
            </span>
          </p>
          <p className="mt-1">已做：{item.done}</p>
          <p className="mt-0.5">下一步：{item.next}</p>
          {item.materials ? <p className="mt-0.5">材料：{item.materials}</p> : null}
          {item.materialUrls.length > 0 ? (
            <div className="mt-1">
              <EvidenceThumbnails urls={item.materialUrls} label="转交材料" />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
