import { useEffect } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateMyBinding } from '@client/src/api/my';
import type {
  BindingOptionsResponse,
  EmployeeBinding,
  EmployeeRole,
} from '@shared/api.interface';

const ROLES: Array<{ value: EmployeeRole; label: string }> = [
  { value: 'procurement', label: '采购' },
  { value: 'sales', label: '销售' },
  { value: 'warehouse', label: '仓库' },
  { value: 'general', label: '通用' },
  { value: 'admin', label: '管理员' },
];

const bindingSchema = z.object({
  planeMemberId: z.string().min(1, '请选择 Plane 成员'),
  role: z.enum(['procurement', 'sales', 'warehouse', 'general', 'admin']),
  frappeEmployeeId: z.string(),
});

type BindingFormData = z.infer<typeof bindingSchema>;

interface BindingSettingsFormProps {
  options: BindingOptionsResponse;
  binding: EmployeeBinding | null;
  onSaved: () => void;
}

export function BindingSettingsForm({
  options,
  binding,
  onSaved,
}: BindingSettingsFormProps) {
  const form = useForm<BindingFormData>({
    resolver: zodResolver(bindingSchema),
    defaultValues: {
      planeMemberId: binding?.planeMemberId ?? '',
      role: binding?.role ?? 'general',
      frappeEmployeeId: binding?.frappeEmployeeId ?? '',
    },
  });

  useEffect(() => {
    form.reset({
      planeMemberId: binding?.planeMemberId ?? '',
      role: binding?.role ?? 'general',
      frappeEmployeeId: binding?.frappeEmployeeId ?? '',
    });
  }, [binding, form]);

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      const saved = await updateMyBinding({
        planeMemberId: data.planeMemberId,
        role: data.role,
        frappeEmployeeId:
          data.frappeEmployeeId && data.frappeEmployeeId !== 'none'
            ? data.frappeEmployeeId
            : null,
      });
      toast.success(
        `已绑定 Plane 成员「${saved.planeMemberName ?? saved.planeMemberId}」`,
      );
      onSaved();
    } catch {
      toast.error('保存失败，请稍后重试');
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4">
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
                  <SelectTrigger>
                    <SelectValue placeholder="选择你的 Plane 成员身份" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {options.members.map((member) => (
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
        <div className="flex flex-wrap gap-4">
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  岗位 <span className="text-destructive">*</span>
                </FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="选择岗位" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
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
              <FormItem className="flex-1">
                <FormLabel>HR 员工（可选）</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="关联 Frappe HR 员工" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="none">不关联</SelectItem>
                    {options.employees.map((employee) => (
                      <SelectItem key={employee.id} value={employee.id}>
                        {employee.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          保存绑定
        </Button>
      </form>
    </Form>
  );
}
