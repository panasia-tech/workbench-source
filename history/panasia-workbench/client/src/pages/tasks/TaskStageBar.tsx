import {
  Circle,
  CircleCheck,
  OctagonAlert,
  Paperclip,
  Trophy,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { TaskEvidenceItem, TaskSummary } from '@shared/api.interface';

type TaskStatus = TaskSummary['status'];

interface EvidenceChecklistBarProps {
  checklist: TaskEvidenceItem[];
  evidenceCount: number;
  status: TaskStatus;
}

export function EvidenceChecklistBar({
  checklist,
  evidenceCount,
  status,
}: EvidenceChecklistBarProps) {
  if (status === 'CANCELLED') {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-5">
          <OctagonAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            任务已取消，无需提交验收凭证
          </p>
        </CardContent>
      </Card>
    );
  }

  const submittedCount = checklist.filter((i: TaskEvidenceItem) => i.submitted)
    .length;
  const missing = checklist
    .filter((i: TaskEvidenceItem) => !i.submitted)
    .map((i: TaskEvidenceItem) => i.name);

  if (checklist.length === 0) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2">
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">验收凭证</p>
            <span className="text-sm text-muted-foreground">
              已提交 {evidenceCount} 份
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            提交验收时需上传能证明任务完成的材料（截图 / 录音 / 视频 / 文件）
          </p>
        </CardContent>
      </Card>
    );
  }

  const allDone = submittedCount === checklist.length;

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            凭证完成度
          </p>
          <span
            className={`text-sm font-semibold ${
              allDone ? 'text-green-600' : 'text-amber-600'
            }`}
          >
            {submittedCount} / {checklist.length}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${
              allDone ? 'bg-green-500' : 'bg-amber-500'
            }`}
            style={{ width: `${(submittedCount / checklist.length) * 100}%` }}
          />
        </div>
        <ul className="mt-3 space-y-1.5">
          {checklist.map((item: TaskEvidenceItem) => (
            <li
              key={item.name}
              className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2 text-sm">
                {item.submitted ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-green-600" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-amber-600" />
                )}
                <span className="truncate">{item.name}</span>
              </span>
              <span
                className={`shrink-0 text-xs ${
                  item.submitted
                    ? 'text-muted-foreground'
                    : 'font-medium text-amber-600'
                }`}
              >
                {item.submitted ? '已提交' : '待补充'}
              </span>
            </li>
          ))}
        </ul>
        <p
          className={`mt-3 rounded-md px-3 py-2 text-sm ${
            allDone ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          {allDone
            ? '凭证材料齐全，可提交验收'
            : `还需补充：${missing.join('；')}`}
        </p>
      </CardContent>
    </Card>
  );
}

interface TaskRewardCardProps {
  status: TaskStatus;
  deadline: string | null;
  deadlineTime: string | null;
  severeBlocked: boolean;
}

const REWARD_RULES = [
  { label: '按时完成', value: '+2 绩效分' },
  { label: '一次验收通过', value: '再 +1' },
  { label: '逾期完成', value: '仅 +1，标记逾期' },
  { label: '被打回返工', value: '返工后按逾期计' },
] as const;

export function TaskRewardCard({
  status,
  deadline,
  deadlineTime,
  severeBlocked,
}: TaskRewardCardProps) {
  const overdueMs =
    deadline === null
      ? -1
      : Date.now() -
        new Date(`${deadline}T${deadlineTime ?? '23:59'}:00+08:00`).getTime();
  const overdue = status !== 'DONE' && status !== 'CANCELLED' && overdueMs > 0;

  if (status === 'DONE') {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-5">
          <Trophy className="h-5 w-5 shrink-0 text-green-600" />
          <p className="text-sm">
            任务已完成，得分已按规则计入当期绩效，可在
            <span className="font-medium">「绩效」</span>
            中查看。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-600" />
          <p className="text-sm font-semibold">完成奖励</p>
          {overdue ? (
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                severeBlocked
                  ? 'bg-red-600 text-white'
                  : 'bg-red-50 text-red-600'
              }`}
            >
              {severeBlocked ? '已超 48 小时 · 严重堵塞' : '已过截止时间'}
            </span>
          ) : (
            <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-600">
              按时完成并通过验收可得 +3 绩效分
            </span>
          )}
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {REWARD_RULES.map((rule) => (
            <div
              key={rule.label}
              className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2"
            >
              <span className="text-muted-foreground">{rule.label}</span>
              <span className="font-medium">{rule.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
