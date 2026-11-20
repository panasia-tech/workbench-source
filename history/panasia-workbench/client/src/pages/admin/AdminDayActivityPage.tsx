import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAdminDayActivity } from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminDayActivityResponse,
  AdminDayMemberActivity,
  AdminDayTaskItem,
  AdminKpiRow,
} from '@shared/api.interface';
import DayActivityMemberCard from './components/DayActivityMemberCard';
import KpiStrip from './components/KpiStrip';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function hasActivity(member: AdminDayMemberActivity): boolean {
  return (
    member.completed.length > 0 || member.due.length > 0 || member.blocked.length > 0
  );
}

/** 管理端 · 执行 Dock · 按日期看：某天谁做了什么（当天完成 / 当天截止 / 当天提交堵塞），按人分组 */
const AdminDayActivityPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = dayjs().format('YYYY-MM-DD');
  const rawDate = searchParams.get('date') ?? '';
  const date = DATE_RE.test(rawDate) && dayjs(rawDate).isValid() ? rawDate : today;
  const [data, setData] = useState<AdminDayActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchAdminDayActivity(date));
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : '获取按日期看数据失败');
      logger.error('管理端按日期看加载失败', err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeDate = (next: string): void => {
    setSearchParams(next === today ? {} : { date: next }, { replace: true });
  };

  const dateLabel = useMemo<string>(() => {
    const d = dayjs(date);
    const suffix = date === today ? '（今天）' : '';
    return `${d.format('M月D日')} ${WEEKDAYS[d.day()]}${suffix}`;
  }, [date, today]);

  const members = data?.members ?? [];
  const active = members.filter(hasActivity);
  const idle = members.filter((m: AdminDayMemberActivity) => !hasActivity(m));
  const kpis = useMemo<AdminKpiRow[]>(() => {
    const sum = (pick: (m: AdminDayMemberActivity) => AdminDayTaskItem[]): number =>
      members.reduce((total: number, m: AdminDayMemberActivity) => total + pick(m).length, 0);
    const overdue = members.reduce(
      (total: number, m: AdminDayMemberActivity) =>
        total + m.due.filter((item: AdminDayTaskItem) => item.dueState === 'overdue').length,
      0,
    );
    return [
      { label: '完成', value: sum((m) => m.completed) },
      { label: '截止', value: overdue > 0 ? `${sum((m) => m.due)}（逾期 ${overdue}）` : sum((m) => m.due) },
      { label: '提交堵塞', value: sum((m) => m.blocked) },
      { label: '有记录', value: `${active.length}/${members.length} 人` },
    ];
  }, [members, active.length]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => navigate('/admin/execute')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <CalendarDays className="h-5 w-5 text-primary" />
              按日期看
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              某天谁做了什么：当天完成的、当天截止的、当天提交过堵塞的任务。
            </p>
          </div>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="前一天"
          onClick={() => changeDate(dayjs(date).subtract(1, 'day').format('YYYY-MM-DD'))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="min-w-36">
              <CalendarDays className="h-4 w-4" />
              {dateLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={new Date(`${date}T00:00:00`)}
              onSelect={(d: Date | undefined) => {
                if (!d) return;
                changeDate(dayjs(d).format('YYYY-MM-DD'));
                setCalendarOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="icon"
          aria-label="后一天"
          onClick={() => changeDate(dayjs(date).add(1, 'day').format('YYYY-MM-DD'))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => changeDate(today)}>
            回到今天
          </Button>
        )}
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      )}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>按日期看加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && data && members.length === 0 && (
        <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          暂无数据 · 请确认已有员工绑定 Plane 成员后重试。
        </div>
      )}

      {!loading && !error && data && members.length > 0 && (
        <>
          <KpiStrip rows={kpis} />
          {active.length > 0 ? (
            <div data-ai-section-type="card-list" className="space-y-4">
              {active.map((member: AdminDayMemberActivity) => (
                <DayActivityMemberCard
                  key={member.userId}
                  member={member}
                  onOpen={(userId: string) => navigate(`/admin/execute/${userId}`)}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
              暂无数据 · {dateLabel}没有人完成任务、到截止或提交堵塞。
            </div>
          )}
          {active.length > 0 && idle.length > 0 && (
            <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
              当天没有记录：
              {idle.map((m: AdminDayMemberActivity) => m.name).join('、')}
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default AdminDayActivityPage;
