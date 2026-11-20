import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarDays, Loader2, Sparkles } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
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
import { Textarea } from '@/components/ui/textarea';
import { createQuickTask, generateQuickTaskDraft } from '@client/src/api/admin';
import { fetchBindingOptions } from '@client/src/api/my';
import { useOptionalIntegrations } from '@client/src/hooks/use-optional-integrations';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { BindingOption, BindingOptionsResponse } from '@shared/api.interface';

const quickTaskSchema = z.object({
  title: z.string().trim().min(1, '请输入任务标题'),
  projectId: z.string().min(1, '请选择所属项目'),
  assigneeMemberId: z.string(),
  description: z.string(),
  dueDate: z.string(),
});

type QuickTaskFormData = z.infer<typeof quickTaskSchema>;

interface QuickTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { projectId: string; name: string }[];
  onCreated?: () => void;
}

/** 快速下任务（表单版）：标题必填 + Plane 全量项目/成员下拉，写 Plane issue */
const QuickTaskDialog: React.FC<QuickTaskDialogProps> = ({
  open,
  onOpenChange,
  projects,
  onCreated,
}) => {
  const [members, setMembers] = useState<BindingOption[]>([]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [draftInput, setDraftInput] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftNotice, setDraftNotice] = useState('');
  // AI 草稿是可选集成（AILY_QUICK_TASK_DRAFT_ENABLED）：没开就不显示一句话起草
  const draftEnabled = useOptionalIntegrations()?.aiQuickTaskDraft === true;

  const form = useForm<QuickTaskFormData>({
    resolver: zodResolver(quickTaskSchema),
    defaultValues: {
      title: '',
      projectId: '',
      assigneeMemberId: '',
      description: '',
      dueDate: '',
    },
  });

  useEffect(() => {
    if (!open || members.length > 0) return;
    fetchBindingOptions()
      .then((options: BindingOptionsResponse) => setMembers(options.members))
      .catch((error: unknown) => {
        logger.warn('获取 Plane 成员列表失败，负责人暂不可选', error);
      });
  }, [open, members.length]);

  const handleGenerateDraft = async () => {
    const input = draftInput.trim();
    if (!input || drafting) return;
    setDrafting(true);
    setDraftNotice('');
    try {
      const result = await generateQuickTaskDraft(input);
      if (result.draft) {
        form.setValue('title', result.draft.title, { shouldValidate: true });
        if (result.draft.description) {
          form.setValue('description', result.draft.description);
        }
        if (result.draft.dueDate) {
          form.setValue('dueDate', result.draft.dueDate);
        }
        toast.success(
          `草稿已生成（把握度 ${result.draft.confidence}%），确认无误后提交`,
        );
      } else {
        const message = result.message ?? 'AI 草稿暂不可用，请手工填写';
        setDraftNotice(message);
        toast.warning(message);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'AI 草稿生成失败，请重试';
      setDraftNotice(message);
      toast.error(message);
    } finally {
      setDrafting(false);
    }
  };

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      const result = await createQuickTask({
        title: data.title,
        projectId: data.projectId,
        assigneeMemberId: data.assigneeMemberId || undefined,
        description: data.description || undefined,
        dueDate: data.dueDate || undefined,
      });
      toast.success(`任务「${data.title}」已创建`);
      onOpenChange(false);
      form.reset();
      onCreated?.();
      if (result.taskUrl) {
        logger.log({ level: 'info', args: ['任务已创建', result.taskUrl] });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '创建任务失败，请重试';
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>快速下任务</DialogTitle>
          <DialogDescription>
            {draftEnabled
              ? '输入一句话需求让 AI 起草，也可以直接填写创建 Plane 任务。'
              : '填写后直接创建 Plane 任务。'}
          </DialogDescription>
        </DialogHeader>
        {draftEnabled && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={draftInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setDraftInput(e.target.value)
                }
                placeholder="一句话需求，如「让小王周五 18:00 前完成仓库盘点」"
              />
              <Button
                type="button"
                variant="outline"
                disabled={drafting || !draftInput.trim()}
                onClick={handleGenerateDraft}
              >
                {drafting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {drafting ? '生成中…' : 'AI 草稿'}
              </Button>
            </div>
            {draftNotice && (
              <p className="text-xs text-muted-foreground">{draftNotice}</p>
            )}
          </div>
        )}
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
                    任务标题 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="一句话描述任务，截止时刻可写在标题内（如 18:00前）"
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
                name="projectId"
                render={({ field }) => (
                  <FormItem className="min-w-52 flex-1">
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
                          <SelectItem
                            key={project.projectId}
                            value={project.projectId}
                          >
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
                  <FormItem className="min-w-52 flex-1">
                    <FormLabel>负责人（可选）</FormLabel>
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
                        {members.map((member) => (
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
            </div>
            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>截止日期（可选）</FormLabel>
                  <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          className="w-full justify-start font-normal"
                        >
                          <CalendarDays className="h-4 w-4 text-muted-foreground" />
                          {field.value || '选择截止日期'}
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={
                          field.value
                            ? new Date(`${field.value}T00:00:00`)
                            : undefined
                        }
                        onSelect={(d: Date | undefined) => {
                          if (!d) return;
                          const y = d.getFullYear();
                          const m = String(d.getMonth() + 1).padStart(2, '0');
                          const day = String(d.getDate()).padStart(2, '0');
                          field.onChange(`${y}-${m}-${day}`);
                          setCalendarOpen(false);
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>任务说明（可选）</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="补充执行要求、验收条件等"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
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
                {form.formState.isSubmitting ? '创建中…' : '创建任务'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default QuickTaskDialog;
