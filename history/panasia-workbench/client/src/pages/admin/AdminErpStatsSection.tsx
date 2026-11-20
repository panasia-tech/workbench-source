import { useCallback, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchErpActivities,
  fetchErpAdminStats,
} from '@client/src/api/erpDashboard';
import { getBackendErrorStatus } from '@client/src/utils/backend-error-guard';
import type {
  ErpAdminPeriodStats,
  ErpRecentActivity,
} from '@shared/api.interface';

/**
 * ERP 经营统计（移植 miniprogram/pages/profile/stats + 最近业务动态）：
 * 今日/昨日/近7天/近30天 admin-stats + activities 分页。
 * 数据走 /api/erp-api/* 的 admin-only 端点：要求 ERP 角色是 ADMIN，
 * 与工作台本地 boss/admin 平台角色是两回事，403 时友好提示。
 */

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

const ACTIVITY_PAGE_SIZE = 20;

function money(value: number | null | undefined): string {
  return `¥${Number(value ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDatetime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

type LoadError = 'forbidden' | 'unavailable' | null;

const AdminErpStatsSection: React.FC = () => {
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [stats, setStats] = useState<ErpAdminPeriodStats | null>(null);
  const [activities, setActivities] = useState<ErpRecentActivity[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError>(null);

  const load = useCallback(async (key: PeriodKey) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, firstPage] = await Promise.all([
        fetchErpAdminStats(key),
        fetchErpActivities(0, ACTIVITY_PAGE_SIZE),
      ]);
      setStats(statsRes);
      setActivities(firstPage);
      setHasMore(firstPage.length >= ACTIVITY_PAGE_SIZE);
    } catch (err) {
      setStats(null);
      setActivities([]);
      setError(
        getBackendErrorStatus(err) === 403 ? 'forbidden' : 'unavailable',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const more = await fetchErpActivities(
        activities.length,
        ACTIVITY_PAGE_SIZE,
      );
      setActivities((prev) => [...prev, ...more]);
      setHasMore(more.length >= ACTIVITY_PAGE_SIZE);
    } catch {
      // 加载更多失败保留已有列表，用户可再点
    } finally {
      setLoadingMore(false);
    }
  }, [activities.length, hasMore, loadingMore]);

  const pickPeriod = (key: PeriodKey) => {
    if (key === period) return;
    setPeriod(key);
    void load(key);
  };

  const purchaseCards: { label: string; value: string }[] = [
    { label: '采购单数', value: String(stats?.purchase_count ?? 0) },
    { label: '采购金额', value: money(stats?.purchase_amount) },
    { label: '验货完成', value: String(stats?.inspection_count ?? 0) },
    { label: '入库数量', value: String(stats?.inbound_count ?? 0) },
  ];

  const salesCards: { label: string; value: string }[] = [
    { label: '出库数量', value: String(stats?.outbound_count ?? 0) },
    { label: '销售额', value: money(stats?.sales_amount) },
    { label: '毛利', value: money(stats?.gross_profit) },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            {PERIODS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => pickPeriod(item.key)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  period === item.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : error === 'forbidden' ? (
        <Card>
          <CardContent className="flex items-start gap-3 p-5 text-sm">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="space-y-2">
              <p className="font-medium">你在工作台是管理员，但在 ERP 里不是管理员角色</p>
              <p className="text-muted-foreground">
                经营统计读的是 ERP 的 ADMIN 权限数据。请让 ERP 管理员调整你在 ERP
                里的角色，或让 ERP 管理员直接查看。
              </p>
            </div>
          </CardContent>
        </Card>
      ) : error === 'unavailable' ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4" />
          <span>经营统计暂时连不上，请稍后重试</span>
          <Button variant="outline" size="sm" onClick={() => void load(period)}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <Card>
            <CardContent className="p-5">
              <p className="text-sm font-medium">采购</p>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {purchaseCards.map((card) => (
                  <div key={card.label} className="rounded-lg border p-3">
                    <p className="text-lg font-semibold">{card.value}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {card.label}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <p className="text-sm font-medium">销售</p>
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {salesCards.map((card) => (
                  <div key={card.label} className="rounded-lg border p-3">
                    <p className="text-lg font-semibold">{card.value}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {card.label}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <p className="text-sm font-medium">最近业务动态</p>
              {activities.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">暂无动态</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {activities.map((item, index) => (
                    <div
                      key={`${item.created_at}-${index}`}
                      className="flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
                    >
                      <p className="min-w-0 text-sm">
                        {item.summary || item.event_type}
                        {item.ref_no ? (
                          <span className="text-muted-foreground">
                            {' '}
                            · {item.ref_no}
                          </span>
                        ) : null}
                      </p>
                      <p className="shrink-0 text-xs text-muted-foreground">
                        {fmtDatetime(item.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
};

export default AdminErpStatsSection;
