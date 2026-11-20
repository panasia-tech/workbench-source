import { useState, type ChangeEvent, type MouseEvent } from 'react';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  HelpCircle,
  Lock,
  PlayCircle,
  SkipForward,
} from 'lucide-react';
import { toast } from 'sonner';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { myApi } from '@client/src/api';
import {
  TutorialMaterialField,
  TutorialMaterialValue,
  isFileInputType,
} from './TutorialMaterialField';
import {
  StepGuidePanel,
  StepMaterialsPreview,
  StepWarnNote,
} from './TutorialStepPreview';
import type {
  SubmitTutorialStepRequest,
  TutorialCaseMaterial,
  TutorialCaseStepDetail,
} from '@shared/api.interface';

type StepState = TutorialCaseStepDetail['state'];

function extractBackendMessage(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const shaped = err as { response?: { data?: { message?: unknown } } };
  const msg = shaped.response?.data?.message;
  return typeof msg === 'string' && msg !== '' ? msg : null;
}

function initialValues(
  step: TutorialCaseStepDetail,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const m of step.materials) {
    const prev = step.submission?.data?.[m.key];
    if (isFileInputType(m.inputType)) {
      values[m.key] = Array.isArray(prev) ? prev : [];
    } else if (typeof prev === 'string') {
      values[m.key] = prev;
    } else if (typeof prev === 'number') {
      values[m.key] = String(prev);
    } else {
      values[m.key] = '';
    }
  }
  return values;
}

function stepIcon(state: StepState) {
  switch (state) {
    case 'approved':
      return <Check className="h-4 w-4 shrink-0 text-emerald-600" />;
    case 'submitted':
      return <Clock3 className="h-4 w-4 shrink-0 text-amber-600" />;
    case 'rejected':
      return <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />;
    case 'skipped':
      return <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground/60" />;
    case 'locked':
      return <Lock className="h-4 w-4 shrink-0 text-muted-foreground/50" />;
    default:
      return <PlayCircle className="h-4 w-4 shrink-0 text-amber-600" />;
  }
}

function stepLabel(state: StepState): string {
  switch (state) {
    case 'approved':
      return '已完成';
    case 'submitted':
      return '已提交 · 等待审核';
    case 'rejected':
      return '已驳回 · 可重新提交';
    case 'skipped':
      return '已跳过';
    case 'locked':
      return '待前序 · 可预览';
    default:
      return '进行中';
  }
}

function cardClass(state: StepState): string {
  switch (state) {
    case 'approved':
      return 'border-emerald-500/30';
    case 'rejected':
      return 'border-destructive/40 bg-destructive/[0.03]';
    case 'skipped':
    case 'locked':
      return 'border-border bg-muted/40';
    case 'submitted':
      return 'border-border';
    default:
      return 'border-amber-500/40';
  }
}

function labelClass(state: StepState): string {
  switch (state) {
    case 'approved':
      return 'text-emerald-600';
    case 'rejected':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

interface TutorialStepCardProps {
  caseId: number;
  step: TutorialCaseStepDetail;
  onSubmitted: () => void;
}

export function TutorialStepCard({
  caseId,
  step,
  onSubmitted,
}: TutorialStepCardProps) {
  const [expanded, setExpanded] = useState<boolean>(
    step.state === 'active' || step.state === 'rejected',
  );
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(step),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [showGuide, setShowGuide] = useState(false);

  const locked = step.state === 'locked';
  const hasGuideMeta =
    Boolean(step.guide) ||
    Boolean(step.deliverNote) ||
    Boolean(step.videoUrl);
  const editable = step.state === 'active' || step.state === 'rejected';
  const submission = step.submission;

  const handleSkipRequest = async (): Promise<void> => {
    const reason = skipReason.trim();
    if (reason.length < 5) {
      toast.error('请填写跳过理由（至少 5 个字）');
      return;
    }
    setSkipping(true);
    try {
      await myApi.submitTutorialSkipRequest(caseId, step.id, reason);
      toast.success('跳过申请已提交，等待审核');
      setSkipOpen(false);
      setSkipReason('');
      onSubmitted();
    } catch (err: unknown) {
      toast.error(extractBackendMessage(err) ?? '提交跳过申请失败，请稍后重试');
    } finally {
      setSkipping(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    for (const m of step.materials) {
      if (!m.required) continue;
      const v = values[m.key];
      const empty = Array.isArray(v)
        ? v.length === 0
        : v == null || String(v).trim() === '';
      if (empty) {
        toast.error(`请填写必填材料「${m.label}」`);
        return;
      }
    }
    if (step.requireConfirm && !confirmed) {
      toast.error('请先勾选完成确认');
      return;
    }
    setSubmitting(true);
    try {
      const body: SubmitTutorialStepRequest = {
        data: values,
        confirmed: step.requireConfirm ? true : undefined,
      };
      await myApi.submitTutorialStep(caseId, step.id, body);
      toast.success(
        step.requireReview ? '已提交，等待导师审核' : '已提交，本步骤完成',
      );
      setExpanded(false);
      onSubmitted();
    } catch (err: unknown) {
      toast.error(extractBackendMessage(err) ?? '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const header = (
    <div className="flex w-full items-center gap-2.5">
      {stepIcon(step.state)}
      <span
        className={`min-w-0 flex-1 truncate text-sm font-medium ${
          locked ? 'text-muted-foreground/60' : ''
        }`}
      >
        {step.title}
      </span>
      {step.requireReview && !locked ? (
        <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">
          需审核
        </span>
      ) : null}
      {hasGuideMeta ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="查看步骤指引"
          onClick={(e: MouseEvent<HTMLSpanElement>) => {
            e.stopPropagation();
            setShowGuide(!showGuide);
          }}
          className={`shrink-0 rounded-full p-0.5 transition-colors ${
            showGuide
              ? 'text-primary'
              : 'text-muted-foreground/70 hover:text-primary'
          }`}
        >
          <HelpCircle className="h-4 w-4" />
        </span>
      ) : null}
      <span
        className={`shrink-0 text-xs ${labelClass(step.state)} ${
          locked ? 'text-muted-foreground/60' : ''
        }`}
      >
        {stepLabel(step.state)}
      </span>
      <ChevronDown
        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
          expanded ? 'rotate-180' : ''
        }`}
      />
    </div>
  );

  const renderEditableBody = () => (
    <>
      {step.warnText ? <StepWarnNote text={step.warnText} /> : null}
      {step.state === 'rejected' ? (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <CircleAlert className="h-4 w-4" />
            导师驳回了本次提交，请修改后重新提交
          </p>
          {submission?.reviewNote ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
              驳回原因：{submission.reviewNote}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 space-y-4">
        <p className="text-xs font-medium text-muted-foreground">提交材料</p>
        {step.materials.length > 0 ? (
          step.materials.map((m: TutorialCaseMaterial) => (
            <TutorialMaterialField
              key={m.key}
              material={m}
              value={values[m.key]}
              onChange={(v: unknown) =>
                setValues((prev) => ({ ...prev, [m.key]: v }))
              }
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">本步骤无需提交材料</p>
        )}
      </div>
      {step.requireConfirm ? (
        <div className="mt-4 flex items-start gap-2">
          <Checkbox
            id={`tutorial-confirm-${step.id}`}
            checked={confirmed}
            onCheckedChange={(v: boolean | 'indeterminate') =>
              setConfirmed(v === true)
            }
            className="mt-0.5"
          />
          <label
            htmlFor={`tutorial-confirm-${step.id}`}
            className="text-sm text-muted-foreground"
          >
            我确认已按指引完成本步骤要求的全部操作
          </label>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          data-ai-section-type="button"
          disabled={submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting
            ? '提交中…'
            : step.state === 'rejected'
              ? '重新提交'
              : step.requireReview
                ? '提交待审核'
                : '提交并完成'}
        </Button>
        {step.skipRequestStatus === 'pending' ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-sm text-blue-500/80">
            <Clock3 className="h-4 w-4" />
            跳过审核中
          </span>
        ) : (
          <Button
            data-ai-section-type="button"
            variant="outline"
            className="text-muted-foreground"
            disabled={skipping}
            onClick={() => {
              setSkipReason('');
              setSkipOpen(true);
            }}
          >
            <SkipForward className="h-4 w-4" />
            申请跳过
          </Button>
        )}
      </div>
      {step.skipRequestStatus === 'rejected' && step.skipReviewerNote ? (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <CircleAlert className="h-4 w-4" />
            上次跳过申请被拒绝
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
            拒绝原因：{step.skipReviewerNote}
          </p>
        </div>
      ) : null}
    </>
  );

  const renderSkippedBody = () => (
    <div className="mt-4 rounded-lg bg-muted/40 p-3">
      <p className="text-sm text-muted-foreground">
        已于 {submission?.submittedAt ?? '—'} 跳过本步骤，无法再补充材料，跳过记录会保留在教程档案中。
      </p>
    </div>
  );

  const renderReadonlyBody = () => (
    <div className="mt-4 space-y-3 rounded-lg bg-muted/40 p-3">
      {submission ? (
        <>
          <p className="text-xs text-muted-foreground">
            提交于 {submission.submittedAt ?? '—'}
            {step.state === 'approved' && submission.reviewedAt
              ? ` · 审核于 ${submission.reviewedAt}`
              : ''}
          </p>
          {step.materials.length > 0 ? (
            step.materials.map((m: TutorialCaseMaterial) => (
              <TutorialMaterialValue
                key={m.key}
                material={m}
                value={submission.data?.[m.key] ?? values[m.key]}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">本步骤无材料要求</p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">暂无提交记录</p>
      )}
    </div>
  );

  const renderLockedPreviewBody = () => (
    <div className="mt-4 space-y-3 rounded-lg bg-muted/40 p-3">
      {step.warnText ? <StepWarnNote text={step.warnText} /> : null}
      <StepMaterialsPreview materials={step.materials} />
      <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        教程内容可随时预览，不受前序步骤限制；提交材料入口在前序步骤完成后解锁。
      </p>
    </div>
  );

  return (
    <>
      <Card className={`rounded-xl ${cardClass(step.state)}`}>
        <CardContent className="p-5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={`w-full text-left ${locked ? 'opacity-70' : ''}`}
          >
            {header}
          </button>
          {showGuide ? (
            <StepGuidePanel
              guide={step.guide}
              deliverNote={step.deliverNote}
              videoUrl={step.videoUrl}
            />
          ) : null}
          {expanded
            ? locked
              ? renderLockedPreviewBody()
              : editable
                ? renderEditableBody()
                : step.state === 'skipped'
                  ? renderSkippedBody()
                  : renderReadonlyBody()
            : null}
        </CardContent>
      </Card>
      <Dialog open={skipOpen} onOpenChange={setSkipOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>申请跳过这一步？</DialogTitle>
            <DialogDescription>
              申请提交后由老板审核，审核通过本步骤才会跳过；请如实填写理由。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              警告：跳过必须符合真实业务（已做过前置工作或业务已中断），虚报将按绩效制度惩罚
            </div>
            {step.skipRequestStatus === 'rejected' && step.skipReviewerNote ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">上次申请被拒绝</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-destructive/90">
                  拒绝原因：{step.skipReviewerNote}
                </p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <label htmlFor={`skip-reason-${step.id}`} className="text-sm font-medium">
                跳过理由
                <span className="ml-0.5 text-destructive">*</span>
              </label>
              <Textarea
                id={`skip-reason-${step.id}`}
                value={skipReason}
                rows={4}
                placeholder="请说明真实业务背景，例如已做过前置工作、业务已中断等（至少 5 个字）"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  setSkipReason(e.target.value)
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={skipping}
              onClick={() => setSkipOpen(false)}
            >
              取消
            </Button>
            <Button
              data-ai-section-type="button"
              disabled={skipping}
              onClick={() => void handleSkipRequest()}
            >
              {skipping ? '提交中…' : '提交申请'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
