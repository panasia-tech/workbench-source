import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface ReviewVerdictDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  /** destructive 时确认按钮为红色（驳回/打回） */
  destructive?: boolean;
  /** 工单终审通过时展示绩效入账金额输入（选填） */
  showPerformanceAmount?: boolean;
  /** 退回、拒绝、打回：必须写原因 */
  requireComment?: boolean;
  submitting: boolean;
  onConfirm: (comment: string, performanceAmount?: number) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * 验收 Dock 通用终审确认弹窗：评论输入 + 确认。
 * 工单终审（通过/驳回）与 Plane 任务验收（通过/打回）共用。
 */
const ReviewVerdictDialog: React.FC<ReviewVerdictDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  showPerformanceAmount = false,
  requireComment = false,
  submitting,
  onConfirm,
  onOpenChange,
}) => {
  const [comment, setComment] = useState('');
  const [amountText, setAmountText] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setComment('');
      setAmountText('');
      setAmountError(null);
      setCommentError(null);
    }
  }, [open]);

  const handleConfirm = (): void => {
    if (requireComment && comment.trim() === '') {
      setCommentError('要写原因');
      return;
    }
    if (showPerformanceAmount) {
      const trimmed = amountText.trim();
      if (trimmed !== '') {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setAmountError('请输入非负数字金额');
          return;
        }
        onConfirm(comment, parsed);
        return;
      }
    }
    onConfirm(comment);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Textarea
          value={comment}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            setComment(e.target.value);
            setCommentError(null);
          }}
          placeholder={
            requireComment ? '原因（必填，员工会看到）' : '评论（可选，将写入流转记录）'
          }
          rows={3}
          disabled={submitting}
        />
        {commentError && <p className="text-xs text-destructive">{commentError}</p>}
        {showPerformanceAmount && (
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium"
              htmlFor="verdict-performance-amount"
            >
              绩效入账金额（¥，选填）
            </label>
            <Input
              id="verdict-performance-amount"
              value={amountText}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setAmountText(e.target.value);
                setAmountError(null);
              }}
              placeholder="例如 100，留空则不入账"
              inputMode="decimal"
              disabled={submitting}
            />
            {amountError && (
              <p className="text-xs text-destructive">{amountError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              填写后终审通过会自动向提交人写入 ERP 绩效入账
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-4 w-4 animate-spin" />
                提交中
              </span>
            ) : (
              confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ReviewVerdictDialog;
