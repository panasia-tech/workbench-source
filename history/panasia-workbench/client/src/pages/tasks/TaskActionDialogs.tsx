import { useEffect, useState } from 'react';
import { BadgeCheck, CircleHelp } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { tasksApi } from '@client/src/api';
import { useOptionalIntegrations } from '@client/src/hooks/use-optional-integrations';
import { EvidenceUploader, type EvidenceFile } from './EvidenceUploader';
import type { TaskActionResult } from '@shared/api.interface';

export type TaskDialogKind = 'block' | 'evidence' | 'assist' | null;

/** 程序类阻塞分类：默认勾选「衍生为问题工单」 */
const DERIVE_PROBLEM_DEFAULT_CATEGORIES = new Set([
  'tool',
  'system',
  'permission',
  'quality',
  'data',
]);

function deriveProblemDefaultForCategory(category: string): boolean {
  return DERIVE_PROBLEM_DEFAULT_CATEGORIES.has(category);
}

const BLOCK_CATEGORIES: { value: string; label: string }[] = [
  { value: 'tool', label: '工具问题' },
  { value: 'system', label: '系统故障' },
  { value: 'permission', label: '权限不足' },
  { value: 'process', label: '流程卡点' },
  { value: 'external_supplier', label: '外部供应商' },
  { value: 'logistics', label: '物流延误' },
  { value: 'customer', label: '客户配合' },
  { value: 'resource', label: '资源缺口' },
  { value: 'knowledge', label: '知识缺失' },
  { value: 'coordination', label: '协同等待' },
  { value: 'quality', label: '质量异常' },
  { value: 'policy', label: '制度合规' },
  { value: 'finance', label: '财务审批' },
  { value: 'data', label: '数据问题' },
  { value: 'other', label: '其他' },
];

interface TaskActionDialogsProps {
  taskId: string;
  projectId: string;
  kind: TaskDialogKind;
  evidenceHint: string | null;
  materials: string[];
  onClose: () => void;
  onDone: () => void;
}

export function TaskActionDialogs({
  taskId,
  projectId,
  kind,
  evidenceHint,
  materials,
  onClose,
  onDone,
}: TaskActionDialogsProps) {
  const [submitting, setSubmitting] = useState(false);
  // 豆包是可选集成：没开 AI 生成 SOP / 顺延 AI 初审时，提示语里不提它们
  const integrations = useOptionalIntegrations();
  const sopEnabled = integrations?.aiSop === true;
  const deferAiEnabled = integrations?.aiBlockDeferReview === true;
  const [blockForm, setBlockForm] = useState({
    reason: '',
    waitingFor: '',
    nextAction: '',
    resolution: '',
    category: 'other',
    deferRequested: false,
    deriveProblem: false,
  });
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [evidenceFiles, setEvidenceFiles] = useState<EvidenceFile[]>([]);
  const [materialChecked, setMaterialChecked] = useState<Record<string, boolean>>({});
  const [assistMessage, setAssistMessage] = useState('');

  useEffect(() => {
    if (kind === 'evidence' && materials.length > 0) {
      setMaterialChecked(
        Object.fromEntries(
          materials.map((m: string) => [m, true]) as [string, boolean][],
        ),
      );
    }
  }, [kind, materials]);

  const runAction = async (action: () => Promise<TaskActionResult>) => {
    setSubmitting(true);
    try {
      const result = await action();
      toast.success(result.message);
      onClose();
      onDone();
    } catch {
      toast.error('操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const submitBlock = () => {
    if (!blockForm.reason || !blockForm.waitingFor || !blockForm.nextAction) {
      toast.error('请完整填写阻塞原因、等待对象与下一步动作');
      return;
    }
    if (blockForm.resolution.trim().length < 5) {
      toast.error(
        sopEnabled
          ? '请填写解决情况和方案（至少 5 个字，用于沉淀 SOP）'
          : '请填写解决情况和方案（至少 5 个字）',
      );
      return;
    }
    void runAction(() =>
      tasksApi.submitTaskBlock(taskId, {
        projectId,
        reason: blockForm.reason,
        waitingFor: blockForm.waitingFor,
        nextAction: blockForm.nextAction,
        resolution: blockForm.resolution.trim(),
        category: blockForm.category,
        deferRequested: blockForm.deferRequested,
        deriveProblem: blockForm.deriveProblem,
      }),
    );
  };

  const submitEvidence = () => {
    if (!evidenceNotes.trim()) {
      toast.error('请填写完成情况说明（No Evidence = Not Done）');
      return;
    }
    if (evidenceFiles.length === 0) {
      toast.error('请至少上传一个凭证文件（截图 / 录音 / 视频 / 文档）');
      return;
    }
    const submittedMaterials = materials.filter(
      (m: string) => materialChecked[m],
    );
    void runAction(() =>
      tasksApi.submitTaskEvidence(taskId, {
        projectId,
        notes: evidenceNotes.trim(),
        links: evidenceFiles.map((f: EvidenceFile) => f.url),
        materials: submittedMaterials,
      }),
    );
  };

  const submitAssist = () => {
    if (!assistMessage.trim()) {
      toast.error('请说明需要的协助内容');
      return;
    }
    void runAction(() =>
      tasksApi.requestTaskAssist(taskId, {
        projectId,
        message: assistMessage.trim(),
      }),
    );
  };

  return (
    <>
      <Dialog open={kind === 'block'} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>提交阻塞（Blocked ≠ Abandoned）</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">阻塞原因</p>
              <Input
                value={blockForm.reason}
                onChange={(e) => setBlockForm((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="例如：腾讯接口字段缺失"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">等待谁</p>
              <Input
                value={blockForm.waitingFor}
                onChange={(e) => setBlockForm((prev) => ({ ...prev, waitingFor: e.target.value }))}
                placeholder="例如：腾讯商务"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">下一步动作</p>
              <Input
                value={blockForm.nextAction}
                onChange={(e) => setBlockForm((prev) => ({ ...prev, nextAction: e.target.value }))}
                placeholder="例如：16:00 再次跟进"
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">
                {sopEnabled ? '解决情况和方案（必填，沉淀为 SOP）' : '解决情况和方案（必填）'}
              </p>
              <Textarea
                value={blockForm.resolution}
                onChange={(e) =>
                  setBlockForm((prev) => ({ ...prev, resolution: e.target.value }))
                }
                placeholder="例如：已联系腾讯商务确认缺失字段清单，等待回邮件；期间先用临时字段跑通流程，拿到正式字段后切换，预计明日恢复"
                rows={3}
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">阻塞分类</p>
              <Select
                value={blockForm.category}
                onValueChange={(v: string) =>
                  setBlockForm((prev) => ({
                    ...prev,
                    category: v,
                    deriveProblem: deriveProblemDefaultForCategory(v),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分类" />
                </SelectTrigger>
                <SelectContent>
                  {BLOCK_CATEGORIES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
              <Checkbox
                checked={blockForm.deferRequested}
                onCheckedChange={(v: boolean | 'indeterminate') =>
                  setBlockForm((prev) => ({ ...prev, deferRequested: v === true }))
                }
                className="mt-0.5"
              />
              <span className="text-sm text-muted-foreground">
                同步申请顺延结束时刻（时长由系统配置，默认 30 分钟；
                {deferAiEnabled ? '需 AI 初审 + 老板终审通过后生效' : '老板终审通过后生效'}）
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
              <Checkbox
                checked={blockForm.deriveProblem}
                onCheckedChange={(v: boolean | 'indeterminate') =>
                  setBlockForm((prev) => ({ ...prev, deriveProblem: v === true }))
                }
                className="mt-0.5"
              />
              <span className="text-sm text-muted-foreground">
                衍生为问题工单 · 程序类问题请勾选，老板 4 小时内响应，
                确认有效有现金奖励
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submitBlock} disabled={submitting}>
              提交阻塞
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'evidence'} onOpenChange={(open: boolean) => { if (!open) { onClose(); setEvidenceFiles([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>提交验收凭证（No Evidence = Not Done）</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {materials.length > 0 ? (
              <div className="rounded-md bg-blue-50/60 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium text-blue-700">
                  <BadgeCheck className="h-4 w-4" />
                  本次已提交的材料
                </p>
                <div className="mt-2 space-y-1.5">
                  {materials.map((m: string) => (
                    <label
                      key={m}
                      className="flex cursor-pointer items-start gap-2 rounded-md border bg-card px-3 py-2"
                    >
                      <Checkbox
                        checked={materialChecked[m] ?? false}
                        onCheckedChange={(v: boolean | 'indeterminate') =>
                          setMaterialChecked((prev: Record<string, boolean>) => ({
                            ...prev,
                            [m]: v === true,
                          }))
                        }
                        className="mt-0.5"
                      />
                      <span className="text-muted-foreground">{m}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-md bg-blue-50/60 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium text-blue-700">
                  <BadgeCheck className="h-4 w-4" />
                  验收凭证要求
                </p>
                <p className="mt-1 text-muted-foreground">
                  {evidenceHint ??
                    '上传能证明任务完成的凭证，例如：客服确认成功的聊天截图、退款到账记录、工单关闭截图'}
                </p>
              </div>
            )}
            <div>
              <p className="mb-1 text-sm text-muted-foreground">完成情况说明</p>
              <Textarea
                value={evidenceNotes}
                onChange={(e) => setEvidenceNotes(e.target.value)}
                placeholder="说明完成情况，例如：已成功退卡并确认退款 ¥260"
                rows={3}
              />
            </div>
            <div>
              <p className="mb-1 text-sm text-muted-foreground">上传凭证</p>
              <EvidenceUploader files={evidenceFiles} onChange={setEvidenceFiles} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submitEvidence} disabled={submitting}>
              提交验收
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={kind === 'assist'} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleHelp className="h-4 w-4" />
              申请协助（向老板申请验证码等）
            </DialogTitle>
          </DialogHeader>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">需要什么协助</p>
            <Textarea
              value={assistMessage}
              onChange={(e) => setAssistMessage(e.target.value)}
              placeholder="例如：客服要求短信验证码，请老板提供"
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submitAssist} disabled={submitting}>
              提交申请
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
