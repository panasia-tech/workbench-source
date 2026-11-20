import React, { useEffect } from 'react';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { createTaskTemplate, updateTaskTemplate } from '@client/src/api/admin';
import type {
  AdminEmployeeBindingRow,
  AdminExecuteProject,
  TaskTemplateSchedule,
  TaskTemplateSummary,
  TaskTemplateUpsertRequest,
} from '@shared/api.interface';

const NO_ASSIGNEE = 'none';

const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

const templateSchema = z
  .object({
    title: z.string().trim().min(1, '请输入模板标题'),
    templateType: z.enum(['daily', 'scheduled']),
    scheduleKind: z.enum(['every_day', 'workdays', 'weekly']),
    weekdays: z.array(z.number()),
    planeProjectId: z.string().min(1, '请选择所属项目'),
    assigneeMemberId: z.string(),
    description: z.string(),
    enabled: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.scheduleKind === 'weekly' && data.weekdays.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: '定时任务需指定每周几执行',
      });
    }
  });

type TaskTemplateFormData = z.infer<typeof templateSchema>;

interface TaskTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  initial: TaskTemplateSummary | null;
  projects: AdminExecuteProject[];
  employees: AdminEmployeeBindingRow[];
  onSaved: () => void;
}

/** 新建/编辑固定·定时任务模板（shadcn Dialog + Form） */
const TaskTemplateDialog: React.FC<TaskTemplateDialogProps> = ({
  open,
  onOpenChange,
  initial,
  projects,
  employees,
  onSaved,
}) => {
  const form = useForm<TaskTemplateFormData>({
    resolver: zodResolver(templateSchema),
    defaultValues: {
      title: '',
      templateType: 'daily',
      scheduleKind: 'every_day',
      weekdays: [],
      planeProjectId: '',
      assigneeMemberId: '',
      description: '',
      enabled: true,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      title: initial?.title ?? '',
      templateType: initial?.templateType ?? 'daily',
      scheduleKind: initial?.schedule.kind ?? 'every_day',
      weekdays: initial?.schedule.weekdays ?? [],
      planeProjectId: initial?.planeProjectId ?? '',
      assigneeMemberId: initial?.assigneeMemberId ?? '',
      description: '',
      enabled: initial?.enabled ?? true,
    });
  }, [open, initial, form]);

  const templateType = form.watch('templateType');
  const scheduleKind = form.watch('scheduleKind');

  // 类型联动：固定任务不提供「每周几」，被选中时回落到「每天」
  useEffect(() => {
    if (templateType === 'daily' && scheduleKind === 'weekly') {
      form.setValue('scheduleKind', 'every_day');
    }
  }, [templateType, scheduleKind, form]);

  const scheduleOptions: { value: TaskTemplateFormData['scheduleKind']; label: string }[] =
    templateType === 'scheduled'
      ? [
          { value: 'every_day', label: '每天' },
          { value: 'workdays', label: '工作日（周一至周五）' },
          { value: 'weekly', label: '每周几' },
        ]
      : [
          { value: 'every_day', label: '每天' },
          { value: 'workdays', label: '工作日（周一至周五）' },
        ];

  const onSubmit = form.handleSubmit(async (data) => {
    const project = projects.find(
      (item: AdminExecuteProject) => item.id === data.planeProjectId,
    );
    const schedule: TaskTemplateSchedule =
      data.scheduleKind === 'weekly'
        ? { kind: 'weekly', weekdays: data.weekdays }
        : { kind: data.scheduleKind };
    const body: TaskTemplateUpsertRequest = {
      title: data.title,
      templateType: data.templateType,
      schedule,
      planeProjectId: data.planeProjectId,
      planeProjectName: project?.name ?? '',
      assigneeMemberId:
        !data.assigneeMemberId || data.assigneeMemberId === NO_ASSIGNEE
          ? null
          : data.assigneeMemberId,
      description: data.description.trim() || null,
      enabled: data.enabled,
    };
    try {
      if (initial) {
        await updateTaskTemplate(initial.id, body);
        toast.success('模板已更新');
      } else {
        await createTaskTemplate(body);
        toast.success('模板已创建');
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存模板失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial ? '编辑任务模板' : '新建任务模板'}
          </DialogTitle>
          <DialogDescription>
            固定/定时任务模板，按计划一键生成当日任务实例。
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
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    模板标题 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="如 门店开门状态巡检"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="templateType"
                render={({ field }) => (
                  <FormItem className="min-w-44 flex-1">
                    <FormLabel>
                      任务类型 <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="daily">固定任务</SelectItem>
                        <SelectItem value="scheduled">定时任务</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="scheduleKind"
                render={({ field }) => (
                  <FormItem className="min-w-44 flex-1">
                    <FormLabel>
                      执行频率 <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择频率" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {scheduleOptions.map((option) => (
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
            </div>
            {scheduleKind === 'weekly' && (
              <FormField
                control={form.control}
                name="weekdays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      每周几执行 <span className="text-destructive">*</span>
                    </FormLabel>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAY_OPTIONS.map((option) => {
                        const active = field.value.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              const next = active
                                ? field.value.filter(
                                    (day: number) => day !== option.value,
                                  )
                                : [...field.value, option.value].sort(
                                    (a: number, b: number) => a - b,
                                  );
                              field.onChange(next);
                            }}
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                              active
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:border-primary/40'
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="planeProjectId"
                render={({ field }) => (
                  <FormItem className="min-w-44 flex-1">
                    <FormLabel>
                      所属项目 <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择 Plane 项目" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
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
                name="assigneeMemberId"
                render={({ field }) => (
                  <FormItem className="min-w-44 flex-1">
                    <FormLabel>指派员工（可选）</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="暂不指派" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_ASSIGNEE}>不指定</SelectItem>
                        {employees
                          .filter(
                            (row: AdminEmployeeBindingRow) =>
                              row.planeMemberId,
                          )
                          .map((row: AdminEmployeeBindingRow) => (
                            <SelectItem
                              key={row.id}
                              value={row.planeMemberId}
                            >
                              {row.planeMemberName ?? row.userName ?? '成员'}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>描述（可选）</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="补充任务说明、材料要求等"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div>
                    <FormLabel className="text-sm">启用模板</FormLabel>
                    <p className="text-xs text-muted-foreground">
                      停用后不参与「生成今日任务」。
                    </p>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  '保存'
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default TaskTemplateDialog;
