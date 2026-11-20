import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronDown, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { projectsApi } from '@client/src/api';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { TaskListItem } from '@/components/task-list-item';
import type { MyProjectsResponse, ProjectSummary } from '@shared/api.interface';

interface ProjectTaskGroupProps {
  project: ProjectSummary;
  expanded: boolean;
  onToggle: (id: string) => void;
}

const ProjectTaskGroup = ({
  project,
  expanded,
  onToggle,
}: ProjectTaskGroupProps) => {
  const myOpenTasks = project.myOpenTasks ?? [];
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link
              to={`/projects/${project.id}`}
              className="truncate text-base font-semibold hover:text-primary"
            >
              {project.name}
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                我的 {project.myDone}/{project.myTotal}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                  project.myActive > 0
                    ? 'bg-amber-50 text-amber-600'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                未完成 {project.myActive}
              </span>
              <span className="text-xs text-muted-foreground">
                总进度 {project.progress}%
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={expanded ? '折叠任务列表' : '展开任务列表'}
            onClick={() => onToggle(project.id)}
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </Button>
        </div>

        {expanded ? (
          <div className="mt-4">
            {myOpenTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                本项目暂无我的待办任务
              </p>
            ) : (
              <div data-ai-section-type="card-list" className="space-y-3">
                {myOpenTasks.map((task) => (
                  <TaskListItem key={task.id} task={task} />
                ))}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

const ProjectsPage = () => {
  const [data, setData] = useState<MyProjectsResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const handleReload = () => {
    setError(null);
    setLoading(true);
    setReloadTick((tick) => tick + 1);
  };

  useEffect(() => {
    let cancelled = false;
    projectsApi
      .fetchMyProjects()
      .then((res: MyProjectsResponse) => {
        if (cancelled) return;
        setData(res);
        const firstId = res.projects[0]?.id;
        if (firstId) setExpanded({ [firstId]: true });
      })
      .catch(() => {
        if (!cancelled) setError('项目数据加载失败，数据源繁忙，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const handleToggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
        <Button size="sm" variant="outline" onClick={handleReload}>
          重试
        </Button>
      </div>
    );
  }

  if (!data.bound) {
    return (
      <Card data-ai-section-type="card-menu" className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center gap-4 p-5 text-center">
          <UserRoundCog className="h-10 w-10 text-muted-foreground" />
          <div>
            <h2 className="text-base font-semibold">请先绑定员工身份</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              绑定你的 Plane 成员身份后，即可看到你参与的项目。
            </p>
          </div>
          <Button asChild>
            <Link to="/my">前往「我的」完成绑定</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">我的项目</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          按项目分组的我的任务总览，展开即可逐项推进
        </p>
      </div>

      {data.projects.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无参与的项目，任务分配后自动出现在这里
        </p>
      ) : (
        <div data-ai-section-type="card-list" className="flex flex-col gap-4">
          {data.projects.map((project) => (
            <ProjectTaskGroup
              key={project.id}
              project={project}
              expanded={Boolean(expanded[project.id])}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ProjectsPage;
