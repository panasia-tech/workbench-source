import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Code2 } from 'lucide-react';
import type { DevRequestSummary } from '@shared/api.interface';
import { STAGE_TONE, formatHours, formatYuan } from './dev-request-ui';

interface DevRequestCardProps {
  item: DevRequestSummary;
}

const CLOSED_STAGES = ['done', 'cancelled', 'missing'];

/** 开发需求卡片：环节 + 下一步 + 标题 + 项目 + 双方 + 报价 / 验收金额；有对不上的情况整行标橙 */
const DevRequestCard = ({ item }: DevRequestCardProps) => {
  // 结束了的、和 Plane 对不上的（下面有橙条）不再写「下一步」，免得和环节名重复
  const showNext = !item.warning && !CLOSED_STAGES.includes(item.stage);
  const money =
    item.finalAmount !== null
      ? `验收 ${formatYuan(item.finalAmount)}`
      : item.quote
        ? `报价 ${formatYuan(item.quote.amount)} · ${formatHours(item.quote.hours)}${
            item.quote.confirmedAt ? '' : '（待确认）'
          }`
        : null;
  return (
    <Link
      to={`/dev-requests/${item.id}`}
      className="flex flex-col gap-2 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_TONE[item.stage]}`}
        >
          {item.stageLabel}
        </span>
        {showNext ? (
          <span
            className={`text-xs ${item.needsMe ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
          >
            {item.needsMe ? `轮到你 · ${item.nextStep}` : item.nextStep}
          </span>
        ) : null}
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-baseline gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">
              #{item.sequenceId ?? '—'}
            </span>
            <span className="break-words text-base font-semibold leading-snug">
              {item.title}
            </span>
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Code2 className="h-3.5 w-3.5 shrink-0" />
            {item.projectName}
          </p>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <p className="text-xs text-muted-foreground">
        {item.publisherName} 发给 {item.developerName}
        {money ? ` · ${money}` : ''}
      </p>
      {item.warning ? (
        <p className="flex items-start gap-1.5 rounded-md bg-orange-50 px-3 py-2 text-xs text-orange-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {item.warning}
        </p>
      ) : null}
    </Link>
  );
};

export default DevRequestCard;
