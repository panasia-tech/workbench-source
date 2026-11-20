import { Table, TableProps } from '@lark-apaas/client-toolkit/antd-table';
import { Badge } from '@/components/ui/badge';
import { TaskTypeTag } from '@/components/task-type-tag';
import { formatTaskDeadline } from '@/utils/deadline-format';
import type { ProjectTaskRow } from '@shared/api.interface';

interface ProjectTaskTableProps {
  taskRows: ProjectTaskRow[];
}

const columns: TableProps<ProjectTaskRow>['columns'] = [
  {
    title: '任务',
    dataIndex: 'title',
    key: 'title',
    fixed: 'left',
    width: 280,
    render: (title: string, t: ProjectTaskRow) => (
      <span className="flex items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">
          #{t.sequenceId ?? '—'}
        </span>
        <span className="truncate">{title}</span>
        {t.isMine ? (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            我的
          </span>
        ) : null}
      </span>
    ),
  },
  {
    title: '类型',
    dataIndex: 'taskType',
    key: 'taskType',
    width: 90,
    render: (_: string, t: ProjectTaskRow) =>
      t.taskType === 'standard' ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <TaskTypeTag type={t.taskType} rewardAmount={t.rewardAmount} />
      ),
  },
  {
    title: '所属模块',
    dataIndex: 'moduleName',
    key: 'moduleName',
    width: 140,
    render: (v: string | null) => v ?? <span className="text-muted-foreground">未分组</span>,
  },
  {
    title: '负责人',
    dataIndex: 'assigneeName',
    key: 'assigneeName',
    width: 110,
    render: (v: string | null) => v ?? <span className="text-muted-foreground">未指派</span>,
  },
  {
    title: '状态',
    dataIndex: 'statusLabel',
    key: 'status',
    width: 100,
    render: (label: string, t: ProjectTaskRow) => (
      <Badge variant={t.status === 'DONE' ? 'default' : 'secondary'}>
        {label}
      </Badge>
    ),
  },
  { title: '优先级', dataIndex: 'priorityLabel', key: 'priority', width: 80 },
  {
    title: '截止时间',
    dataIndex: 'deadline',
    key: 'deadline',
    width: 150,
    render: (_: string | null, t: ProjectTaskRow) => {
      const dl = formatTaskDeadline(t);
      if (dl === null) {
        return <span className="text-muted-foreground">未设置</span>;
      }
      const toneClass =
        dl.tone === 'today'
          ? 'font-medium text-amber-600'
          : dl.tone === 'overdue'
            ? 'font-medium text-red-600'
            : dl.tone === 'severe'
              ? 'font-bold text-red-700'
              : 'text-muted-foreground';
      return (
        <span className="flex items-center gap-1.5">
          {t.severeBlocked ? (
            <span className="rounded bg-red-600 px-1 py-0.5 text-[10px] font-semibold text-white">
              严重堵塞
            </span>
          ) : null}
          <span className={toneClass}>{dl.text}</span>
        </span>
      );
    },
  },
];

export function ProjectTaskTable({ taskRows }: ProjectTaskTableProps) {
  return (
    <Table
      columns={columns}
      dataSource={taskRows}
      rowKey="id"
      scroll={{ x: 1000, y: 500 }}
      pagination={false}
    />
  );
}
