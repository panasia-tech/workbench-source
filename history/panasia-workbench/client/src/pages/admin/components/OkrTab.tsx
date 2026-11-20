import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createOkrKeyResult,
  createOkrObjective,
  deleteOkrKeyResult,
  deleteOkrObjective,
  fetchAdminOkr,
  patchOkrKeyResult,
  patchOkrObjective,
} from '@client/src/api/admin';
import type {
  AdminOkrListResponse,
  OkrKeyResultItem,
  OkrObjectiveItem,
  OkrObjectiveStatus,
} from '@shared/api.interface';

const STATUS_META: Record<OkrObjectiveStatus, { label: string; className: string }> = {
  on_track: { label: '正常', className: 'bg-green-100 text-green-700' },
  at_risk: { label: '有风险', className: 'bg-amber-100 text-amber-700' },
  behind: { label: '落后', className: 'bg-red-100 text-red-700' },
  completed: { label: '已完成', className: 'bg-muted text-muted-foreground' },
};

const STATUS_OPTIONS: { value: OkrObjectiveStatus; label: string }[] = [
  { value: 'on_track', label: '正常' },
  { value: 'at_risk', label: '有风险' },
  { value: 'behind', label: '落后' },
  { value: 'completed', label: '已完成' },
];

interface DeleteTarget {
  type: 'objective' | 'keyResult';
  id: string;
  title: string;
  note: string;
}

const computeProgressPercent = (kr: OkrKeyResultItem): number | null => {
  const target = Number(kr.targetValue);
  const current = Number(kr.currentValue);
  if (!Number.isFinite(target) || !Number.isFinite(current) || target === 0) {
    return null;
  }
  return (current / target) * 100;
};

const OkrTab: React.FC = () => {
  const [data, setData] = useState<AdminOkrListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [objectiveDialogOpen, setObjectiveDialogOpen] = useState(false);
  const [editingObjective, setEditingObjective] = useState<OkrObjectiveItem | null>(null);
  const [objPeriod, setObjPeriod] = useState('');
  const [objTitle, setObjTitle] = useState('');
  const [objStatus, setObjStatus] = useState<OkrObjectiveStatus>('on_track');
  const [objSort, setObjSort] = useState('0');
  const [objectiveBusy, setObjectiveBusy] = useState(false);

  const [krAddFor, setKrAddFor] = useState<OkrObjectiveItem | null>(null);
  const [krTitle, setKrTitle] = useState('');
  const [krUnit, setKrUnit] = useState('');
  const [krTarget, setKrTarget] = useState('');
  const [krAddBusy, setKrAddBusy] = useState(false);

  const [krUpdate, setKrUpdate] = useState<OkrKeyResultItem | null>(null);
  const [krCurrent, setKrCurrent] = useState('');
  const [krUpdateBusy, setKrUpdateBusy] = useState(false);

  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchAdminOkr();
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取 OKR 列表失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const current = data;
    if (!current) return [];
    return current.periods.map((period: string) => ({
      period,
      objectives: current.objectives.filter(
        (o: OkrObjectiveItem) => o.period === period,
      ),
    }));
  }, [data]);

  const openCreateObjective = (): void => {
    setEditingObjective(null);
    setObjPeriod('');
    setObjTitle('');
    setObjStatus('on_track');
    setObjSort('0');
    setObjectiveDialogOpen(true);
  };

  const openEditObjective = (objective: OkrObjectiveItem): void => {
    setEditingObjective(objective);
    setObjPeriod(objective.period);
    setObjTitle(objective.title);
    setObjStatus(objective.status);
    setObjSort(String(objective.sort));
    setObjectiveDialogOpen(true);
  };

  const handleSaveObjective = async (): Promise<void> => {
    const title = objTitle.trim();
    if (!title) {
      toast.error('请填写目标标题');
      return;
    }
    if (editingObjective) {
      const sortNum = Number(objSort);
      if (!Number.isFinite(sortNum)) {
        toast.error('排序必须为数字');
        return;
      }
      setObjectiveBusy(true);
      try {
        await patchOkrObjective(editingObjective.id, {
          title,
          status: objStatus,
          sort: Math.trunc(sortNum),
        });
        toast.success('目标已更新');
        setObjectiveDialogOpen(false);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '更新目标失败');
      } finally {
        setObjectiveBusy(false);
      }
      return;
    }
    const period = objPeriod.trim();
    if (!period) {
      toast.error('请填写考核周期，如 2026-Q4');
      return;
    }
    setObjectiveBusy(true);
    try {
      await createOkrObjective({ period, title });
      toast.success('目标已创建');
      setObjectiveDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建目标失败');
    } finally {
      setObjectiveBusy(false);
    }
  };

  const handleAddKeyResult = async (): Promise<void> => {
    if (!krAddFor) return;
    const title = krTitle.trim();
    if (!title) {
      toast.error('请填写关键结果标题');
      return;
    }
    const targetValue = krTarget.trim();
    if (targetValue !== '' && !Number.isFinite(Number(targetValue))) {
      toast.error('目标值必须为数字');
      return;
    }
    setKrAddBusy(true);
    try {
      await createOkrKeyResult(krAddFor.id, {
        title,
        unit: krUnit.trim() || null,
        targetValue: targetValue === '' ? undefined : targetValue,
      });
      toast.success('关键结果已添加');
      setKrAddFor(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加关键结果失败');
    } finally {
      setKrAddBusy(false);
    }
  };

  const handleUpdateKeyResult = async (): Promise<void> => {
    if (!krUpdate) return;
    const current = krCurrent.trim();
    if (current === '' || !Number.isFinite(Number(current))) {
      toast.error('请填写有效的当前值');
      return;
    }
    setKrUpdateBusy(true);
    try {
      await patchOkrKeyResult(krUpdate.id, { currentValue: current });
      toast.success('进度已更新');
      setKrUpdate(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新进度失败');
    } finally {
      setKrUpdateBusy(false);
    }
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      if (deleting.type === 'objective') {
        await deleteOkrObjective(deleting.id);
        toast.success('目标已删除');
      } else {
        await deleteOkrKeyResult(deleting.id);
        toast.success('关键结果已删除');
      }
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleteBusy(false);
    }
  };

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

  if (!data) {
    return <Skeleton className="h-72 rounded-xl" />;
  }

  const hasObjectives = data.objectives.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button onClick={openCreateObjective}>
          <Plus className="h-4 w-4" />
          新建目标
        </Button>
      </div>

      {!hasObjectives ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无 OKR，点击「新建目标」创建第一个目标。
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.period} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                {group.period}
              </h3>
              <span className="text-xs text-muted-foreground">
                {group.objectives.length} 个目标
              </span>
            </div>
            <div className="space-y-4">
              {group.objectives.map((objective) => (
                <div
                  key={objective.id}
                  className="rounded-xl border p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold">
                          {objective.title}
                        </span>
                        <Badge
                          variant="secondary"
                          className={STATUS_META[objective.status].className}
                        >
                          {STATUS_META[objective.status].label}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditObjective(objective)}
                      >
                        <Pencil className="h-4 w-4" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() =>
                          setDeleting({
                            type: 'objective',
                            id: objective.id,
                            title: objective.title,
                            note: '其下所有关键结果将一并删除。',
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                        删除
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 space-y-3">
                    {objective.keyResults.length === 0 ? (
                      <div className="text-xs text-muted-foreground">
                        暂无关键结果
                      </div>
                    ) : (
                      objective.keyResults.map((kr) => {
                        const percent = computeProgressPercent(kr);
                        return (
                          <div
                            key={kr.id}
                            className="rounded-lg border bg-muted/30 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm">
                                {kr.title}
                              </span>
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setKrUpdate(kr);
                                    setKrCurrent(kr.currentValue);
                                  }}
                                >
                                  更新
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() =>
                                    setDeleting({
                                      type: 'keyResult',
                                      id: kr.id,
                                      title: kr.title,
                                      note: '该关键结果将被删除。',
                                    })
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                              <span>
                                {percent === null
                                  ? '—'
                                  : `${kr.currentValue}/${kr.targetValue}`}
                                {kr.unit ? ` ${kr.unit}` : ''}
                              </span>
                              <span>
                                {percent === null
                                  ? '—'
                                  : `${Math.min(percent, 999).toFixed(0)}%`}
                              </span>
                            </div>
                            <Progress
                              className="mt-2 h-1.5"
                              value={
                                percent === null
                                  ? 0
                                  : Math.max(0, Math.min(100, percent))
                              }
                            />
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setKrAddFor(objective);
                        setKrTitle('');
                        setKrUnit('');
                        setKrTarget('');
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      添加关键结果
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {/* 目标新建 / 编辑 */}
      <Dialog
        open={objectiveDialogOpen}
        onOpenChange={(open: boolean) => {
          if (!open) setObjectiveDialogOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingObjective ? '编辑目标' : '新建目标'}
            </DialogTitle>
            <DialogDescription>
              {editingObjective
                ? '更新目标标题、状态或排序。'
                : '考核周期如 2026-Q4，目标标题必填。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="okr-period">考核周期</Label>
              <Input
                id="okr-period"
                value={objPeriod}
                disabled={editingObjective !== null}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setObjPeriod(e.target.value)
                }
                placeholder="如 2026-Q4"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="okr-title">目标标题</Label>
              <Input
                id="okr-title"
                value={objTitle}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setObjTitle(e.target.value)
                }
                placeholder="如 提升华东区月度销售额"
              />
            </div>
            {editingObjective !== null && (
              <>
                <div className="space-y-2">
                  <Label>状态</Label>
                  <Select
                    value={objStatus}
                    onValueChange={(v: string) =>
                      setObjStatus(v as OkrObjectiveStatus)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="okr-sort">排序</Label>
                  <Input
                    id="okr-sort"
                    value={objSort}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setObjSort(e.target.value)
                    }
                    placeholder="0"
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setObjectiveDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={objectiveBusy}
              onClick={() => void handleSaveObjective()}
            >
              {objectiveBusy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加关键结果 */}
      <Dialog
        open={krAddFor !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setKrAddFor(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加关键结果</DialogTitle>
            <DialogDescription>
              挂在目标「{krAddFor?.title}」下的可量化关键结果。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kr-title">标题</Label>
              <Input
                id="kr-title"
                value={krTitle}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setKrTitle(e.target.value)
                }
                placeholder="如 新增签约客户数"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="kr-unit">单位（可选）</Label>
                <Input
                  id="kr-unit"
                  value={krUnit}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setKrUnit(e.target.value)
                  }
                  placeholder="如 家 / 万元"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="kr-target">目标值（可选）</Label>
                <Input
                  id="kr-target"
                  value={krTarget}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setKrTarget(e.target.value)
                  }
                  placeholder="如 20"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKrAddFor(null)}>
              取消
            </Button>
            <Button disabled={krAddBusy} onClick={() => void handleAddKeyResult()}>
              {krAddBusy ? '添加中…' : '添加'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 更新 KR 进度 */}
      <Dialog
        open={krUpdate !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setKrUpdate(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>更新进度</DialogTitle>
            <DialogDescription>
              {krUpdate?.title}（目标 {krUpdate?.targetValue}
              {krUpdate?.unit ? ` ${krUpdate.unit}` : ''}）
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="kr-current">当前值</Label>
            <Input
              id="kr-current"
              value={krCurrent}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setKrCurrent(e.target.value)
              }
              placeholder="请输入数字，如 12"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKrUpdate(null)}>
              取消
            </Button>
            <Button
              disabled={krUpdateBusy}
              onClick={() => void handleUpdateKeyResult()}
            >
              {krUpdateBusy ? '提交中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting?.type === 'objective' ? '确认删除目标？' : '确认删除关键结果？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleting?.title}」。{deleting?.note}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteBusy}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                void handleDeleteConfirm();
              }}
            >
              {deleteBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                '删除'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default OkrTab;
