import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { workordersApi } from '@client/src/api';
import EvidenceThumbnails from '@/components/EvidenceThumbnails';
import { EvidenceUploader, type EvidenceFile } from './EvidenceUploader';
import type { WorkOrderDetail } from '@shared/api.interface';

interface WorkOrderEvidenceDialogProps {
  order: WorkOrderDetail | null;
  onClose: () => void;
  onSubmitted: (detail: WorkOrderDetail) => void;
}

/**
 * 工单凭证提交弹窗：按 checklist 逐项上传（wb-files 网关，前端只传 URL）。
 */
export function WorkOrderEvidenceDialog({
  order,
  onClose,
  onSubmitted,
}: WorkOrderEvidenceDialogProps) {
  const [filesByKey, setFilesByKey] = useState<Record<string, EvidenceFile[]>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (order !== null) setFilesByKey({});
  }, [order]);

  if (order === null) return null;

  const setFiles = (key: string, files: EvidenceFile[]) => {
    setFilesByKey((prev: Record<string, EvidenceFile[]>) => ({
      ...prev,
      [key]: files,
    }));
  };

  const submit = () => {
    const items = order.checklist
      .filter((item) => (filesByKey[item.key] ?? []).length > 0)
      .map((item) => ({
        itemKey: item.key,
        fileUrls: (filesByKey[item.key] ?? []).map(
          (f: EvidenceFile) => f.url,
        ),
      }));
    if (items.length === 0) {
      toast.error('请至少为一个凭证项上传文件');
      return;
    }
    setSubmitting(true);
    workordersApi
      .submitWorkOrderEvidence(order.id, { items })
      .then((result) => {
        onSubmitted(result.workOrder);
      })
      .catch(() => {
        toast.error('凭证提交失败，请稍后重试');
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>提交工单凭证（{order.code}）</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <p className="text-sm text-muted-foreground">
            必传凭证齐全后自动进行规则初审，通过即提交老板终审；不齐将退回「需修改」。
          </p>
          {order.checklist.map((item) => {
            const existing = order.evidence.find(
              (e) => e.itemKey === item.key,
            );
            const required = item.required !== false;
            return (
              <div
                key={item.key}
                className="space-y-2 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  {item.onSite ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      需现场
                    </span>
                  ) : null}
                  {required ? (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">
                      必传
                    </span>
                  ) : (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      选传
                    </span>
                  )}
                  {existing && existing.fileUrls.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      已传 {existing.fileUrls.length} 个
                    </span>
                  ) : null}
                </div>
                {existing && existing.fileUrls.length > 0 ? (
                  <EvidenceThumbnails
                    urls={existing.fileUrls}
                    label={existing.itemName ?? '已传凭证'}
                  />
                ) : null}
                <EvidenceUploader
                  files={filesByKey[item.key] ?? []}
                  onChange={(files: EvidenceFile[]) =>
                    setFiles(item.key, files)
                  }
                />
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" />
                提交中
              </span>
            ) : (
              '提交凭证'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
