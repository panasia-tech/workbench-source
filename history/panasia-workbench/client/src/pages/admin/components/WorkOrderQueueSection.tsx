import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  type TableColumnsType,
} from '@lark-apaas/client-toolkit/antd-table';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  deleteAdminWorkOrderDraft,
  getAdminConfig,
  getAdminEmployees,
  listAdminWorkOrderDrafts,
  listAdminWorkOrderQueue,
  publishAdminWorkOrderDraft,
} from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  formatDueAt,
  WORK_ORDER_BUSINESS_LINE_LABELS,
  WORK_ORDER_STATUS_LABELS,
  WORK_ORDER_TYPE_LABELS,
  workOrderBadge,
} from '@client/src/pages/tasks/workorder-status';
import type {
  AdminEmployeeBindingRow,
  AdminExecuteTaskRow,
  AdminWorkOrderDraftRow,
  AdminWorkOrderQueueRow,
} from '@shared/api.interface';

interface WorkOrderQueueSectionProps {
  tasks: AdminExecuteTaskRow[];
}

type LoadLevel = 'light' | 'medium' | 'heavy';

const LEVEL_LABELS: Record<LoadLevel, string> = {
  light: '今日负载较轻',
  medium: '今日任务较多',
  heavy: '今日任务繁重',
};

const LEVEL_BADGE_CLASS: Record<LoadLevel, string> = {
  light: 'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  heavy: 'bg-red-100 text-red-700',
};

function formatDateTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** SLA 时长展示：≥24h 用天，否则用小时（向上取整到 1） */
function formatSlaDuration(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 24) {
    return `${Math.round(hours / 24)} 天`;
  }
  return `${Math.max(1, Math.round(hours))} 小时`;
}

function renderSlaCell(row: AdminWorkOrderQueueRow): React.ReactNode {
  if (!row.slaDeadline) {
    return <span className="text-muted-foreground">—</span>;
  }
  const remainMs = Date.parse(row.slaDeadline) - Date.now();
  if (row.slaOverdue) {
    return (
      <span className="font-medium text-destructive">
        已超时 {formatSlaDuration(Math.max(0, -remainMs))}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      剩余 {formatSlaDuration(remainMs)}
    </span>
  );
}

/** 管理端执行 Dock：工单发单 + 草稿箱 + 执行队列 */
const WorkOrderQueueSection: React.FC<WorkOrderQueueSectionProps> = ({
  tasks,
}) => {
  const [drafts, setDrafts] = useState<AdminWorkOrderDraftRow[]>([]);
  const [queue, setQueue] = useState<AdminWorkOrderQueueRow[]>([]);
  const [employees, setEmployees] = useState<AdminEmployeeBindingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatchChatUrl, setDispatchChatUrl] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [deletingDraft, setDeletingDraft] =
    useState<AdminWorkOrderDraftRow | null>(null);

  const loadAll = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [draftsRes, queueRes, employeesRes, configRes] = await Promise.all([
        listAdminWorkOrderDrafts(),
        listAdminWorkOrderQueue(),
        getAdminEmployees().catch(() => ({ items: [] as AdminEmployeeBindingRow[] })),
        getAdminConfig().catch(() => ({ items: [] as { configKey: string; configValue: Record<string, unknown> }[] })),
      ]);
      setDrafts(draftsRes.items);
      setQueue(queueRes.items);
      setEmployees(employeesRes.items);
      const dispatchConfig = configRes.items.find(
        (item: { configKey: string; configValue: Record<string, unknown> }) =>
          item.configKey === 'workorder.dispatch_agent',
      );
      const chatUrl = dispatchConfig?.configValue?.chat_url;
      setDispatchChatUrl(typeof chatUrl === 'string' && chatUrl ? chatUrl : null);
    } catch (err) {
      logger.error('加载工单草稿箱/队列失败', err);
      setError(err instanceof Error ? err.message : '加载工单队列失败');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [loadAll]);

  const employeeMemberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of employees) {
      if (row.miaodaUserId && row.planeMemberName) {
        map.set(row.miaodaUserId, row.planeMemberName);
      }
    }
    return map;
  }, [employees]);

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
        new Date(),
      ),
    [],
  );

  const loadLevel = useCallback(
    (draft: AdminWorkOrderDraftRow): LoadLevel => {
      const memberName = draft.assigneeId
        ? employeeMemberNames.get(draft.assigneeId)
        : undefined;
      const todayOpenTasks = memberName
        ? tasks.filter(
            (task: AdminExecuteTaskRow) =>
              task.assigneeName === memberName &&
              task.targetDate === today &&
              task.stateGroup !== 'completed' &&
              task.stateGroup !== 'cancelled',
          ).length
        : 0;
      if (todayOpenTasks >= 5) return 'heavy';
      if (todayOpenTasks >= 3) return 'medium';
      return 'light';
    },
    [employeeMemberNames, tasks, today],
  );

  const handlePublish = useCallback(
    async (draft: AdminWorkOrderDraftRow): Promise<void> => {
      setPublishingId(draft.id);
      try {
        await publishAdminWorkOrderDraft(draft.id);
        toast.success(`工单 ${draft.code} 已发布，进入执行队列`);
        await loadAll();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '发布工单失败');
      } finally {
        setPublishingId(null);
      }
    },
    [loadAll],
  );

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!deletingDraft) return;
    try {
      await deleteAdminWorkOrderDraft(deletingDraft.id);
      toast.success(`草稿 ${deletingDraft.code} 已删除`);
      setDeletingDraft(null);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除草稿失败');
    }
  }, [deletingDraft, loadAll]);

  // 豆包发单助手是可选集成：没配聊天链接就不显示「去豆包发单」
  const handleOpenDispatch = useCallback((): void => {
    if (dispatchChatUrl) {
      window.open(dispatchChatUrl, '_blank', 'noopener,noreferrer');
    }
  }, [dispatchChatUrl]);

  const queueColumns: TableColumnsType<AdminWorkOrderQueueRow> = [
    { title: '编号', dataIndex: 'code', width: 120 },
    {
      title: '标题',
      dataIndex: 'title',
      width: 220,
      ellipsis: true,
      render: (title: string, record: AdminWorkOrderQueueRow) => (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{title}</span>
          {record.source === 'mcp' ? (
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              豆包
            </span>
          ) : null}
        </span>
      ),
    },
    {
      title: '种类',
      dataIndex: 'orderType',
      width: 90,
      render: (type: AdminWorkOrderQueueRow['orderType']) =>
        WORK_ORDER_TYPE_LABELS[type] ?? type,
    },
    {
      title: '业务线',
      dataIndex: 'businessLine',
      width: 90,
      render: (line: AdminWorkOrderQueueRow['businessLine']) =>
        line ? WORK_ORDER_BUSINESS_LINE_LABELS[line] : '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: AdminWorkOrderQueueRow['status']) => (
        <span className={workOrderBadge(status)}>
          {WORK_ORDER_STATUS_LABELS[status] ?? status}
        </span>
      ),
    },
    {
      title: '指派',
      dataIndex: 'assigneeName',
      width: 100,
      render: (name: string | null) => name ?? '—',
    },
    {
      title: '截止',
      dataIndex: 'dueAt',
      width: 110,
      render: (dueAt: string | null, record: AdminWorkOrderQueueRow) => {
        if (!dueAt) return <span className="text-muted-foreground">—</span>;
        const overdue =
          Date.parse(dueAt) < Date.now() &&
          !['approved', 'refused', 'rejected'].includes(record.status);
        return (
          <span className={overdue ? 'font-medium text-destructive' : undefined}>
            {formatDueAt(dueAt)}
          </span>
        );
      },
    },
    {
      title: 'SLA',
      dataIndex: 'slaDeadline',
      width: 110,
      render: (
        _value: string | null,
        record: AdminWorkOrderQueueRow,
      ) => renderSlaCell(record),
    },
    {
      title: '发布时间',
      dataIndex: 'createdAt',
      width: 140,
      render: (iso: string) => formatDateTime(iso),
    },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Inbox className="h-5 w-5 text-primary" />
            工单发单与队列
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {dispatchChatUrl
              ? '发单由豆包工作伙伴里的发单助手承接：要素齐全直接发布进队列，需暂缓可让助手存草稿箱。'
              : '草稿箱与执行队列。'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              loadAll().finally(() => setLoading(false));
            }}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          {dispatchChatUrl && (
            <Button size="sm" onClick={handleOpenDispatch}>
              <Bot className="h-4 w-4" />
              去豆包发单
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center rounded-xl border p-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载工单数据中…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                草稿箱
                <Badge variant="secondary" className="ml-2">
                  {drafts.length}
                </Badge>
              </h3>
              <span className="text-xs text-muted-foreground">
                草稿对员工不可见
              </span>
            </div>

            {drafts.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                草稿箱为空。发单时向发单助手说明「先存草稿箱」即可暂存
              </p>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {drafts.map((draft: AdminWorkOrderDraftRow) => {
                  const level = loadLevel(draft);
                  return (
                    <div
                      key={draft.id}
                      className="flex flex-col gap-3 rounded-xl border bg-background p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {draft.title}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">{draft.code}</span>
                            <span>{draft.catalogName ?? draft.catalogCode}</span>
                            <span>
                              <FileText className="mr-0.5 inline h-3 w-3" />
                              在途工单 {draft.activeWorkOrders} 个
                            </span>
                          </p>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${LEVEL_BADGE_CLASS[level]}`}
                        >
                          {LEVEL_LABELS[level]}
                        </span>
                      </div>

                      {draft.remark ? (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {draft.remark}
                        </p>
                      ) : null}

                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-muted-foreground">
                          指派：{draft.assigneeName ?? '未指派'} · 存于{' '}
                          {formatDateTime(draft.createdAt)}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handlePublish(draft)}
                            disabled={publishingId !== null}
                          >
                            {publishingId === draft.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Send className="h-4 w-4" />
                            )}
                            发布
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDeletingDraft(draft)}
                          >
                            <Trash2 className="h-4 w-4" />
                            删除
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-xl border bg-card p-5">
            <h3 className="text-sm font-semibold">
              执行队列
              <Badge variant="secondary" className="ml-2">
                {queue.length}
              </Badge>
            </h3>
            {queue.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                暂无执行中的工单
              </p>
            ) : (
              <Table<AdminWorkOrderQueueRow>
                columns={queueColumns}
                dataSource={queue}
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ x: 1090 }}
              />
            )}
          </div>
        </div>
      )}

      <AlertDialog
        open={deletingDraft !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDeletingDraft(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条草稿工单？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deletingDraft?.title}」尚未发布给员工，删除后不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                void handleDelete();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};

export default WorkOrderQueueSection;
