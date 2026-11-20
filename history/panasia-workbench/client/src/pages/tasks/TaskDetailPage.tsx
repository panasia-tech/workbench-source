import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Gift,
  LifeBuoy,
  OctagonAlert,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { tasksApi } from '@client/src/api';
import { TaskListItem } from '@/components/task-list-item';
import { TaskStatusBadge } from '@/components/status-badge';
import { TaskActionDialogs, type TaskDialogKind } from './TaskActionDialogs';
import { BlockDeferCard } from './BlockDeferCard';
import { DevRequestTaskNotice } from './DevRequestTaskNotice';
import { TaskCelebrationOverlay } from './TaskCelebrationOverlay';
import { EvidenceChecklistBar, TaskRewardCard } from './TaskStageBar';
import { TaskTypeTag } from '@/components/task-type-tag';
import { TaskMetaGrid } from './TaskMetaGrid';
import { TaskTimeline } from './TaskTimeline';
import TutorialOutputSection from './TutorialOutputSection';
import { WorkOrderSection } from './WorkOrderSection';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { getBackendErrorStatus } from '@/utils/backend-error-guard';
import type { TaskDetail, TaskTimelineEntry } from '@shared/api.interface';

const EXECUTING_STATUSES = ['IN_PROGRESS', 'WAITING', 'REJECTED'];

const TRANSIENT_ERROR_STATUSES: number[] = [502, 503, 504];
const RETRY_DELAYS_MS: number[] = [3000, 6000];
// 员工只能看指派给自己的任务，别人的与不存在的服务端都回 404
const NOT_FOUND_TEXT = '任务不存在，或不是指派给你的';

const TaskDetailPage = () => {
  const { taskId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('projectId') ?? undefined;

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TaskDialogKind>(null);
  const [changingStatus, setChangingStatus] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const prevStatusRef = useRef<TaskDetail['task']['status'] | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);

  const triggerCelebration = useCallback(() => {
    if (celebrationTimerRef.current !== null) {
      window.clearTimeout(celebrationTimerRef.current);
    }
    setCelebrating(true);
    celebrationTimerRef.current = window.setTimeout(() => {
      setCelebrating(false);
      celebrationTimerRef.current = null;
    }, 2400);
  }, []);

  useEffect(() => {
    prevStatusRef.current = null;
    retryCountRef.current = 0;
    return () => {
      if (celebrationTimerRef.current !== null) {
        window.clearTimeout(celebrationTimerRef.current);
        celebrationTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      abortRef.current?.abort();
    };
  }, [taskId]);

  const loadDetail = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    tasksApi
      .fetchTaskDetail(taskId, projectId, controller.signal)
      .then((data: TaskDetail) => {
        setDetail(data);
        setError(null);
        retryCountRef.current = 0;
        const prev = prevStatusRef.current;
        if (
          prev !== null &&
          prev !== 'DONE' &&
          data.task.status === 'DONE'
        ) {
          triggerCelebration();
        }
        prevStatusRef.current = data.task.status;
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = getBackendErrorStatus(error);
        const transient =
          status !== undefined && TRANSIENT_ERROR_STATUSES.includes(status);
        if (transient && retryCountRef.current < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[retryCountRef.current];
          retryCountRef.current += 1;
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            loadDetail();
          }, delay);
          return;
        }
        setError(
          transient
            ? '外部系统暂时繁忙，稍后会自动恢复；您也可以点击重试'
            : status === 404
              ? NOT_FOUND_TEXT
              : '任务详情加载失败，请稍后重试',
        );
        setLoading(false);
      });
  }, [taskId, projectId, triggerCelebration]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const changeStatus = (status: TaskDetail['task']['status']) => {
    if (!detail) return;
    setChangingStatus(true);
    tasksApi
      .updateTaskStatus(taskId, {
        projectId: detail.task.projectId,
        status,
      })
      .then((result) => {
        toast.success(result.message);
        loadDetail();
      })
      .catch(() => {
        toast.error('状态更新失败，请稍后重试');
      })
      .finally(() => {
        setChangingStatus(false);
      });
  };

  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link to="/tasks">
            <ArrowLeft className="h-4 w-4" />
            返回任务
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>{error ?? '任务详情加载失败'}</AlertTitle>
        </Alert>
        {error !== NOT_FOUND_TEXT ? (
          <Button variant="outline" onClick={loadDetail}>
            <RotateCcw className="h-4 w-4" />
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  const { task, objective, ownerName, subTasks, timeline, blockedInfo } =
    detail;

  const objectiveLines = objective
    ? objective.split('\n').filter((line: string) => line.length > 0)
    : [];
  const acceptanceHint =
    objectiveLines
      .find((line: string) => line.startsWith('验收条件='))
      ?.replace('验收条件=', '') ?? null;
  // 「验收条件=」「工时=」两行在别处单独展示，正文里不重复
  const objectiveBody = objectiveLines
    .filter(
      (line: string) =>
        !line.startsWith('验收条件=') && !/^\s*工时\s*[=＝]/u.test(line),
    )
    .join('\n');

  const renderMainAction = () => {
    // 父任务是自己的、子任务指派给别人：能看不能操作
    if (detail.readOnly) {
      return (
        <p className="text-sm text-muted-foreground">
          这条子任务不是指派给你的，只能查看。
        </p>
      );
    }
    if (detail.devRequestId) {
      return <DevRequestTaskNotice devRequestId={detail.devRequestId} />;
    }
    if (task.status === 'TODO') {
      return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            size="lg"
            onClick={() => changeStatus('IN_PROGRESS')}
            disabled={changingStatus}
          >
            <CheckCircle2 className="h-4 w-4" />
            开始任务
          </Button>
          <p className="text-sm text-muted-foreground">
            开始后进入第 2 阶段「执行中」
          </p>
        </div>
      );
    }
    if (task.status === 'BLOCKED') {
      return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            size="lg"
            onClick={() => changeStatus('IN_PROGRESS')}
            disabled={changingStatus}
          >
            解除阻塞，继续执行
          </Button>
          <p className="text-sm text-muted-foreground">
            外部条件恢复后，回到执行中继续推进
          </p>
        </div>
      );
    }
    if (EXECUTING_STATUSES.includes(task.status)) {
      return (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg" onClick={() => setDialog('evidence')}>
              <BadgeCheck className="h-4 w-4" />
              提交验收
            </Button>
            <p className="text-sm text-muted-foreground">
              提交完成凭证后任务进入第 4 阶段「待验收」，主管核验通过即计分
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialog('block')}>
              <OctagonAlert className="h-3.5 w-3.5" />
              提交阻塞
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDialog('assist')}>
              <LifeBuoy className="h-3.5 w-3.5" />
              申请协助
            </Button>
          </div>
        </div>
      );
    }
    if (task.status === 'READY_FOR_REVIEW') {
      return (
        <div className="flex items-start gap-3 rounded-md bg-blue-50/60 p-4">
          <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          <div className="text-sm">
            <p className="font-medium text-blue-700">验收中 · 等待主管核验</p>
            <p className="mt-1 text-muted-foreground">
              凭证已提交（第 4 阶段）。主管核验通过后按规则计入绩效分；如被打回将回到执行中返工。
            </p>
          </div>
        </div>
      );
    }
    if (task.status === 'DONE') {
      return (
        <div className="flex items-center gap-3 rounded-md bg-green-50/60 p-4 text-sm">
          <BadgeCheck className="h-5 w-5 shrink-0 text-green-600" />
          <p className="text-green-700">
            任务已完成，得分已计入绩效。
          </p>
        </div>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        任务已取消，无需处理。
      </p>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/tasks">
            <ArrowLeft className="h-4 w-4" />
            返回任务
          </Link>
        </Button>
        <span className="text-xs text-muted-foreground">{task.projectName}</span>
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{task.title}</h1>
          {DEMO_MODE && <DemoBadge />}
          <TaskTypeTag
            type={task.taskType}
            rewardAmount={task.rewardAmount}
          />
          <TaskStatusBadge status={task.status} label={task.statusLabel} />
          {task.sequenceId !== null ? (
            <span className="text-sm text-muted-foreground">#{task.sequenceId}</span>
          ) : null}
        </div>
        <TaskMetaGrid task={task} ownerName={ownerName} />
      </div>

      {task.severeBlocked ? (
        <Alert variant="destructive">
          <OctagonAlert className="h-4 w-4" />
          <AlertTitle>严重堵塞：已超过 48 小时未处理</AlertTitle>
          <AlertDescription>
            任务均为当天强时效任务，超出截止时间 48
            小时仍未完结属严重违规行为，将计入当期绩效的「阻塞升级次数」考核；请立即处理，完成后仍可在绩效页补救中心补回分数。
          </AlertDescription>
        </Alert>
      ) : null}

      {task.taskType === 'delegated' && task.rewardAmount !== null ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-amber-300 bg-gradient-to-r from-amber-100 to-amber-200 px-4 py-3 text-sm font-medium text-amber-800">
          <Gift className="h-4 w-4 shrink-0" />
          <span>
            完成本单可获额外奖励 ¥{task.rewardAmount}，不计入绩效
          </span>
        </div>
      ) : null}

      {detail.devRequestId ? null : (
        <EvidenceChecklistBar
          checklist={detail.evidenceChecklist}
          evidenceCount={
            timeline.filter((t: TaskTimelineEntry) =>
              t.content.includes('【验收凭证】'),
            ).length
          }
          status={task.status}
        />
      )}

      {blockedInfo ? (
        <Alert variant="destructive">
          <OctagonAlert className="h-4 w-4" />
          <AlertTitle>任务阻塞中：{blockedInfo.reason}</AlertTitle>
          <AlertDescription>
            等待「{blockedInfo.waitingFor}」 · 下一步：{blockedInfo.nextAction}
          </AlertDescription>
        </Alert>
      ) : null}

      {detail.blockDefer ? <BlockDeferCard defer={detail.blockDefer} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">下一步行动</CardTitle>
        </CardHeader>
        <CardContent>{renderMainAction()}</CardContent>
      </Card>

      {detail.devRequestId ? null : (
        <TaskRewardCard
          status={task.status}
          deadline={task.deadline}
          deadlineTime={task.deadlineTime}
          severeBlocked={task.severeBlocked}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最终目标</CardTitle>
        </CardHeader>
        <CardContent>
          {objectiveBody ? (
            <p className="whitespace-pre-wrap text-sm">{objectiveBody}</p>
          ) : (
            <p className="text-sm text-muted-foreground">未填写目标说明</p>
          )}
          <div className="mt-3 rounded-md bg-blue-50/60 px-3 py-2 text-sm">
            <span className="font-medium text-blue-700">验收凭证：</span>
            <span className="text-muted-foreground">
              {acceptanceHint ??
                '提交验收时需上传凭证（截图 / 录音 / 视频 / 文件）'}
            </span>
          </div>
          {task.currentAction ? (
            <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
              当前下一步：{task.currentAction}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {subTasks.length > 0 ? (
        <section>
          <h2 className="mb-3 text-base font-semibold">子任务</h2>
          <div data-ai-section-type="card-list" className="space-y-3">
            {subTasks.map((sub) => (
              <TaskListItem key={sub.id} task={sub} />
            ))}
          </div>
        </section>
      ) : null}

      {detail.relatedTutorial ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">相关教程</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <BookOpen className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">
                  {detail.relatedTutorial.title}
                </p>
                {detail.relatedTutorial.durationMinutes !== null ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    预计 {detail.relatedTutorial.durationMinutes} 分钟
                  </p>
                ) : null}
              </div>
            </div>
            <Button variant="outline" size="sm" asChild className="shrink-0">
              <Link to="/my/learning">
                查看教程
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {detail.tutorialOutput ? (
        <TutorialOutputSection output={detail.tutorialOutput} />
      ) : null}

      {detail.readOnly || detail.devRequestId ? null : (
        <WorkOrderSection taskId={taskId} />
      )}

      <section>
        <h2 className="mb-3 text-base font-semibold">任务动态</h2>
        <TaskTimeline timeline={timeline} />
      </section>

      <TaskCelebrationOverlay active={celebrating} />

      <TaskActionDialogs
        taskId={taskId}
        projectId={task.projectId}
        kind={dialog}
        evidenceHint={acceptanceHint}
        materials={detail.evidenceChecklist.map((i) => i.name)}
        onClose={() => setDialog(null)}
        onDone={loadDetail}
      />
    </div>
  );
};

export default TaskDetailPage;
