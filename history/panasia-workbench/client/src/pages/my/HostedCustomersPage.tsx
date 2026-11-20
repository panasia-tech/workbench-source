import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import dayjs from 'dayjs';
import { CalendarDays, ChevronLeft, CircleAlert, Pencil, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { myApi } from '@client/src/api';
import type {
  CreateHostedCustomerRequest,
  HostedCustomerDimension,
  HostedCustomerInfo,
  HostedCustomerStatus,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';

type DimensionFilter = HostedCustomerDimension | 'all';

const DIMENSION_LABELS: Record<HostedCustomerDimension, string> = {
  enterprise_alipay: '企业支付宝',
  xianyu: '闲鱼',
  phone_card: '电话卡',
  other: '其他',
};

const DIMENSION_OPTIONS: HostedCustomerDimension[] = ['enterprise_alipay', 'xianyu', 'phone_card', 'other'];

const STATUS_LABELS: Record<HostedCustomerStatus, string> = {
  hosting: '托管中',
  paused: '暂停',
  returned: '已退回',
};

const STATUS_BADGE_CLASS: Record<HostedCustomerStatus, string> = {
  hosting: 'bg-emerald-100 text-emerald-700',
  paused: 'bg-amber-100 text-amber-700',
  returned: 'bg-secondary text-secondary-foreground',
};

const STATUS_OPTIONS: HostedCustomerStatus[] = ['hosting', 'paused', 'returned'];

/** 主邮箱必须是腾讯邮箱：运营商邮箱随号码停用有失效风险 */
const TENCENT_MAIL_PATTERN = /@(qq\.com|foxmail\.com)$/u;

const LEGAL_INFO_EXPLAIN =
  '外部电话卡非法人本人持有，有注销风险；运营商邮箱也会随号码停用而失效。企业支付宝绑定、工商局登记等关键实名操作，必须落在法人本人的主设备（手机）与主邮箱上，账号资产才长期可控。';

const EMPTY_FORM: CustomerFormState = {
  customerName: '',
  dimension: '',
  contactName: '',
  contactPhone: '',
  legalPersonName: '',
  mainDevicePhone: '',
  mainEmail: '',
  content: '',
  status: 'hosting',
  startedAt: '',
  remark: '',
};

interface CustomerFormState {
  customerName: string;
  dimension: HostedCustomerDimension | '';
  contactName: string;
  contactPhone: string;
  legalPersonName: string;
  mainDevicePhone: string;
  mainEmail: string;
  content: string;
  status: HostedCustomerStatus;
  startedAt: string;
  remark: string;
}

const HostedCustomersPage = () => {
  const [items, setItems] = useState<HostedCustomerInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimension, setDimension] = useState<DimensionFilter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const load = useCallback((d: DimensionFilter): void => {
    setLoading(true);
    myApi
      .fetchHostedCustomers(d === 'all' ? undefined : d)
      .then((response) => {
        setItems(response.items);
        setError(null);
      })
      .catch(() => {
        setError('托管客户档案加载失败，请稍后重试');
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load(dimension);
  }, [dimension, load]);

  const openCreate = (): void => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (item: HostedCustomerInfo): void => {
    setEditingId(item.id);
    setForm({
      customerName: item.customerName,
      dimension: item.dimension,
      contactName: item.contactName ?? '',
      contactPhone: item.contactPhone ?? '',
      legalPersonName: item.legalPersonName ?? '',
      mainDevicePhone: item.mainDevicePhone ?? '',
      mainEmail: item.mainEmail ?? '',
      content: item.content ?? '',
      status: item.status,
      startedAt: item.startedAt ?? '',
      remark: item.remark ?? '',
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (form.customerName.trim() === '') {
      toast.error('请填写客户名');
      return;
    }
    if (form.dimension === '') {
      toast.error('请选择维度');
      return;
    }
    const mainEmail = form.mainEmail.trim();
    if (mainEmail !== '' && !TENCENT_MAIL_PATTERN.test(mainEmail)) {
      toast.error(
        '主邮箱请使用腾讯邮箱（@qq.com / @foxmail.com），运营商邮箱有停用风险',
      );
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const body: UpdateHostedCustomerRequest = {
          customerName: form.customerName.trim(),
          dimension: form.dimension,
          contactName: form.contactName.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          legalPersonName: form.legalPersonName.trim() || null,
          mainDevicePhone: form.mainDevicePhone.trim() || null,
          mainEmail: mainEmail || null,
          content: form.content.trim() || null,
          status: form.status,
          startedAt: form.startedAt || null,
          remark: form.remark.trim() || null,
        };
        await myApi.updateHostedCustomer(editingId, body);
        toast.success('档案已更新');
      } else {
        const body: CreateHostedCustomerRequest = {
          customerName: form.customerName.trim(),
          dimension: form.dimension,
          contactName: form.contactName.trim() || undefined,
          contactPhone: form.contactPhone.trim() || undefined,
          legalPersonName: form.legalPersonName.trim() || undefined,
          mainDevicePhone: form.mainDevicePhone.trim() || undefined,
          mainEmail: mainEmail || undefined,
          content: form.content.trim() || undefined,
          status: form.status,
          startedAt: form.startedAt || undefined,
          remark: form.remark.trim() || undefined,
        };
        await myApi.createHostedCustomer(body);
        toast.success('档案已创建');
      }
      setDialogOpen(false);
      load(dimension);
    } catch (err: unknown) {
      const shaped = err as { response?: { data?: { message?: unknown } } };
      const msg = shaped.response?.data?.message;
      toast.error(
        typeof msg === 'string' && msg !== ''
          ? msg
          : editingId
            ? '保存失败，请稍后重试'
            : '创建失败，请稍后重试',
      );
    } finally {
      setSaving(false);
    }
  };

  const renderField = (
    label: string,
    required: boolean,
    control: React.ReactNode,
  ): React.ReactNode => (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </label>
      {control}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/my"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold">托管客户管理</h1>
          <p className="text-xs text-muted-foreground">
            按维度登记我负责的托管客户档案，一人一份
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(['all', ...DIMENSION_OPTIONS] as DimensionFilter[]).map(
            (d: DimensionFilter) => (
              <button
                key={d}
                type="button"
                onClick={() => setDimension(d)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  dimension === d
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:text-foreground'
                }`}
              >
                {d === 'all' ? '全部' : DIMENSION_LABELS[d]}
              </button>
            ),
          )}
        </div>
        <Button data-ai-section-type="button" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建档案
        </Button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {loading ? (
        <div data-ai-section-type="card-list" className="space-y-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : !items || items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无托管客户档案
          <p className="mt-1 text-xs">
            点击右上角「新建档案」，登记企业支付宝、闲鱼、电话卡等维度的托管客户
          </p>
        </div>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-4">
          {items.map((item: HostedCustomerInfo) => (
            <Card key={item.id} className="rounded-xl transition-colors hover:border-primary/40">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold break-words">
                        {item.customerName}
                      </p>
                      <Badge className="bg-blue-500/10 text-blue-600">
                        {DIMENSION_LABELS[item.dimension]}
                      </Badge>
                      <Badge className={STATUS_BADGE_CLASS[item.status]}>
                        {STATUS_LABELS[item.status]}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {[
                        item.contactName,
                        item.contactPhone,
                        item.startedAt
                          ? `托管开始 ${dayjs(item.startedAt).format('YYYY-MM-DD')}`
                          : null,
                      ]
                        .filter((v: string | null): v is string => v != null && v !== '')
                        .join(' · ')}
                    </p>
                    {item.legalPersonName || item.mainDevicePhone || item.mainEmail ? (
                      <p className="break-words text-xs text-muted-foreground">
                        {[
                          item.legalPersonName
                            ? `法人 ${item.legalPersonName}`
                            : null,
                          item.mainDevicePhone
                            ? `主设备 ${item.mainDevicePhone}`
                            : null,
                          item.mainEmail ? `主邮箱 ${item.mainEmail}` : null,
                        ]
                          .filter((v: string | null): v is string => v != null)
                          .join(' · ')}
                      </p>
                    ) : null}
                    {item.content ? (
                      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                        托管内容：{item.content}
                      </p>
                    ) : null}
                    {item.remark ? (
                      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        备注：{item.remark}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(item)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    编辑
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑档案' : '新建档案'}</DialogTitle>
            <DialogDescription>
              托管客户档案仅你本人可见，请如实登记客户信息。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {renderField(
              '客户名',
              true,
              <Input
                value={form.customerName}
                placeholder="请输入客户名"
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setForm((prev) => ({ ...prev, customerName: e.target.value }))
                }
              />,
            )}
            {renderField(
              '维度',
              true,
              <Select
                value={form.dimension}
                onValueChange={(v: string) =>
                  setForm((prev) => ({
                    ...prev,
                    dimension: v as HostedCustomerDimension,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="请选择维度" />
                </SelectTrigger>
                <SelectContent>
                  {DIMENSION_OPTIONS.map((d: HostedCustomerDimension) => (
                    <SelectItem key={d} value={d}>
                      {DIMENSION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {renderField(
                '联系人',
                false,
                <Input
                  value={form.contactName}
                  placeholder="请输入联系人"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm((prev) => ({
                      ...prev,
                      contactName: e.target.value,
                    }))
                  }
                />,
              )}
              {renderField(
                '联系方式',
                false,
                <Input
                  value={form.contactPhone}
                  placeholder="请输入联系方式"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm((prev) => ({
                      ...prev,
                      contactPhone: e.target.value,
                    }))
                  }
                />,
              )}
            </div>
            <div className="space-y-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
              <p className="text-xs font-semibold text-blue-700">
                为什么要用法人的主设备与主邮箱？
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {LEGAL_INFO_EXPLAIN}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {renderField(
                '法人姓名',
                false,
                <Input
                  value={form.legalPersonName}
                  placeholder="托管客户企业的法定代表人"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm((prev) => ({
                      ...prev,
                      legalPersonName: e.target.value,
                    }))
                  }
                />,
              )}
              {renderField(
                '法人主设备手机号',
                false,
                <Input
                  value={form.mainDevicePhone}
                  placeholder="法人本人实名手机，用于企业支付宝绑定等"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm((prev) => ({
                      ...prev,
                      mainDevicePhone: e.target.value,
                    }))
                  }
                />,
              )}
            </div>
            {renderField(
              '主邮箱（腾讯邮箱）',
              false,
              <div className="space-y-1">
                <Input
                  value={form.mainEmail}
                  placeholder="例如 15f454a732@example.invalid"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setForm((prev) => ({
                      ...prev,
                      mainEmail: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  请使用腾讯邮箱（@qq.com / @foxmail.com），用于工商局登记等政务通知；运营商邮箱随号码停用有失效风险
                </p>
              </div>,
            )}
            {renderField(
              '托管内容',
              false,
              <Textarea
                value={form.content}
                rows={3}
                placeholder="托管了什么，例如店铺、账号、卡号等"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setForm((prev) => ({ ...prev, content: e.target.value }))
                }
              />,
            )}
            {renderField(
              '状态',
              false,
              <Select
                value={form.status}
                onValueChange={(v: string) =>
                  setForm((prev) => ({
                    ...prev,
                    status: v as HostedCustomerStatus,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="请选择状态" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s: HostedCustomerStatus) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
            {renderField(
              '开始日期',
              false,
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start font-normal">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    {form.startedAt || '请选择托管开始日期'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={
                      form.startedAt
                        ? new Date(`${form.startedAt}T00:00:00`)
                        : undefined
                    }
                    onSelect={(d: Date | undefined) => {
                      if (!d) return;
                      setForm((prev) => ({
                        ...prev,
                        startedAt: dayjs(d).format('YYYY-MM-DD'),
                      }));
                      setCalendarOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>,
            )}
            {renderField(
              '备注',
              false,
              <Textarea
                value={form.remark}
                rows={2}
                placeholder="其他需要说明的信息"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setForm((prev) => ({ ...prev, remark: e.target.value }))
                }
              />,
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              data-ai-section-type="button"
              disabled={saving}
              onClick={() => void handleSubmit()}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default HostedCustomersPage;
