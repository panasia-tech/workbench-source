import { Link } from 'react-router-dom';
import { BookOpen, CircleAlert } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { TutorialTask } from '@shared/api.interface';

interface TutorialTaskCardProps {
  task: TutorialTask;
}

export function TutorialTaskCard({ task }: TutorialTaskCardProps) {
  const stepsDone = task.stepsDone ?? 0;
  const stepsTotal = task.stepsTotal ?? 0;
  const stagesTotal = task.stagesTotal ?? 0;

  const body = (
    <>
      <div className="flex items-start justify-between gap-4">
        <span className="flex items-center gap-1.5 text-lg font-bold text-primary">
          <BookOpen className="h-5 w-5" />
          教程任务
        </span>
        {task.rewardAmount !== null ? (
          <span className="shrink-0 text-2xl font-bold leading-tight text-red-600">
            ¥{task.rewardAmount}
          </span>
        ) : (
          <span className="shrink-0 text-2xl font-bold leading-tight text-primary">
            +{task.rewardScore} 分
          </span>
        )}
      </div>
      <p className="text-right text-xs text-muted-foreground">
        {task.rewardAmount !== null
          ? `教程奖励 · 绩效 +${task.rewardScore} 分，完成后计入`
          : '教程奖励 · 完成后计入绩效'}
      </p>
      {task.blockedReason !== null ? (
        <p
          className={`flex items-center gap-1.5 ${
            task.severeBlocked
              ? 'text-sm font-bold text-red-700'
              : 'text-sm text-red-600'
          }`}
        >
          <CircleAlert className="h-4 w-4 shrink-0" />
          {task.blockedReason === 'step_rejected'
            ? '当前步骤材料被打回 · 请重新提交或跳过'
            : `严重堵塞 · 教程已超 ${task.overdueDays} 天未完成`}
        </p>
      ) : null}
      <p className="text-lg font-bold leading-snug">{task.title}</p>
      {task.currentStageTitle ? (
        <p className="text-sm text-muted-foreground">
          当前阶段：{task.currentStageTitle}
        </p>
      ) : null}
      {stepsTotal > 0 ? (
        <p className="text-sm text-muted-foreground">
          已完成 {stepsDone}/{stepsTotal} 步 · 共 {stagesTotal} 个阶段
        </p>
      ) : null}
      <Progress value={task.progress} className="h-1.5" />
    </>
  );

  const className =
    'flex flex-col gap-3 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/50';

  if (!Number.isInteger(task.caseId) || task.caseId <= 0) {
    return <div className={className}>{body}</div>;
  }
  return (
    <Link to={`/my/learning/case/${task.caseId}`} className={className}>
      {body}
    </Link>
  );
}

export default TutorialTaskCard;
