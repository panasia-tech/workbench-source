import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CircleCheck,
  LayoutDashboard,
  RefreshCw,
  Zap,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { getOverview } from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminAttentionItem,
  AdminOverviewResponse,
  AdminProjectProgress,
} from '@shared/api.interface';
import KpiStrip from './components/KpiStrip';
import QuickTaskDialog from './components/QuickTaskDialog';

const KIND_LABELS: Record<AdminAttentionItem['kind'], string> = {
  blocker: '阻塞',
  overdue_workorder: '逾期工单',
  overdue_task: '逾期任务',
  pending_review: '待验收',
  problem_candidate: '问题候选',
  problem_overdue: '问题超时',
};

const SEVERITY_STYLE: Record<AdminAttentionItem['severity'], string> = {
  critical: 'bg-red-500',
  high: 'bg-amber-500',
  normal: 'bg-muted-foreground/40',
};

const SEVERITY_LABEL: Record<AdminAttentionItem['severity'], string> = {
  critical: '紧急',
  high: '高危',
  normal: '关注',
};

const AdminOverviewPage: React.FC = () => {
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const overview = await getOverview();
      setData(overview);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '获取总览数据失败';
      setError(message);
      logger.error('管理端总览加载失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <LayoutDashboard className="h-5 w-5 text-primary" />
            总览
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            老板视角的核心经营驾驶舱，只呈现需要你介入的例外。
          </p>
        </div>
        <Button onClick={() => setQuickOpen(true)}>
          <Zap className="h-4 w-4" />
          快速下任务
        </Button>
      </div>

      {loading && (
        <div className="space-y-6">
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-64 rounded-xl lg:col-span-2" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </div>
      )}

      {!loading && error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>总览数据加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && data && (
        <>
          <KpiStrip rows={data.kpis ?? []} />

          <div className="grid gap-4 lg:grid-cols-3">
            <div
              data-ai-section-type="card-list"
              className="space-y-3 rounded-xl border bg-card p-5 lg:col-span-2"
            >
              <h2 className="text-sm font-semibold">需要我处理</h2>
              {(data.attentions ?? []).length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无需要介入的事项，一切正常运转。
                </p>
              )}
              {(data.attentions ?? []).map((item: AdminAttentionItem) => (
                <Link
                  key={item.id}
                  to={item.href ?? '/admin'}
                  className="block rounded-lg border p-3 transition-colors hover:bg-accent"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        SEVERITY_STYLE[item.severity]
                      }`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {item.title}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {KIND_LABELS[item.kind] ?? item.kind}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {SEVERITY_LABEL[item.severity]}
                        </span>
                      </div>
                      {item.detail && (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {item.detail}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {dayjs(item.occurredAt).format('MM-DD HH:mm')}
                    </span>
                  </div>
                </Link>
              ))}
            </div>

            <div className="space-y-4">
              <div
                data-ai-section-type="card-stat"
                className="rounded-xl border bg-card p-5"
              >
                <h2 className="text-sm font-semibold">系统性问题摘要</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  来自问题池与改进项目（阻塞 SOP 聚类）
                </p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                  <span className="text-sm">
                    候选{' '}
                    <span className="text-lg font-semibold tabular-nums">
                      {data.problemSummary?.candidateCount ?? 0}
                    </span>
                  </span>
                  <span className="text-sm">
                    已立项{' '}
                    <span className="text-lg font-semibold tabular-nums">
                      {data.problemSummary?.confirmedCount ?? 0}
                    </span>
                  </span>
                  <span className="text-sm">
                    观察期{' '}
                    <span className="text-lg font-semibold tabular-nums">
                      {data.problemSummary?.observingCount ?? 0}
                    </span>
                  </span>
                </div>
                <Link
                  to="/admin/problems"
                  className="mt-3 inline-block text-xs text-primary hover:underline"
                >
                  查看问题域 →
                </Link>
              </div>

              <div className="rounded-xl border bg-card p-5">
                <h2 className="text-sm font-semibold">重点项目进度</h2>
                {(data.projects ?? []).length === 0 && (
                  <p className="mt-4 text-sm text-muted-foreground">
                    暂无项目数据。
                  </p>
                )}
                <div className="mt-3 space-y-4">
                  {(data.projects ?? []).map((project) => (
                    <div key={project.projectId}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {project.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {project.openTasks}/{project.totalTasks} 未完成
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <Progress value={project.progress} className="h-2" />
                        <span className="w-9 shrink-0 text-right text-xs tabular-nums">
                          {project.progress}%
                        </span>
                        {project.risky && (
                          <Badge
                            variant="secondary"
                            className="bg-red-500/10 text-red-600"
                          >
                            有逾期
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <QuickTaskDialog
            open={quickOpen}
            onOpenChange={setQuickOpen}
            projects={(data.projects ?? []).map((p: AdminProjectProgress) => ({
              projectId: p.projectId,
              name: p.name,
            }))}
            onCreated={() => void load()}
          />
        </>
      )}

      {!loading && !error && !data && (
        <div className="flex items-center gap-2 rounded-xl border p-5 text-sm text-muted-foreground">
          <CircleCheck className="h-4 w-4" />
          暂无数据。
        </div>
      )}
    </div>
  );
};

export default AdminOverviewPage;
