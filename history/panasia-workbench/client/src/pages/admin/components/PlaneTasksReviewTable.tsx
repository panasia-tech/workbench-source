import React from 'react';
import { Video } from 'lucide-react';

import { Table, type TableProps } from '@lark-apaas/client-toolkit/antd-table';
import { Button } from '@/components/ui/button';
import { formatWorkHours } from '@/utils/work-hours-format';
import type { ReviewPlaneTaskRow } from '@shared/api.interface';

interface PlaneTasksReviewTableProps {
  data: ReviewPlaneTaskRow[];
  loading: boolean;
  onAction: (taskId: string, action: 'approve' | 'reject') => void;
}

/** Plane 任务验收表：待验收（mapStatusByState 口径，含中文名「结果验收」）issue 列表 + 通过/打回 */
const PlaneTasksReviewTable: React.FC<PlaneTasksReviewTableProps> = ({
  data,
  loading,
  onAction,
}) => {
  const columns: TableProps<ReviewPlaneTaskRow>['columns'] = [
    {
      title: '序号',
      dataIndex: 'sequenceId',
      width: 70,
      render: (value: number) => <span className="tabular-nums">{value}</span>,
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 260,
      ellipsis: true,
    },
    {
      title: '项目',
      dataIndex: 'projectName',
      width: 150,
      ellipsis: true,
    },
    {
      title: '负责人',
      dataIndex: 'assigneeName',
      width: 110,
      render: (value: string | null) => value ?? '未指派',
    },
    {
      title: '截止',
      dataIndex: 'targetDate',
      width: 110,
      render: (value: string | null) => value ?? '—',
    },
    {
      title: '工时',
      key: 'workHours',
      width: 150,
      render: (_: unknown, record: ReviewPlaneTaskRow) =>
        formatWorkHours(record) ?? '—',
    },
    {
      title: '材料摘要',
      dataIndex: 'evidenceSummary',
      ellipsis: true,
      render: (value: string | null) => value ?? '—',
    },
    {
      title: '版本',
      dataIndex: 'latestVersion',
      width: 80,
      render: (value: number | null) => (value !== null ? `第 ${value} 版` : '—'),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_: unknown, record: ReviewPlaneTaskRow) => (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-green-500/40 text-green-600 hover:bg-green-500/10"
            onClick={() => onAction(record.taskId, 'approve')}
          >
            通过
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-red-500/40 text-red-600 hover:bg-red-500/10"
            onClick={() => onAction(record.taskId, 'reject')}
          >
            打回
          </Button>
        </div>
      ),
    },
  ];

  const expandable: TableProps<ReviewPlaneTaskRow>['expandable'] = {
    rowExpandable: (record: ReviewPlaneTaskRow) => !!record.tutorialOutput,
    expandedRowRender: (record: ReviewPlaneTaskRow) => {
      const output = record.tutorialOutput;
      if (!output) return null;
      return (
        <div className="space-y-3 p-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-bold">{output.projectName}</span>
            <span className="text-xs text-muted-foreground">
              {output.stageCount} 个阶段 · {output.stepCount} 个步骤 ·{' '}
              {output.videoCount} 个实操视频
            </span>
          </div>
          {output.stages.map((stage, stageIndex: number) => (
            <div key={stageIndex} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {stage.title}
              </p>
              {stage.steps.map((step, stepIndex: number) => (
                <div
                  key={stepIndex}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>{step.title}</span>
                  {step.hasVideo ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-green-600">
                      <Video className="h-3.5 w-3.5" />
                      实操视频
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    },
  };

  return (
    <Table
      columns={columns}
      dataSource={data}
      loading={loading}
      rowKey="taskId"
      scroll={{ x: 1050, y: 500 }}
      pagination={false}
      expandable={expandable}
    />
  );
};

export default PlaneTasksReviewTable;
