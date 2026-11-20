import { formatTaskDeadline } from '@/utils/deadline-format';
import { formatWorkHours } from '@/utils/work-hours-format';
import type { TaskSummary } from '@shared/api.interface';

interface TaskMetaGridProps {
  task: TaskSummary;
  ownerName: string;
}

/** 任务详情标题下的字段行：负责人 / 截止 / 优先级 / 工时（描述里写了「工时=」才显示） */
export function TaskMetaGrid({ task, ownerName }: TaskMetaGridProps) {
  const deadlineDisplay = formatTaskDeadline(task);
  const workHoursLabel = formatWorkHours(task);
  return (
    <div
      className={`mt-3 grid gap-4 text-sm ${
        workHoursLabel ? 'sm:grid-cols-4' : 'sm:grid-cols-3'
      }`}
    >
      <div>
        <p className="text-muted-foreground">负责人</p>
        <p className="mt-0.5 font-medium">{ownerName}</p>
      </div>
      <div>
        <p className="text-muted-foreground">截止</p>
        <p
          className={`mt-0.5 font-medium ${
            deadlineDisplay?.tone === 'today'
              ? 'text-amber-600'
              : deadlineDisplay && deadlineDisplay.tone !== 'plain'
                ? 'text-red-600'
                : ''
          }`}
        >
          {deadlineDisplay?.text ?? task.deadline ?? '未设置'}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">优先级</p>
        <p className="mt-0.5 font-medium">{task.priorityLabel}</p>
      </div>
      {workHoursLabel ? (
        <div>
          <p className="text-muted-foreground">工时</p>
          <p className="mt-0.5 font-medium">{workHoursLabel}</p>
        </div>
      ) : null}
    </div>
  );
}
