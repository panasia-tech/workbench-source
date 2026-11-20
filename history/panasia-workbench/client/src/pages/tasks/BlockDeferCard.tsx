import { CalendarClock } from 'lucide-react';
import type { BlockDeferInfo, BlockDeferStatus } from '@shared/api.interface';

interface BlockDeferStatusStyle {
  label: string;
  badgeClass: string;
  borderClass: string;
  iconClass: string;
  titleClass: string;
}

const STATUS_STYLES: Record<BlockDeferStatus, BlockDeferStatusStyle> = {
  pending: {
    label: 'AI 初审中',
    badgeClass: 'bg-blue-50 text-blue-700 border border-blue-200',
    borderClass: 'border-blue-200',
    iconClass: 'text-blue-600',
    titleClass: 'text-blue-700',
  },
  ai_passed: {
    label: '待老板终审',
    badgeClass: 'bg-purple-50 text-purple-700 border border-purple-200',
    borderClass: 'border-purple-200',
    iconClass: 'text-purple-600',
    titleClass: 'text-purple-700',
  },
  ai_rejected: {
    label: 'AI 已驳回',
    badgeClass: 'bg-red-50 text-red-700 border border-red-200',
    borderClass: 'border-red-200',
    iconClass: 'text-red-600',
    titleClass: 'text-red-700',
  },
  approved: {
    label: '已顺延',
    badgeClass: 'bg-green-50 text-green-700 border border-green-200',
    borderClass: 'border-green-200',
    iconClass: 'text-green-600',
    titleClass: 'text-green-700',
  },
  rejected: {
    label: '老板已拒绝',
    badgeClass: 'bg-red-50 text-red-700 border border-red-200',
    borderClass: 'border-red-200',
    iconClass: 'text-red-600',
    titleClass: 'text-red-700',
  },
  cancelled: {
    label: '已取消',
    badgeClass: 'bg-muted text-muted-foreground border',
    borderClass: 'border-border',
    iconClass: 'text-muted-foreground',
    titleClass: 'text-muted-foreground',
  },
};

const formatDeferMinutes = (minutes: number): string => {
  if (minutes < 60) return `顺延 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `顺延 ${hours} 小时 ${rest} 分` : `顺延 ${hours} 小时`;
};

interface BlockDeferCardProps {
  defer: BlockDeferInfo;
}

export const BlockDeferCard = ({ defer }: BlockDeferCardProps) => {
  const style = STATUS_STYLES[defer.status];

  return (
    <div className={`rounded-xl border p-5 ${style.borderClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className={`h-4 w-4 shrink-0 ${style.iconClass}`} />
          <h3 className={`text-base font-semibold ${style.titleClass}`}>
            顺延申请
          </h3>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style.badgeClass}`}
        >
          {style.label}
        </span>
      </div>
      <div className="mt-3 space-y-3 text-sm">
        <p>
          <span className="text-muted-foreground">截止时刻：</span>
          <span className="font-medium">{defer.originalDeadline ?? '未设置'}</span>
          <span className="mx-1.5 text-muted-foreground">→</span>
          <span className="font-medium">{defer.requestedDeadline}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            （{formatDeferMinutes(defer.deferMinutes)}）
          </span>
        </p>
        <p className="whitespace-pre-wrap break-words">
          <span className="text-muted-foreground">申请原因：</span>
          {defer.reason}
        </p>
        <p className="whitespace-pre-wrap break-words">
          <span className="text-muted-foreground">解决情况和方案：</span>
          {defer.resolution}
        </p>
        {defer.aiOpinion ? (
          <p className="whitespace-pre-wrap break-words">
            <span className="text-muted-foreground">AI 初审意见：</span>
            {defer.aiOpinion}
          </p>
        ) : null}
        {defer.bossComment ? (
          <p className="whitespace-pre-wrap break-words">
            <span className="text-muted-foreground">老板备注：</span>
            {defer.bossComment}
          </p>
        ) : null}
      </div>
    </div>
  );
};
