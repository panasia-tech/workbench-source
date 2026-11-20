import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CircleCheck, ClipboardCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchReviewPlaneTasks,
  fetchReviewWorkOrders,
  submitPlaneTaskReview,
  submitReviewVerdict,
} from '@client/src/api/workorders';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminKpiRow,
  ReviewPlaneTaskRow,
  ReviewVerdictResponse,
  ReviewWorkOrderRow,
  ReviewWorkOrdersResponse,
} from '@shared/api.interface';
import BlockDeferReviewSection from './components/BlockDeferReviewSection';
import DevRequestReviewSection from './components/DevRequestReviewSection';
import TutorialSkipReviewSection from './components/TutorialSkipReviewSection';
import KpiStrip from './components/KpiStrip';
import PlaneTasksReviewTable from './components/PlaneTasksReviewTable';
import ReviewVerdictDialog from './components/ReviewVerdictDialog';
import WorkOrderReviewCard, {
  type WorkOrderVerdictResult,
} from './components/WorkOrderReviewCard';

type VerdictTarget =
  | {
      kind: 'work_order';
      id: string;
      code: string;
      result: WorkOrderVerdictResult;
      /** 审的是第几版（员工这期间又交了会被拒） */
      version?: number;
    }
  | {
      kind: 'plane_task';
      id: string;
      code: string;
      action: 'approve' | 'reject';
      version?: number;
    };

const VERDICT_TITLES: Record<WorkOrderVerdictResult, string> = {
  approved: '通过',
  refused: '拒绝',
  returned: '退回',
};

const AdminReviewPage: React.FC = () => {
  const [ordersData, setOrdersData] =
    useState<ReviewWorkOrdersResponse | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [planeTasks, setPlaneTasks] = useState<ReviewPlaneTaskRow[] | null>(
    null,
  );
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<VerdictTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const data = await fetchReviewWorkOrders();
      setOrdersData(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取终审工单失败';
      setOrdersError(message);
      logger.error('验收 Dock 工单列表加载失败', err);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const data = await fetchReviewPlaneTasks();
      setPlaneTasks(data.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取待验收任务失败';
      setTasksError(message);
      logger.error('验收 Dock Plane 任务加载失败', err);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
    void loadTasks();
  }, [loadOrders, loadTasks]);

  const pendingOrders = (ordersData?.items ?? []).filter(
    (item: ReviewWorkOrderRow) => item.status === 'pending_boss',
  );
  const finishedOrders = (ordersData?.items ?? []).filter(
    (item: ReviewWorkOrderRow) => item.status !== 'pending_boss',
  );

  const kpiRows: AdminKpiRow[] = [
    { label: '待终审工单', value: pendingOrders.length },
    {
      label: '已通过',
      value: finishedOrders.filter((o: ReviewWorkOrderRow) => o.status === 'approved')
        .length,
    },
    {
      label: '已拒绝',
      value: finishedOrders.filter((o: ReviewWorkOrderRow) => o.status === 'refused')
        .length,
    },
    { label: 'Plane 待验收', value: planeTasks?.length ?? 0 },
  ];

  const confirmWorkOrderVerdict = (
    comment: string,
    performanceAmount?: number,
  ): void => {
    if (!dialog || dialog.kind !== 'work_order') return;
    const target = dialog;
    setSubmitting(true);
    submitReviewVerdict(target.id, {
      result: target.result,
      ...(comment.trim() !== '' ? { comment: comment.trim() } : {}),
      ...(target.version !== undefined ? { version: target.version } : {}),
      ...(performanceAmount !== undefined ? { performanceAmount } : {}),
    })
      .then((res: ReviewVerdictResponse) => {
        toast.success(
          target.result === 'approved'
            ? '已通过终审，ERP 联动单据已创建（如适用）'
            : target.result === 'returned'
              ? '已退回，员工改好会重新提交'
              : '已拒绝工单',
        );
        if (res.erpSettled === true) {
          toast.success('绩效已入账');
        } else if (res.erpSettleError) {
          toast.warning(`绩效未入账：${res.erpSettleError}`);
        }
        setDialog(null);
        void loadOrders();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '终审操作失败，请稍后重试',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const confirmPlaneTaskAction = (comment: string): void => {
    if (!dialog || dialog.kind !== 'plane_task') return;
    const target = dialog;
    setSubmitting(true);
    submitPlaneTaskReview(target.id, {
      action: target.action,
      ...(comment.trim() !== '' ? { comment: comment.trim() } : {}),
      ...(target.version !== undefined ? { version: target.version } : {}),
    })
      .then((result) => {
        toast.success(result.message ?? '验收操作已完成');
        setDialog(null);
        void loadTasks();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '任务验收操作失败，请稍后重试',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          验收
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          员工说完成不等于完成：凭证 → AI / 规则初审 → 老板终审。
        </p>
      </div>

      <BlockDeferReviewSection />

      <TutorialSkipReviewSection />

      <DevRequestReviewSection />

      {(ordersLoading || tasksLoading) && (
        <div className="space-y-6">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      )}

      {!ordersLoading && ordersError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>终审工单加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{ordersError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadOrders()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!ordersLoading && !ordersError && (
        <>
          <KpiStrip rows={kpiRows} />

          <div
            data-ai-section-type="card-list"
            className="space-y-4 rounded-xl border bg-card p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">工单终审</h2>
              <Badge variant="secondary" className="text-xs">
                待终审 {pendingOrders.length}
              </Badge>
            </div>
            {pendingOrders.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                暂无待终审工单。
              </p>
            )}
            <div className="space-y-4">
              {pendingOrders.map((order: ReviewWorkOrderRow) => (
                <WorkOrderReviewCard
                  key={order.id}
                  order={order}
                  onVerdict={(result: WorkOrderVerdictResult) =>
                    setDialog({
                      kind: 'work_order',
                      id: order.id,
                      code: order.code,
                      result,
                      version: order.versions[0]?.version,
                    })
                  }
                  onChanged={() => void loadOrders()}
                />
              ))}
            </div>
            {finishedOrders.length > 0 && (
              <>
                <div className="pt-2 text-xs text-muted-foreground">
                  最近终审记录
                </div>
                <div className="space-y-4 opacity-80">
                  {finishedOrders.map((order: ReviewWorkOrderRow) => (
                    <WorkOrderReviewCard
                      key={order.id}
                      order={order}
                      onVerdict={() => undefined}
                      onChanged={() => void loadOrders()}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {!tasksLoading && tasksError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>待验收任务加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{tasksError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadTasks()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!tasksLoading && !tasksError && (
        <div className="space-y-3 rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Plane 任务验收</h2>
            <Badge variant="secondary" className="text-xs">
              待验收 {planeTasks?.length ?? 0}
            </Badge>
          </div>
          {(planeTasks ?? []).length === 0 ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <CircleCheck className="h-4 w-4" />
              暂无待验收任务。
            </div>
          ) : (
            <PlaneTasksReviewTable
              data={planeTasks ?? []}
              loading={tasksLoading}
              onAction={(taskId: string, action: 'approve' | 'reject') =>
                setDialog({
                  kind: 'plane_task',
                  id: taskId,
                  code: taskId,
                  action,
                  version:
                    (planeTasks ?? []).find((t: ReviewPlaneTaskRow) => t.taskId === taskId)
                      ?.latestVersion ?? undefined,
                })
              }
            />
          )}
        </div>
      )}

      {dialog && (
        <ReviewVerdictDialog
          open
          title={
            dialog.kind === 'work_order'
              ? `${VERDICT_TITLES[dialog.result]}工单 ${dialog.code}${
                  dialog.version !== undefined ? `（第 ${dialog.version} 版）` : ''
                }`
              : `${dialog.action === 'approve' ? '通过' : '打回'}任务验收${
                  dialog.version !== undefined ? `（第 ${dialog.version} 版）` : ''
                }`
          }
          description={
            dialog.kind === 'work_order' && dialog.result === 'approved'
              ? '通过后议价类工单将自动在 ERP 创建 Supplier Quotation 草稿。'
              : dialog.kind === 'work_order' && dialog.result === 'returned'
                ? '回到员工手里改，改好重新提交是新的一版。'
                : undefined
          }
          confirmLabel={dialog.kind === 'work_order' ? '确认' : '确认'}
          destructive={
            dialog.kind === 'work_order'
              ? dialog.result === 'refused'
              : dialog.action === 'reject'
          }
          requireComment={
            dialog.kind === 'work_order'
              ? dialog.result !== 'approved'
              : dialog.action === 'reject'
          }
          showPerformanceAmount={
            dialog.kind === 'work_order' && dialog.result === 'approved'
          }
          submitting={submitting}
          onConfirm={
            dialog.kind === 'work_order'
              ? confirmWorkOrderVerdict
              : confirmPlaneTaskAction
          }
          onOpenChange={(open: boolean) => {
            if (!open) setDialog(null);
          }}
        />
      )}
    </div>
  );
};

export default AdminReviewPage;
