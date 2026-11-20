import type { Request } from 'express';
import type { ResolvedView } from '../demo/demo-view.service';

/**
 * 开发需求接口的调用方。谁都能发需求；发布人看「我发起的」、开发者看「派给我的」，
 * boss / admin 本人能看全部（canSeeAll），只有 boss 能替发布人确认报价、验收、撤销（isBoss）。
 * 演示视角按被演示的员工算、没有老板权限（同任务接口 taskViewerOf 的口径）
 */
export interface DevRequestViewer {
  userId: string;
  isBoss: boolean;
  canSeeAll: boolean;
}

export function devRequestViewerOf(
  req: Request,
  view: ResolvedView,
): DevRequestViewer {
  const roles: string[] = req.userContext.roles ?? [];
  const real = !view.demoAs;
  return {
    userId: view.userId,
    isBoss: real && roles.includes('boss'),
    canSeeAll: real && (roles.includes('boss') || roles.includes('admin')),
  };
}

/** 管理端（@CanRole boss/admin，不接演示视角） */
export function adminDevRequestViewerOf(req: Request): DevRequestViewer {
  const roles: string[] = req.userContext.roles ?? [];
  return {
    userId: String(req.userContext.userId ?? ''),
    isBoss: roles.includes('boss'),
    canSeeAll: true,
  };
}

/** 能不能看这条需求：发布人、开发者、boss/admin 本人；别人一律当不存在（404） */
export function canSeeDevRequest(
  viewer: DevRequestViewer,
  row: { publisherId: string; developerId: string },
): boolean {
  return (
    viewer.canSeeAll ||
    viewer.userId === row.publisherId ||
    viewer.userId === row.developerId
  );
}
