import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Hash,
  UserRoundCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { TaskStatusBadge } from '@/components/status-badge';
import { tasksApi } from '@client/src/api';
import type {
  TaskHistoryResponse,
  TaskSummary,
} from '@shared/api.interface';

type ScopeKey = 'day' | 'week' | 'month';

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
];

const TaskHistoryPage = () => {
  const [scope, setScope] = useState<ScopeKey>('day');
  const [date, setDate] = useState<string>(dayjs().format('YYYY-MM-DD'));
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState<TaskHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setKeyword(keywordInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tasksApi
      .fetchTaskHistory({ date, scope, keyword: keyword || undefined })
      .then((res: TaskHistoryResponse) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError('历史任务加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, scope, keyword]);

  const rangeLabel = useMemo<string>(() => {
    const d = dayjs(date);
    if (scope === 'day') return d.format('YYYY年M月D日');
    if (scope === 'week') {
      const monday = d.subtract((d.day() + 6) % 7, 'day');
      const sunday = monday.add(6, 'day');
      return `${monday.format('M月D日')} - ${sunday.format('M月D日')}`;
    }
    return d.format('YYYY年M月');
  }, [scope, date]);

  const shiftRange = (dir: 1 | -1): void => {
    const d = dayjs(date);
    let next: dayjs.Dayjs;
    if (scope === 'day') next = d.add(dir, 'day');
    else if (scope === 'week') next = d.add(dir * 7, 'day');
    else next = d.add(dir, 'month');
    setDate(next.format('YYYY-MM-DD'));
  };

  if (loading && !data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28 rounded-full" />
          <Skeleton className="h-8 w-40 rounded-full" />
          <Skeleton className="h-8 w-44 rounded-full" />
        </div>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    );
  }

  if (data && !data.bound) {
    return (
      <Card data-ai-section-type="card-menu" className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center gap-4 p-5 text-center">
          <UserRoundCog className="h-10 w-10 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">请先绑定员工身份</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              绑定你的 Plane 成员身份后，即可查看你的历史任务。
            </p>
          </div>
          <Button asChild>
            <Link to="/my">前往「我的」完成绑定</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const items: TaskSummary[] = data?.items ?? [];
  const heading = keyword
    ? `序号搜索「${keyword}」 · ${items.length} 条`
    : `${rangeLabel} · ${items.length} 条`;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/my" aria-label="返回我的">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">历史任务</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            按日 / 周 / 月或任务序号查看已完成任务
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-full border bg-card p-0.5">
          {SCOPES.map((s) => {
            const active = scope === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setScope(s.key)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  active
                    ? 'bg-primary/10 font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="上一个区间"
            onClick={() => shiftRange(-1)}
            className="flex h-8 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
              >
                <CalendarDays className="h-3.5 w-3.5" />
                {rangeLabel}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={new Date(`${date}T00:00:00`)}
                onSelect={(d: Date | undefined) => {
                  if (!d) return;
                  setDate(dayjs(d).format('YYYY-MM-DD'));
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          <button
            type="button"
            aria-label="下一个区间"
            onClick={() => shiftRange(1)}
            className="flex h-8 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="relative ml-auto">
          <Hash className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setKeywordInput(e.target.value)
            }
            placeholder="按序号搜索，如 5"
            className="h-8 w-44 rounded-full pl-8 text-xs"
          />
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-base font-semibold">{heading}</h2>
        {error ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}，当前展示的是上一次成功加载的数据
          </div>
        ) : null}
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {keyword
              ? `没有找到序号为「${keyword}」的已完成任务`
              : '该时间段暂无已完成任务'}
          </p>
        ) : (
          <div data-ai-section-type="card-list" className="space-y-3">
            {items.map((task: TaskSummary) => (
              <Link
                key={`${task.projectId}-${task.id}`}
                to={`/tasks/${task.id}?projectId=${task.projectId}`}
                className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 md:p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground">
                      #{task.sequenceId ?? '—'}
                    </span>
                    <span className="truncate text-base font-semibold">
                      {task.title}
                    </span>
                  </div>
                  <TaskStatusBadge
                    status={task.status}
                    label={task.statusLabel}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-muted-foreground">
                    {task.projectName}
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    完成于 {task.completedAt ?? '未知日期'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default TaskHistoryPage;
