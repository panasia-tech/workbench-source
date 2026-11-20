import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { AcceptanceRecordList } from '@client/src/pages/tasks/WorkOrderAcceptance';
import { ACCEPTANCE_KIND_LABELS } from '@client/src/pages/tasks/workorder-status';
import type {
  AcceptanceRecordCreateRequest,
  AcceptanceRecordView,
  AcceptanceSubjectType,
  SubmissionVersionView,
} from '@shared/api.interface';

type RecordKind = AcceptanceRecordCreateRequest['kind'];
type StateAction = 'pause' | 'resume' | 'exit';

const STATE_ACTION_LABELS: Record<StateAction, string> = {
  pause: '暂停经营批准',
  resume: '恢复经营批准',
  exit: '退出经营批准',
};

interface AcceptancePanelProps {
  subjectType: AcceptanceSubjectType;
  subjectId: string;
  versions: SubmissionVersionView[];
  records: AcceptanceRecordView[];
  onChanged: () => void;
}

/**
 * 验收记录 + 研究通过 / 经营批准 / 上架确认三个按钮（老板 / 管理员）。
 * 三类各记各的：研究通过不等于经营批准，经营批准也不等于已上架；经营批准要写范围，可暂停 / 恢复 / 退出。
 */
const AcceptancePanel: React.FC<AcceptancePanelProps> = ({
  subjectType,
  subjectId,
  versions,
  records,
  onChanged,
}) => {
  const [createKind, setCreateKind] = useState<RecordKind | null>(null);
  const [version, setVersion] = useState('');
  const [scope, setScope] = useState('');
  const [note, setNote] = useState('');
  const [stateTarget, setStateTarget] = useState<{
    record: AcceptanceRecordView;
    action: StateAction;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const openCreate = (kind: RecordKind): void => {
    setCreateKind(kind);
    setVersion(versions[0] ? String(versions[0].version) : '');
    setScope('');
    setNote('');
  };

  const submitCreate = (): void => {
    if (!createKind) return;
    if (createKind === 'business_approval' && scope.trim() === '') {
      toast.error('写清批准的范围');
      return;
    }
    setSubmitting(true);
    workordersApi
      .createAcceptanceRecord({
        subjectType,
        subjectId,
        kind: createKind,
        ...(version !== '' ? { version: Number(version) } : {}),
        ...(scope.trim() !== '' ? { scope: scope.trim() } : {}),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      })
      .then(() => {
        toast.success(`已记${ACCEPTANCE_KIND_LABELS[createKind]}`);
        setCreateKind(null);
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '没记上');
      })
      .finally(() => setSubmitting(false));
  };

  const submitState = (): void => {
    if (!stateTarget) return;
    if (stateTarget.action !== 'resume' && reason.trim() === '') {
      toast.error('要写原因');
      return;
    }
    setSubmitting(true);
    workordersApi
      .changeAcceptanceRecordState(stateTarget.record.id, {
        action: stateTarget.action,
        ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
      })
      .then(() => {
        toast.success('已改');
        setStateTarget(null);
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : '没改成');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="space-y-2">
      <AcceptanceRecordList
        records={records}
        onApprovalAction={(record: AcceptanceRecordView, action: StateAction) => {
          setStateTarget({ record, action });
          setReason('');
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => openCreate('research_pass')}>
          记研究通过
        </Button>
        <Button size="sm" variant="outline" onClick={() => openCreate('business_approval')}>
          给经营批准
        </Button>
        <Button size="sm" variant="outline" onClick={() => openCreate('listing_confirm')}>
          记上架确认
        </Button>
      </div>

      <Dialog
        open={createKind !== null}
        onOpenChange={(open: boolean) => {
          if (!open && !submitting) setCreateKind(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{createKind ? ACCEPTANCE_KIND_LABELS[createKind] : ''}</DialogTitle>
            {createKind === 'business_approval' ? (
              <DialogDescription>只批写明的范围，之后可以暂停、恢复或退出。</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="space-y-3">
            {versions.length > 0 ? (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">依据哪一版</p>
                <Select value={version} onValueChange={setVersion}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((item: SubmissionVersionView) => (
                      <SelectItem key={item.id} value={String(item.version)}>
                        第 {item.version} 版
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {createKind === 'business_approval' ? (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">批准范围</p>
                <Textarea
                  rows={3}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="能做什么、做到多大（品类、数量、金额、渠道）"
                />
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-sm text-muted-foreground">备注（选填）</p>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateKind(null)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submitCreate} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={stateTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open && !submitting) setStateTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{stateTarget ? STATE_ACTION_LABELS[stateTarget.action] : ''}</DialogTitle>
            {stateTarget?.action === 'exit' ? (
              <DialogDescription>退出后不能再恢复，要做得重新批。</DialogDescription>
            ) : null}
          </DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={stateTarget?.action === 'resume' ? '备注（选填）' : '原因（必填）'}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setStateTarget(null)} disabled={submitting}>
              取消
            </Button>
            <Button
              variant={stateTarget?.action === 'exit' ? 'destructive' : 'default'}
              onClick={submitState}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AcceptancePanel;
