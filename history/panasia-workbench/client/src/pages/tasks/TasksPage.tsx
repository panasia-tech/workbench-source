import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlarmClock, AlertCircle, Check, Timer, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { tasksApi } from '@client/src/api';
import { TaskListItem } from '@/components/task-list-item';
import TutorialTaskCard from '@/components/tutorial-task-card';
import type {
  TaskTemplateSummary,
  TasksOverview,
  TaskSummary,
  TodayProgress,
} from '@shared/api.interface';

type FilterKey = 'all' | 'done';

const CATEGORY_KEYS = [
  'all',
  'daily',
  'scheduled',
  'delegated',
  'workorder',
] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  all: '全部',
  daily: '固定任务',
  scheduled: '定时任务',
  delegated: '委派任务',
  workorder: '工单任务',
};

const TasksPage = () => {
  const [data, setData] = useState<TasksOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [category, setCategory] = useState<CategoryKey>('all');
  const [reloadTick, setReloadTick] = useState(0);

  const handleReload = () => {
    setError(null);
    setLoading(true);
    setReloadTick((tick) => tick + 1);
  };

  useEffect(() => {
    let cancelled = false;
    tasksApi
      .fetchTasksOverview()
      .then((overview: TasksOverview) => {
        if (!cancelled) setData(overview);
      })
      .catch(() => {
        if (!cancelled) setError('任务数据加载失败，数据源繁忙，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const allTasks = useMemo<TaskSummary[]>(() => {
    if (!data) return [];
    const todayTasks = data.todayTasks ?? [];
    const openTasks = data.openTasks ?? [];
    const seen = new Set<string>(todayTasks.map((t: TaskSummary) => t.id));
    const merged = [...todayTasks, ...openTasks.filter((t: TaskSummary) => !seen.has(t.id))];
    return merged.sort((a: TaskSummary, b: TaskSummary) => {
      const rank = (t: TaskSummary): number => {
        if (t.severeBlocked) return 0;
        if (t.isToday) return 1;
        const open = !['DONE', 'CANCELLED'].includes(t.status);
        const overdue = open && t.deadline !== null && !t.isToday;
        return overdue ? 2 : 3;
      };
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });
  }, [data]);

  const categoryCounts = useMemo<Record<CategoryKey, number>>(() => {
    const today: TaskSummary[] = data?.todayTasks ?? [];
    const counts: Record<CategoryKey, number> = {
      all: today.length,
      daily: 0,
      scheduled: 0,
      delegated: 0,
      workorder: 0,
    };
    for (const task of today) {
      if (task.taskType === 'daily') counts.daily += 1;
      else if (task.taskType === 'scheduled') counts.scheduled += 1;
      else if (task.taskType === 'delegated') counts.delegated += 1;
      else if (task.taskType === 'workorder') counts.workorder += 1;
    }
    return counts;
  }, [data]);

  const categoryTemplates = useMemo<TaskTemplateSummary[]>(() => {
    if (category !== 'daily' && category !== 'scheduled') return [];
    const templates: TaskTemplateSummary[] = data?.templates ?? [];
    return templates.filter(
      (tpl: TaskTemplateSummary) => tpl.templateType === category,
    );
  }, [category, data]);

  const visibleTasks = useMemo<TaskSummary[]>(() => {
    if (!data) return [];
    const base: TaskSummary[] =
      filter === 'done' ? data.doneTasks ?? [] : allTasks;
    if (category === 'all') return base;
    return base.filter((task: TaskSummary) => task.taskType === category);
  }, [allTasks, category, data, filter]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
        <Button size="sm" variant="outline" onClick={handleReload}>
          重试
        </Button>
      </div>
    );
  }

  const tutorialTasks = data.tutorialTasks ?? [];

  if (!data.bound) {
    return (
      <div className="space-y-4">
        <Card data-ai-section-type="card-menu" className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-4 p-5 text-center">
            <UserRoundCog className="h-10 w-10 text-muted-foreground" />
            <div>
              <h2 className="text-base font-semibold">请先绑定员工身份</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                绑定你的 Plane 成员身份后，即可看到分配给你的任务与项目。
              </p>
            </div>
            <Button asChild>
              <Link to="/my">前往「我的」完成绑定</Link>
            </Button>
          </CardContent>
        </Card>
        {tutorialTasks.length > 0 ? (
          <div className="mx-auto max-w-xl space-y-4">
            <h2 className="text-base font-semibold">教程任务</h2>
            {tutorialTasks.map((task) => (
              <TutorialTaskCard key={task.id} task={task} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const gamification = data.gamification;
  const progress: TodayProgress | null = data.progress ?? null;
  const now = new Date();
  const nowLabel = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}`;

  return (
    <div className="space-y-5">
      <div
        data-ai-section-type="card-stat"
        className="flex items-center justify-between rounded-xl border bg-card px-4 py-2"
      >
        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          今日完成
          <span className="text-sm font-semibold text-foreground">
            {gamification?.todayDone ?? 0}/{gamification?.todayTotal ?? 0}
          </span>
        </span>
        <span className="h-4 w-px bg-border" />
        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          连续完成
          <span className="text-sm font-semibold text-foreground">
            {gamification?.streakDays ?? 0} 天
          </span>
        </span>
        <span className="h-4 w-px bg-border" />
        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          本月钱包
          <span className="text-sm font-semibold text-foreground">
            ¥{gamification?.walletMonth ?? 0}
          </span>
        </span>
      </div>

      {progress ? (
        <div
          data-ai-section-type="card-stat"
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-2"
        >
          <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            今日进度
            <span className="text-sm font-semibold text-foreground">
              {progress.todayDone}/{progress.todayTotal}
            </span>
          </span>
          <span className="h-4 w-px bg-border" />
          <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            阶段目标
            <span className="text-sm font-semibold text-foreground">
              {nowLabel} 前应完成 {progress.rhythmTarget} 个
            </span>
          </span>
          {progress.warn && progress.behindCount > 0 ? (
            <span className="flex items-center gap-1 text-xs font-medium text-red-600">
              <AlarmClock className="h-3.5 w-3.5" />
              落后 {progress.behindCount} 个 · 请合理安排时间
            </span>
          ) : null}
          <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            <Timer className="h-3.5 w-3.5 self-center" />
            预计
            <span
              className={`text-sm font-semibold ${
                progress.overtimeMinutes > 0 ? 'text-red-600' : 'text-foreground'
              }`}
            >
              {progress.expectedEndTime} 下班
            </span>
            {progress.overtimeMinutes > 0 ? (
              <span className="font-medium text-red-600">
                超时 {progress.overtimeMinutes} 分钟
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {CATEGORY_KEYS.map((key) => {
          const selected = category === key;
          const label =
            key === 'all'
              ? CATEGORY_LABELS.all
              : `${CATEGORY_LABELS[key]} ${categoryCounts[key]}`;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition-colors ${
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            {filter === 'done'
              ? `已完成 · ${visibleTasks.length}`
              : category === 'all'
                ? `今日任务 · ${visibleTasks.length}`
                : `${CATEGORY_LABELS[category]} · ${visibleTasks.length}`}
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFilter(filter === 'all' ? 'done' : 'all')}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filter === 'done'
                  ? 'border-primary/60 bg-primary/5 text-primary'
                  : 'bg-card text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {filter === 'all' ? `已完成 ${data.counts?.done ?? 0}` : '返回今日任务'}
            </button>
          </div>
        </div>
        {(category === 'daily' || category === 'scheduled') &&
          (categoryTemplates.length > 0 ? (
            <div className="mb-4">
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                任务模板
              </h3>
              <div data-ai-section-type="card-list" className="space-y-2">
                {categoryTemplates.map((tpl) => (
                  <Card key={tpl.id} className="rounded-xl">
                    <CardContent className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">
                          {tpl.title}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {tpl.scheduleLabel} · {tpl.planeProjectName}
                        </p>
                      </div>
                      {tpl.runsToday ? (
                        tpl.todayTaskId ? (
                          <Link
                            to={`/tasks/${tpl.todayTaskId}?projectId=${tpl.planeProjectId}`}
                            className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 transition-colors hover:bg-green-500/20"
                          >
                            <Check className="h-3.5 w-3.5" />
                            今日已生成
                          </Link>
                        ) : (
                          <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600">
                            今日待生成
                          </span>
                        )
                      ) : (
                        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                          今天不执行
                        </span>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <p className="mb-4 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              暂无{CATEGORY_LABELS[category]}模板，由管理员配置
            </p>
          ))}
        {visibleTasks.length === 0 &&
        (filter === 'done' || category !== 'all' || tutorialTasks.length === 0) ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {filter === 'done' ? '暂无已完成任务' : '暂无未完成任务'}
          </p>
        ) : (
          <div data-ai-section-type="card-list" className="space-y-4">
            {filter === 'all' && category === 'all'
              ? tutorialTasks.map((task) => (
                  <TutorialTaskCard key={task.id} task={task} />
                ))
              : null}
            {visibleTasks.map((task) => (
              <TaskListItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default TasksPage;
