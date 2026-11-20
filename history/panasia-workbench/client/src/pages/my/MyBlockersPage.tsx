import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BLOCKER_CATEGORY_LABELS,
  BLOCKER_SEVERITY_LABELS,
  BLOCKER_STATUS_LABELS,
  listMyBlockers,
} from '@client/src/api/problems';
import type { BlockerItem, DerivedProblemStatus } from '@shared/api.interface';

const SEVERITY_BADGE_CLASS: Record<string, string> = {
  normal: 'bg-secondary text-secondary-foreground',
  high: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  waiting: 'bg-amber-100 text-amber-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-secondary text-secondary-foreground',
};

/** 衍生问题工单状态徽章：无衍生数据返回 null 不渲染 */
function renderDerivedProblemBadges(derived: DerivedProblemStatus): React.ReactNode {
  const badges: React.ReactNode[] = [];
  const repaired = derived.repairedAt !== null;

  if (derived.poolStatus === 'pending_response') {
    badges.push(
      <Badge
        key="pending"
        className="bg-sky-100 text-sky-700 whitespace-normal break-words"
      >
        问题工单 · 待响应
      </Badge>,
    );
    if (derived.slaExceeded) {
      badges.push(
        <Badge
          key="sla"
          className="bg-red-100 text-red-700 whitespace-normal break-words"
        >
          响应超时
        </Badge>,
      );
    }
  } else if (derived.poolStatus === 'confirmed' || derived.poolStatus === 'projected') {
    badges.push(
      <Badge
        key="confirmed"
        className="bg-emerald-100 text-emerald-700 whitespace-normal break-words"
      >
        {derived.bountyAmount > 0
          ? `已确认 +¥${derived.bountyAmount} 已入钱包`
          : '已确认有效'}
      </Badge>,
    );
  } else if (derived.poolStatus === 'dismissed') {
    badges.push(
      <Badge
        key="dismissed"
        className="bg-red-100 text-red-700 whitespace-normal break-words"
      >
        {derived.rejectReason ? `已驳回：${derived.rejectReason}` : '已驳回'}
      </Badge>,
    );
  }

  if (repaired) {
    badges.push(
      <Badge
        key="repaired"
        className="bg-emerald-100 text-emerald-700 whitespace-normal break-words"
      >
        已修复回访
      </Badge>,
    );
  }

  if (badges.length === 0) return null;
  return <div className="mt-2 flex flex-wrap gap-2">{badges}</div>;
}

const MyBlockersPage: React.FC = () => {
  const [items, setItems] = useState<BlockerItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMyBlockers()
      .then((response) => {
        setItems(response.items);
        setError(null);
      })
      .catch(() => {
        setError('阻塞记录加载失败，请稍后重试');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div className="mx-auto max-w-6xl p-6 pb-28">
      <div className="mb-4 flex items-center gap-3">
        <Link
          to="/my"
          className="flex h-8 w-8 items-center justify-center rounded-md border"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold">我的阻塞</h1>
          <p className="text-xs text-muted-foreground">
            我提交过的问题记录，同类问题会自动聚类进入问题池
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : !items || items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有提交过阻塞
          <p className="mt-1 text-xs">
            在「我的-问题反馈-遇到问题」提交工作中遇到的阻塞
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item: BlockerItem) => (
            <div key={item.id} className="rounded-xl border p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    <Badge
                      className={SEVERITY_BADGE_CLASS[item.severity] ?? ''}
                    >
                      {BLOCKER_SEVERITY_LABELS[item.severity] ??
                        item.severity}
                    </Badge>
                    <Badge className={STATUS_BADGE_CLASS[item.status] ?? ''}>
                      {BLOCKER_STATUS_LABELS[item.status] ?? item.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {BLOCKER_CATEGORY_LABELS[item.category] ?? item.category}
                    {' · '}
                    提交于 {dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}
                    {item.lossHours !== null
                      ? ` · 损失 ${item.lossHours}h`
                      : ''}
                    {item.taskId ? ` · 关联任务 ${item.taskId}` : ''}
                  </p>
                  {item.description ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  ) : null}
                  {item.derivedProblem
                    ? renderDerivedProblemBadges(item.derivedProblem)
                    : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MyBlockersPage;
