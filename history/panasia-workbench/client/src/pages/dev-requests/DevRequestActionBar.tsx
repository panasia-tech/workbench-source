import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { tasksApi } from '@client/src/api';
import { TaskActionDialogs, type TaskDialogKind } from '../tasks/TaskActionDialogs';
import type { DevRequestAction, DevRequestDetail } from '@shared/api.interface';
import { DevRequestDialogs, type DevRequestDialogKind } from './DevRequestDialogs';

interface DevRequestActionBarProps {
  detail: DevRequestDetail;
  onDone: () => void;
}

/** 主动作（每个环节最多一个）放大按钮，其余小按钮；撤销放最后 */
const PRIMARY: { action: DevRequestAction; label: string }[] = [
  { action: 'quote', label: '报价' },
  { action: 'clarify', label: '补充需求' },
  { action: 'confirm_quote', label: '确认报价，开工' },
  { action: 'deliver', label: '交付' },
  { action: 'accept', label: '验收通过' },
];

const SECONDARY: { action: DevRequestAction; label: string }[] = [
  { action: 'return', label: '退回补充' },
  { action: 'reject_quote', label: '退回报价' },
  { action: 'reject_delivery', label: '打回' },
];

/**
 * 当前用户此刻能做的动作（服务端算好的 actions）。提交阻塞 / 解除阻塞走任务的通用接口（原有语义：
 * 评论 + 挪到阻塞状态，解除后回到「开发交付」），服务端同样只在开发中放行
 */
export function DevRequestActionBar({ detail, onDone }: DevRequestActionBarProps) {
  const [dialog, setDialog] = useState<DevRequestDialogKind>(null);
  const [taskDialog, setTaskDialog] = useState<TaskDialogKind>(null);
  const [unblocking, setUnblocking] = useState(false);
  const can = (action: DevRequestAction): boolean => detail.actions.includes(action);
  const primary = PRIMARY.filter((item) => can(item.action));
  const secondary = SECONDARY.filter((item) => can(item.action));

  const unblock = () => {
    setUnblocking(true);
    tasksApi
      .updateTaskStatus(detail.issueId, { projectId: detail.projectId, status: 'IN_PROGRESS' })
      .then((result) => {
        toast.success(result.message);
        onDone();
      })
      .catch(() => toast.error('解除阻塞失败，请稍后重试'))
      .finally(() => setUnblocking(false));
  };

  if (detail.actions.length === 0) {
    return <p className="text-sm text-muted-foreground">{detail.nextStep}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {primary.length > 0 || can('unblock') ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          {primary.map((item) => (
            <Button
              key={item.action}
              size="lg"
              onClick={() => setDialog(item.action as DevRequestDialogKind)}
            >
              {item.label}
            </Button>
          ))}
          {can('unblock') ? (
            <Button size="lg" onClick={unblock} disabled={unblocking}>
              解除阻塞，继续开发
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{detail.nextStep}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {secondary.map((item) => (
          <Button
            key={item.action}
            variant="outline"
            size="sm"
            onClick={() => setDialog(item.action as DevRequestDialogKind)}
          >
            {item.label}
          </Button>
        ))}
        {can('block') ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setTaskDialog('block')}>
              提交阻塞
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTaskDialog('assist')}>
              申请协助
            </Button>
          </>
        ) : null}
        {can('cancel') ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDialog('cancel')}
          >
            撤销需求
          </Button>
        ) : null}
      </div>

      <DevRequestDialogs
        detail={detail}
        kind={dialog}
        onClose={() => setDialog(null)}
        onDone={onDone}
      />
      <TaskActionDialogs
        taskId={detail.issueId}
        projectId={detail.projectId}
        kind={taskDialog}
        evidenceHint={null}
        materials={[]}
        onClose={() => setTaskDialog(null)}
        onDone={onDone}
      />
    </div>
  );
}
