import React from 'react';
import { ArrowRight, User } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BLOCKER_CATEGORY_LABELS } from '@client/src/api/problems';
import { formatWorkHours } from '@/utils/work-hours-format';
import type {
  AdminDayDueState,
  AdminDayMemberActivity,
  AdminDayTaskItem,
} from '@shared/api.interface';
import TaskStatusBadge from './TaskStatusBadge';

const ROLE_LABELS: Record<string, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓储',
  general: '通用',
  admin: '管理员',
};

/** 截止口径：按时完成绿 / 逾期完成琥珀 / 逾期未完成红 / 未到截止灰 */
const DUE_STATE_META: Record<AdminDayDueState, { label: string; cls: string }> = {
  done: { label: '按时完成', cls: 'text-emerald-600' },
  done_late: { label: '逾期完成', cls: 'font-medium text-amber-600' },
  overdue: { label: '逾期未完成', cls: 'font-medium text-red-600' },
  open: { label: '未到截止', cls: 'text-muted-foreground' },
};

type GroupKind = 'completed' | 'due' | 'blocked';

/** 每组任务行第二行的说明：完成看完成时刻、截止看是否按时、堵塞看提交时刻与分类 */
function rowNote(item: AdminDayTaskItem, kind: GroupKind): React.ReactNode {
  if (kind === 'completed') {
    return item.completedTime ? <span>{item.completedTime} 完成</span> : null;
  }
  if (kind === 'due') {
    const meta = item.dueState ? DUE_STATE_META[item.dueState] : null;
    return (
      <>
        <span>截止 {item.deadlineTime ?? '当天'}</span>
        {meta && <span className={meta.cls}>{meta.label}</span>}
        {item.dueState === 'done_late' && item.completedTime && (
          <span>{item.completedTime} 才完成</span>
        )}
      </>
    );
  }
  return (
    <>
      {item.blockedAt && <span className="text-red-600">{item.blockedAt} 提交堵塞</span>}
      {item.blockCategory && (
        <span>{BLOCKER_CATEGORY_LABELS[item.blockCategory] ?? item.blockCategory}</span>
      )}
    </>
  );
}

const DayTaskRow: React.FC<{ item: AdminDayTaskItem; kind: GroupKind }> = ({
  item,
  kind,
}) => {
  const workHours = formatWorkHours(item);
  return (
    <div className="space-y-1 rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium">
          {item.sequenceId !== null && (
            <span className="text-muted-foreground">#{item.sequenceId} </span>
          )}
          {item.title}
        </span>
        <TaskStatusBadge stateGroup={item.status} label={item.statusLabel} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{item.projectName}</span>
        {rowNote(item, kind)}
        {workHours && <span>工时 {workHours}</span>}
      </div>
    </div>
  );
};

const GROUPS: { kind: GroupKind; title: string }[] = [
  { kind: 'completed', title: '完成' },
  { kind: 'due', title: '截止' },
  { kind: 'blocked', title: '提交堵塞' },
];

interface DayActivityMemberCardProps {
  member: AdminDayMemberActivity;
  onOpen: (userId: string) => void;
}

/** 按日期看 · 员工卡：当天完成 / 截止 / 提交堵塞三组，空组不显示 */
const DayActivityMemberCard: React.FC<DayActivityMemberCardProps> = ({
  member,
  onOpen,
}) => {
  const overdue = member.due.filter(
    (item: AdminDayTaskItem) => item.dueState === 'overdue',
  ).length;
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <button
        type="button"
        onClick={() => onOpen(member.userId)}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <User className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate">{member.name}</span>
          <Badge variant="secondary" className="shrink-0 bg-muted text-muted-foreground">
            {ROLE_LABELS[member.role] ?? member.role}
          </Badge>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>完成 {member.completed.length}</span>
          <span>
            截止 {member.due.length}
            {overdue > 0 && <span className="text-red-600">（逾期 {overdue}）</span>}
          </span>
          <span className={member.blocked.length > 0 ? 'text-red-600' : ''}>
            堵塞 {member.blocked.length}
          </span>
          <ArrowRight className="h-4 w-4" />
        </span>
      </button>
      {GROUPS.map(({ kind, title }) => {
        const items = member[kind];
        if (items.length === 0) return null;
        return (
          <div key={kind} className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              {title}（{items.length}）
            </h3>
            <div className="space-y-2" data-ai-section-type="card-list">
              {items.map((item: AdminDayTaskItem) => (
                <DayTaskRow key={`${kind}-${item.taskId}`} item={item} kind={kind} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
};

export default DayActivityMemberCard;
