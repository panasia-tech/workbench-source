import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BookX,
  CheckCircle2,
  Clock,
  Hourglass,
  RefreshCw,
  User,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchTutorialSkipReviews,
  submitTutorialSkipVerdict,
} from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { TutorialSkipReviewItem } from '@shared/api.interface';
import ReviewVerdictDialog from './ReviewVerdictDialog';

type SkipViewFilter = 'pending' | 'handled';

const SKIP_VIEW_OPTIONS: { key: SkipViewFilter; label: string }[] = [
  { key: 'pending', label: '待审核' },
  { key: 'handled', label: '已处理' },
];

const formatTime = (iso: string | null): string => {
  if (iso === null || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const StatusBadge: React.FC<{ status: TutorialSkipReviewItem['status'] }> = ({
  status,
}) => {
  if (status === 'approved') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-green-500/40 bg-green-500/10 text-green-600"
      >
        <CheckCircle2 className="h-3 w-3" />
        已通过
      </Badge>
    );
  }
  if (status === 'rejected') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-red-500/40 bg-red-500/10 text-red-600"
      >
        <XCircle className="h-3 w-3" />
        已拒绝
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-blue-500/40 bg-blue-500/10 text-blue-600"
    >
      <Hourglass className="h-3 w-3" />
      待审核
    </Badge>
  );
};

interface SkipCardProps {
  item: TutorialSkipReviewItem;
  acting: boolean;
  onApprove: (item: TutorialSkipReviewItem) => void;
  onReject: (item: TutorialSkipReviewItem) => void;
}

const SkipCard: React.FC<SkipCardProps> = ({
  item,
  acting,
  onApprove,
  onReject,
}) => {
  const isPending = item.status === 'pending';
  return (
    <div className="space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-base font-semibold break-words">
          {item.caseTitle}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {item.stepTitle}
          </span>
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <User className="h-3.5 w-3.5" />
          {item.employeeName}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          申请于 {formatTime(item.createdAt)}
        </span>
        {item.status !== 'pending' && (
          <span>审核于 {formatTime(item.reviewedAt)}</span>
        )}
      </div>

      <div className="text-sm">
        <span className="text-xs text-muted-foreground">申请理由：</span>
        <span className="break-words">{item.reason}</span>
      </div>

      {item.reviewerNote !== null && item.reviewerNote !== '' && (
        <div className="text-sm text-muted-foreground">
          <span className="text-xs">审核意见：</span>
          <span className="break-words">{item.reviewerNote}</span>
        </div>
      )}

      {isPending && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            disabled={acting}
            onClick={() => onApprove(item)}
          >
            <CheckCircle2 className="h-4 w-4" />
            通过
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={acting}
            onClick={() => onReject(item)}
          >
            <XCircle className="h-4 w-4" />
            拒绝
          </Button>
        </div>
      )}
    </div>
  );
};

/** 验收 Dock · 教程跳过审核区：员工跳过教程步骤须 boss 审核通过才生效 */
const TutorialSkipReviewSection: React.FC = () => {
  const [view, setView] = useState<SkipViewFilter>('pending');
  const [items, setItems] = useState<TutorialSkipReviewItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<TutorialSkipReviewItem | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === 'pending') {
        const data = await fetchTutorialSkipReviews('pending');
        setItems(data.items);
      } else {
        const [approved, rejected] = await Promise.all([
          fetchTutorialSkipReviews('approved'),
          fetchTutorialSkipReviews('rejected'),
        ]);
        const merged: TutorialSkipReviewItem[] = [
          ...approved.items,
          ...rejected.items,
        ];
        merged.sort(
          (a: TutorialSkipReviewItem, b: TutorialSkipReviewItem) => {
            const ta = new Date(a.reviewedAt ?? a.createdAt).getTime();
            const tb = new Date(b.reviewedAt ?? b.createdAt).getTime();
            return tb - ta;
          },
        );
        setItems(merged);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取跳过审核列表失败';
      setError(message);
      logger.error('教程跳过审核列表加载失败', err);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApprove = useCallback(
    (item: TutorialSkipReviewItem) => {
      setActingId(item.id);
      submitTutorialSkipVerdict(item.id, { action: 'approve' })
        .then(() => {
          toast.success(`已通过：${item.employeeName} 跳过「${item.stepTitle}」`);
          void load();
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : '通过操作失败，请稍后重试',
          );
        })
        .finally(() => {
          setActingId(null);
        });
    },
    [load],
  );

  const confirmReject = (comment: string): void => {
    if (!rejecting) return;
    const target = rejecting;
    setSubmitting(true);
    submitTutorialSkipVerdict(target.id, {
      action: 'reject',
      ...(comment !== '' ? { comment } : {}),
    })
      .then(() => {
        toast.success(`已拒绝：${target.employeeName} 跳过「${target.stepTitle}」`);
        setRejecting(null);
        void load();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '拒绝操作失败，请稍后重试',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const pendingCount =
    view === 'pending' ? (items?.length ?? 0) : 0;

  return (
    <div
      data-ai-section-type="card-list"
      className="space-y-4 rounded-xl border bg-card p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <BookX className="h-4 w-4 text-primary" />
          教程跳过审核
        </h2>
        <Badge variant="secondary" className="text-xs">
          {view === 'pending' ? `待审核 ${pendingCount}` : `共 ${items?.length ?? 0} 条`}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        {SKIP_VIEW_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              view === option.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setView(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      )}

      {!loading && error !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>教程跳过审核加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && error === null && (items ?? []).length === 0 && (
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <BookX className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">暂无跳过申请审核</p>
          <p className="text-xs text-muted-foreground">
            员工申请跳过教程步骤后，须经你审核通过才真正跳过，虚报将被惩罚。
          </p>
        </div>
      )}

      {!loading && error === null && (
        <div className="space-y-4">
          {(items ?? []).map((item: TutorialSkipReviewItem) => (
            <SkipCard
              key={item.id}
              item={item}
              acting={actingId !== null}
              onApprove={handleApprove}
              onReject={(target: TutorialSkipReviewItem) =>
                setRejecting(target)
              }
            />
          ))}
        </div>
      )}

      {rejecting && (
        <ReviewVerdictDialog
          open
          title="拒绝跳过申请"
          description={`拒绝后「${rejecting.employeeName}」需继续完成步骤「${rejecting.stepTitle}」并提交材料。`}
          confirmLabel="确认拒绝"
          destructive
          submitting={submitting}
          onConfirm={confirmReject}
          onOpenChange={(open: boolean) => {
            if (!open) setRejecting(null);
          }}
        />
      )}
    </div>
  );
};

export default TutorialSkipReviewSection;
