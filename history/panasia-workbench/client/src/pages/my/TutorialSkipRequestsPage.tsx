import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { ChevronLeft, CircleAlert, FileX2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { myApi } from '@client/src/api';
import type { TutorialSkipRequestInfo, TutorialSkipStatus } from '@shared/api.interface';

type StatusFilter = TutorialSkipStatus | 'all';

const STATUS_LABELS: Record<TutorialSkipStatus, string> = {
  pending: '审核中',
  approved: '已通过',
  rejected: '已拒绝',
};

const STATUS_BADGE_CLASS: Record<TutorialSkipStatus, string> = {
  pending: 'bg-blue-100 text-blue-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};

const STATUS_OPTIONS: TutorialSkipStatus[] = ['pending', 'approved', 'rejected'];

const TutorialSkipRequestsPage = () => {
  const [items, setItems] = useState<TutorialSkipRequestInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');

  useEffect(() => {
    myApi
      .fetchMyTutorialSkipRequests()
      .then((response) => {
        setItems(response.items);
        setError(null);
      })
      .catch(() => {
        setError('跳过申请加载失败，请稍后重试');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const filtered = (items ?? []).filter(
    (item: TutorialSkipRequestInfo) =>
      status === 'all' || item.status === status,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/my"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold">跳过申请</h1>
          <p className="text-xs text-muted-foreground">
            我提交的教程步骤跳过申请，由老板审核
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['all', ...STATUS_OPTIONS] as StatusFilter[]).map(
          (s: StatusFilter) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                status === s
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? '全部' : STATUS_LABELS[s]}
            </button>
          ),
        )}
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {loading ? (
        <div data-ai-section-type="card-list" className="space-y-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : !items || items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无跳过申请
          <p className="mt-1 text-xs">
            在教程案例步骤中点「申请跳过」，提交后由老板审核
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          该状态下暂无申请
        </div>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-4">
          {filtered.map((item: TutorialSkipRequestInfo) => (
            <Card key={item.id} className="rounded-xl transition-colors hover:border-primary/40">
              <CardContent className="space-y-2 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <FileX2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm font-medium break-words">{item.caseTitle}</p>
                  <Badge className={STATUS_BADGE_CLASS[item.status]}>
                    {STATUS_LABELS[item.status]}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  步骤：{item.stepTitle} · 申请于{' '}
                  {dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}
                  {item.reviewedAt
                    ? ` · 审核于 ${dayjs(item.reviewedAt).format('YYYY-MM-DD HH:mm')}`
                    : ''}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  理由：{item.reason}
                </p>
                {item.status === 'rejected' && item.reviewerNote ? (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    <p className="font-medium text-destructive">拒绝原因</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
                      {item.reviewerNote}
                    </p>
                  </div>
                ) : item.reviewerNote ? (
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    审核备注：{item.reviewerNote}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default TutorialSkipRequestsPage;
