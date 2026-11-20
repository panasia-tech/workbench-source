import { Link } from 'react-router-dom';
import { CheckCircle2, Clock3, Code2, Paperclip } from 'lucide-react';
import { formatTaskDeadline } from '@/utils/deadline-format';
import type { TaskSummary } from '@shared/api.interface';

interface TaskListItemProps {
  task: TaskSummary;
}

const TONE_CLASS: Record<string, string> = {
  today: 'text-amber-600',
  overdue: 'text-red-600',
  severe: 'font-bold text-red-700',
  plain: 'text-muted-foreground',
};

const CLOSED = ['DONE', 'CANCELLED'];

function earningOf(task: TaskSummary): number | null {
  if (task.rewardAmount !== null) return task.rewardAmount;
  return task.estimatedEarning;
}

function earningNoteOf(task: TaskSummary): string {
  return task.rewardAmount !== null
    ? '额外奖励 · 不计绩效只进钱包'
    : '绩效估算 · 按当月任务量分摊';
}

function formatEarning(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function TaskListItem({ task }: TaskListItemProps) {
  const deadlineDisplay = formatTaskDeadline(task);
  const isClosed = CLOSED.includes(task.status);
  const isDone = task.status === 'DONE';
  const isOverdueOpen =
    !isClosed &&
    (deadlineDisplay?.tone === 'overdue' || deadlineDisplay?.tone === 'severe');
  const earning = earningOf(task);
  const showEarningNote = earning !== null && (!isClosed || isDone);
  const overview = task.currentAction?.replace(/^验收条件=/u, '') ?? null;
  // 开发需求：报价、交付、验收都在开发需求页，卡片直接点过去；环节显示 Plane 状态名（如「工时报价」）
  const devRequestId = task.devRequestId ?? null;
  const statusText = devRequestId ? (task.stateName ?? task.statusLabel) : task.statusLabel;

  return (
    <Link
      to={
        devRequestId
          ? `/dev-requests/${devRequestId}`
          : `/tasks/${task.id}?projectId=${task.projectId}`
      }
      className="flex flex-col gap-3 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {devRequestId ? (
            <span className="flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700">
              <Code2 className="h-3.5 w-3.5" />
              开发需求
            </span>
          ) : null}
          {isDone && task.completedAt ? (
            <span className="flex items-center gap-1.5 text-base font-semibold text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              {task.completedAt} 完成
            </span>
          ) : isClosed ? (
            <span className="text-base text-muted-foreground">
              {statusText}
            </span>
          ) : deadlineDisplay ? (
            <span
              className={`flex items-center gap-1.5 text-lg font-bold ${
                TONE_CLASS[deadlineDisplay.tone] ?? 'text-muted-foreground'
              }`}
            >
              <Clock3 className="h-5 w-5" />
              {deadlineDisplay.text}
            </span>
          ) : (
            <span className="text-base text-muted-foreground">
              {statusText}
            </span>
          )}
          {task.plannedTime ? (
            <span className="text-xs text-muted-foreground">
              计划 {task.plannedTime}
            </span>
          ) : null}
        </div>
        {earning !== null ? (
          <span
            className={`shrink-0 text-2xl font-bold leading-tight ${
              isClosed ? 'text-muted-foreground' : 'text-red-600'
            }`}
          >
            ¥{formatEarning(earning)}
          </span>
        ) : null}
      </div>

      {showEarningNote ? (
        <p className="-mt-2 text-right text-xs text-muted-foreground">
          {isDone
            ? task.rewardAmount !== null
              ? '已入钱包'
              : '已计绩效估算'
            : earningNoteOf(task)}
        </p>
      ) : null}

      {task.severeBlocked || isOverdueOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          {task.severeBlocked ? (
            <span className="rounded bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">
              严重堵塞
            </span>
          ) : null}
          {isOverdueOpen ? (
            <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600">
              逾期完成 +2 分
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          #{task.sequenceId ?? '—'}
        </span>
        <span className="text-lg font-semibold leading-snug">
          {task.title}
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{task.projectName}</p>

      {overview ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/80">工作概览：</span>
          {overview}
        </p>
      ) : null}

      {task.evidenceSummary ? (
        <p className="flex items-start gap-1.5 text-sm leading-relaxed text-muted-foreground">
          <Paperclip className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium text-foreground/80">
              {devRequestId ? '验收条件：' : '提交材料：'}
            </span>
            {task.evidenceSummary}
          </span>
        </p>
      ) : null}
    </Link>
  );
}
