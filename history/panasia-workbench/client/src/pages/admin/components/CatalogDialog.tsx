import React, { useEffect, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  createAdminCatalog,
  updateAdminCatalog,
} from '@client/src/api/admin';
import { WORK_ORDER_BUSINESS_LINE_LABELS } from '@client/src/pages/tasks/workorder-status';
import type {
  AdminCatalogUpsertRequest,
  WorkOrderBusinessLine,
  WorkOrderCatalogItem,
  WorkOrderChecklistItem,
  WorkOrderComplexity,
  WorkOrderType,
} from '@shared/api.interface';

interface CatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新建 */
  initial: WorkOrderCatalogItem | null;
  onSaved: () => void;
}

const ORDER_TYPE_OPTIONS: { value: WorkOrderType; label: string }[] = [
  { value: 'purchase', label: '采购' },
  { value: 'sales', label: '销售' },
  { value: 'special_delegation', label: '特殊委派' },
  { value: 'other', label: '其他' },
];

const COMPLEXITY_OPTIONS: { value: WorkOrderComplexity; label: string }[] = [
  { value: 'simple', label: '简单' },
  { value: 'medium', label: '中等' },
  { value: 'complex', label: '复杂' },
];

const LINE_NONE = 'none';

const CatalogDialog: React.FC<CatalogDialogProps> = ({
  open,
  onOpenChange,
  initial,
  onSaved,
}) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [orderType, setOrderType] = useState<WorkOrderType>('other');
  const [complexity, setComplexity] = useState<WorkOrderComplexity>('medium');
  const [businessLine, setBusinessLine] = useState<string>(LINE_NONE);
  const [sort, setSort] = useState('0');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [erpAction, setErpAction] = useState('');
  const [checklistText, setChecklistText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setCode(initial.code);
      setName(initial.name);
      setOrderType(initial.orderType);
      setComplexity(initial.complexity);
      setBusinessLine(initial.businessLine ?? LINE_NONE);
      setSort(String(initial.sort));
      setPromptTemplate(initial.promptTemplate ?? '');
      setErpAction(initial.erpAction ?? '');
      setChecklistText(
        initial.checklistTemplate.length > 0
          ? JSON.stringify(initial.checklistTemplate, null, 2)
          : '',
      );
    } else {
      setCode('');
      setName('');
      setOrderType('other');
      setComplexity('medium');
      setBusinessLine(LINE_NONE);
      setSort('0');
      setPromptTemplate('');
      setErpAction('');
      setChecklistText('');
    }
  }, [open, initial]);

  const handleSave = async (): Promise<void> => {
    if (!code.trim() || !name.trim()) {
      toast.error('请填写目录编码与名称');
      return;
    }
    const sortNum = Number(sort);
    if (!Number.isFinite(sortNum)) {
      toast.error('排序值必须为数字');
      return;
    }
    let checklist: WorkOrderChecklistItem[] | undefined;
    if (checklistText.trim() !== '') {
      try {
        const parsed = JSON.parse(checklistText);
        if (!Array.isArray(parsed)) {
          toast.error('检查清单模板必须为 JSON 数组');
          return;
        }
        checklist = parsed as WorkOrderChecklistItem[];
      } catch {
        toast.error('检查清单 JSON 格式不正确');
        return;
      }
    }
    const body: AdminCatalogUpsertRequest = {
      code: code.trim(),
      name: name.trim(),
      orderType,
      complexity,
      businessLine:
        businessLine === LINE_NONE ? null : (businessLine as WorkOrderBusinessLine),
      sort: Math.trunc(sortNum),
      promptTemplate: promptTemplate.trim() || undefined,
      erpAction: erpAction.trim() || undefined,
      checklistTemplate: checklist,
    };
    setSaving(true);
    try {
      if (initial) {
        await updateAdminCatalog(initial.id, body);
        toast.success('目录已更新');
      } else {
        await createAdminCatalog(body);
        toast.success('目录已创建');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存目录失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑工单目录' : '新增工单目录'}</DialogTitle>
          <DialogDescription>
            目录决定工单的默认检查清单与复杂度，编码需全局唯一。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="catalog-code">编码</Label>
              <Input
                id="catalog-code"
                value={code}
                disabled={initial !== null}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCode(e.target.value)
                }
                placeholder="如 purchase_routine"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-name">名称</Label>
              <Input
                id="catalog-name"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setName(e.target.value)
                }
                placeholder="如 采购常规单"
              />
            </div>
            <div className="space-y-2">
              <Label>任务类型</Label>
              <Select
                value={orderType}
                onValueChange={(v: string) => setOrderType(v as WorkOrderType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>复杂度</Label>
              <Select
                value={complexity}
                onValueChange={(v: string) =>
                  setComplexity(v as WorkOrderComplexity)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPLEXITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>业务线</Label>
              <Select value={businessLine} onValueChange={setBusinessLine}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LINE_NONE}>不设</SelectItem>
                  {(
                    Object.keys(WORK_ORDER_BUSINESS_LINE_LABELS) as WorkOrderBusinessLine[]
                  ).map((line: WorkOrderBusinessLine) => (
                    <SelectItem key={line} value={line}>
                      {WORK_ORDER_BUSINESS_LINE_LABELS[line]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-sort">排序</Label>
              <Input
                id="catalog-sort"
                value={sort}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSort(e.target.value)
                }
                placeholder="0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-erp">ERP 动作（可选）</Label>
              <Input
                id="catalog-erp"
                value={erpAction}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setErpAction(e.target.value)
                }
                placeholder="如 supplier_quotation"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-prompt">提示词模板（可选）</Label>
            <Textarea
              id="catalog-prompt"
              value={promptTemplate}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setPromptTemplate(e.target.value)
              }
              placeholder="AI 初审 / 下任务入口使用的提示词模板"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="catalog-checklist">
              检查清单模板（可选，JSON 数组）
            </Label>
            <Textarea
              id="catalog-checklist"
              value={checklistText}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setChecklistText(e.target.value)
              }
              className="min-h-[120px] font-mono text-xs"
              placeholder='[{"key":"invoice","name":"发票","required":true},{"key":"inspect","name":"现场验货照","onSite":true}]'
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void handleSave()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default CatalogDialog;
