import React from 'react';
import { Link } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
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
import { Textarea } from '@/components/ui/textarea';
import {
  BLOCKER_CATEGORY_LABELS,
  BLOCKER_SEVERITY_LABELS,
  submitBlocker,
} from '@client/src/api/problems';
import type {
  BlockerCategory,
  BlockerSeverity,
  SubmitBlockerRequest,
} from '@shared/api.interface';

const blockerSchema = z.object({
  title: z
    .string()
    .min(1, '请填写问题标题')
    .max(100, '标题不超过 100 字'),
  description: z.string().max(1000, '描述不超过 1000 字'),
  category: z.string().min(1, '请选择问题类别'),
  severity: z.string().min(1, '请选择严重度'),
  taskId: z.string().max(64, '任务 ID 过长'),
  lossHours: z
    .string()
    .refine(
      (value: string) =>
        value.trim() === '' ||
        (!Number.isNaN(Number(value)) &&
          Number(value) >= 0 &&
          Number(value) <= 1000),
      '请输入 0-1000 之间的数字',
    ),
});

type BlockerFormData = z.infer<typeof blockerSchema>;

interface SubmitBlockerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CATEGORY_OPTIONS: BlockerCategory[] = [
  'tool',
  'system',
  'permission',
  'process',
  'external_supplier',
  'logistics',
  'customer',
  'resource',
  'knowledge',
  'coordination',
  'quality',
  'policy',
  'finance',
  'data',
  'other',
];

const SEVERITY_OPTIONS: BlockerSeverity[] = ['normal', 'high', 'critical'];

const SubmitBlockerDialog: React.FC<SubmitBlockerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const form = useForm<BlockerFormData>({
    resolver: zodResolver(blockerSchema),
    defaultValues: {
      title: '',
      description: '',
      category: 'other',
      severity: 'normal',
      taskId: '',
      lossHours: '',
    },
  });

  const submitting = form.formState.isSubmitting;

  const close = (): void => {
    onOpenChange(false);
    form.reset();
  };

  const onSubmit = form.handleSubmit(async (data: BlockerFormData) => {
    const request: SubmitBlockerRequest = {
      title: data.title.trim(),
      category: data.category as BlockerCategory,
      severity: data.severity as BlockerSeverity,
    };
    if (data.description.trim()) {
      request.description = data.description.trim();
    }
    if (data.taskId.trim()) {
      request.taskId = data.taskId.trim();
    }
    const lossHours = data.lossHours.trim() === '' ? 0 : Number(data.lossHours);
    if (lossHours > 0) {
      request.lossHours = lossHours;
    }
    try {
      await submitBlocker(request);
      toast.success('已提交，同类问题会自动聚类，达阈值将进入改进候选');
      close();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '提交失败，请稍后重试',
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>遇到问题</DialogTitle>
          <DialogDescription>
            提交工作中遇到的阻塞，系统会自动归类聚类；同类问题达到阈值后将进入改进候选。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    问题标题 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="一句话说清卡住了什么"
                      maxLength={100}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>问题类别</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map(
                          (value: BlockerCategory) => (
                            <SelectItem key={value} value={value}>
                              {BLOCKER_CATEGORY_LABELS[value]}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="severity"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>严重度</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SEVERITY_OPTIONS.map(
                          (value: BlockerSeverity) => (
                            <SelectItem key={value} value={value}>
                              {BLOCKER_SEVERITY_LABELS[value]}
                              {value === 'critical'
                                ? '（资金/权限/合规，单次进入候选）'
                                : ''}
                            </SelectItem>
                          ),
                        )}
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
                  <FormLabel>补充说明</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="补充描述：什么时候开始、卡在谁那里、影响什么"
                      maxLength={1000}
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="taskId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>关联任务（可选）</FormLabel>
                    <FormControl>
                      <Input placeholder="Plane 任务 ID" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lossHours"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>损失工时（可选）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.5"
                        min={0}
                        placeholder="0"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter className="items-center gap-3">
              <Link
                to="/my/blockers"
                onClick={() => onOpenChange(false)}
                className="text-xs text-primary hover:underline"
              >
                查看我的阻塞记录
              </Link>
              <Button type="button" variant="ghost" onClick={close}>
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? '提交中…' : '提交'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default SubmitBlockerDialog;
