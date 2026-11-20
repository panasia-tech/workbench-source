import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CalendarDays, ChevronLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { myApi } from '@client/src/api';
import type { LeaveApplicationRecord } from '@shared/api.interface';

const fmtDate = (value: string | null): string => value ?? '—';

const fmtDays = (value: number | null): string =>
  value === null ? '—' : `${value} 天`;

const LEAVE_STATUS: Record<
  string,
  { label: string; className: string }
> = {
  Approved: {
    label: '已批准',
    className: 'border-green-200 bg-green-50 text-green-700',
  },
  Open: {
    label: '审批中',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  Rejected: {
    label: '已拒绝',
    className: 'border-red-200 bg-red-50 text-red-600',
  },
  Cancelled: {
    label: '已取消',
    className: 'border-muted bg-muted text-muted-foreground',
  },
};

const leaveStatus = (value: string | null) => {
  if (value === null) return null;
  const meta = LEAVE_STATUS[value];
  return meta === undefined
    ? { label: value, className: 'border-muted bg-muted text-muted-foreground' }
    : meta;
};

const LeavePage = () => {
  const [items, setItems] = useState<LeaveApplicationRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMyLeaveApplications()
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setError('请假记录加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/my"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回我的
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">请假记录</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          我的历次请假申请与审批状态
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : error || !items ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无请假记录，提交请假申请后会出现在这里
        </p>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-4">
          {items.map((record: LeaveApplicationRecord) => {
            const status = leaveStatus(record.status);
            return (
              <Card key={record.name}>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        <CalendarDays className="h-5 w-5" />
                      </span>
                      <p className="text-sm font-medium">
                        {record.leaveType ?? '请假'}
                      </p>
                    </div>
                    {status ? (
                      <Badge variant="outline" className={status.className}>
                        {status.label}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {fmtDate(record.fromDate)} ~ {fmtDate(record.toDate)}
                    </span>
                    <span className="font-medium">
                      {fmtDays(record.totalDays)}
                    </span>
                  </div>
                  {record.reason ? (
                    <p className="mt-2 break-words text-xs text-muted-foreground">
                      {record.reason}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default LeavePage;
