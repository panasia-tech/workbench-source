import { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  ArrowRightLeft,
  ChevronDown,
  ClipboardList,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { workordersApi } from '@client/src/api';
import type {
  WorkOrderBusinessLine,
  WorkOrderCatalogItem,
  WorkOrderDetail,
  WorkOrderSubject,
  WorkOrderSubjectKind,
  WorkOrderSummary,
  WorkOrderTransitionKind,
} from '@shared/api.interface';
import {
  formatDueAt,
  WORK_ORDER_BUSINESS_LINE_LABELS,
  WORK_ORDER_COMPLEXITY_LABELS,
  WORK_ORDER_STATUS_LABELS,
  WORK_ORDER_SUBJECT_KIND_LABELS,
  WORK_ORDER_TYPE_LABELS,
  workOrderBadge,
} from './workorder-status';
import { WorkOrderEvidenceDialog } from './WorkOrderEvidenceDialog';
import { WorkOrderHandoverDialog } from './WorkOrderHandoverDialog';
import {
  AcceptanceRecordList,
  HandoverList,
  SubjectChips,
  SubmissionVersionList,
} from './WorkOrderAcceptance';

interface WorkOrderSectionProps {
  taskId: string;
}

const EXPAND_DEFAULT_STATUSES = [
  'executing',
  'needs_revision',
  'pending_submit',
  'ai_reviewing',
];

/** 还在员工手里的能转交 */
const HANDOVER_STATUSES = ['pending', 'executing', 'needs_revision'];

const LINE_FROM_CATALOG = 'catalog';

interface SubjectDraft {
  kind: WorkOrderSubjectKind;
  name: string;
  ref: string;
}

const EMPTY_SUBJECT: SubjectDraft = { kind: 'product', name: '', ref: '' };

/**
 * 任务详情内嵌工单区：按任务关联工单展示（创建 / 凭证 / 状态机操作）。
 */
export function WorkOrderSection({ taskId }: WorkOrderSectionProps) {
  const [orders, setOrders] = useState<WorkOrderSummary[]>([]);
  const [details, setDetails] = useState<Record<string, WorkOrderDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [evidenceOrder, setEvidenceOrder] = useState<WorkOrderDetail | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [catalog, setCatalog] = useState<WorkOrderCatalogItem[] | null>(null);
  const [createForm, setCreateForm] = useState({
    catalogCode: '',
    title: '',
    remark: '',
    businessLine: LINE_FROM_CATALOG,
  });
  const [subjectDrafts, setSubjectDrafts] = useState<SubjectDraft[]>([]);
  const [creating, setCreating] = useState(false);
  const [handoverOrder, setHandoverOrder] = useState<WorkOrderDetail | null>(
    null,
  );

  const load = useCallback((quiet = false) => {
    if (!quiet) setLoading(true);
    workordersApi
      .listMyWorkOrders({ taskId, pageSize: 50 })
      .then((data) => {
        setOrders(data.items ?? []);
        setError(null);
        return Promise.all(
          (data.items ?? []).map((order: WorkOrderSummary) =>
            workordersApi.fetchWorkOrderDetail(order.id),
          ),
        );
      })
      .then((responses) => {
        const map: Record<string, WorkOrderDetail> = {};
        for (const response of responses) {
          map[response.workOrder.id] = response.workOrder;
        }
        setDetails(map);
      })
      .catch((err: unknown) => {
        setError('工单加载失败，请稍后重试');
        logger.error('工单区加载失败', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const hasAiReviewing = orders.some(
    (order: WorkOrderSummary) => order.status === 'ai_reviewing',
  );

  // AI 初审中的工单每 5 秒静默刷新，状态自动流转后停止
  useEffect(() => {
    if (!hasAiReviewing) return;
    const timer = setInterval(() => {
      load(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [hasAiReviewing, load]);

  const runTransition = (
    order: WorkOrderSummary,
    action: WorkOrderTransitionKind,
  ) => {
    setBusyOrderId(order.id);
    workordersApi
      .transitionWorkOrder(order.id, { action })
      .then((result) => {
        toast.success(result.message ?? '操作成功');
        load();
      })
      .catch((err: unknown) => {
        toast.error('操作失败，请稍后重试');
        logger.error('工单流转失败', { action, code: order.code, err });
      })
      .finally(() => {
        setBusyOrderId(null);
      });
  };

  const handleEvidenceSubmitted = (detail: WorkOrderDetail) => {
    setEvidenceOrder(null);
    if (detail.status === 'ai_reviewing') {
      toast.success('凭证齐全，豆包 AI 初审中，完成后自动流转');
    } else if (detail.status === 'pending_boss') {
      toast.success('凭证齐全，规则初审通过，已提交老板终审');
    } else if (detail.status === 'needs_revision') {
      toast.error(detail.aiVerdict?.summary ?? '凭证不齐，已退回需修改');
    } else {
      toast.success('凭证已提交');
    }
    load();
  };

  const openCreate = () => {
    setCreateOpen(true);
    if (catalog === null) {
      workordersApi
        .fetchWorkOrderCatalog()
        .then((data) => {
          setCatalog(data.items ?? []);
        })
        .catch((err: unknown) => {
          toast.error('种类目录加载失败，请稍后重试');
          logger.error('种类目录加载失败', err);
        });
    }
  };

  const selectedCatalog = (catalog ?? []).find(
    (item: WorkOrderCatalogItem) => item.code === createForm.catalogCode,
  );

  const submitCreate = () => {
    if (createForm.catalogCode === '') {
      toast.error('请选择工单种类');
      return;
    }
    if (createForm.title.trim() === '') {
      toast.error('请填写工单标题');
      return;
    }
    const subjects: WorkOrderSubject[] = subjectDrafts
      .filter((draft: SubjectDraft) => draft.name.trim() !== '')
      .map((draft: SubjectDraft) => ({
        kind: draft.kind,
        name: draft.name.trim(),
        ...(draft.ref.trim() !== '' ? { ref: draft.ref.trim() } : {}),
      }));
    setCreating(true);
    workordersApi
      .createWorkOrder({
        catalogCode: createForm.catalogCode,
        title: createForm.title.trim(),
        taskId,
        ...(createForm.remark.trim() !== ''
          ? { remark: createForm.remark.trim() }
          : {}),
        ...(createForm.businessLine !== LINE_FROM_CATALOG
          ? { businessLine: createForm.businessLine as WorkOrderBusinessLine }
          : {}),
        ...(subjects.length > 0 ? { subjects } : {}),
      })
      .then((result) => {
        toast.success(`工单已创建：${result.workOrder.code}`);
        setCreateOpen(false);
        setCreateForm({
          catalogCode: '',
          title: '',
          remark: '',
          businessLine: LINE_FROM_CATALOG,
        });
        setSubjectDrafts([]);
        load();
      })
      .catch((err: unknown) => {
        toast.error('工单创建失败，请稍后重试');
        logger.error('工单创建失败', err);
      })
      .finally(() => {
        setCreating(false);
      });
  };

  const renderActions = (order: WorkOrderSummary) => {
    const detail = details[order.id];
    const handover =
      HANDOVER_STATUSES.includes(order.status) && detail !== undefined ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setHandoverOrder(detail)}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
          转交
        </Button>
      ) : null;
    return (
      <div className="flex gap-2">
        {handover}
        {renderMainAction(order)}
      </div>
    );
  };

  const renderMainAction = (order: WorkOrderSummary) => {
    const busy = busyOrderId === order.id;
    if (order.status === 'pending') {
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => runTransition(order, 'start')}
        >
          <Play className="h-3.5 w-3.5" />
          开始工单
        </Button>
      );
    }
    if (order.status === 'executing') {
      const detail = details[order.id];
      return (
        <Button
          size="sm"
          disabled={detail === undefined}
          onClick={() => {
            if (detail !== undefined) setEvidenceOrder(detail);
          }}
        >
          <Upload className="h-3.5 w-3.5" />
          提交凭证
        </Button>
      );
    }
    if (order.status === 'pending_submit') {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => runTransition(order, 'revoke_submit')}
        >
          <Undo2 className="h-3.5 w-3.5" />
          撤回提交
        </Button>
      );
    }
    if (order.status === 'needs_revision') {
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => runTransition(order, 'resubmit')}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重新提交
        </Button>
      );
    }
    return null;
  };

  const renderOrderCard = (order: WorkOrderSummary) => {
    const detail = details[order.id];
    const checklist = detail?.checklist ?? [];
    const evidence = detail?.evidence ?? [];
    const doneCount = checklist.filter((item) => {
      const row = evidence.find((e) => e.itemKey === item.key);
      return row !== undefined && row.fileUrls.length > 0;
    }).length;
    const progress =
      checklist.length === 0
        ? 100
        : Math.round((doneCount / checklist.length) * 100);
    const defaultOpen = EXPAND_DEFAULT_STATUSES.includes(order.status);

    return (
      <Card key={order.id}>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-xs text-muted-foreground">
                {order.code}
              </p>
              <p className="mt-0.5 truncate text-base font-medium">
                {order.title}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {order.businessLine
                  ? `${WORK_ORDER_BUSINESS_LINE_LABELS[order.businessLine]} · `
                  : ''}
                {order.catalogName ?? order.catalogCode} ·{' '}
                {WORK_ORDER_TYPE_LABELS[order.orderType]} ·{' '}
                {WORK_ORDER_COMPLEXITY_LABELS[order.complexity]} · 创建于{' '}
                {dayjs(order.createdAt).format('MM-DD HH:mm')}
                {order.dueAt ? (
                  <span className="text-foreground">
                    {' '}
                    · 截止 {formatDueAt(order.dueAt)}
                  </span>
                ) : null}
              </p>
              {order.subjects.length > 0 ? (
                <div className="mt-1.5">
                  <SubjectChips subjects={order.subjects} />
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className={workOrderBadge(order.status)}>
                {WORK_ORDER_STATUS_LABELS[order.status]}
              </span>
              <Collapsible defaultOpen={defaultOpen}>
                <CollapsibleTrigger className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
                  凭证 {doneCount}/{checklist.length}
                  <ChevronDown className="h-3.5 w-3.5" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-3 space-y-3">
                    <Progress value={progress} className="h-1.5" />
                    <ul className="space-y-1.5">
                      {checklist.map((item) => {
                        const row = evidence.find(
                          (e) => e.itemKey === item.key,
                        );
                        const uploaded =
                          row !== undefined && row.fileUrls.length > 0;
                        return (
                          <li
                            key={item.key}
                            className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
                          >
                            <span className="flex items-center gap-2">
                              {item.name}
                              {item.onSite ? (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                                  需现场
                                </span>
                              ) : null}
                              {item.required !== false ? (
                                <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                                  必传
                                </span>
                              ) : (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                  选传
                                </span>
                              )}
                            </span>
                            <span
                              className={
                                uploaded
                                  ? 'text-xs text-green-700'
                                  : 'text-xs text-muted-foreground'
                              }
                            >
                              {uploaded ? `已传 ${row?.fileUrls.length} 个` : '待上传'}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    {order.status === 'ai_reviewing' ? (
                      <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
                        豆包 AI 初审中，约 1 分钟内自动流转，无需操作
                      </p>
                    ) : null}
                    {order.status === 'needs_revision' &&
                    detail?.humanVerdict?.result === 'returned' ? (
                      <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                        退回原因：{detail.humanVerdict.comment ?? ''}
                      </p>
                    ) : order.status === 'needs_revision' &&
                      detail?.aiVerdict?.summary ? (
                      <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                        {detail.aiVerdict.summary}
                      </p>
                    ) : null}
                    {detail && detail.versions.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          交过 {detail.versions.length} 版
                        </p>
                        <SubmissionVersionList versions={detail.versions} />
                      </div>
                    ) : null}
                    {detail && detail.acceptanceRecords.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          验收记录
                        </p>
                        <AcceptanceRecordList records={detail.acceptanceRecords} />
                      </div>
                    ) : null}
                    {detail && detail.events.length > 0 ? (
                      <div className="rounded-md bg-muted/50 px-3 py-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          流转记录
                        </p>
                        <ul className="mt-1 space-y-1">
                          {[...detail.events]
                            .reverse()
                            .slice(0, 6)
                            .map((event) => (
                              <li
                                key={event.id}
                                className="text-xs text-muted-foreground"
                              >
                                {event.fromStatus === null
                                  ? '创建'
                                  : WORK_ORDER_STATUS_LABELS[
                                      event.fromStatus
                                    ]}{' '}
                                → {WORK_ORDER_STATUS_LABELS[event.toStatus]} ·{' '}
                                {event.comment ?? ''}
                                {event.comment ? ' · ' : ''}
                                {dayjs(event.createdAt).format(
                                  'MM-DD HH:mm',
                                )}
                              </li>
                            ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>
          {detail && detail.handovers.length > 0 ? (
            <div className="mt-3">
              <HandoverList handovers={detail.handovers} />
            </div>
          ) : null}
          <div className="mt-3 flex justify-end">
            {renderActions(order)}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          工单
          {orders.length > 0 ? (
            <span className="text-sm font-normal text-muted-foreground">
              （{orders.length}）
            </span>
          ) : null}
        </h2>
        <Button variant="outline" size="sm" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" />
          新建工单
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">工单加载中...</p>
      ) : null}
      {!loading && error !== null ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}

      {!loading && error === null && orders.length === 0 ? (
        <div className="rounded-xl border border-dashed p-5 text-center">
          <p className="text-sm font-medium">暂无关联工单</p>
          <p className="mt-1 text-sm text-muted-foreground">
            本任务还没有凭证审批工单，可按种类目录创建（瑕疵议价、退卡、
            快递破损投诉等）
          </p>
          <Button className="mt-3" size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5" />
            按目录创建工单
          </Button>
        </div>
      ) : null}

      {!loading && orders.length > 0 ? (
        <div data-ai-section-type="card-list" className="space-y-4">
          {orders.map((order: WorkOrderSummary) => renderOrderCard(order))}
        </div>
      ) : null}

      <WorkOrderHandoverDialog
        order={handoverOrder}
        onClose={() => setHandoverOrder(null)}
        onDone={() => {
          setHandoverOrder(null);
          load();
        }}
      />

      <WorkOrderEvidenceDialog
        order={evidenceOrder}
        onClose={() => {
          setEvidenceOrder(null);
        }}
        onSubmitted={handleEvidenceSubmitted}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>按目录创建工单</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">工单种类</p>
              <Select
                value={createForm.catalogCode}
                onValueChange={(value: string) => {
                  setCreateForm((prev) => ({ ...prev, catalogCode: value }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={catalog === null ? '目录加载中...' : '选择种类'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(catalog ?? []).map((item: WorkOrderCatalogItem) => (
                    <SelectItem key={item.id} value={item.code}>
                      {item.name}（
                      {WORK_ORDER_COMPLEXITY_LABELS[item.complexity]} ·{' '}
                      {WORK_ORDER_TYPE_LABELS[item.orderType]}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCatalog ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  凭证清单：
                  {selectedCatalog.checklistTemplate
                    .map((item) => (item.onSite ? `${item.name}（需现场）` : item.name))
                    .join('、') || '无固定凭证要求'}
                </p>
              ) : null}
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">业务线</p>
              <Select
                value={createForm.businessLine}
                onValueChange={(value: string) => {
                  setCreateForm((prev) => ({ ...prev, businessLine: value }));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LINE_FROM_CATALOG}>
                    {selectedCatalog?.businessLine
                      ? `按种类：${WORK_ORDER_BUSINESS_LINE_LABELS[selectedCatalog.businessLine]}`
                      : '不选'}
                  </SelectItem>
                  {(
                    Object.keys(WORK_ORDER_BUSINESS_LINE_LABELS) as WorkOrderBusinessLine[]
                  ).map((line: WorkOrderBusinessLine) => (
                    <SelectItem key={line} value={line}>
                      {WORK_ORDER_BUSINESS_LINE_LABELS[line]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">工单标题</p>
              <Input
                value={createForm.title}
                onChange={(e) => {
                  setCreateForm((prev) => ({ ...prev, title: e.target.value }));
                }}
                placeholder="例如：蓝牙耳机验货发现屏幕划痕，需议价"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">
                备注（选填）
              </p>
              <Textarea
                rows={2}
                value={createForm.remark}
                onChange={(e) => {
                  setCreateForm((prev) => ({
                    ...prev,
                    remark: e.target.value,
                  }));
                }}
                placeholder="补充背景信息，例如供应商、订单号等"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">关联对象（选填）</p>
                {subjectDrafts.length < 10 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setSubjectDrafts((prev) => [...prev, { ...EMPTY_SUBJECT }])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    加一个
                  </Button>
                ) : null}
              </div>
              <div className="space-y-2">
                {subjectDrafts.map((draft: SubjectDraft, index: number) => (
                  <div key={index} className="flex items-center gap-2">
                    <Select
                      value={draft.kind}
                      onValueChange={(value: string) => {
                        setSubjectDrafts((prev) =>
                          prev.map((item, i) =>
                            i === index
                              ? { ...item, kind: value as WorkOrderSubjectKind }
                              : item,
                          ),
                        );
                      }}
                    >
                      <SelectTrigger className="w-28 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          Object.keys(WORK_ORDER_SUBJECT_KIND_LABELS) as WorkOrderSubjectKind[]
                        ).map((kind: WorkOrderSubjectKind) => (
                          <SelectItem key={kind} value={kind}>
                            {WORK_ORDER_SUBJECT_KIND_LABELS[kind]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={draft.name}
                      placeholder="名字"
                      onChange={(e) => {
                        const value = e.target.value;
                        setSubjectDrafts((prev) =>
                          prev.map((item, i) => (i === index ? { ...item, name: value } : item)),
                        );
                      }}
                    />
                    <Input
                      value={draft.ref}
                      placeholder="编号或链接"
                      onChange={(e) => {
                        const value = e.target.value;
                        setSubjectDrafts((prev) =>
                          prev.map((item, i) => (i === index ? { ...item, ref: value } : item)),
                        );
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      aria-label="去掉"
                      onClick={() =>
                        setSubjectDrafts((prev) => prev.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
              }}
              disabled={creating}
            >
              取消
            </Button>
            <Button onClick={submitCreate} disabled={creating}>
              创建工单
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
