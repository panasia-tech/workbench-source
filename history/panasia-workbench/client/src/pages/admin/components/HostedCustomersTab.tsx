import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Loader2,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  StickyNote,
  Trash2,
  User,
  UserCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createAdminHostedCustomer,
  deleteAdminHostedCustomer,
  fetchAdminHostedCustomers,
  getAdminEmployees,
  updateAdminHostedCustomer,
} from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminEmployeeBindingRow,
  CreateHostedCustomerRequest,
  HostedCustomerDimension,
  HostedCustomerInfo,
  HostedCustomerStatus,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';
import {
  DIMENSION_LABELS,
  EMPTY_FORM,
  EmployeeOption,
  HostedCustomerFormState,
  STATUS_LABELS,
  formFromItem,
  trimOrNull,
} from './HostedCustomerFormDialog';
import HostedCustomerFormDialog from './HostedCustomerFormDialog';

type DimensionFilter = 'all' | HostedCustomerDimension;
type StatusFilter = 'all' | HostedCustomerStatus;

const STATUS_BADGE_CLASS: Record<HostedCustomerStatus, string> = {
  hosting: 'border-green-500/40 bg-green-500/10 text-green-600',
  paused: 'border-amber-500/40 bg-amber-500/10 text-amber-600',
  returned: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

const DIMENSION_FILTER_OPTIONS: { key: DimensionFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'enterprise_alipay', label: '企业支付宝' },
  { key: 'xianyu', label: '闲鱼' },
  { key: 'phone_card', label: '电话卡' },
  { key: 'other', label: '其他' },
];

const STATUS_FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'hosting', label: '托管中' },
  { key: 'paused', label: '已暂停' },
  { key: 'returned', label: '已归还' },
];

const formatDate = (value: string | null): string => {
  if (value === null || value === '') return '—';
  return value.slice(0, 10);
};

interface HostedCustomerCardProps {
  item: HostedCustomerInfo;
  onEdit: (item: HostedCustomerInfo) => void;
  onDelete: (item: HostedCustomerInfo) => void;
}

const HostedCustomerCard: React.FC<HostedCustomerCardProps> = ({
  item,
  onEdit,
  onDelete,
}) => {
  return (
    <div className="space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-base font-semibold break-words">
          {item.customerName}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {DIMENSION_LABELS[item.dimension] ?? item.dimension}
          </Badge>
          <Badge
            variant="outline"
            className={`text-xs ${STATUS_BADGE_CLASS[item.status] ?? ''}`}
          >
            {STATUS_LABELS[item.status] ?? item.status}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <UserCheck className="h-3.5 w-3.5" />
          负责人 {item.ownerName ?? '未指派'}
        </span>
        <span className="flex items-center gap-1">
          <User className="h-3.5 w-3.5" />
          {item.contactName ?? '—'}
        </span>
        <span className="flex items-center gap-1">
          <Phone className="h-3.5 w-3.5" />
          {item.contactPhone ?? '—'}
        </span>
        <span className="flex items-center gap-1">
          <CalendarDays className="h-3.5 w-3.5" />
          开始 {formatDate(item.startedAt)}
        </span>
      </div>

      {(item.legalPersonName !== null && item.legalPersonName !== '') ||
        (item.mainDevicePhone !== null && item.mainDevicePhone !== '') ||
        (item.mainEmail !== null && item.mainEmail !== '') ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {item.legalPersonName !== null && item.legalPersonName !== '' && (
            <span>法人 {item.legalPersonName}</span>
          )}
          {item.mainDevicePhone !== null && item.mainDevicePhone !== '' && (
            <span>主设备 {item.mainDevicePhone}</span>
          )}
          {item.mainEmail !== null && item.mainEmail !== '' && (
            <span>主邮箱 {item.mainEmail}</span>
          )}
        </div>
      ) : null}

      {item.content !== null && item.content !== '' && (
        <div className="text-sm">
          <span className="text-xs text-muted-foreground">托管内容：</span>
          <span className="break-words">{item.content}</span>
        </div>
      )}

      {item.remark !== null && item.remark !== '' && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{item.remark}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={() => onEdit(item)}>
          <Pencil className="h-4 w-4" />
          编辑
        </Button>
        <Button size="sm" variant="destructive" onClick={() => onDelete(item)}>
          <Trash2 className="h-4 w-4" />
          删除
        </Button>
      </div>
    </div>
  );
};

/** 管理 Dock · 托管客户档案 Tab：按维度管理托管客户，可增删改并指派负责员工 */
const HostedCustomersTab: React.FC = () => {
  const [items, setItems] = useState<HostedCustomerInfo[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensionFilter, setDimensionFilter] =
    useState<DimensionFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [editing, setEditing] = useState<HostedCustomerInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<HostedCustomerInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminHostedCustomers();
      setItems(data.items);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '获取托管客户档案失败';
      setError(message);
      logger.error('托管客户档案列表加载失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    getAdminEmployees()
      .then((data) => {
        setEmployees(
          (data.items ?? []).map((row: AdminEmployeeBindingRow) => ({
            userId: row.miaodaUserId,
            name: row.userName ?? row.planeMemberName ?? row.miaodaUserId,
          })),
        );
      })
      .catch((err: unknown) => {
        logger.error('托管客户负责员工选项加载失败', err);
        toast.error('负责员工列表加载失败，请稍后重试');
      });
  }, [load]);

  const filtered = (items ?? []).filter(
    (item: HostedCustomerInfo) =>
      (dimensionFilter === 'all' || item.dimension === dimensionFilter) &&
      (statusFilter === 'all' || item.status === statusFilter),
  );

  const handleSubmit = (form: HostedCustomerFormState): void => {
    setSubmitting(true);
    if (creating) {
      const body: CreateHostedCustomerRequest = {
        customerName: form.customerName.trim(),
        dimension: form.dimension,
        status: form.status,
        ownerUserId: form.ownerUserId,
        contactName: trimOrNull(form.contactName) ?? undefined,
        contactPhone: trimOrNull(form.contactPhone) ?? undefined,
        legalPersonName: trimOrNull(form.legalPersonName) ?? undefined,
        mainDevicePhone: trimOrNull(form.mainDevicePhone) ?? undefined,
        mainEmail: trimOrNull(form.mainEmail) ?? undefined,
        content: trimOrNull(form.content) ?? undefined,
        startedAt: trimOrNull(form.startedAt) ?? undefined,
        remark: trimOrNull(form.remark) ?? undefined,
      };
      createAdminHostedCustomer(body)
        .then(() => {
          toast.success('托管客户档案已创建');
          setCreating(false);
          void load();
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : '创建托管客户档案失败',
          );
        })
        .finally(() => {
          setSubmitting(false);
        });
      return;
    }
    if (editing !== null) {
      const body: UpdateHostedCustomerRequest = {
        customerName: form.customerName.trim(),
        dimension: form.dimension,
        status: form.status,
        ownerUserId: form.ownerUserId,
        contactName: trimOrNull(form.contactName),
        contactPhone: trimOrNull(form.contactPhone),
        legalPersonName: trimOrNull(form.legalPersonName),
        mainDevicePhone: trimOrNull(form.mainDevicePhone),
        mainEmail: trimOrNull(form.mainEmail),
        content: trimOrNull(form.content),
        startedAt: trimOrNull(form.startedAt),
        remark: trimOrNull(form.remark),
      };
      updateAdminHostedCustomer(editing.id, body)
        .then(() => {
          toast.success('托管客户档案已更新');
          setEditing(null);
          void load();
        })
        .catch((err: unknown) => {
          toast.error(
            err instanceof Error ? err.message : '保存托管客户档案失败',
          );
        })
        .finally(() => {
          setSubmitting(false);
        });
    }
  };

  const handleDelete = (): void => {
    if (!deleting) return;
    const target = deleting;
    setSubmitting(true);
    deleteAdminHostedCustomer(target.id)
      .then(() => {
        toast.success(`已删除托管客户档案：${target.customerName}`);
        setDeleting(null);
        void load();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '删除托管客户档案失败',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const chipClass = (active: boolean): string =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      active
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-background text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {DIMENSION_FILTER_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={chipClass(dimensionFilter === option.key)}
              onClick={() => setDimensionFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          新建档案
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTER_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            className={chipClass(statusFilter === option.key)}
            onClick={() => setStatusFilter(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      )}

      {!loading && error !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>托管客户档案加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && error === null && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed py-8 text-center">
          <Users className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">暂无托管客户档案</p>
          <p className="text-xs text-muted-foreground">
            点击右上角「新建档案」添加企业支付宝、闲鱼、电话卡等维度的托管客户。
          </p>
        </div>
      )}

      {!loading && error === null && (
        <div data-ai-section-type="card-list" className="space-y-4">
          {filtered.map((item: HostedCustomerInfo) => (
            <HostedCustomerCard
              key={item.id}
              item={item}
              onEdit={(target: HostedCustomerInfo) => setEditing(target)}
              onDelete={(target: HostedCustomerInfo) => setDeleting(target)}
            />
          ))}
        </div>
      )}

      {creating && (
        <HostedCustomerFormDialog
          mode="create"
          initial={EMPTY_FORM}
          employees={employees}
          submitting={submitting}
          onSubmit={handleSubmit}
          onOpenChange={(open: boolean) => {
            if (!open) setCreating(false);
          }}
        />
      )}

      {editing !== null && (
        <HostedCustomerFormDialog
          mode="edit"
          initial={formFromItem(editing)}
          employees={employees}
          submitting={submitting}
          onSubmit={handleSubmit}
          onOpenChange={(open: boolean) => {
            if (!open) setEditing(null);
          }}
        />
      )}

      {deleting !== null && (
        <Dialog
          open
          onOpenChange={(open: boolean) => {
            if (!open) setDeleting(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除托管客户档案</DialogTitle>
              <DialogDescription>
                确认删除「{deleting.customerName}
                」的托管档案？删除后不可恢复。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleting(null)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={submitting}
              >
                {submitting ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    删除中
                  </span>
                ) : (
                  '确认删除'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default HostedCustomersTab;
