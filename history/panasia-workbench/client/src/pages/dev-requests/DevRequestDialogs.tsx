import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  acceptDevRequest,
  cancelDevRequest,
  clarifyDevRequest,
  confirmDevRequestQuote,
  deliverDevRequest,
  devRequestErrorMessage,
  quoteDevRequest,
  rejectDevRequestDelivery,
  rejectDevRequestQuote,
  returnDevRequest,
} from '@client/src/api/dev-requests';
import { EvidenceUploader, type EvidenceFile } from '../tasks/EvidenceUploader';
import type { DevRequestActionResponse, DevRequestDetail } from '@shared/api.interface';
import { formatHours, formatYuan, parseAmountInput, todayShanghai } from './dev-request-ui';

export type DevRequestDialogKind =
  | 'quote'
  | 'return'
  | 'clarify'
  | 'confirm_quote'
  | 'reject_quote'
  | 'deliver'
  | 'accept'
  | 'reject_delivery'
  | 'cancel'
  | null;

type ReasonKind = 'return' | 'reject_quote' | 'reject_delivery' | 'cancel';

const REASON_COPY: Record<ReasonKind, { title: string; label: string; placeholder: string; submit: string }> = {
  return: {
    title: '退回补充',
    label: '要发布人补充什么',
    placeholder: '例如：要导出哪些字段？给个样例表',
    submit: '退回',
  },
  reject_quote: {
    title: '退回报价',
    label: '为什么退回',
    placeholder: '例如：工时偏多，先做筛选，导出放下一期',
    submit: '退回报价',
  },
  reject_delivery: {
    title: '打回',
    label: '哪里没达到验收条件',
    placeholder: '例如：导出的表缺供应商电话',
    submit: '打回',
  },
  cancel: {
    title: '撤销需求',
    label: '撤销原因',
    placeholder: '例如：需求取消了',
    submit: '撤销',
  },
};

interface DevRequestDialogsProps {
  detail: DevRequestDetail;
  kind: DevRequestDialogKind;
  onClose: () => void;
  onDone: () => void;
}

/** 开发需求各动作的弹窗：报价、退回补充、补充需求、确认 / 退回报价、交付、验收 / 打回、撤销 */
export function DevRequestDialogs({ detail, kind, onClose, onDone }: DevRequestDialogsProps) {
  const [submitting, setSubmitting] = useState(false);
  const [hours, setHours] = useState('');
  const [amount, setAmount] = useState('');
  const [promisedDate, setPromisedDate] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [linksText, setLinksText] = useState('');
  const [finalAmount, setFinalAmount] = useState('');

  useEffect(() => {
    if (!kind) return;
    setNote('');
    setReason('');
    setFiles([]);
    setLinksText('');
    setHours('');
    setAmount('');
    setPromisedDate('');
    setDescription(detail.description);
    setAcceptance(detail.acceptance ?? '');
    setFinalAmount(detail.quote ? String(detail.quote.amount) : '');
  }, [kind, detail]);

  const run = (work: () => Promise<DevRequestActionResponse>) => {
    setSubmitting(true);
    work()
      .then((result: DevRequestActionResponse) => {
        toast.success(result.message);
        onClose();
        onDone();
      })
      .catch((err: unknown) => toast.error(devRequestErrorMessage(err, '操作失败，请稍后重试')))
      .finally(() => setSubmitting(false));
  };

  const submitQuote = () => {
    const hoursValue = Number(hours);
    if (!Number.isFinite(hoursValue) || hoursValue <= 0 || !/^\d+(\.\d{1,2})?$/u.test(hours.trim())) {
      toast.error('工时要大于 0，最多两位小数');
      return;
    }
    const amountValue = parseAmountInput(amount);
    if (amountValue === null) {
      toast.error('报价要填金额（元），最多两位小数');
      return;
    }
    run(() =>
      quoteDevRequest(detail.id, {
        hours: hoursValue,
        amount: amountValue,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(promisedDate ? { promisedDate } : {}),
      }),
    );
  };

  const submitReason = (reasonKind: ReasonKind) => {
    const value = reason.trim();
    if (value.length < 2) {
      toast.error(`请写${REASON_COPY[reasonKind].label}（至少 2 个字）`);
      return;
    }
    const work = {
      return: () => returnDevRequest(detail.id, value),
      reject_quote: () => rejectDevRequestQuote(detail.id, value),
      reject_delivery: () => rejectDevRequestDelivery(detail.id, value),
      cancel: () => cancelDevRequest(detail.id, value),
    }[reasonKind];
    run(work);
  };

  const submitClarify = () => {
    if (!description.trim() || !acceptance.trim()) {
      toast.error('需求说明和验收条件都要写');
      return;
    }
    run(() =>
      clarifyDevRequest(detail.id, {
        description: description.trim(),
        acceptance: acceptance.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
  };

  const submitDeliver = () => {
    if (note.trim().length < 2) {
      toast.error('请写交付说明（至少 2 个字）');
      return;
    }
    const pasted = linksText
      .split(/\s+/u)
      .map((link: string) => link.trim())
      .filter((link: string) => link !== '');
    if (pasted.some((link: string) => !/^https?:\/\//iu.test(link))) {
      toast.error('链接要以 http:// 或 https:// 开头');
      return;
    }
    run(() =>
      deliverDevRequest(detail.id, {
        note: note.trim(),
        links: [...files.map((file: EvidenceFile) => file.url), ...pasted],
      }),
    );
  };

  const quoteAmount = detail.quote?.amount ?? 0;
  const finalValue = parseAmountInput(finalAmount);
  const adjusted = finalValue !== null && Math.round(finalValue * 100) !== Math.round(quoteAmount * 100);

  const submitAccept = () => {
    if (finalValue === null) {
      toast.error('验收金额要填数字（元），最多两位小数');
      return;
    }
    if (adjusted && reason.trim().length < 2) {
      toast.error('验收金额和报价不一样，要写调整原因');
      return;
    }
    run(() =>
      acceptDevRequest(detail.id, {
        finalAmount: finalValue,
        ...(adjusted ? { adjustReason: reason.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
  };

  const close = (open: boolean) => {
    if (!open && !submitting) onClose();
  };
  const reasonKind: ReasonKind | null =
    kind === 'return' || kind === 'reject_quote' || kind === 'reject_delivery' || kind === 'cancel'
      ? kind
      : null;
  const quoteLine = detail.quote
    ? `${formatHours(detail.quote.hours)} · ${formatYuan(detail.quote.amount)}`
    : '';

  return (
    <>
      <Dialog open={kind === 'quote'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>报价</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-sm text-muted-foreground">工时（小时）</p>
                <Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="例如 6" />
              </div>
              <div>
                <p className="mb-1 text-sm text-muted-foreground">价格（元）</p>
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="例如 1200" />
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">承诺交付日期（可不填）</p>
              <Input type="date" min={todayShanghai()} value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">说明（可不填）</p>
              <Textarea rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="怎么做、哪些不含" />
            </div>
            <p className="text-xs text-muted-foreground">价格只记账，不进钱包；发布人确认后才开工。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={submitQuote} disabled={submitting}>提交报价</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reasonKind !== null} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reasonKind ? REASON_COPY[reasonKind].title : ''}</DialogTitle>
          </DialogHeader>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">{reasonKind ? REASON_COPY[reasonKind].label : ''}</p>
            <Textarea rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonKind ? REASON_COPY[reasonKind].placeholder : ''} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button
              variant={reasonKind === 'cancel' || reasonKind === 'reject_delivery' ? 'destructive' : 'default'}
              onClick={() => reasonKind && submitReason(reasonKind)}
              disabled={submitting}
            >
              {reasonKind ? REASON_COPY[reasonKind].submit : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'clarify'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>补充需求</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">需求说明</p>
              <Textarea rows={6} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">验收条件</p>
              <Textarea rows={3} maxLength={500} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">补充了什么（可不填）</p>
              <Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：补了导出字段和样例" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={submitClarify} disabled={submitting}>提交补充</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'confirm_quote'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认报价</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-base font-semibold">{quoteLine}</p>
            {detail.quote?.promisedDate ? (
              <p className="text-muted-foreground">承诺 {detail.quote.promisedDate} 前交付</p>
            ) : null}
            {detail.quote?.note ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{detail.quote.note}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">确认后开发者开工；价格只记账，不进钱包。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={() => run(() => confirmDevRequestQuote(detail.id))} disabled={submitting}>
              确认，开工
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'deliver'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>交付</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {detail.acceptance ? (
              <p className="rounded-md bg-blue-50/60 px-3 py-2 text-sm">
                <span className="font-medium text-blue-700">验收条件：</span>
                {detail.acceptance}
              </p>
            ) : null}
            <div>
              <p className="mb-1 text-sm text-muted-foreground">交付说明</p>
              <Textarea rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="做了什么、怎么验" />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">链接（可不填，空格或换行分隔）</p>
              <Textarea rows={2} value={linksText} onChange={(e) => setLinksText(e.target.value)} placeholder="例如 PR、演示地址" />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">截图 / 录屏（可不传）</p>
              <EvidenceUploader files={files} onChange={setFiles} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={submitDeliver} disabled={submitting}>提交交付</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'accept'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>验收通过</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">确认的报价：{quoteLine}</p>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">记账金额（元）</p>
              <Input inputMode="decimal" value={finalAmount} onChange={(e) => setFinalAmount(e.target.value)} />
            </div>
            {adjusted ? (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">和报价不一样，写调整原因</p>
                <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：导出功能没做，按比例扣" />
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-sm text-muted-foreground">验收意见（可不填）</p>
              <Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">只记进开发需求台账，不进钱包。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={submitAccept} disabled={submitting}>验收通过</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
