import React, { useCallback, useEffect, useState } from 'react';
import { ListChecks, RefreshCw } from 'lucide-react';
import dayjs from 'dayjs';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchTaskCoordination } from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminCoordinationEmployee,
  AdminCoordinationTask,
  AdminTaskCoordinationResponse,
} from '@shared/api.interface';

const ROLE_LABELS: Record<string, string> = {
  procurement: '采购',
  sales: '销售',
  warehouse: '仓储',
  general: '通用',
  admin: '管理员',
};

/** 执行 Dock 顶部：任务统筹——全公司每人今日任务状况一览（boss 视角） */
const TaskCoordinationSection: React.FC = () => {
  const [data, setData] = useState<AdminTaskCoordinationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const coordination = await fetchTaskCoordination();
      setData(coordination);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取任务统筹数据失败';
      setError(message);
      logger.error('任务统筹数据加载失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const renderTask = (task: AdminCoordinationTask): React.ReactNode => {
    const done = task.statusLabel === '完成';
    return (
      <div
        key={task.taskId}
        className={`rounded-lg border p-3 ${
          done ? 'bg-muted/40 opacity-60' : 'bg-card'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                #{task.sequenceId ?? '—'}
              </span>
              <span className="break-words font-medium">{task.title}</span>
              {task.overdue && (
                <Badge
                  variant="secondary"
                  className="shrink-0 bg-red-500/10 text-red-600"
                >
                  逾期
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {task.projectName ?? '未关联项目'}
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {task.statusLabel}
          </Badge>
        </div>
      </div>
    );
  };

  const renderEmployee = (
    employee: AdminCoordinationEmployee,
  ): React.ReactNode => (
    <div
      key={employee.userId}
      className="rounded-xl border bg-card p-5 transition-colors hover:border-primary/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{employee.name}</span>
          <Badge variant="secondary">
            {ROLE_LABELS[employee.role] ?? employee.role}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="tabular-nums">
            今日{' '}
            <span className="font-medium">{employee.todayDone}</span>
            /
            <span className="font-medium">{employee.todayTotal}</span>
          </span>
          {employee.overdueCount > 0 && (
            <span className="font-medium tabular-nums text-red-600">
              逾期 {employee.overdueCount}
            </span>
          )}
        </div>
      </div>
      {employee.tasks.length > 0 ? (
        <div className="mt-4 space-y-2" data-ai-section-type="card-list">
          {employee.tasks.map(renderTask)}
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          今日暂无任务。
        </p>
      )}
    </div>
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ListChecks className="h-5 w-5 text-primary" />
            任务统筹
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            全公司每人今日任务状况：完成进度、逾期与任务明细。
            {data?.generatedAt && (
              <span className="ml-2 text-xs">
                刷新于 {dayjs(data.generatedAt).format('HH:mm:ss')}
              </span>
            )}
          </p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {loading && (
        <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          正在加载今日任务统筹数据…
        </div>
      )}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertTitle>任务统筹数据加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && data && data.items.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无绑定员工，员工在「我的」页完成绑定（或管理端代建绑定）后会出现在这里。
        </div>
      )}

      {!loading && !error && data && data.items.length > 0 && (
        <div data-ai-section-type="card-list" className="space-y-4">
          {data.items.map(renderEmployee)}
        </div>
      )}
    </section>
  );
};

export default TaskCoordinationSection;
