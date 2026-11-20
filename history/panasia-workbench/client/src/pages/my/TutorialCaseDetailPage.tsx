import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, CircleAlert, ClipboardList, Gift } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { myApi } from '@client/src/api';
import { TutorialStepCard } from './TutorialStepCard';
import type {
  TutorialCaseDetail,
  TutorialCaseStageDetail,
  TutorialCaseStepDetail,
} from '@shared/api.interface';

interface StageSectionProps {
  index: number;
  stage: TutorialCaseStageDetail;
  active: boolean;
  caseId: number;
  onSubmitted: () => void;
}

const isHandled = (step: TutorialCaseStepDetail): boolean =>
  step.state === 'approved' || step.state === 'skipped';

const StageSection = ({
  index,
  stage,
  active,
  caseId,
  onSubmitted,
}: StageSectionProps) => {
  const done = stage.steps.filter(isHandled).length;
  return (
    <section className="space-y-3">
      <Card
        className={
          active ? 'border-primary/40 bg-primary/[0.03]' : undefined
        }
      >
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  done === stage.steps.length
                    ? 'bg-emerald-500/10 text-emerald-600'
                    : active
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {index}
              </span>
              <span className="truncate text-sm font-semibold">
                {stage.title}
              </span>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {done}/{stage.steps.length} 步
            </span>
          </div>
        </CardContent>
      </Card>
      <div data-ai-section-type="card-list" className="space-y-3">
        {stage.steps.map((step: TutorialCaseStepDetail) => (
          <TutorialStepCard
            key={`${step.id}-${step.state}-${
              step.skipRequestStatus ?? 'none'
            }-${step.submission?.submittedAt ?? 'none'}`}
            caseId={caseId}
            step={step}
            onSubmitted={onSubmitted}
          />
        ))}
      </div>
    </section>
  );
};

/** Learning 连不上时后端回 503「教程内容暂时读不到」，原话给员工看；别的错误给通用提示 */
const loadErrorMessage = (err: unknown): string => {
  const shaped = err as {
    response?: { status?: number; data?: { message?: unknown; error?: { message?: unknown } } };
  };
  const data = shaped.response?.data;
  const message = data?.error?.message ?? data?.message;
  return shaped.response?.status === 503 && typeof message === 'string' && message !== ''
    ? message
    : '教程案例加载失败，请稍后重试';
};

const TutorialCaseDetailPage = () => {
  const { caseId } = useParams();
  const [data, setData] = useState<TutorialCaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const parsedId = Number(caseId);
  const validId = Number.isInteger(parsedId) && parsedId > 0;

  const load = useCallback(async (id: number): Promise<void> => {
    try {
      const detail = await myApi.fetchTutorialCase(id);
      setData(detail);
    } catch (err: unknown) {
      logger.error('获取教程案例详情失败', err);
      setError(loadErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!validId) {
      setError('案例 ID 非法');
      setLoading(false);
      return;
    }
    let cancelled = false;
    void load(parsedId).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [validId, parsedId, load]);

  const handleSubmitted = useCallback((): void => {
    if (validId) void load(parsedId);
  }, [validId, parsedId, load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link
          to="/my/learning"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回学习中心
        </Link>
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      </div>
    );
  }

  const stepsTotal = data.stages.reduce(
    (sum: number, s: TutorialCaseStageDetail) => sum + s.steps.length,
    0,
  );
  const stepsDone = data.stages.reduce(
    (sum: number, s: TutorialCaseStageDetail) =>
      sum + s.steps.filter(isHandled).length,
    0,
  );
  const firstUndoneStage = data.stages.find(
    (s: TutorialCaseStageDetail) =>
      !s.steps.every((step: TutorialCaseStepDetail) => isHandled(step)),
  );
  const activeStageId =
    data.currentStageId ?? firstUndoneStage?.id ?? null;

  const caseMeta = [data.projectName, data.clientName]
    .filter((item: string | null): boolean => item != null && item !== '')
    .join(' · ');

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/my/learning"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回学习中心
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{data.title}</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {caseMeta ? `${caseMeta} · ` : ''}
          共 {data.stages.length} 个阶段 · {stepsTotal} 个步骤
        </p>
      </div>

      <Card data-ai-section-type="card-stat">
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">整体进度</p>
            <p className="text-sm">
              <span className="text-2xl font-semibold">{data.progress}%</span>
              <span className="ml-2 text-muted-foreground">
                {stepsDone}/{stepsTotal} 步
              </span>
            </p>
          </div>
          <Progress value={data.progress} className="mt-3" />
          {data.completedAt ? (
            <p className="mt-2 text-xs text-emerald-600">
              已于 {data.completedAt} 完成 · 教程奖励绩效 +{data.rewardScore} 分已计入
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Gift className="h-3.5 w-3.5 shrink-0" />
              完成本教程奖励绩效 +{data.rewardScore} 分
              {data.rewardAmount !== null
                ? `，折算约 ¥${data.rewardAmount}`
                : ''}
              ，与任务绩效同口径计入
            </p>
          )}
          {!data.completedAt && (data.hasRejectedStep || data.overdueDays !== null) ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
              <CircleAlert className="h-3.5 w-3.5 shrink-0" />
              {data.overdueDays !== null
                ? `严重堵塞：教程已超 ${data.overdueDays} 天未完成`
                : '当前有步骤材料被打回，请重新提交或跳过'}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {data.stages.length > 0 ? (
        <section className="space-y-6">
          {data.stages.map(
            (stage: TutorialCaseStageDetail, i: number) => (
              <StageSection
                key={stage.id}
                index={i + 1}
                stage={stage}
                active={stage.id === activeStageId}
                caseId={data.caseId}
                onSubmitted={handleSubmitted}
              />
            ),
          )}
        </section>
      ) : (
        <Card>
          <CardContent className="p-5 text-center">
            <p className="text-sm font-medium">暂无数据</p>
            <p className="mt-1 text-sm text-muted-foreground">
              该教程案例尚未配置阶段与步骤
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default TutorialCaseDetailPage;
