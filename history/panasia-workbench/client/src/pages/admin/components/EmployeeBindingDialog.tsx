import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  fetchAdminBindingOptions,
  upsertEmployeeBinding,
} from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminEmployeeBindingRow,
  BindingOption,
  BindingOptionsResponse,
  EmployeeRole,
  HrEmployee,
} from '@shared/api.interface';

const NO_HR_EMPLOYEE = 'none';

const ROLE_OPTIONS: { value: EmployeeRole; label: string }[] = [
  { value: 'procurement', label: '采购' },
  { value: 'sales', label: '销售' },
  { value: 'warehouse', label: '仓储' },
  { value: 'general', label: '通用' },
  { value: 'admin', label: '管理员' },
];

const bindingSchema = z.object({
  miaodaUserId: z.string().trim().min(1, '请输入工作台用户 ID'),
  planeMemberId: z.string().min(1, '请选择 Plane 成员'),
  role: z.enum(['procurement', 'sales', 'warehouse', 'general', 'admin']),
  frappeEmployeeId: z.string(),
});

type EmployeeBindingFormData = z.infer<typeof bindingSchema>;

/** 从「待绑定」点进来：用户 ID 已知，不用手填 */
export interface EmployeeBindingPreset {
  miaodaUserId: string;
  userName: string | null;
}

interface EmployeeBindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  initial: AdminEmployeeBindingRow | null;
  /** 新建时预填的员工（initial 为 null 时才用） */
  preset?: EmployeeBindingPreset | null;
  onSaved: () => void;
}

/** 管理端代管新建/编辑员工绑定（Plane 成员 + 角色 + 可选 HR 雇员） */
const EmployeeBindingDialog: React.FC<EmployeeBindingDialogProps> = ({
  open,
  onOpenChange,
  initial,
  preset = null,
  onSaved,
}) => {
  const lockedUser: EmployeeBindingPreset | null = initial
    ? { miaodaUserId: initial.miaodaUserId, userName: initial.userName }
    : preset;
  const [options, setOptions] = useState<BindingOptionsResponse | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);

  const form = useForm<EmployeeBindingFormData>({
    resolver: zodResolver(bindingSchema),
    defaultValues: {
      miaodaUserId: '',
      planeMemberId: '',
      role: 'general',
      frappeEmployeeId: NO_HR_EMPLOYEE,
    },
  });

  useEffect(() => {
    if (!open) return;
    const initialRole =
      ROLE_OPTIONS.find(
        (option) => option.value === initial?.role,
      )?.value ?? 'general';
    form.reset({
      miaodaUserId: initial?.miaodaUserId ?? preset?.miaodaUserId ?? '',
      planeMemberId: initial?.planeMemberId ?? '',
      role: initialRole,
      frappeEmployeeId: initial?.frappeEmployeeId ?? NO_HR_EMPLOYEE,
    });
    setOptionsLoading(true);
    fetchAdminBindingOptions()
      .then((response) => setOptions(response))
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '获取绑定选项失败',
        );
        logger.error('获取绑定选项失败', err);
      })
      .finally(() => setOptionsLoading(false));
  }, [open, initial, preset, form]);

  const members: BindingOption[] = options?.members ?? [];
  const employees: HrEmployee[] = options?.employees ?? [];

  const onSubmit = form.handleSubmit(async (data) => {
    const member = members.find(
      (m: BindingOption) => m.planeMemberId === data.planeMemberId,
    );
    try {
      await upsertEmployeeBinding({
        miaodaUserId: data.miaodaUserId,
        planeMemberId: data.planeMemberId,
        planeMemberName: member?.planeMemberName ?? '',
        role: data.role,
        frappeEmployeeId:
          data.frappeEmployeeId === NO_HR_EMPLOYEE
            ? null
            : data.frappeEmployeeId,
      });
      toast.success(initial ? '员工绑定已更新' : '员工绑定已创建');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存员工绑定失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑员工绑定' : '新建员工绑定'}</DialogTitle>
          <DialogDescription>
            代管设置员工与 Plane 成员、岗位角色的映射关系，HR 雇员为可选。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            data-ai-section-type="card-list"
            onSubmit={onSubmit}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="miaodaUserId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    员工 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    {lockedUser ? (
                      <Input
                        value={
                          lockedUser.userName
                            ? `${lockedUser.userName}（${field.value}）`
                            : field.value
                        }
                        disabled
                      />
                    ) : (
                      <Input
                        placeholder="工作台用户 ID，即 ERP 员工 ID（保存后不可修改）"
                        value={field.value}
                        onChange={field.onChange}
                      />
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="planeMemberId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Plane 成员 <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger disabled={optionsLoading}>
                        <SelectValue
                          placeholder={
                            optionsLoading ? '加载成员选项…' : '选择 Plane 成员'
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {members.map((member: BindingOption) => (
                        <SelectItem
                          key={member.planeMemberId}
                          value={member.planeMemberId}
                        >
                          {member.planeMemberName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    岗位角色 <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="选择角色" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="frappeEmployeeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>HR 雇员（可选）</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger disabled={optionsLoading}>
                        <SelectValue
                          placeholder={
                            optionsLoading ? '加载雇员选项…' : '不绑定 HR 雇员'
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NO_HR_EMPLOYEE}>
                        不绑定 HR 雇员
                      </SelectItem>
                      {employees.map((employee: HrEmployee) => (
                        <SelectItem key={employee.id} value={employee.id}>
                          {employee.name}
                          {employee.designation
                            ? ` · ${employee.designation}`
                            : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button
            disabled={form.formState.isSubmitting || optionsLoading}
            onClick={() => void onSubmit()}
          >
            {form.formState.isSubmitting && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmployeeBindingDialog;
