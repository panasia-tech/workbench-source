import React, { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Ban, Check, Clock, Flag, FlagOff, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  BLOCKER_CATEGORY_LABELS,
  PROBLEM_POOL_STATUS_LABELS,
  getProblemPool,
  submitPoolAction,
} from '@client/src/api/problems';
import type {
  ProblemLampConfig,
  ProblemPoolActionRequest,
  ProblemPoolItem,
  ProblemPoolResponse,
  ProblemThresholds,
} from '@shared/api.interface';

const POOL_STATUS_BADGE_CLASS: Record<string, string> = {
  candidate: 'bg-amber-100 text-amber-700',
  confirmed: 'bg-violet-100 text-violet-700',
  dismissed: 'bg-secondary text-secondary-foreground',
  projected: 'bg-emerald-100 text-emerald-700',
  pending_response: 'bg-sky-100 text-sky-700',
};

/** 展示兜底配置（后端 config 未返回时仅用于文案） */
const DEFAULT_LAMP_CONFIG: ProblemLampConfig = {
  bountyAmount: 20,
  slaHours: 4,
};

/** 已等待时长文案：responseAt 起算，分钟级 */
function formatWaitedText(responseAt: string | null | undefined): string {
  if (!responseAt) return '—';
  const minutes = dayjs().diff(dayjs(responseAt), 'minute');
  if (minutes < 60) {
    return `已等待 ${Math.max(minutes, 0)} 分钟`;
  }
  return `已等待 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

interface AdminPoolSectionProps {
  items: ProblemPoolItem[];
  thresholds: ProblemThresholds;
  onChanged: () => void;
}

const AdminPoolSection: React.FC<AdminPoolSectionProps> = ({
  items,
  thresholds,
  onChanged,
}) => {
  const [actingId, setActingId] = useState<string | null>(null);
  const [lampConfig, setLampConfig] =
    useState<ProblemLampConfig>(DEFAULT_LAMP_CONFIG);
  const [rejectTarget, setRejectTarget] = useState<ProblemPoolItem | null>(
    null,
  );
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    getProblemPool()
      .then((response: ProblemPoolResponse) => {
        // config 可选，缺省时沿用 DEFAULT_LAMP_CONFIG 兜底文案
        if (!cancelled && response.config) {
          setLampConfig(response.config);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const act = async (
    item: ProblemPoolItem,
    action: ProblemPoolActionRequest['action'],
    successMessage: string,
    reason?: string,
  ): Promise<void> => {
    setActingId(item.id);
    try {
      await submitPoolAction(
        item.id,
        reason !== undefined ? { action, reason } : { action },
      );
      toast.success(successMessage);
      onChanged();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '操作失败，请稍后重试',
      );
    } finally {
      setActingId(null);
    }
  };

  const confirmReject = async (): Promise<void> => {
    if (rejectTarget === null) return;
    const reason = rejectReason.trim();
    if (reason.length < 2) return;
    await act(rejectTarget, 'reject', '已驳回，原因将反馈给报告员工', reason);
    setRejectTarget(null);
    setRejectReason('');
  };

  const statChip = (label: string, value: string) => (
    <div className="rounded-lg bg-muted/60 px-3 py-1.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );

  // pending_response 卡片置顶（sort 稳定，其余保持后端顺序）
  const sortedItems: ProblemPoolItem[] = [...items].sort(
    (a: ProblemPoolItem, b: ProblemPoolItem) =>
      Number(b.status === 'pending_response') -
      Number(a.status === 'pending_response'),
  );

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">问题池</h2>
        <p className="text-xs text-muted-foreground">
          立项阈值：{thresholds.days} 天内 ≥{thresholds.count} 次 / ≥
          {thresholds.users} 人 / 损失 ≥{thresholds.lossHours}h / 逾期 ≥
          {thresholds.overdue} 次，严重问题单次即候选
        </p>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无聚类问题
          <p className="mt-1 text-xs">
            员工提交的同类阻塞会自动聚类，出现在这里
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedItems.map((item: ProblemPoolItem) => {
            const isCandidate = item.status === 'candidate';
            const isPending = item.status === 'pending_response';
            const dismissed = item.status === 'dismissed';
            const cardBorder = isPending
              ? item.slaExceeded
                ? 'border-2 border-red-500'
                : 'border-amber-500'
              : dismissed
                ? 'opacity-60'
                : '';
            return (
              <div
                key={item.id}
                className={`rounded-xl border p-5 ${cardBorder}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 break-words text-sm font-medium">
                    {item.title}
                  </p>
                  <Badge
                    className={
                      POOL_STATUS_BADGE_CLASS[item.status] ?? ''
                    }
                  >
                    {PROBLEM_POOL_STATUS_LABELS[item.status] ?? item.status}
                  </Badge>
                  {isPending && item.slaExceeded ? (
                    <Badge className="shrink-0 bg-red-100 text-red-700">
                      响应超时
                    </Badge>
                  ) : null}
                  {(item.status === 'confirmed' || item.status === 'projected') &&
                  (item.bountyAmount ?? 0) > 0 ? (
                    <Badge className="shrink-0 bg-amber-100 text-amber-700">
                      <Wallet className="mr-1 h-3 w-3" />
                      已奖励 ¥{item.bountyAmount}
                    </Badge>
                  ) : null}
                  {item.thresholdMet ? (
                    <Badge className="shrink-0 bg-red-100 text-red-700">
                      已命中阈值
                    </Badge>
                  ) : null}
                  {item.manualFlagged ? (
                    <Badge className="shrink-0 bg-violet-100 text-violet-700">
                      手工标记
                    </Badge>
                  ) : null}
                </div>
                {isPending ? (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">
                      报告人：
                      <span className="font-medium text-foreground">
                        {item.reporterName || '未记录'}
                      </span>
                    </span>
                    <span
                      className={`flex items-center gap-1 font-medium ${
                        item.slaExceeded ? 'text-red-600' : 'text-amber-600'
                      }`}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {formatWaitedText(item.responseAt)}
                    </span>
                    <span className="text-muted-foreground">
                      需 {lampConfig.slaHours} 小时内响应
                    </span>
                  </div>
                ) : null}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {statChip(
                    '分类',
                    item.category
                      ? BLOCKER_CATEGORY_LABELS[item.category] ?? item.category
                      : '未分类',
                  )}
                  {statChip('发生', `${item.occurrenceCount} 次`)}
                  {statChip('影响', `${item.affectedUsers} 人`)}
                  {statChip('损失', `${item.totalLossHours}h`)}
                  {statChip('逾期', `${item.overdueCount} 次`)}
                  {statChip(
                    '最近',
                    item.lastOccurredAt
                      ? dayjs(item.lastOccurredAt).format('MM-DD HH:mm')
                      : '—',
                  )}
                </div>
                {item.thresholdMet ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    快照：7 天内 {item.thresholdMet.days7Count ?? 0} 次 ·{' '}
                    {item.thresholdMet.users ?? 0} 人 · 损失{' '}
                    {item.thresholdMet.lossHours ?? 0}h · 逾期{' '}
                    {item.thresholdMet.overdueCount ?? 0} 次
                    {item.thresholdMet.manual ? ' · 手工标记' : ''}
                  </p>
                ) : null}
                {dismissed && item.rejectReason ? (
                  <p className="mt-2 text-xs text-red-600">
                    驳回原因：{item.rejectReason}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {isPending ? (
                    <>
                      <Button
                        size="sm"
                        disabled={actingId === item.id}
                        onClick={() =>
                          act(
                            item,
                            'ack',
                            `已确认有效，奖励 ¥${lampConfig.bountyAmount} 已入员工钱包`,
                          )
                        }
                      >
                        <Check className="h-4 w-4" />
                        确认有效 +¥{lampConfig.bountyAmount}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingId === item.id}
                        onClick={() => {
                          setRejectReason('');
                          setRejectTarget(item);
                        }}
                      >
                        <Ban className="h-4 w-4" />
                        驳回
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingId === item.id}
                        onClick={() =>
                          act(item, 'confirm', '已在 Plane 创建改进项目')
                        }
                      >
                        <Flag className="h-4 w-4" />
                        立项
                      </Button>
                    </>
                  ) : null}
                  {isCandidate ? (
                    <>
                      <Button
                        size="sm"
                        disabled={actingId === item.id}
                        onClick={() =>
                          act(item, 'confirm', '已在 Plane 创建改进项目')
                        }
                      >
                        <Check className="h-4 w-4" />
                        确认立项
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actingId === item.id}
                        onClick={() => act(item, 'dismiss', '已驳回该问题候选')}
                      >
                        <Ban className="h-4 w-4" />
                        驳回
                      </Button>
                    </>
                  ) : null}
                  {!isPending && !isCandidate ? (
                    <>
                      {item.manualFlagged ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actingId === item.id}
                          onClick={() => act(item, 'unflag', '已取消手工标记')}
                        >
                          <FlagOff className="h-4 w-4" />
                          取消标记
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actingId === item.id}
                          onClick={() =>
                            act(item, 'flag', '已手工标记并进入候选')
                          }
                        >
                          <Flag className="h-4 w-4" />
                          标记
                        </Button>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setRejectTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回问题报告</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium text-red-600">
            驳回原因将反馈给报告员工
          </p>
          <Textarea
            value={rejectReason}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setRejectReason(event.target.value)
            }
            placeholder="请填写驳回原因（必填，至少 2 个字）"
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRejectTarget(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={rejectReason.trim().length < 2 || actingId !== null}
              onClick={() => {
                void confirmReject();
              }}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};

export default AdminPoolSection;
