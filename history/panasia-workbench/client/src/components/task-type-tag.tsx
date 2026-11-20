import type { TaskType } from '@shared/api.interface';

interface TaskTypeTagProps {
  type: TaskType;
  rewardAmount?: number | null;
  className?: string;
}

const TYPE_STYLES: Record<TaskType, { label: string; className: string }> = {
  daily: {
    label: '日常',
    className: 'bg-indigo-50 text-indigo-600',
  },
  scheduled: {
    label: '定时',
    className: 'bg-violet-50 text-violet-600',
  },
  delegated: {
    label: '委派',
    className:
      'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-sm',
  },
  workorder: { label: '', className: '' },
  standard: { label: '', className: '' },
};

export function TaskTypeTag({
  type,
  rewardAmount,
  className = '',
}: TaskTypeTagProps) {
  if (type === 'standard' || type === 'workorder') return null;
  const style = TYPE_STYLES[type];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${style.className} ${className}`}
    >
      {style.label}
      {type === 'delegated' &&
      rewardAmount !== null &&
      rewardAmount !== undefined ? (
        <span>+¥{rewardAmount}</span>
      ) : null}
    </span>
  );
}
