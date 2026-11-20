import type { Request } from 'express';
import type { ResolvedView } from '../demo/demo-view.service';

/**
 * 员工端任务接口的调用方。boss/admin 本人 fullAccess=true，不受限；其他人（含演示视角）
 * 只能看、只能操作指派给自己的任务。演示视角按被演示的员工算，口径同项目详情（projects.controller）
 */
export interface TaskViewer {
  userId: string;
  fullAccess: boolean;
}

export function taskViewerOf(req: Request, view: ResolvedView): TaskViewer {
  const roles: string[] = req.userContext.roles ?? [];
  return {
    userId: view.userId,
    fullAccess:
      !view.demoAs && (roles.includes('boss') || roles.includes('admin')),
  };
}
