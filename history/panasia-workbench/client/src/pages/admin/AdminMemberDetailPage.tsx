import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Circle,
  RefreshCw,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAdminMemberDetail } from '@client/src/api/admin';
import { formatWorkHours } from '@/utils/work-hours-format';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminMemberDetailResponse,
  BlockDeferReviewItem,
  BlockDeferStatus,
  TaskSummary,
} from '@shared/api.interface';
import TaskStatusBadge from './components/TaskStatusBadge';

/** 顺延申请状态徽章：pending 蓝 / ai_passed 紫 / ai_rejected 红 / approved 绿 / rejected 红 / cancelled 灰 */
const DEFER_BADGES: Record<BlockDeferStatus, { label: string; cls: string }> = {
  pending: { label: 'AI 初审中', cls: 'bg-sky-500/10 text-sky-600' },
  ai_passed: { label: '待老板终审', cls: 'bg-violet-500/10 text-violet-600' },
  ai_rejected: { label: 'AI 已驳回', cls: 'bg-red-500/10 text-red-600' },
  approved: { label: '已顺延', cls: 'bg-emerald-500/10 text-emerald-600' },
  rejected: { label: '已拒绝', cls: 'bg-red-500/10 text-red-500' },
  cancelled: { label: '已取消', cls: 'bg-muted text-muted-foreground' },
};

const SectionCard: React.FC<{
  title: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, hint, children }) => (
  <section className="space-y-4 rounded-xl border bg-card p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {hint}
    </div>
    {children}
  </section>
);

const EmptyHint: React.FC<{ note: string }> = ({ note }) => (
  <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
    暂无数据 · {note}
  </div>
);

const TaskRow: React.FC<{ task: TaskSummary }> = ({ task }) => (
  <div className="space-y-1.5 rounded-xl border bg-card p-4">
    <div className="flex items-start justify-between gap-2">
      <span className="min-w-0 break-words font-medium">
        {task.sequenceId !== null && (
          <span className="text-muted-foreground">#{task.sequenceId} </span>
        )}
        {task.title}
      </span>
      <TaskStatusBadge stateGroup={task.status} label={task.statusLabel} />
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{task.projectName}</span>
      {task.plannedTime && (
        <span className="flex items-center gap-1">
          <CalendarClock className="h-3 w-3" />
          计划 {task.plannedTime}
        </span>
      )}
      {task.deadlineTime && <span>截止 {task.deadlineTime}</span>}
      {task.completedAt && <span>完成于 {task.completedAt}</span>}
      {formatWorkHours(task) && <span>工时 {formatWorkHours(task)}</span>}
    </div>
  </div>
);

const LabeledText: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <p className="break-words text-sm">
    <span className="text-muted-foreground">{label}：</span>
    {children}
  </p>
);

const DeferRow: React.FC<{ item: BlockDeferReviewItem }> = ({ item }) => {
  const badge = DEFER_BADGES[item.status];
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words font-medium">
          {item.sequenceId !== null && (
            <span className="text-muted-foreground">#{item.sequenceId} </span>
          )}
          {item.title}
        </span>
        <Badge variant="secondary" className={`shrink-0 whitespace-nowrap ${badge.cls}`}>
          {badge.label}
        </Badge>
      </div>
      <p className="break-words text-sm text-muted-foreground">
        原截止 {item.originalDeadline ?? '—'} → 申请至 {item.requestedDeadline}
        （顺延 {item.deferMinutes} 分钟）
      </p>
      <LabeledText label="原因">{item.reason}</LabeledText>
      <LabeledText label="方案">{item.resolution}</LabeledText>
      {item.aiOpinion && <LabeledText label="AI 意见">{item.aiOpinion}</LabeledText>}
      {item.sopTitle && <LabeledText label="关联 SOP">{item.sopTitle}</LabeledText>}
    </div>
  );
};

/** 管理端 · 员工详情四视图（今日任务/在途堵塞与顺延/历史完成/计划模式），只读 */
const AdminMemberDetailPage: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<AdminMemberDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await fetchAdminMemberDetail(userId);
      setData(detail);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取员工详情失败';
      setError(message);
      logger.error('管理端员工详情加载失败', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const plannedTasks = useMemo<TaskSummary[]>(() => {
    const withTime = (data?.todayTasks ?? []).filter(
      (task: TaskSummary) => typeof task.plannedTime === 'string' && task.plannedTime,
    );
    return [...withTime].sort((a: TaskSummary, b: TaskSummary) =>
      String(a.plannedTime ?? '').localeCompare(String(b.plannedTime ?? '')),
    );
  }, [data]);

  if (!userId) {
    return (
      <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
        缺少员工标识，无法加载详情。
      </div>
    );
  }

  const member = data?.member;
  const progress = data?.progress ?? null;
  const behindCount = progress?.behindCount ?? member?.behindCount ?? 0;
  const blockedCount = member?.blockedCount ?? 0;
  const deferPending = member?.deferPending ?? 0;
  const todayDone = progress?.todayDone ?? member?.todayDone ?? 0;
  const todayTotal = progress?.todayTotal ?? member?.todayTotal ?? 0;
  const expectedEndTime = progress?.expectedEndTime ?? member?.expectedEndTime ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              {member ? member.name : '员工详情'}
              {member && (
                <Badge
                  variant="secondary"
                  className="bg-muted text-muted-foreground"
                >
                  {member.role}
                </Badge>
              )}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              员工今日执行详情（只读视图）
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      )}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>员工详情加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && data && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-2 text-sm">
            <span>
              <span className="text-xs text-muted-foreground">今日 </span>
              <span className="font-medium tabular-nums">
                {todayDone}/{todayTotal}
              </span>
            </span>
            <span className="text-muted-foreground/40">｜</span>
            <span
              className={behindCount > 0 ? 'font-medium text-red-600' : 'text-muted-foreground'}
            >
              落后 {behindCount}
            </span>
            <span className="text-muted-foreground/40">｜</span>
            <span className="text-muted-foreground">
              预测 {expectedEndTime ?? '—'} 下班
            </span>
            <span className="text-muted-foreground/40">｜</span>
            <span
              className={blockedCount > 0 ? 'font-medium text-red-600' : 'text-muted-foreground'}
            >
              堵塞 {blockedCount}
            </span>
            <span className="text-muted-foreground/40">｜</span>
            <span
              className={
                deferPending > 0 ? 'font-medium text-violet-600' : 'text-muted-foreground'
              }
            >
              顺延待审 {deferPending}
            </span>
          </div>

          <SectionCard title="今日任务">
            {data.todayTasks.length > 0 ? (
              <div className="space-y-3">
                {data.todayTasks.map((task: TaskSummary) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            ) : (
              <EmptyHint note="该员工今天还没有任务" />
            )}
          </SectionCard>

          <SectionCard title="在途堵塞与顺延">
            <h3 className="text-sm font-medium text-muted-foreground">在途堵塞任务</h3>
            {data.blockers.length > 0 ? (
              <div className="space-y-3">
                {data.blockers.map((task: TaskSummary) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            ) : (
              <EmptyHint note="当前没有在途堵塞任务" />
            )}
            <h3 className="pt-2 text-sm font-medium text-muted-foreground">顺延申请记录</h3>
            {data.deferRequests.length > 0 ? (
              <div className="space-y-3">
                {data.deferRequests.map((item: BlockDeferReviewItem) => (
                  <DeferRow key={item.id} item={item} />
                ))}
              </div>
            ) : (
              <EmptyHint note="暂无堵塞顺延申请记录" />
            )}
          </SectionCard>

          <SectionCard
            title="历史完成"
            hint={<span className="text-sm text-muted-foreground">本周已完成 {data.historyTotal} 条</span>}
          >
            {data.history.length > 0 ? (
              <div className="space-y-3">
                {data.history.map((task: TaskSummary) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            ) : (
              <EmptyHint note="本周暂无已完成任务" />
            )}
          </SectionCard>

          <SectionCard title="计划模式">
            <p className="text-xs text-muted-foreground">
              系统按 9:00-18:00 工作时段（午休 12:00-13:00 共 1 小时）自动均分生成计划时刻，只读展示。
            </p>
            {plannedTasks.length > 0 ? (
              <ul className="space-y-2">
                {plannedTasks.map((task: TaskSummary) => (
                  <li
                    key={task.id}
                    className="flex items-center gap-3 rounded-xl border bg-card px-4 py-2.5"
                  >
                    <span className="w-12 shrink-0 text-sm font-medium tabular-nums">
                      {task.plannedTime}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-sm">
                      {task.sequenceId !== null && (
                        <span className="text-muted-foreground">#{task.sequenceId} </span>
                      )}
                      {task.title}
                    </span>
                    {task.status === 'DONE' ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        已完成
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Circle className="h-3.5 w-3.5" />
                        未完成
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyHint note="今日任务暂无系统分配的计划时刻" />
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
};

export default AdminMemberDetailPage;
