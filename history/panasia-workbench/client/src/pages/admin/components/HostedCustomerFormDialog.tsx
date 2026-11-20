import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { CircleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  HostedCustomerDimension,
  HostedCustomerInfo,
  HostedCustomerStatus,
} from '@shared/api.interface';

export const DIMENSION_LABELS: Record<HostedCustomerDimension, string> = {
  enterprise_alipay: '企业支付宝',
  xianyu: '闲鱼',
  phone_card: '电话卡',
  other: '其他',
};

export const STATUS_LABELS: Record<HostedCustomerStatus, string> = {
  hosting: '托管中',
  paused: '已暂停',
  returned: '已归还',
};

/** 主邮箱必须是腾讯邮箱：运营商邮箱随号码停用有失效风险 */
const TENCENT_MAIL_PATTERN = /@(qq\.com|foxmail\.com)$/u;

const LEGAL_INFO_EXPLAIN =
  '外部电话卡非法人本人持有，有注销风险；运营商邮箱也会随号码停用而失效。企业支付宝绑定、工商局登记等关键实名操作，必须落在法人本人的主设备（手机）与主邮箱上，账号资产才长期可控。';

export interface EmployeeOption {
  userId: string;
  name: string;
}

export interface HostedCustomerFormState {
  customerName: string;
  dimension: HostedCustomerDimension;
  contactName: string;
  contactPhone: string;
  legalPersonName: string;
  mainDevicePhone: string;
  mainEmail: string;
  content: string;
  status: HostedCustomerStatus;
  ownerUserId: string;
  startedAt: string;
  remark: string;
}

export const EMPTY_FORM: HostedCustomerFormState = {
  customerName: '',
  dimension: 'enterprise_alipay',
  contactName: '',
  contactPhone: '',
  legalPersonName: '',
  mainDevicePhone: '',
  mainEmail: '',
  content: '',
  status: 'hosting',
  ownerUserId: '',
  startedAt: '',
  remark: '',
};

export const formFromItem = (
  item: HostedCustomerInfo,
): HostedCustomerFormState => ({
  customerName: item.customerName,
  dimension: item.dimension,
  contactName: item.contactName ?? '',
  contactPhone: item.contactPhone ?? '',
  legalPersonName: item.legalPersonName ?? '',
  mainDevicePhone: item.mainDevicePhone ?? '',
  mainEmail: item.mainEmail ?? '',
  content: item.content ?? '',
  status: item.status,
  ownerUserId: item.ownerUserId,
  startedAt: item.startedAt !== null ? item.startedAt.slice(0, 10) : '',
  remark: item.remark ?? '',
});

export const trimOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

interface HostedCustomerFormDialogProps {
  mode: 'create' | 'edit';
  initial: HostedCustomerFormState;
  employees: EmployeeOption[];
  submitting: boolean;
  onSubmit: (form: HostedCustomerFormState) => void;
  onOpenChange: (open: boolean) => void;
}

/** 托管客户新建 / 编辑弹窗表单 */
const HostedCustomerFormDialog: React.FC<HostedCustomerFormDialogProps> = ({
  mode,
  initial,
  employees,
  submitting,
  onSubmit,
  onOpenChange,
}) => {
  const [form, setForm] = useState<HostedCustomerFormState>(initial);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const handleConfirm = (): void => {
    if (form.customerName.trim() === '') {
      toast.error('请填写客户名');
      return;
    }
    if (form.ownerUserId === '') {
      toast.error('请选择负责员工');
      return;
    }
    const startedAt = form.startedAt.trim();
    if (startedAt !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(startedAt)) {
      toast.error('开始日期格式应为 YYYY-MM-DD');
      return;
    }
    const mainEmail = form.mainEmail.trim();
    if (mainEmail !== '' && !TENCENT_MAIL_PATTERN.test(mainEmail)) {
      toast.error(
        '主邮箱请使用腾讯邮箱（@qq.com / @foxmail.com），运营商邮箱有停用风险',
      );
      return;
    }
    onSubmit(form);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? '新建托管客户档案' : '编辑托管客户档案'}
          </DialogTitle>
          <DialogDescription>
            托管客户按维度管理，可指派负责员工跟进。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-name"
            >
              客户名
            </label>
            <Input
              id="hosted-customer-name"
              value={form.customerName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setForm((prev) => ({ ...prev, customerName: e.target.value }))
              }
              placeholder="客户 / 商户名称"
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">维度</label>
            <Select
              value={form.dimension}
              onValueChange={(value: string) =>
                setForm((prev) => ({
                  ...prev,
                  dimension: value as HostedCustomerDimension,
                }))
              }
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(DIMENSION_LABELS) as HostedCustomerDimension[]
                ).map((key: HostedCustomerDimension) => (
                  <SelectItem key={key} value={key}>
                    {DIMENSION_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">状态</label>
            <Select
              value={form.status}
              onValueChange={(value: string) =>
                setForm((prev) => ({
                  ...prev,
                  status: value as HostedCustomerStatus,
                }))
              }
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STATUS_LABELS) as HostedCustomerStatus[]).map(
                  (key: HostedCustomerStatus) => (
                    <SelectItem key={key} value={key}>
                      {STATUS_LABELS[key]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-owner"
            >
              负责员工
            </label>
            <Select
              value={form.ownerUserId}
              onValueChange={(value: string) =>
                setForm((prev) => ({ ...prev, ownerUserId: value }))
              }
              disabled={submitting}
            >
              <SelectTrigger id="hosted-customer-owner">
                <SelectValue placeholder="选择负责员工" />
              </SelectTrigger>
              <SelectContent>
                {employees.map((employee: EmployeeOption) => (
                  <SelectItem key={employee.userId} value={employee.userId}>
                    {employee.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-blue-700">
              <CircleAlert className="h-3.5 w-3.5" />
              为什么要用法人的主设备与主邮箱？
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {LEGAL_INFO_EXPLAIN}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="hosted-customer-legal-name"
              >
                法人姓名
              </label>
              <Input
                id="hosted-customer-legal-name"
                value={form.legalPersonName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setForm((prev) => ({ ...prev, legalPersonName: e.target.value }))
                }
                placeholder="法定代表人（选填）"
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="hosted-customer-main-device"
              >
                法人主设备手机号
              </label>
              <Input
                id="hosted-customer-main-device"
                value={form.mainDevicePhone}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setForm((prev) => ({ ...prev, mainDevicePhone: e.target.value }))
                }
                placeholder="法人本人实名手机（选填）"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-main-email"
            >
              主邮箱（腾讯邮箱）
            </label>
            <Input
              id="hosted-customer-main-email"
              value={form.mainEmail}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setForm((prev) => ({ ...prev, mainEmail: e.target.value }))
              }
              placeholder="例如 15f454a732@example.invalid（选填）"
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              请使用腾讯邮箱（@qq.com / @foxmail.com），用于工商局登记等政务通知；运营商邮箱随号码停用有失效风险
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="hosted-customer-contact"
              >
                联系人
              </label>
              <Input
                id="hosted-customer-contact"
                value={form.contactName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setForm((prev) => ({ ...prev, contactName: e.target.value }))
                }
                placeholder="选填"
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="hosted-customer-phone"
              >
                联系方式
              </label>
              <Input
                id="hosted-customer-phone"
                value={form.contactPhone}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setForm((prev) => ({ ...prev, contactPhone: e.target.value }))
                }
                placeholder="选填"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-started"
            >
              开始日期
            </label>
            <Input
              id="hosted-customer-started"
              value={form.startedAt}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setForm((prev) => ({ ...prev, startedAt: e.target.value }))
              }
              placeholder="YYYY-MM-DD（选填）"
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-content"
            >
              托管内容
            </label>
            <Textarea
              id="hosted-customer-content"
              value={form.content}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setForm((prev) => ({ ...prev, content: e.target.value }))
              }
              placeholder="例如：店铺账号、资产明细（选填）"
              rows={3}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="hosted-customer-remark"
            >
              备注
            </label>
            <Textarea
              id="hosted-customer-remark"
              value={form.remark}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setForm((prev) => ({ ...prev, remark: e.target.value }))
              }
              placeholder="选填"
              rows={2}
              disabled={submitting}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中
              </span>
            ) : (
              '保存'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default HostedCustomerFormDialog;
