import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { myApi } from '@client/src/api';
import type {
  SalarySlipComponent,
  SalarySlipDetail,
  SalarySlipSummary,
} from '@shared/api.interface';

const fmtMoney = (value: number | null): string =>
  value === null ? '—' : `¥${value.toFixed(2)}`;

const fmtDate = (value: string | null): string => value ?? '—';

const SLIP_STATUS: Record<
  string,
  { label: string; className: string }
> = {
  Submitted: {
    label: '已发放',
    className: 'border-green-200 bg-green-50 text-green-700',
  },
  Draft: {
    label: '草稿',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  Cancelled: {
    label: '已取消',
    className: 'border-muted bg-muted text-muted-foreground',
  },
};

const slipStatus = (value: string | null) => {
  if (value === null) return null;
  const meta = SLIP_STATUS[value];
  return meta === undefined ? { label: value, className: 'border-muted bg-muted text-muted-foreground' } : meta;
};

const ComponentRows = ({
  rows,
}: {
  rows: SalarySlipComponent[];
}) => (
  <div className="space-y-1.5">
    {rows.map((row: SalarySlipComponent) => (
      <div
        key={row.label}
        className="flex items-center justify-between text-sm"
      >
        <span className="text-muted-foreground">{row.label}</span>
        <span className="font-medium">{fmtMoney(row.amount)}</span>
      </div>
    ))}
  </div>
);

const SalarySlipsPage = () => {
  const [items, setItems] = useState<SalarySlipSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SalarySlipDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMySalarySlips()
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setError('工资单加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSlip = useCallback(
    (name: string) => {
      setDetailError(null);
      if (expandedName === name) {
        setExpandedName(null);
        return;
      }
      setExpandedName(name);
      if (details[name] !== undefined) return;
      setDetailLoading(true);
      myApi
        .fetchMySalarySlipDetail(name)
        .then((detail: SalarySlipDetail) => {
          setDetails((prev: Record<string, SalarySlipDetail>) => ({
            ...prev,
            [name]: detail,
          }));
        })
        .catch(() => {
          setDetailError('明细加载失败，请稍后重试');
        })
        .finally(() => {
          setDetailLoading(false);
        });
    },
    [expandedName, details],
  );

  const renderDetail = (name: string): React.ReactNode => {
    if (detailLoading && details[name] === undefined) {
      return <Skeleton className="h-40" />;
    }
    if (detailError) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {detailError}
        </div>
      );
    }
    const detail = details[name];
    if (!detail) return null;
    return (
      <div className="space-y-4 border-t pt-4">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-muted-foreground">净得金额</p>
            <p className="text-2xl font-semibold text-red-600">
              {fmtMoney(detail.netPay)}
            </p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>应发 {fmtMoney(detail.grossPay)}</p>
            <p>扣除合计 {fmtMoney(detail.totalDeduction)}</p>
          </div>
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <TrendingUp className="h-4 w-4 text-green-600" />
            计入项目
          </p>
          {detail.earnings.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无计入项目</p>
          ) : (
            <ComponentRows rows={detail.earnings} />
          )}
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <TrendingDown className="h-4 w-4 text-red-500" />
            扣除项目
          </p>
          {detail.deductions.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无扣除项目</p>
          ) : (
            <ComponentRows rows={detail.deductions} />
          )}
        </div>
      </div>
    );
  };

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
          <h1 className="text-xl font-semibold">工资单</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          我的历次薪资发放记录
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
          暂无工资单，绑定 HR 员工并发放薪资后会出现在这里
        </p>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-4">
          {items.map((slip: SalarySlipSummary) => {
            const status = slipStatus(slip.status);
            const expanded = expandedName === slip.name;
            return (
              <Card key={slip.name} className="transition-shadow">
                <CardContent className="p-5">
                  <button
                    type="button"
                    onClick={() => toggleSlip(slip.name)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        <Wallet className="h-5 w-5" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {fmtDate(slip.startDate)} ~ {fmtDate(slip.endDate)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          发薪日 {fmtDate(slip.postingDate)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {status ? (
                        <Badge
                          variant="outline"
                          className={status.className}
                        >
                          {status.label}
                        </Badge>
                      ) : null}
                      <span className="text-lg font-semibold">
                        {fmtMoney(slip.netPay)}
                      </span>
                      {expanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>
                  {expanded ? renderDetail(slip.name) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SalarySlipsPage;
