import React, { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, Plus, RefreshCw, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { fetchTutorialAuthoringList } from '@client/src/api/admin';
import type { TutorialAuthoringProjectView } from '@shared/api.interface';
import {
  defaultFormValues,
  viewToFormValues,
} from './TutorialAuthoringForm';
import TutorialAuthoringForm from './TutorialAuthoringForm';
import TutorialAssignDialog from './TutorialAssignDialog';

const TutorialAuthoringTab: React.FC = () => {
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [initial, setInitial] = useState(defaultFormValues());
  const [items, setItems] = useState<TutorialAuthoringProjectView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<TutorialAuthoringProjectView | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchTutorialAuthoringList();
      setItems(response.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载教程列表失败';
      setError(message);
      logger.error('加载教程模板列表失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'list') void loadList();
  }, [mode, loadList]);

  const startCreate = (): void => {
    setInitial(defaultFormValues());
    setMode('edit');
  };

  const startCopy = (project: TutorialAuthoringProjectView): void => {
    setInitial(viewToFormValues(project));
    setMode('edit');
  };

  if (mode === 'edit') {
    return (
      <TutorialAuthoringForm
        initial={initial}
        onCancel={() => setMode('list')}
        onCreated={() => setMode('list')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">教程模板</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            教程 = 阶段 → 步骤 → 提交材料三层，内容存在 Learning（默认不发布）。照着实际工作填一遍，
            点「分配给员工」后员工就能在学习中心按步骤学、交材料；也可以复制一条现有教程，改几个字段快速生成新教程。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={startCreate}>
              <Plus className="h-4 w-4" />
              空白新建
            </Button>
            {error && (
              <Button variant="outline" onClick={() => void loadList()}>
                <RefreshCw className="h-4 w-4" />
                重试
              </Button>
            )}
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="space-y-3" data-ai-section-type="card-list">
          {items.length === 0 && !error && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                还没有教程，点「空白新建」配置第一条。
              </CardContent>
            </Card>
          )}
          {items.map((project) => {
            const materialCount = project.stages.reduce(
              (total: number, stage) =>
                total +
                stage.steps.reduce(
                  (stepTotal: number, step) => stepTotal + step.materials.length,
                  0,
                ),
              0,
            );
            return (
              <Card key={project.projectId}>
                <CardContent className="flex flex-col gap-3 py-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words font-medium">{project.name}</p>
                      {project.description && (
                        <p className="mt-1 break-words text-sm text-muted-foreground">
                          {project.description}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setAssigning(project)}>
                        <UserPlus className="h-4 w-4" />
                        分配给员工
                      </Button>
                      {project.learningUrl && (
                        <Button variant="outline" size="sm" asChild>
                          <a href={project.learningUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-4 w-4" />
                            在 Learning 打开
                          </a>
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startCopy(project)}
                      >
                        <Copy className="h-4 w-4" />
                        复制
                      </Button>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {project.stageCount} 个阶段 · {project.stepCount} 个步骤 ·{' '}
                    {materialCount} 项提交材料
                    {project.published ? ' · Learning 已发布' : ''}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <TutorialAssignDialog
        project={assigning}
        onOpenChange={(open: boolean) => {
          if (!open) setAssigning(null);
        }}
      />
    </div>
  );
};

export default TutorialAuthoringTab;
