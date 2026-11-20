import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableColumnsType,
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  deleteAdminCatalog,
  getAdminCatalog,
  updateAdminCatalog,
} from '@client/src/api/admin';
import type {
  WorkOrderCatalogItem,
  WorkOrderComplexity,
  WorkOrderType,
} from '@shared/api.interface';
import CatalogDialog from './CatalogDialog';

const ORDER_TYPE_LABELS: Record<WorkOrderType, string> = {
  purchase: '采购',
  sales: '销售',
  special_delegation: '特殊委派',
  other: '其他',
};

const COMPLEXITY_LABELS: Record<WorkOrderComplexity, string> = {
  simple: '简单',
  medium: '中等',
  complex: '复杂',
};

const CatalogTab: React.FC = () => {
  const [items, setItems] = useState<WorkOrderCatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkOrderCatalogItem | null>(null);
  const [deleting, setDeleting] = useState<WorkOrderCatalogItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await getAdminCatalog();
      setItems(response.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取工单目录失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleEnabled = (
    item: WorkOrderCatalogItem,
    next: boolean,
  ): void => {
    setItems((prev) =>
      (prev ?? []).map((row: WorkOrderCatalogItem) =>
        row.id === item.id ? { ...row, enabled: next } : row,
      ),
    );
    updateAdminCatalog(item.id, { enabled: next }).catch(
      (err: unknown): void => {
        setItems((prev) =>
          (prev ?? []).map((row: WorkOrderCatalogItem) =>
            row.id === item.id ? { ...row, enabled: !next } : row,
          ),
        );
        toast.error(err instanceof Error ? err.message : '切换启用状态失败');
      },
    );
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteAdminCatalog(deleting.id);
      toast.success('目录已删除');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除目录失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns: TableColumnsType<WorkOrderCatalogItem> = useMemo(
    () => [
      {
        title: '编码',
        dataIndex: 'code',
        width: 160,
        render: (code: string) => (
          <span className="font-mono text-sm">{code}</span>
        ),
      },
      { title: '名称', dataIndex: 'name', width: 160 },
      {
        title: '任务类型',
        dataIndex: 'orderType',
        width: 110,
        render: (value: WorkOrderType) => (
          <Badge variant="secondary">
            {ORDER_TYPE_LABELS[value] ?? value}
          </Badge>
        ),
      },
      {
        title: '复杂度',
        dataIndex: 'complexity',
        width: 90,
        render: (value: WorkOrderComplexity) => (
          <span>{COMPLEXITY_LABELS[value] ?? value}</span>
        ),
      },
      {
        title: '启用',
        dataIndex: 'enabled',
        width: 90,
        render: (_: unknown, record: WorkOrderCatalogItem) => (
          <Switch
            checked={record.enabled}
            onCheckedChange={(checked: boolean) =>
              handleToggleEnabled(record, checked)
            }
          />
        ),
      },
      { title: '排序', dataIndex: 'sort', width: 80 },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 150,
        render: (_: unknown, record: WorkOrderCatalogItem) => (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(record);
                setDialogOpen(true);
              }}
            >
              <Pencil className="h-4 w-4" />
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(record)}
            >
              <Trash2 className="h-4 w-4" />
              删除
            </Button>
          </div>
        ),
      },
    ],
    // handleToggleEnabled 引用 state setter，稳定；空数组避免每次渲染重建列
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (error !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (!items) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          新增目录
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          还没有工单目录，点右上角「新增目录」创建第一项。
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={items}
          rowKey="id"
          scroll={{ x: 900, y: 500 }}
          pagination={false}
        />
      )}

      <CatalogDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        onSaved={() => void load()}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除目录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleting?.name}」（{deleting?.code}）。已被工单引用的目录无法删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteBusy}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
            >
              {deleteBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                '删除'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CatalogTab;
