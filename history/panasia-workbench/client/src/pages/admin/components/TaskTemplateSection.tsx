import React, { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

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
  deleteTaskTemplate,
  generateTodayTemplates,
  getAdminEmployees,
  listTaskTemplates,
  updateTaskTemplate,
} from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminEmployeeBindingRow,
  AdminExecuteProject,
  TaskTemplateSummary,
  TaskTemplateUpsertRequest,
} from '@shared/api.interface';
import TaskTemplateDialog from './TaskTemplateDialog';

interface TaskTemplateSectionProps {
  projects: AdminExecuteProject[];
  /** 生成任务后刷新执行页任务列表 */
  onTasksChanged?: () => void;
}

const TYPE_BADGES: Record<
  'daily' | 'scheduled',
  { label: string; className: string }
> = {
  daily: {
    label: '固定任务',
    className: 'bg-blue-500/10 text-blue-600',
  },
  scheduled: {
    label: '定时任务',
    className: 'bg-purple-500/10 text-purple-600',
  },
};

/** 执行 Dock：任务模板管理区块（模板列表 + 新建/编辑 + 一键生成今日任务） */
const TaskTemplateSection: React.FC<TaskTemplateSectionProps> = ({
  projects,
  onTasksChanged,
}) => {
  const [templates, setTemplates] = useState<TaskTemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<AdminEmployeeBindingRow[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaskTemplateSummary | null>(null);
  const [deleting, setDeleting] = useState<TaskTemplateSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const items = await listTaskTemplates();
      setTemplates(items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取任务模板失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getAdminEmployees()
      .then((response) => setEmployees(response.items ?? []))
      .catch((err: unknown) => {
        logger.warn('获取员工绑定列表失败，指派下拉暂不可选', err);
      });
  }, []);

  const handleToggleEnabled = (
    tpl: TaskTemplateSummary,
    next: boolean,
  ): void => {
    const revert = (): void => {
      setTemplates((prev) =>
        (prev ?? []).map((row: TaskTemplateSummary) =>
          row.id === tpl.id ? { ...row, enabled: !next } : row,
        ),
      );
    };
    setTemplates((prev) =>
      (prev ?? []).map((row: TaskTemplateSummary) =>
        row.id === tpl.id ? { ...row, enabled: next } : row,
      ),
    );
    const body: TaskTemplateUpsertRequest = {
      title: tpl.title,
      templateType: tpl.templateType,
      schedule: tpl.schedule,
      planeProjectId: tpl.planeProjectId,
      planeProjectName: tpl.planeProjectName,
      assigneeMemberId: tpl.assigneeMemberId,
      enabled: next,
    };
    updateTaskTemplate(tpl.id, body).catch((err: unknown) => {
      revert();
      toast.error(err instanceof Error ? err.message : '切换启用状态失败');
    });
  };

  const handleGenerate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await generateTodayTemplates();
      toast.success(`已生成 ${result.created} 条 / 跳过 ${result.skipped} 条`);
      const details = (result.details ?? []).filter((item: string) => item);
      if (details.length > 0) {
        toast.info(details.join('；'));
      }
      await load();
      onTasksChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '生成今日任务失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteTaskTemplate(deleting.id);
      toast.success('模板已删除');
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除模板失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarClock className="h-5 w-5 text-primary" />
            任务模板
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            固定/定时任务模板，按计划一键生成当日任务实例（当日已生成的自动跳过）。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={generating}
            onClick={() => void handleGenerate()}
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            立即生成今日任务
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            新建模板
          </Button>
        </div>
      </div>

      {error !== null && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        </div>
      )}

      {error === null && templates === null && (
        <Skeleton className="h-40 rounded-xl" />
      )}

      {error === null && templates !== null && templates.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          尚未配置固定/定时任务模板，点「新建模板」创建第一条，即可一键生成每日任务。
        </div>
      )}

      {error === null && templates !== null && templates.length > 0 && (
        <div
          data-ai-section-type="card-list"
          className="grid gap-4 md:grid-cols-2"
        >
          {templates.map((tpl: TaskTemplateSummary) => {
            const badge = TYPE_BADGES[tpl.templateType] ?? {
              label: tpl.templateType,
              className: '',
            };
            return (
              <div
                key={tpl.id}
                className="rounded-xl border bg-card p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={`shrink-0 ${badge.className}`}
                      >
                        {badge.label}
                      </Badge>
                      <span className="truncate font-medium">{tpl.title}</span>
                    </div>
                    <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {tpl.scheduleLabel} · {tpl.planeProjectName}
                      </span>
                    </p>
                  </div>
                  <Switch
                    checked={tpl.enabled}
                    onCheckedChange={(checked: boolean) =>
                      handleToggleEnabled(tpl, checked)
                    }
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  {tpl.runsToday ? (
                    <span className="flex items-center gap-1.5 text-xs text-green-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      今天执行
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      今天不执行
                    </span>
                  )}
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(tpl);
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
                      onClick={() => setDeleting(tpl)}
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

      <TaskTemplateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        projects={projects}
        employees={employees}
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
            <AlertDialogTitle>确认删除模板？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除模板「{deleting?.title}」，已生成的历史任务不受影响，删除后不可恢复。
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
    </section>
  );
};

export default TaskTemplateSection;
