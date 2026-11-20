import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Link2,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchTutorialReviewQueue,
  submitTutorialReviewVerdict,
} from '@client/src/api/admin';
import type { TutorialReviewItem } from '@shared/api.interface';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

const IMAGE_TYPES = new Set(['image']);

function formatSubmittedAt(iso: string): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

interface ImageViewerState {
  urls: string[];
  index: number;
}

const TutorialReviewTab: React.FC = () => {
  const [items, setItems] = useState<TutorialReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectingItem, setRejectingItem] = useState<TutorialReviewItem | null>(
    null,
  );
  const [rejectComment, setRejectComment] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);
  const [viewer, setViewer] = useState<ImageViewerState | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchTutorialReviewQueue();
      setItems(response.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取教程待审队列失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApprove = useCallback(
    async (item: TutorialReviewItem) => {
      setActingId(item.submissionId);
      try {
        await submitTutorialReviewVerdict(item.submissionId, {
          action: 'approved',
        });
        toast.success(`已通过：${item.stepTitle}`);
        setItems((prev) =>
          prev
            ? prev.filter(
                (it: TutorialReviewItem) =>
                  it.submissionId !== item.submissionId,
              )
            : prev,
        );
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : '审核通过操作失败',
        );
      } finally {
        setActingId(null);
      }
    },
    [],
  );

  const handleRejectConfirm = useCallback(async () => {
    if (!rejectingItem) return;
    const comment = rejectComment.trim();
    if (comment === '') {
      toast.error('请填写打回意见');
      return;
    }
    setActingId(rejectingItem.submissionId);
    try {
      await submitTutorialReviewVerdict(rejectingItem.submissionId, {
        action: 'rejected',
        comment,
      });
      toast.success(`已打回：${rejectingItem.stepTitle}`);
      const removedId = rejectingItem.submissionId;
      setItems((prev) =>
        prev
          ? prev.filter(
              (it: TutorialReviewItem) => it.submissionId !== removedId,
            )
          : prev,
      );
      setRejectingItem(null);
      setRejectComment('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打回操作失败');
    } finally {
      setActingId(null);
    }
  }, [rejectingItem, rejectComment]);

  const openRejectDialog = useCallback((item: TutorialReviewItem) => {
    setRejectingItem(item);
    setRejectComment('');
  }, []);

  if (error !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (!items) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        暂无待审核的教程材料
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item: TutorialReviewItem) => {
        return (
          <div
            key={item.submissionId}
            className="rounded-xl border p-5"
            data-ai-section-type="card-list"
          >
            <div className="space-y-1">
              <p className="text-base font-semibold">{item.caseTitle}</p>
              <p className="text-xs text-muted-foreground">
                {item.projectName}
                {item.stageTitle ? ` · ${item.stageTitle}` : ''}
              </p>
              <p className="text-sm">
                步骤 {item.stepSort} · {item.stepTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                提交于 {formatSubmittedAt(item.submittedAt)}
              </p>
            </div>

            {item.materials.length > 0 && (
              <div className="mt-4 space-y-3">
                {item.materials.map((material) => (
                  <div key={material.key} className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {material.name}
                    </p>
                    {IMAGE_TYPES.has(material.type) ? (
                      material.value.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {material.value.map((url: string, idx: number) => (
                            <button
                              key={`${material.key}-${idx}`}
                              type="button"
                              className="overflow-hidden rounded-lg border"
                              onClick={() =>
                                setViewer({
                                  urls: material.value,
                                  index: idx,
                                })
                              }
                            >
                              <Image
                                src={url}
                                alt={`${material.name} ${idx + 1}`}
                                width={96}
                                height={96}
                                className="h-24 w-24 object-cover"
                              />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          未提交图片
                        </p>
                      )
                    ) : material.type === 'video' ||
                      material.type === 'file' ? (
                      material.value.length > 0 ? (
                        <div className="space-y-1.5">
                          {material.value.map((url: string, idx: number) => (
                            <UniversalLink
                              key={`${material.key}-${idx}`}
                              to={url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-primary hover:underline"
                            >
                              <Link2 className="h-3.5 w-3.5 shrink-0" />
                              <span className="break-all">
                                {material.name}
                                {material.value.length > 1
                                  ? ` ${idx + 1}`
                                  : ''}
                              </span>
                            </UniversalLink>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          未提交文件
                        </p>
                      )
                    ) : material.value.length > 0 ? (
                      <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="break-words whitespace-pre-wrap">
                          {material.value.join('\n')}
                        </span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">未填写</p>
                    )}
                  </div>
                ))}
              </div>
            )}


            <div className="mt-4 flex gap-2">
              <Button
                className="bg-green-600 text-white hover:bg-green-700"
                size="sm"
                disabled={actingId !== null}
                onClick={() => void handleApprove(item)}
              >
                通过
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={actingId !== null}
                onClick={() => openRejectDialog(item)}
              >
                打回
              </Button>
            </div>
          </div>
        );
      })}

      <Dialog
        open={rejectingItem !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setRejectingItem(null);
            setRejectComment('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>打回教程材料</DialogTitle>
            <DialogDescription>
              打回后会通知案例作者重新提交或跳过，请填写打回意见。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={rejectComment}
            placeholder="打回意见（必填）"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setRejectComment(e.target.value)
            }
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={actingId !== null}
              onClick={() => {
                setRejectingItem(null);
                setRejectComment('');
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={actingId !== null}
              onClick={() => void handleRejectConfirm()}
            >
              确认打回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={viewer !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setViewer(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              图片 {viewer ? viewer.index + 1 : 0} /{' '}
              {viewer ? viewer.urls.length : 0}
            </DialogTitle>
          </DialogHeader>
          {viewer && viewer.urls.length > 0 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="icon"
                disabled={viewer.urls.length <= 1}
                onClick={() =>
                  setViewer({
                    urls: viewer.urls,
                    index:
                      (viewer.index - 1 + viewer.urls.length) %
                      viewer.urls.length,
                  })
                }
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Image
                src={viewer.urls[viewer.index]}
                alt={`图片 ${viewer.index + 1}`}
                className="max-h-[60vh] w-auto object-contain"
              />
              <Button
                variant="outline"
                size="icon"
                disabled={viewer.urls.length <= 1}
                onClick={() =>
                  setViewer({
                    urls: viewer.urls,
                    index: (viewer.index + 1) % viewer.urls.length,
                  })
                }
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TutorialReviewTab;
