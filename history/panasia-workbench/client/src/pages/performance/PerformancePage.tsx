import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleAlert,
  Gift,
  Info,
  Lightbulb,
  ListTodo,
  Sparkles,
  Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { performanceApi, tasksApi } from '@client/src/api';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import type {
  PerformanceCycle,
  PerformanceOverview,
  TasksOverview,
} from '@shared/api.interface';
import PerformanceTrendChart from './PerformanceTrendChart';
import PerformanceKraTable from './PerformanceKraTable';
import PerformanceEventTimeline from './PerformanceEventTimeline';
import { computeRescue } from './rescue-rules';
import type { RescueResult } from './rescue-rules';

function ratingClass(label: string | null): string {
  if (label === '优秀') return 'bg-emerald-500/10 text-emerald-600';
  if (label === '良好') return 'bg-blue-500/10 text-blue-600';
  if (label === '合格') return 'bg-amber-500/10 text-amber-600';
  return 'bg-red-500/10 text-red-600';
}

function formatPoints(points: number): string {
  return Number.isInteger(points) ? `${points}` : points.toFixed(1);
}

const PerformancePage = () => {
  const [data, setData] = useState<PerformanceOverview | null>(null);
  const [tasks, setTasks] = useState<TasksOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      performanceApi.fetchPerformanceOverview(),
      tasksApi.fetchTasksOverview().catch(() => null),
    ])
      .then(([overview, tasksOverview]) => {
        if (cancelled) return;
        setData(overview);
        setSelectedId(overview.currentCycleId ?? null);
        if (tasksOverview) setTasks(tasksOverview);
      })
      .catch(() => {
        if (!cancelled) setError('绩效数据加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-[200px]" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[120px]" />
          <Skeleton className="h-[120px]" />
          <Skeleton className="h-[120px]" />
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <CircleAlert className="h-4 w-4" />
        {error ?? '数据加载失败'}
      </div>
    );
  }

  const cycles = data.cycles ?? [];
  const selected =
    cycles.find((c: PerformanceCycle) => c.id === selectedId) ??
    cycles[cycles.length - 1];

  if (cycles.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">我的绩效</h1>
            {DEMO_MODE && <DemoBadge />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">我干得怎么样</p>
        </div>
        <Card>
          <CardContent className="p-5">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              暂无绩效档案，请先在「我的」中绑定员工身份，绑定后按周期自动汇总评分、奖惩与学习记录
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const bonus = data.expectedBonus;
  const emptyRescue: RescueResult = { items: [], totalYuan: 0 };
  const rescue = tasks ? computeRescue(data, tasks) : emptyRescue;
  const wallet = tasks?.gamification ?? null;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">我的绩效</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">我干得怎么样</p>
      </div>

      {/* 补救中心：还可争取的分数折算（黄色仅点缀） */}
      <Card data-ai-section-type="card-stat">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <Gift className="mt-1 h-5 w-5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-semibold">
                还能多拿
                <span className="ml-1 text-red-600">
                  ¥{rescue.totalYuan}
                </span>
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                完成逾期任务、补齐低分 KRA，按 1 分 ≈ ¥
                {bonus === null ? '—' : Math.round((bonus / 100) * 10) / 10}{' '}
                折算
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {!tasks ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleAlert className="h-4 w-4 shrink-0" />
                任务数据加载失败，暂时无法统计可补救项
              </p>
            ) : rescue.items.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
                当前没有可补救项，保持住
              </p>
            ) : (
              rescue.items.map((item) =>
                item.kind === 'overdueTask' && item.taskId ? (
                  <Link
                    key={`task-${item.taskId}`}
                    to={`/tasks/${item.taskId}?projectId=${item.projectId ?? ''}`}
                    className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    <ListTodo className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 font-medium text-red-600">
                      +{formatPoints(item.points)} 分 ≈ +¥{item.yuan}
                    </span>
                  </Link>
                ) : (
                  <div
                    key={`kra-${item.title}`}
                    className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm"
                  >
                    <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 font-medium text-red-600">
                      +{formatPoints(item.points)} 分 ≈ +¥{item.yuan}
                    </span>
                  </div>
                ),
              )
            )}
          </div>
        </CardContent>
      </Card>

      {/* 问题发现故事线：薄横条 KPI，不折算绩效分（黄色仅点缀） */}
      {data.problemDiscovery ? (
        <div data-ai-section-type="card-stat" className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-4 py-2">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <span className="text-xs text-muted-foreground">本月发现</span>
              <span className="text-lg font-semibold tabular-nums">
                {data.problemDiscovery.discovered}
              </span>
            </div>
            <span
              className="hidden h-8 w-px bg-border sm:block"
              aria-hidden
            />
            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <span className="text-xs text-muted-foreground">被采纳</span>
              <span className="text-lg font-semibold tabular-nums">
                {data.problemDiscovery.adopted}
              </span>
            </div>
            <span
              className="hidden h-8 w-px bg-border sm:block"
              aria-hidden
            />
            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <span className="text-xs text-muted-foreground">已修复</span>
              <span className="text-lg font-semibold tabular-nums">
                {data.problemDiscovery.repaired}
              </span>
            </div>
            <span
              className="hidden h-8 w-px bg-border sm:block"
              aria-hidden
            />
            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <Wallet className="h-4 w-4 self-center text-amber-500" />
              <span className="text-xs text-muted-foreground">奖励</span>
              <span className="text-lg font-semibold tabular-nums">
                ¥{data.problemDiscovery.bountyTotal}
              </span>
            </div>
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            问题发现不折算绩效分数，仅作月度回顾故事线
          </p>
        </div>
      ) : null}

      {/* 三卡一行：周期得分 / 预计奖金 / 额外奖励钱包 */}
      <div data-ai-section-type="card-stat" className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">
              {selected?.name} 周期得分
            </p>
            <div className="mt-1 flex items-center gap-3">
              <p className="text-4xl font-semibold">{selected?.score ?? '—'}</p>
              {selected?.ratingLabel ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${ratingClass(selected.ratingLabel)}`}
                >
                  {selected.ratingLabel}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {selected?.startDate} ~ {selected?.endDate}
              {selected?.active ? ' · 评估进行中' : ' · 已归档'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">预计绩效奖金</p>
            <p className="mt-1 text-3xl font-semibold">
              {data.expectedBonus === null
                ? '—'
                : `¥${data.expectedBonus}`}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              按当前薪资结构估算，实发以 HR 结算为准
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-muted-foreground">额外奖励钱包</p>
            {wallet ? (
              <>
                <p className="mt-1 flex items-center gap-2 text-3xl font-semibold">
                  <Wallet className="h-5 w-5 text-amber-500" />
                  ¥{wallet.walletMonth}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  本月已获 ¥{wallet.walletMonth}，另有 ¥{wallet.walletPending}{' '}
                  待完成可拿
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                钱包数据加载失败，稍后可在任务页查看
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 周期切换 */}
      <div className="flex flex-wrap gap-2">
        {cycles.map((c: PerformanceCycle) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedId(c.id)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
              c.id === selectedId
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground'
            }`}
          >
            {c.name}
            {c.active ? (
              <span
                className={`text-[10px] ${
                  c.id === selectedId ? 'opacity-80' : 'text-emerald-600'
                }`}
              >
                进行中
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div data-ai-section-type="card-list" className="grid gap-4">
        <PerformanceKraTable cycle={selected} />
      </div>

      <div data-ai-section-type="card-list" className="grid gap-4">
        <PerformanceEventTimeline events={data.events} />
      </div>

      <div data-ai-section-type="card-list" className="grid gap-4">
        <Card>
          <CardContent className="p-5">
            <p className="mb-2 text-sm text-muted-foreground">评分趋势</p>
            <PerformanceTrendChart cycles={cycles} selectedId={selectedId} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default PerformancePage;
