import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  FolderGit2,
  Hourglass,
  RefreshCw,
  User,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchBlockDeferReviews, submitBlockDeferVerdict } from '@client/src/api/admin';
import { useOptionalIntegrations } from '@client/src/hooks/use-optional-integrations';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { BlockDeferReviewItem } from '@shared/api.interface';
import ReviewVerdictDialog from './ReviewVerdictDialog';

interface DeferVerdictTarget {
  id: string;
  title: string;
  action: 'approve' | 'reject';
}

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const StatusBadge: React.FC<{ status: BlockDeferReviewItem['status'] }> = ({
  status,
}) => {
  if (status === 'ai_passed') {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-purple-500/40 bg-purple-500/10 text-purple-600"
      >
        <CheckCircle2 className="h-3 w-3" />
        待老板终审
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-blue-500/40 bg-blue-500/10 text-blue-600"
    >
      <Hourglass className="h-3 w-3" />
      AI 初审中
    </Badge>
  );
};

const DeferCard: React.FC<{
  item: BlockDeferReviewItem;
  onVerdict: (target: DeferVerdictTarget) => void;
}> = ({ item, onVerdict }) => {
  const isAiPassed = item.status === 'ai_passed';
  return (
    <div className="space-y-3 rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-base font-semibold break-words">
          {item.sequenceId !== null && (
            <span className="mr-1 text-muted-foreground">#{item.sequenceId}</span>
          )}
          {item.title}
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <User className="h-3.5 w-3.5" />
          {item.assigneeName}
        </span>
        <span className="flex items-center gap-1">
          <FolderGit2 className="h-3.5 w-3.5" />
          {item.projectName}
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {item.originalDeadline ?? '--:--'} → {item.requestedDeadline}
          （+{item.deferMinutes} 分钟）
        </span>
        <span>申请于 {formatTime(item.requestedAt)}</span>
      </div>

      <div className="space-y-2 text-sm">
        <div>
          <span className="text-xs text-muted-foreground">阻塞分类：</span>
          <Badge variant="secondary" className="text-xs">
            {item.category}
          </Badge>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">阻塞原因：</span>
          <span className="break-words">{item.reason}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">解决情况和方案：</span>
          <span className="break-words">{item.resolution}</span>
        </div>
      </div>

      {item.aiOpinion !== null && item.aiOpinion !== '' && (
        <div className="flex gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-sm text-blue-700 dark:text-blue-300">
          <Bot className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="text-xs font-semibold">AI 初审意见</div>
            <p className="mt-0.5 break-words leading-relaxed">{item.aiOpinion}</p>
          </div>
        </div>
      )}

      {item.sopTitle !== null && item.sopTitle !== '' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          已生成 SOP：{item.sopTitle}
        </div>
      )}

      {isAiPassed ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={() => onVerdict({ id: item.id, title: item.title, action: 'approve' })}
          >
            <CheckCircle2 className="h-4 w-4" />
            批准顺延
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onVerdict({ id: item.id, title: item.title, action: 'reject' })}
          >
            <XCircle className="h-4 w-4" />
            拒绝
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          豆包 AI 初审中，通过后自动进入老板终审。
        </p>
      )}
    </div>
  );
};

/** 验收 Dock · 顺延审核区：老板终审（开了顺延 AI 初审时先过豆包，双闸） */
const BlockDeferReviewSection: React.FC = () => {
  const deferAiEnabled = useOptionalIntegrations()?.aiBlockDeferReview === true;
  const [items, setItems] = useState<BlockDeferReviewItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DeferVerdictTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBlockDeferReviews();
      setItems(data.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : '获取顺延审核列表失败';
      setError(message);
      logger.error('顺延审核列表加载失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmVerdict = (comment: string): void => {
    if (!dialog) return;
    const target = dialog;
    setSubmitting(true);
    submitBlockDeferVerdict(target.id, {
      action: target.action,
      ...(comment !== '' ? { comment } : {}),
    })
      .then((data) => {
        setItems(data.items);
        toast.success(
          target.action === 'approve'
            ? '已批准顺延，任务结束时间已顺延'
            : '已拒绝该顺延申请',
        );
        setDialog(null);
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : '顺延审核操作失败，请稍后重试',
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <div
      data-ai-section-type="card-list"
      className="space-y-4 rounded-xl border bg-card p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <ClipboardList className="h-4 w-4 text-primary" />
          顺延审核
        </h2>
        <Badge variant="secondary" className="text-xs">
          待处理 {items?.length ?? 0}
        </Badge>
      </div>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      )}

      {!loading && error !== null && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>顺延审核加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && error === null && (items ?? []).length === 0 && (
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <ClipboardList className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">暂无顺延申请</p>
          <p className="text-xs text-muted-foreground">
            员工提交堵塞时可申请顺延任务结束时间，
            {deferAiEnabled ? '经 AI 初审与你终审后生效。' : '经你终审后生效。'}
          </p>
        </div>
      )}

      {!loading && error === null && (
        <div className="space-y-4">
          {(items ?? []).map((item: BlockDeferReviewItem) => (
            <DeferCard
              key={item.id}
              item={item}
              onVerdict={(target: DeferVerdictTarget) => setDialog(target)}
            />
          ))}
        </div>
      )}

      {dialog && (
        <ReviewVerdictDialog
          open
          title={`${dialog.action === 'approve' ? '批准' : '拒绝'}顺延申请`}
          description={
            dialog.action === 'approve'
              ? `通过后「${dialog.title}」的结束时间将按申请顺延。`
              : `拒绝后「${dialog.title}」将退回原结束时间。`
          }
          confirmLabel={dialog.action === 'approve' ? '确认批准' : '确认拒绝'}
          destructive={dialog.action === 'reject'}
          submitting={submitting}
          onConfirm={confirmVerdict}
          onOpenChange={(open: boolean) => {
            if (!open) setDialog(null);
          }}
        />
      )}
    </div>
  );
};

export default BlockDeferReviewSection;
