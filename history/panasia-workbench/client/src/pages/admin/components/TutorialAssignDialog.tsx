import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  assignTutorialCase,
  cancelTutorialCase,
  fetchTutorialCases,
  getAdminEmployees,
} from '@client/src/api/admin';
import type {
  TutorialAuthoringProjectView,
  TutorialCaseAdminItem,
  TutorialCaseStatus,
} from '@shared/api.interface';

interface EmployeeOption {
  userId: string;
  label: string;
}

const STATUS_LABELS: Record<TutorialCaseStatus, string> = {
  in_progress: '学习中',
  completed: '已学完',
  cancelled: '已取消',
};

interface TutorialAssignDialogProps {
  /** null = 关闭 */
  project: TutorialAuthoringProjectView | null;
  onOpenChange: (open: boolean) => void;
}

/** 给员工分配教程：选员工（登录过工作台的人），可填对象名；下面列出这套教程已分配给谁 */
const TutorialAssignDialog: React.FC<TutorialAssignDialogProps> = ({
  project,
  onOpenChange,
}) => {
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [cases, setCases] = useState<TutorialCaseAdminItem[]>([]);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [clientName, setClientName] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 取消要点两下：第一下变成「确认取消」 */
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const loadCases = useCallback(async (lmsCourse: string) => {
    const response = await fetchTutorialCases(lmsCourse);
    setCases(response.items);
  }, []);

  useEffect(() => {
    if (!project) return;
    setOwnerUserId('');
    setClientName('');
    setLoading(true);
    Promise.all([getAdminEmployees(), loadCases(project.projectId)])
      .then(([bindings]) => {
        const seen = new Set<string>();
        const options: EmployeeOption[] = [];
        for (const row of bindings.items) {
          if (seen.has(row.miaodaUserId)) continue;
          seen.add(row.miaodaUserId);
          options.push({
            userId: row.miaodaUserId,
            label: row.userName ?? row.planeMemberName ?? row.miaodaUserId,
          });
        }
        for (const row of bindings.unbound ?? []) {
          if (seen.has(row.miaodaUserId)) continue;
          seen.add(row.miaodaUserId);
          options.push({
            userId: row.miaodaUserId,
            label: `${row.userName ?? row.loginName ?? row.miaodaUserId}（未绑定 Plane）`,
          });
        }
        setEmployees(options);
      })
      .catch((err: unknown) => {
        logger.error('加载分配教程数据失败', err);
        toast.error(err instanceof Error ? err.message : '加载员工列表失败');
      })
      .finally(() => setLoading(false));
  }, [project, loadCases]);

  const activeCases = useMemo(
    () => cases.filter((item: TutorialCaseAdminItem) => item.status !== 'cancelled'),
    [cases],
  );

  const handleAssign = async (): Promise<void> => {
    if (!project) return;
    if (!ownerUserId) {
      toast.error('请选择员工');
      return;
    }
    setSaving(true);
    try {
      const created = await assignTutorialCase({
        lmsCourse: project.projectId,
        ownerUserId,
        clientName: clientName.trim() || undefined,
      });
      toast.success(`已分配给 ${created.ownerName || '该员工'}，员工会收到站内消息`);
      setOwnerUserId('');
      setClientName('');
      await loadCases(project.projectId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '分配教程失败');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (item: TutorialCaseAdminItem): Promise<void> => {
    if (!project) return;
    if (confirmingId !== item.caseId) {
      setConfirmingId(item.caseId);
      return;
    }
    setConfirmingId(null);
    try {
      await cancelTutorialCase(item.caseId);
      toast.success('已取消');
      await loadCases(project.projectId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消失败');
    }
  };

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>分配给员工</DialogTitle>
          <DialogDescription>
            《{project?.name}》分配后员工在学习中心按步骤学、交材料；同一个人同一个对象只能有一个在学的。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">员工</p>
            <Select value={ownerUserId} onValueChange={setOwnerUserId} disabled={loading}>
              <SelectTrigger>
                <SelectValue placeholder={loading ? '加载中…' : '选择员工（登录过工作台的人）'} />
              </SelectTrigger>
              <SelectContent>
                {employees.map((option: EmployeeOption) => (
                  <SelectItem key={option.userId} value={option.userId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">对象名（可不填）</p>
            <Input
              value={clientName}
              maxLength={255}
              placeholder="比如在帮哪位客户开店"
              onChange={(event) => setClientName(event.target.value)}
            />
          </div>
          {activeCases.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-sm font-medium">已分配</p>
              {activeCases.map((item: TutorialCaseAdminItem) => (
                <div
                  key={item.caseId}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {item.ownerName || item.ownerUserId}
                    {item.clientName ? ` · ${item.clientName}` : ''}
                    <span className="ml-2 text-muted-foreground">
                      {STATUS_LABELS[item.status]} {item.stepsDone}/{item.stepsTotal} 步
                    </span>
                  </span>
                  {item.status === 'in_progress' && (
                    <Button
                      variant={confirmingId === item.caseId ? 'destructive' : 'ghost'}
                      size="sm"
                      onClick={() => void handleCancel(item)}
                    >
                      {confirmingId === item.caseId ? '确认取消' : '取消'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => void handleAssign()} disabled={saving || loading}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            分配
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TutorialAssignDialog;
