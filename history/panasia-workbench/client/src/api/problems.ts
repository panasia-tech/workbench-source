import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

import type {
  BlockerItem,
  BlockerListResponse,
  ImprovementProjectItem,
  ImprovementProjectsResponse,
  ImprovementStage,
  MyBlockersResponse,
  ProblemPoolActionRequest,
  ProblemPoolActionResponse,
  ProblemPoolResponse,
  SubmitBlockerRequest,
  SubmitBlockerResponse,
} from '@shared/api.interface';

export const BLOCKER_CATEGORY_LABELS: Record<string, string> = {
  tool: '工具',
  system: '系统',
  permission: '权限',
  process: '流程',
  external_supplier: '外部供应商',
  logistics: '物流',
  customer: '客户',
  resource: '资源',
  knowledge: '知识技能',
  coordination: '协作',
  quality: '质量',
  policy: '制度合规',
  finance: '资金',
  data: '数据',
  other: '其他',
};

export const BLOCKER_SEVERITY_LABELS: Record<string, string> = {
  normal: '一般',
  high: '较严重',
  critical: '严重',
};

export const BLOCKER_STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  waiting: '等待中',
  resolved: '已解决',
  closed: '已关闭',
};

export const PROBLEM_POOL_STATUS_LABELS: Record<string, string> = {
  candidate: '候选',
  confirmed: '已确认',
  dismissed: '已驳回',
  projected: '已立项',
  pending_response: '待响应',
};

export const IMPROVEMENT_STAGE_OPTIONS: {
  value: ImprovementStage;
  label: string;
}[] = [
  { value: 'define', label: '定义' },
  { value: 'root_cause', label: '根因分析' },
  { value: 'design', label: '方案设计' },
  { value: 'implement', label: '实施' },
  { value: 'verify', label: '验证' },
  { value: 'standardize', label: '标准化' },
  { value: 'observe', label: '观察期' },
  { value: 'closed', label: '关闭' },
];

export function improvementStageLabel(stage: string): string {
  return (
    IMPROVEMENT_STAGE_OPTIONS.find(
      (item: { value: ImprovementStage; label: string }) =>
        item.value === stage,
    )?.label ?? stage
  );
}

export async function listMyBlockers(): Promise<MyBlockersResponse> {
  const response = await axiosForBackend.get<MyBlockersResponse>(
    '/api/problems/my',
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function submitBlocker(
  payload: SubmitBlockerRequest,
): Promise<SubmitBlockerResponse> {
  const response = await axiosForBackend.post<SubmitBlockerResponse>(
    '/api/problems',
    payload,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function listAllBlockers(): Promise<BlockerListResponse> {
  const response = await axiosForBackend.get<BlockerListResponse>(
    '/api/admin/problems/blockers',
  );
  if (response.status === 403) {
    throw new Error('无操作权限，需要 boss 角色');
  }
  return response.data;
}

export async function getProblemPool(): Promise<ProblemPoolResponse> {
  const response = await axiosForBackend.get<ProblemPoolResponse>(
    '/api/admin/problems/pool',
  );
  if (response.status === 403) {
    throw new Error('无操作权限，需要 boss 角色');
  }
  return response.data;
}

export async function submitPoolAction(
  poolId: string,
  payload: ProblemPoolActionRequest,
): Promise<ProblemPoolActionResponse> {
  const response = await axiosForBackend.post<ProblemPoolActionResponse>(
    `/api/admin/problems/pool/${poolId}/action`,
    payload,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，需要 boss 角色');
  }
  return response.data;
}

export async function listImprovements(): Promise<ImprovementProjectsResponse> {
  const response = await axiosForBackend.get<ImprovementProjectsResponse>(
    '/api/admin/problems/improvements',
  );
  if (response.status === 403) {
    throw new Error('无操作权限，需要 boss 角色');
  }
  return response.data;
}

export async function updateImprovementStage(
  improvementId: string,
  stage: ImprovementStage,
): Promise<ImprovementProjectItem> {
  const response = await axiosForBackend.patch<ImprovementProjectItem>(
    `/api/admin/problems/improvements/${improvementId}/stage`,
    { stage },
  );
  if (response.status === 403) {
    throw new Error('无操作权限，需要 boss 角色');
  }
  return response.data;
}

export type { BlockerItem, ImprovementProjectItem };
