import React from 'react';

import { Badge } from '@/components/ui/badge';

/** 状态色沿用员工端口径：待处理灰、进行中琥珀、阻塞红、待验收蓝紫、完成绿 */
const STATE_BADGE_CLASS: Record<string, string> = {
  TODO: 'bg-muted text-muted-foreground',
  IN_PROGRESS: 'bg-amber-500/15 text-amber-600',
  WAITING: 'bg-sky-500/10 text-sky-600',
  BLOCKED: 'bg-red-500/10 text-red-600',
  READY_FOR_REVIEW: 'bg-violet-500/10 text-violet-600',
  REJECTED: 'bg-red-500/10 text-red-500',
  DONE: 'bg-emerald-500/10 text-emerald-600',
  CANCELLED: 'bg-muted text-muted-foreground line-through',
};

interface TaskStatusBadgeProps {
  stateGroup: string;
  label: string;
}

const TaskStatusBadge: React.FC<TaskStatusBadgeProps> = ({
  stateGroup,
  label,
}) => {
  const cls = STATE_BADGE_CLASS[stateGroup] ?? STATE_BADGE_CLASS.TODO;
  return (
    <Badge variant="secondary" className={`whitespace-nowrap ${cls}`}>
      {label}
    </Badge>
  );
};

export default TaskStatusBadge;
