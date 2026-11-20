import type { DevRequestEventView } from '@shared/api.interface';
import { formatDateTime, formatHours, formatYuan } from './dev-request-ui';

interface DevRequestTimelineProps {
  events: DevRequestEventView[];
}

function detailText(event: DevRequestEventView): string | null {
  const detail = event.detail;
  if (!detail) return null;
  if (event.action === 'accept' && detail.finalAmount !== undefined) {
    const adjusted =
      detail.quoteAmount !== undefined && detail.quoteAmount !== detail.finalAmount
        ? `（报价 ${formatYuan(detail.quoteAmount)}${detail.adjustReason ? `，${detail.adjustReason}` : ''}）`
        : '';
    return `记账 ${formatYuan(detail.finalAmount)}${adjusted}`;
  }
  if (detail.hours !== undefined && detail.amount !== undefined) {
    return `${formatHours(detail.hours)} · ${formatYuan(detail.amount)}${
      detail.promisedDate ? ` · 承诺 ${detail.promisedDate} 前交付` : ''
    }`;
  }
  return null;
}

/** 事件历史：谁、什么时候、做了什么（只追加，最新的在最下面） */
const DevRequestTimeline = ({ events }: DevRequestTimelineProps) => {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">暂无记录</p>;
  }
  return (
    <ol className="space-y-4 border-l pl-4">
      {events.map((event: DevRequestEventView) => {
        const extra = detailText(event);
        return (
          <li key={event.id} className="relative">
            <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
            <p className="text-sm">
              <span className="font-medium">{event.actorName ?? '系统'}</span>
              <span className="ml-1.5">{event.actionLabel}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {formatDateTime(event.createdAt)}
              </span>
            </p>
            {extra ? <p className="mt-0.5 text-sm text-muted-foreground">{extra}</p> : null}
            {event.note ? (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {event.note}
              </p>
            ) : null}
            {event.detail?.links && event.detail.links.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {event.detail.links.map((link: string) => (
                  <li key={link} className="truncate text-xs">
                    <a href={link} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

export default DevRequestTimeline;
