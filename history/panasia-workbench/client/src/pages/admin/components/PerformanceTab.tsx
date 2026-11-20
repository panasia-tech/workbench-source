import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Info, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchAdminPerformanceDetail,
  fetchAdminPerformanceEmployees,
} from '@client/src/api/admin';
import type {
  AdminPerformanceDetailResponse,
  AdminPerformanceEmployee,
  PerformanceCycle,
  PerformanceEvent,
  PerformanceEventType,
  PerformanceOverview,
} from '@shared/api.interface';

const ROLE_LABELS: Record<string, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓储',
  general: '通用',
  admin: '管理员',
};

const TYPE_META: Record<
  PerformanceEventType,
  { label: string; badgeClass: string }
> = {
  bonus: { label: '奖励', badgeClass: 'bg-emerald-500/10 text-emerald-600' },
  deduction: { label: '扣减', badgeClass: 'bg-red-500/10 text-red-600' },
  attendance: { label: '考勤', badgeClass: 'bg-amber-500/10 text-amber-600' },
  leave: { label: '请假', badgeClass: 'bg-sky-500/10 text-sky-600' },
  course: { label: '学习', badgeClass: 'bg-blue-500/10 text-blue-600' },
  exam: { label: '考试', badgeClass: 'bg-violet-500/10 text-violet-600' },
  problem: { label: '问题发现', badgeClass: 'bg-amber-500/10 text-amber-600' },
};

function ratingClass(label: string | null): string {
  if (label === '优秀') return 'bg-emerald-500/10 text-emerald-600';
  if (label === '良好') return 'bg-blue-500/10 text-blue-600';
  if (label === '合格') return 'bg-amber-500/10 text-amber-600';
  return 'bg-red-500/10 text-red-600';
}

function formatAmount(amount: number): string {
  return amount >= 0 ? `+¥${amount}` : `-¥${Math.abs(amount)}`;
}

function latestCycleOf(overview: PerformanceOverview): PerformanceCycle | null {
  const cycles = overview.cycles ?? [];
  return (
    cycles.find((c: PerformanceCycle) => c.id === overview.currentCycleId) ??
    cycles[cycles.length - 1] ??
    null
  );
}

function sortEventsDesc(events: PerformanceEvent[]): PerformanceEvent[] {
  return [...events].sort((a: PerformanceEvent, b: PerformanceEvent) =>
    a.date < b.date ? 1 : -1,
  );
}

/** 单周期卡片：周期名 + 总分 + 等级 + KRA 逐项 */
const CycleCard: React.FC<{ cycle: PerformanceCycle }> = ({ cycle }) => (
  <Card>
    <CardContent className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{cycle.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {cycle.startDate ?? '—'} ~ {cycle.endDate ?? '—'}
            {cycle.active ? ' · 评估进行中' : ' · 已归档'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xl font-semibold">{cycle.score ?? '—'}</span>
          {cycle.ratingLabel ? (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${ratingClass(cycle.ratingLabel)}`}
            >
              {cycle.ratingLabel}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {cycle.kras.length === 0 ? (
          <p className="text-sm text-muted-foreground">本周期暂无 KRA 评分</p>
        ) : (
          cycle.kras.map(
            (kra: PerformanceCycle['kras'][number], index: number) => (
              <div
                key={`${cycle.id}-kra-${index}`}
                className="flex items-start justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="break-words">{kra.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    权重 {kra.weight}% · 评分 {kra.rating}
                  </p>
                </div>
                <span
                  className={`shrink-0 font-medium ${
                    kra.earned < kra.rating
                      ? 'text-red-600'
                      : 'text-emerald-600'
                  }`}
                >
                  {kra.earned} 分
                </span>
              </div>
            ),
          )
        )}
      </div>
    </CardContent>
  </Card>
);

/** 事件溯源：每事件一行完整展示（类型徽章 + 日期 + 标题 + 详情全量） */
const EventTimeline: React.FC<{ events: PerformanceEvent[] }> = ({ events }) => {
  const sorted = sortEventsDesc(events);
  if (sorted.length === 0) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            暂无绩效事件，奖惩、考勤与学习记录产生后自动汇总
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {sorted.map((e: PerformanceEvent) => {
        const meta = TYPE_META[e.type];
        return (
          <div
            key={e.id}
            className="rounded-xl border bg-background p-4"
          >
            <div className="flex items-center gap-2">
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.badgeClass}`}
              >
                {meta.label}
              </span>
              <span className="text-xs text-muted-foreground">{e.date}</span>
              {e.amount !== null ? (
                <span
                  className={`ml-auto shrink-0 text-sm font-medium ${
                    e.amount >= 0 ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {formatAmount(e.amount)}
                </span>
              ) : null}
            </div>
            <p className="mt-2 font-medium">{e.title}</p>
            {e.detail ? (
              <p className="mt-1 break-words text-sm text-muted-foreground">
                {e.detail}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground/70">
              来源：{e.source}
            </p>
          </div>
        );
      })}
    </div>
  );
};

const PerformanceTab: React.FC = () => {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const [items, setItems] = useState<AdminPerformanceEmployee[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<AdminPerformanceDetailResponse | null>(
    null,
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const response = await fetchAdminPerformanceEmployees();
      setItems(response.items ?? []);
    } catch (error) {
      setListError(
        error instanceof Error ? error.message : '获取员工绩效列表失败',
      );
    }
  }, []);

  const loadDetail = useCallback(async (userId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetchAdminPerformanceDetail(userId);
      setDetail(response);
    } catch (error) {
      setDetail(null);
      setDetailError(
        error instanceof Error ? error.message : '获取员工绩效详情失败',
      );
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedUserId !== null) {
      setDetail(null);
      void loadDetail(selectedUserId);
    }
  }, [selectedUserId, loadDetail]);

  // ===== 详情态 =====
  if (selectedUserId !== null) {
    const overview: PerformanceOverview | null = detail?.overview ?? null;
    const latest = overview ? latestCycleOf(overview) : null;

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedUserId(null)}
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
          <h2 className="text-lg font-semibold">{detail?.name ?? '员工详情'}</h2>
        </div>

        {detailError !== null ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <span className="flex items-center gap-2">
              <CircleAlert className="h-4 w-4 shrink-0" />
              {detailError}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadDetail(selectedUserId)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        ) : detailLoading || overview === null ? (
          <div className="space-y-4">
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        ) : (
          <>
            {/* KPI 薄横条：最新总分 | 等级 | 预计奖金 */}
            <div className="flex items-center rounded-lg border bg-background px-4 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">最新总分</span>
                <span className="font-medium">{latest?.score ?? '—'}</span>
              </div>
              <div className="mx-3 h-4 w-px bg-border" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">等级</span>
                <span className="font-medium">{latest?.ratingLabel ?? '—'}</span>
              </div>
              <div className="mx-3 h-4 w-px bg-border" />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">预计奖金</span>
                <span className="font-medium">
                  {overview.expectedBonus === null
                    ? '—'
                    : `¥${overview.expectedBonus}`}
                </span>
              </div>
            </div>

            {/* 周期历史 */}
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                周期评分历史
              </p>
              {(overview.cycles ?? []).length === 0 ? (
                <Card>
                  <CardContent className="p-5">
                    <p className="flex items-start gap-2 text-sm text-muted-foreground">
                      <Info className="mt-0.5 h-4 w-4 shrink-0" />
                      暂无考核周期数据，HR 在 Frappe 建立周期并评分后自动汇总
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-4">
                  {(overview.cycles ?? []).map((c: PerformanceCycle) => (
                    <CycleCard key={c.id} cycle={c} />
                  ))}
                </div>
              )}
            </div>

            {/* 事件溯源时间线 */}
            <div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                事件溯源（奖惩 · 考勤 · 学习，按时间倒序）
              </p>
              <EventTimeline events={overview.events ?? []} />
            </div>
          </>
        )}
      </div>
    );
  }

  // ===== 列表态 =====
  if (listError !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <span>{listError}</span>
        <Button variant="outline" size="sm" onClick={() => void loadList()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        暂无绑定员工，员工在「我的」页完成绑定后会出现在这里。
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        点击员工查看各考核周期评分与奖惩、考勤、学习事件溯源。
      </p>
      {items.map((item: AdminPerformanceEmployee) => (
        <button
          key={item.userId}
          type="button"
          onClick={() => setSelectedUserId(item.userId)}
          className="w-full rounded-xl border bg-background p-5 text-left transition-colors hover:bg-muted/60"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold">{item.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {ROLE_LABELS[item.role] ?? item.role}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium">
                {item.latestTotalScore === null
                  ? '暂无评分'
                  : `${item.latestTotalScore} 分`}
                {item.latestGrade ? ` · ${item.latestGrade}` : ''}
              </p>
              {item.latestCycleName ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.latestCycleName}
                </p>
              ) : null}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
};

export default PerformanceTab;
