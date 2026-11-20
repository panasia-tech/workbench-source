import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '@shared/api.interface';

const STATUS_STYLES: Record<TaskStatus, string> = {
  TODO: 'bg-muted text-muted-foreground',
  IN_PROGRESS: 'bg-amber-100 text-amber-800',
  WAITING: 'bg-blue-100 text-blue-800',
  BLOCKED: 'bg-red-100 text-red-700',
  READY_FOR_REVIEW: 'bg-violet-100 text-violet-800',
  REJECTED: 'bg-orange-100 text-orange-800',
  DONE: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-muted text-muted-foreground line-through',
};

interface TaskStatusBadgeProps {
  status: TaskStatus;
  label: string;
}

export function TaskStatusBadge({ status, label }: TaskStatusBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={`border-transparent ${STATUS_STYLES[status]}`}
    >
      {label}
    </Badge>
  );
}
