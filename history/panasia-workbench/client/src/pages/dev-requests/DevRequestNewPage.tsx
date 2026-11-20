import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, CircleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createDevRequest,
  devRequestErrorMessage,
  fetchDevRequestDevelopers,
  fetchDevRequestOptions,
} from '@client/src/api/dev-requests';
import type {
  DevRequestDeveloperOption,
  DevRequestProjectOption,
} from '@shared/api.interface';

const TITLE_MAX = 120;

/** 发开发需求：选开发类项目 → 选这个项目里的开发者 → 标题、需求说明、验收条件 */
const DevRequestNewPage = () => {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<DevRequestProjectOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [developers, setDevelopers] = useState<DevRequestDeveloperOption[] | null>(null);
  const [developerId, setDeveloperId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchDevRequestOptions()
      .then((response) => setProjects(response.projects))
      .catch((err: unknown) =>
        setLoadError(devRequestErrorMessage(err, '开发类项目加载失败，请稍后重试')),
      );
  }, []);

  useEffect(() => {
    setDeveloperId('');
    setDevelopers(null);
    if (!projectId) return;
    let cancelled = false;
    fetchDevRequestDevelopers(projectId)
      .then((response) => {
        if (!cancelled) setDevelopers(response.developers);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDevelopers([]);
          toast.error(devRequestErrorMessage(err, '项目成员加载失败'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const submit = () => {
    if (!projectId) return toast.error('请选项目');
    if (!developerId) return toast.error('请选开发者');
    if (!title.trim()) return toast.error('请写标题');
    if (/\+\s*[¥￥]?\s*\d/u.test(title)) {
      return toast.error('标题里不要写「+金额」，价格由开发者报价');
    }
    if (!description.trim()) return toast.error('请写需求说明');
    if (!acceptance.trim()) return toast.error('请写验收条件');
    setSubmitting(true);
    createDevRequest({
      projectId,
      developerId,
      title: title.trim(),
      description: description.trim(),
      acceptance: acceptance.trim(),
    })
      .then((result) => {
        toast.success(result.message);
        navigate(`/dev-requests/${result.id}`, { replace: true });
      })
      .catch((err: unknown) => toast.error(devRequestErrorMessage(err, '发布失败，请稍后重试')))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link
          to="/dev-requests"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
        >
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">发开发需求</h1>
      </div>

      {loadError ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {loadError}
        </div>
      ) : projects === null ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : projects.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无开发类项目
          <span className="mt-1 block text-xs">
            Plane 项目里有「需求提交」到「结果验收」五步状态才能发
          </span>
        </p>
      ) : (
        <Card className="mx-auto max-w-2xl">
          <CardContent className="space-y-4 p-5">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">项目</p>
              {/* 本项目的 Select 把空串换成占位值，传 undefined 才显示占位文字 */}
              <Select value={projectId || undefined} onValueChange={setProjectId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选开发类项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project: DevRequestProjectOption) => (
                    <SelectItem key={project.projectId} value={project.projectId}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">开发者</p>
              <Select
                key={projectId || 'none'}
                value={developerId || undefined}
                onValueChange={setDeveloperId}
                disabled={!projectId || developers === null || developers.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      !projectId
                        ? '先选项目'
                        : developers === null
                          ? '加载中…'
                          : developers.length === 0
                            ? '这个项目里没有能派的人'
                            : '选派给谁'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(developers ?? []).map((developer: DevRequestDeveloperOption) => (
                    <SelectItem key={developer.userId} value={developer.userId}>
                      {developer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">标题</p>
              <Input
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：采购单加按供应商筛选"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">需求说明</p>
              <Textarea
                value={description}
                rows={6}
                maxLength={5000}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="要做什么、为什么做、在哪个页面"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">验收条件</p>
              <Textarea
                value={acceptance}
                rows={3}
                maxLength={500}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder="怎样算做完，例如：能按供应商筛选并导出"
              />
            </div>
            <Button className="w-full" onClick={submit} disabled={submitting}>
              {submitting ? '发布中…' : '发布'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default DevRequestNewPage;
