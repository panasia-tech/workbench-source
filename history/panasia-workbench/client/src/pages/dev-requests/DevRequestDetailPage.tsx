import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ChevronLeft, CircleAlert, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  devRequestErrorMessage,
  devRequestErrorStatus,
  fetchDevRequest,
} from '@client/src/api/dev-requests';
import type { DevRequestDetail } from '@shared/api.interface';
import { DevRequestActionBar } from './DevRequestActionBar';
import DevRequestTimeline from './DevRequestTimeline';
import {
  FLOW_STEPS,
  STAGE_TONE,
  flowIndexOf,
  formatDateTime,
  formatHours,
  formatYuan,
} from './dev-request-ui';

const NOT_FOUND_TEXT = '开发需求不存在，或不是你发的、派给你的';

const ROLE_TEXT: Record<DevRequestDetail['myRole'], string> = {
  publisher: '你是发布人',
  developer: '你是开发者',
  boss: '你是老板',
  viewer: '只读',
};

/** 五步进度：走到哪一步高亮（等宽小格，手机上一行放得下）；撤销、流程外的不显示 */
function FlowSteps({ detail }: { detail: DevRequestDetail }) {
  const current = flowIndexOf(detail.stage);
  if (current < 0) return null;
  return (
    <div className="grid grid-cols-5 gap-1">
      {FLOW_STEPS.map((step, index: number) => (
        <span
          key={step.stage}
          className={`truncate rounded-md px-1 py-1 text-center text-[11px] ${
            index < current
              ? 'bg-green-50 text-green-700'
              : index === current
                ? 'bg-primary font-medium text-primary-foreground'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {step.label}
        </span>
      ))}
    </div>
  );
}

const DevRequestDetailPage = () => {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<DevRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchDevRequest(id)
      .then((data: DevRequestDetail) => {
        setDetail(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          devRequestErrorStatus(err) === 404
            ? NOT_FOUND_TEXT
            : devRequestErrorMessage(err, '开发需求加载失败，请稍后重试'),
        );
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const back = (
    <Link
      to="/dev-requests"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
    >
      <ChevronLeft className="h-4 w-4" />
    </Link>
  );

  if (loading && !detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-4">
        {back}
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error ?? '开发需求加载失败'}
        </div>
        {error !== NOT_FOUND_TEXT ? (
          <Button variant="outline" onClick={load}>
            <RotateCcw className="h-4 w-4" />
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  const quote = detail.quote;
  const showNextCard =
    detail.actions.length > 0 ||
    (!detail.warning && !['done', 'cancelled', 'missing'].includes(detail.stage));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        {back}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STAGE_TONE[detail.stage]}`}>
              {detail.stageLabel}
            </span>
            <span className="text-xs text-muted-foreground">
              #{detail.sequenceId ?? '—'} · {detail.projectName} · {ROLE_TEXT[detail.myRole]}
            </span>
          </div>
          <h1 className="mt-1 break-words text-xl font-semibold">{detail.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {detail.publisherName} 发给 {detail.developerName} · {formatDateTime(detail.createdAt)}
          </p>
        </div>
      </div>

      <FlowSteps detail={detail} />

      {detail.warning ? (
        <div className="flex items-start gap-2 rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm text-orange-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {detail.warning}
        </div>
      ) : null}

      {showNextCard ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">下一步</CardTitle>
          </CardHeader>
          <CardContent>
            <DevRequestActionBar detail={detail} onDone={load} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">需求</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {detail.description ? (
            <p className="whitespace-pre-wrap break-words text-sm">{detail.description}</p>
          ) : (
            <p className="text-sm text-muted-foreground">没写需求说明</p>
          )}
          <p className="rounded-md bg-blue-50/60 px-3 py-2 text-sm">
            <span className="font-medium text-blue-700">验收条件：</span>
            <span className="break-words">{detail.acceptance ?? '没写'}</span>
          </p>
        </CardContent>
      </Card>

      {quote || detail.finalAmount !== null ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">报价与记账</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {quote ? (
              <>
                <p>
                  <span className="text-lg font-semibold">{formatYuan(quote.amount)}</span>
                  <span className="ml-2 text-muted-foreground">{formatHours(quote.hours)}</span>
                  {quote.promisedDate ? (
                    <span className="ml-2 text-muted-foreground">承诺 {quote.promisedDate} 前交付</span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {quote.quotedByName ?? '开发者'} 报价于 {formatDateTime(quote.quotedAt)}
                  {quote.confirmedAt
                    ? ` · ${quote.confirmedByName ?? '发布人'} 确认于 ${formatDateTime(quote.confirmedAt)}`
                    : ' · 等发布人确认'}
                </p>
                {quote.note ? (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">{quote.note}</p>
                ) : null}
              </>
            ) : null}
            {detail.finalAmount !== null ? (
              <p className="rounded-md bg-green-50 px-3 py-2 text-green-700">
                已验收记账 {formatYuan(detail.finalAmount)}
                {detail.adjustReason ? `（调整原因：${detail.adjustReason}）` : ''}
                {detail.acceptedByName ? ` · ${detail.acceptedByName}` : ''}
                {detail.acceptedAt ? ` · ${formatDateTime(detail.acceptedAt)}` : ''}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {detail.delivery ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">交付</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap break-words">{detail.delivery.note}</p>
            {detail.delivery.links.length > 0 ? (
              <ul className="space-y-1">
                {detail.delivery.links.map((link: string) => (
                  <li key={link} className="truncate">
                    <a href={link} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">交付于 {formatDateTime(detail.delivery.deliveredAt)}</p>
          </CardContent>
        </Card>
      ) : null}

      {detail.cancelReason ? (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          撤销原因：{detail.cancelReason}
        </p>
      ) : null}

      <section>
        <h2 className="mb-3 text-base font-semibold">记录</h2>
        <Card>
          <CardContent className="p-5">
            <DevRequestTimeline events={detail.events} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default DevRequestDetailPage;
