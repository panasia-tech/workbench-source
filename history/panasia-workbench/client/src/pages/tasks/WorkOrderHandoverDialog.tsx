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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { workordersApi } from '@client/src/api';
import type {
  WorkOrderDetail,
  WorkOrderHandoverCandidate,
} from '@shared/api.interface';
import { EvidenceUploader, type EvidenceFile } from './EvidenceUploader';

interface WorkOrderHandoverDialogProps {
  order: WorkOrderDetail | null;
  onClose: () => void;
  onDone: (detail: WorkOrderDetail) => void;
}

/** 转交工单：选接手人，写清已做了什么、下一步、材料在哪（文字或附件至少一样） */
export function WorkOrderHandoverDialog({
  order,
  onClose,
  onDone,
}: WorkOrderHandoverDialogProps) {
  const [candidates, setCandidates] = useState<WorkOrderHandoverCandidate[] | null>(null);
  const [toUserId, setToUserId] = useState('');
  const [done, setDone] = useState('');
  const [next, setNext] = useState('');
  const [materials, setMaterials] = useState('');
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (order === null) return;
    setToUserId('');
    setDone('');
    setNext('');
    setMaterials('');
    setFiles([]);
    if (candidates === null) {
      workordersApi
        .fetchHandoverCandidates()
        .then((data) => setCandidates(data.items))
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : '同事名单没加载出来');
        });
    }
  }, [order, candidates]);

  const submit = () => {
    if (order === null) return;
    if (toUserId === '') {
      toast.error('选一下接手人');
      return;
    }
    if (done.trim() === '' || next.trim() === '') {
      toast.error('已做了什么、下一步都要写');
      return;
    }
    if (materials.trim() === '' && files.length === 0) {
      toast.error('写一下材料在哪，或者传个附件');
      return;
    }
    setSubmitting(true);
    workordersApi
      .handoverWorkOrder(order.id, {
        toUserId,
        done: done.trim(),
        next: next.trim(),
        materials: materials.trim(),
        materialUrls: files.map((f: EvidenceFile) => f.url),
      })
      .then((result) => {
        toast.success('已转交');
        onDone(result.workOrder);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '转交失败，请稍后重试');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog
      open={order !== null}
      onOpenChange={(open: boolean) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>转交工单{order ? `（${order.code}）` : ''}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <div>
            <p className="mb-1 text-sm text-muted-foreground">接手人</p>
            <Select value={toUserId} onValueChange={setToUserId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={candidates === null ? '加载中...' : '选同事'} />
              </SelectTrigger>
              <SelectContent>
                {(candidates ?? []).map((item: WorkOrderHandoverCandidate) => (
                  <SelectItem key={item.userId} value={item.userId}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">已做了什么</p>
            <Textarea rows={3} value={done} onChange={(e) => setDone(e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">下一步</p>
            <Textarea rows={2} value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">材料</p>
            <Textarea
              rows={2}
              value={materials}
              onChange={(e) => setMaterials(e.target.value)}
              placeholder="在哪、是什么，链接直接贴"
            />
            <div className="mt-2">
              <EvidenceUploader files={files} onChange={setFiles} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            转交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
