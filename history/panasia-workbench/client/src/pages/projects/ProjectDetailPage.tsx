import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleAlert, Target } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { projectsApi } from '@client/src/api';
import { TaskListItem } from '@/components/task-list-item';
import { ProjectTaskTable } from './ProjectTaskTable';
import { getBackendErrorStatus } from '@/utils/backend-error-guard';
import type { ProjectDetail, ProjectModuleInfo } from '@shared/api.interface';

const ProjectDetailPage = () => {
  const { projectId = '' } = useParams();

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(() => {
    setLoading(true);
    projectsApi
      .fetchProjectDetail(projectId)
      .then((data: ProjectDetail) => {
        setDetail(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          getBackendErrorStatus(err) === 404
            ? '项目不存在，或你在这个项目里还没有任务'
            : '项目详情加载失败，请稍后重试',
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [projectId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-4 w-4" />
            返回项目
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>{error ?? '项目详情加载失败'}</AlertTitle>
        </Alert>
      </div>
    );
  }

  const { project } = detail;
  const activeCycle = detail.cycles.find((c) => c.isActive) ?? null;
  const rows: { label: string; value: string }[] = [
    { label: '项目代号', value: project.identifier },
    { label: '起止时间', value: `${project.startDate ?? '未定'} ~ ${project.endDate ?? '预计中'}` },
    { label: '创建时间', value: project.createdOn?.slice(0, 10) ?? '未知' },
    { label: '当前周期', value: detail.currentStage ?? '未设置周期' },
    { label: '完成进度', value: `${project.progress}%` },
    { label: '模块 / 周期数', value: `${project.moduleCount} / ${project.cycleCount}` },
    { label: '参与成员', value: detail.memberNames.join('、') || '未指派' },
    { label: '任务总量', value: `${project.openTasks} 开放 / ${project.totalTasks} 总计` },
    { label: '受阻任务', value: String(project.blockedTasks) },
    { label: '我的任务', value: `${project.myDone}/${project.myTotal} 完成 · ${project.myActive} 进行中 · ${project.myBlocked} 受阻` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/projects">
            <ArrowLeft className="h-4 w-4" />
            返回项目
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {project.identifier}
        </span>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">项目档案</CardTitle>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            <div className="grid gap-x-8 gap-y-2 px-3 py-2 sm:grid-cols-2">
              {rows.map((r) => (
                <div
                  key={r.label}
                  className="flex items-baseline justify-between gap-3 border-b border-dashed py-1.5 text-sm last:border-0"
                >
                  <span className="shrink-0 text-xs text-muted-foreground">{r.label}</span>
                  <span className="truncate text-right">{r.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Target className="h-4 w-4 text-primary" />
              最终目标
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">
              {project.description ?? '项目未填写总体目标，可在 Plane 项目设置中补充。'}
            </p>
            {detail.modules.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                <p className="text-xs font-medium text-foreground">模块拆解：</p>
                {detail.modules.map((m: ProjectModuleInfo) => (
                  <div
                    key={m.id}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-muted-foreground">
                      {m.name}
                      {m.description ? `：${m.description}` : ''}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {m.done}/{m.total}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            当前周期：
            <span className="text-foreground">
              {activeCycle
                ? `${activeCycle.name}（进度 ${activeCycle.progress}%，${activeCycle.done}/${activeCycle.total}）`
                : detail.currentStage ?? '未设置周期'}
            </span>
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span>
            模块：
            <span className="text-foreground">
              {detail.modules.length > 0
                ? `${detail.modules.length} 个，累计完成 ${detail.modules.reduce(
                    (sum: number, m: ProjectModuleInfo) => sum + m.done,
                    0,
                  )}/${detail.modules.reduce(
                    (sum: number, m: ProjectModuleInfo) => sum + m.total,
                    0,
                  )} 任务`
                : '暂无模块'}
            </span>
          </span>
        </div>
      </section>

      <section>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {detail.taskScope === 'mine' ? '我的任务明细' : '任务明细'}（{detail.taskRows.length}）
            </CardTitle>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            {detail.taskRows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                暂无任务
              </p>
            ) : (
              <ProjectTaskTable taskRows={detail.taskRows} />
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">我负责的任务</h2>
        {detail.myTasks.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            暂无进行中的任务
          </p>
        ) : (
          <div data-ai-section-type="card-list" className="space-y-3">
            {detail.myTasks.map((task) => (
              <TaskListItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <CircleAlert className="h-4 w-4 text-red-500" />
          需要注意
        </h2>
        {detail.risks.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            暂无需要关注的风险任务
          </p>
        ) : (
          <div data-ai-section-type="card-list" className="space-y-3">
            {detail.risks.map((task) => (
              <TaskListItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default ProjectDetailPage;
