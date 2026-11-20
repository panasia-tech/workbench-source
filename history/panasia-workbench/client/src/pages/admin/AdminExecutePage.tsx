import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  FolderKanban,
  RefreshCw,
  User,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAdminExecuteMembers, getExecute } from '@client/src/api/admin';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AdminExecuteProject,
  AdminExecuteResponse,
  AdminExecuteTaskRow,
  AdminMemberSlot,
} from '@shared/api.interface';
import TaskCoordinationSection from './components/TaskCoordinationSection';
import TaskTemplateSection from './components/TaskTemplateSection';
import WorkOrderQueueSection from './components/WorkOrderQueueSection';

/** 员工槽位卡：姓名 + 角色 + 今日完成 + 节奏摘要 + 堵塞/顺延/在办计数 */
const MemberSlotCard: React.FC<{
  member: AdminMemberSlot;
  onOpen: (userId: string) => void;
}> = ({ member, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(member.userId)}
    className="w-full space-y-3 rounded-xl border bg-card p-5 text-left transition-colors hover:border-primary/50"
  >
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <User className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">{member.name}</span>
      </span>
      <Badge variant="secondary" className="shrink-0 bg-muted text-muted-foreground">
        {member.role}
      </Badge>
    </div>

    <div className="flex items-baseline gap-1.5">
      <span className="text-2xl font-semibold tabular-nums">
        {member.todayDone}
        <span className="font-normal text-muted-foreground">/{member.todayTotal}</span>
      </span>
      <span className="text-xs text-muted-foreground">今日完成</span>
    </div>

    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {member.behindCount > 0 ? (
        <span className="font-medium text-red-600">落后 {member.behindCount} 个</span>
      ) : (
        <span className="text-muted-foreground">节奏正常</span>
      )}
      {member.expectedEndTime && (
        <span className="text-muted-foreground">预测 {member.expectedEndTime} 下班</span>
      )}
    </div>

    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={member.blockedCount > 0 ? 'font-medium text-red-600' : 'text-muted-foreground'}>
        堵塞 {member.blockedCount}
      </span>
      <span
        className={
          member.deferPending > 0
            ? 'font-medium text-violet-600'
            : 'text-muted-foreground'
        }
      >
        顺延待审 {member.deferPending}
      </span>
      <span className="text-muted-foreground">在办 {member.openCount}</span>
      <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
    </div>
  </button>
);

const AdminExecutePage: React.FC = () => {
  const navigate = useNavigate();
  const [members, setMembers] = useState<AdminMemberSlot[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [execute, setExecute] = useState<AdminExecuteResponse | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setMembersError(null);
    setExecuteError(null);
    const [membersResult, executeResult] = await Promise.allSettled([
      fetchAdminExecuteMembers(),
      getExecute(),
    ]);
    if (membersResult.status === 'fulfilled') {
      setMembers(membersResult.value.members);
    } else {
      setMembers(null);
      const message =
        membersResult.reason instanceof Error
          ? membersResult.reason.message
          : '获取员工槽位数据失败';
      setMembersError(message);
      logger.error('管理端员工槽位加载失败', membersResult.reason);
    }
    if (executeResult.status === 'fulfilled') {
      setExecute(executeResult.value);
    } else {
      setExecute(null);
      const message =
        executeResult.reason instanceof Error
          ? executeResult.reason.message
          : '获取工单队列数据失败';
      setExecuteError(message);
      logger.error('管理端执行辅助数据加载失败', executeResult.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openMemberDetail = useCallback(
    (userId: string) => {
      navigate(`/admin/execute/${userId}`);
    },
    [navigate],
  );

  const tasks: AdminExecuteTaskRow[] = execute?.tasks ?? [];
  const projects: AdminExecuteProject[] = execute?.projects ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FolderKanban className="h-5 w-5 text-primary" />
            执行
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            员工槽位视角：今日完成节奏、在途堵塞与顺延待审，点击卡片查看员工详情。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => navigate('/admin/execute/day')}>
            <CalendarDays className="h-4 w-4" />
            按日期看
          </Button>
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>

      <TaskCoordinationSection />

      {loading && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      )}

      {!loading && membersError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>员工槽位数据加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{membersError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !membersError && members && members.length === 0 && (
        <div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
          暂无数据 · 请确认已有员工绑定 Plane 成员后重试。
        </div>
      )}

      {!loading && !membersError && members && members.length > 0 && (
        <div
          data-ai-section-type="card-list"
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          {members.map((member: AdminMemberSlot) => (
            <MemberSlotCard
              key={member.userId}
              member={member}
              onOpen={openMemberDetail}
            />
          ))}
        </div>
      )}

      {!loading && executeError && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>工单队列与任务模板数据加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{executeError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <WorkOrderQueueSection tasks={tasks} />

      <TaskTemplateSection projects={projects} onTasksChanged={() => void load()} />
    </div>
  );
};

export default AdminExecutePage;
