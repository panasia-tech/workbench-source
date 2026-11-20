import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { isAxiosError } from 'axios';

import type {
  AcceptanceOverviewResponse,
  AcceptanceRecordCreateRequest,
  AcceptanceRecordResponse,
  AcceptanceRecordStateRequest,
  AcceptanceSubjectType,
  CreateWorkOrderRequest,
  CreateWorkOrderResponse,
  ReviewPlaneTaskActionRequest,
  ReviewPlaneTaskActionResponse,
  ReviewPlaneTasksResponse,
  ReviewVerdictRequest,
  ReviewVerdictResponse,
  ReviewWorkOrdersResponse,
  SubmitEvidenceRequest,
  WorkOrderActionResult,
  WorkOrderCatalogResponse,
  WorkOrderDetailResponse,
  WorkOrderHandoverCandidatesResponse,
  WorkOrderHandoverRequest,
  WorkOrderTransitionRequest,
  WorkOrdersResponse,
} from '@shared/api.interface';

/** 验收 Dock（boss 终审）403 等错误统一转可读文案 */
function normalizeReviewError(error: unknown, fallback: string): Error {
  if (isAxiosError(error)) {
    if (error.response?.status === 403) {
      return new Error('无操作权限，请联系管理员分配角色');
    }
    const data = error.response?.data as { message?: unknown } | undefined;
    if (typeof data?.message === 'string' && data.message) {
      return new Error(data.message);
    }
  }
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

export interface ListWorkOrdersParams {
  status?: string;
  taskId?: string;
  page?: number;
  pageSize?: number;
}

export async function listMyWorkOrders(
  params: ListWorkOrdersParams = {},
): Promise<WorkOrdersResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.taskId) query.set('taskId', params.taskId);
  if (params.page !== undefined) query.set('page', String(params.page));
  if (params.pageSize !== undefined) {
    query.set('pageSize', String(params.pageSize));
  }
  const qs = query.toString();
  const response = await axiosForBackend.get<WorkOrdersResponse>(
    `/api/work-orders${qs ? `?${qs}` : ''}`,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function fetchWorkOrderCatalog(): Promise<WorkOrderCatalogResponse> {
  const response = await axiosForBackend.get<WorkOrderCatalogResponse>(
    '/api/work-orders/catalog',
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function fetchWorkOrderDetail(
  id: string,
): Promise<WorkOrderDetailResponse> {
  const response = await axiosForBackend.get<WorkOrderDetailResponse>(
    `/api/work-orders/${id}`,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function createWorkOrder(
  payload: CreateWorkOrderRequest,
): Promise<CreateWorkOrderResponse> {
  const response = await axiosForBackend.post<CreateWorkOrderResponse>(
    '/api/work-orders',
    payload,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function submitWorkOrderEvidence(
  id: string,
  payload: SubmitEvidenceRequest,
): Promise<WorkOrderDetailResponse> {
  const response = await axiosForBackend.post<WorkOrderDetailResponse>(
    `/api/work-orders/${id}/evidence`,
    payload,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function transitionWorkOrder(
  id: string,
  payload: WorkOrderTransitionRequest,
): Promise<WorkOrderActionResult> {
  const response = await axiosForBackend.post<WorkOrderActionResult>(
    `/api/work-orders/${id}/transitions`,
    payload,
  );
  if (response.status === 403) {
    throw new Error('无操作权限，请联系管理员分配角色');
  }
  return response.data;
}

export async function fetchReviewWorkOrders(): Promise<ReviewWorkOrdersResponse> {
  try {
    const response = await axiosForBackend.get<ReviewWorkOrdersResponse>(
      '/api/admin/review/work-orders',
    );
    return response.data;
  } catch (error) {
    logger.error('获取终审工单列表失败', error);
    throw normalizeReviewError(error, '获取终审工单列表失败');
  }
}

export async function submitReviewVerdict(
  id: string,
  payload: ReviewVerdictRequest,
): Promise<ReviewVerdictResponse> {
  try {
    const response = await axiosForBackend.post<ReviewVerdictResponse>(
      `/api/admin/review/work-orders/${id}/verdict`,
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('工单终审操作失败', error);
    throw normalizeReviewError(error, '工单终审操作失败');
  }
}

export async function fetchReviewPlaneTasks(): Promise<ReviewPlaneTasksResponse> {
  try {
    const response = await axiosForBackend.get<ReviewPlaneTasksResponse>(
      '/api/admin/review/plane-tasks',
    );
    return response.data;
  } catch (error) {
    logger.error('获取待验收 Plane 任务失败', error);
    throw normalizeReviewError(error, '获取待验收任务失败');
  }
}

export async function submitPlaneTaskReview(
  taskId: string,
  payload: ReviewPlaneTaskActionRequest,
): Promise<ReviewPlaneTaskActionResponse> {
  try {
    const response = await axiosForBackend.post<ReviewPlaneTaskActionResponse>(
      `/api/admin/review/plane-tasks/${taskId}/action`,
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('Plane 任务验收操作失败', error);
    throw normalizeReviewError(error, '任务验收操作失败');
  }
}

// ───────── 转交（11-10 A01）─────────

export async function fetchHandoverCandidates(): Promise<WorkOrderHandoverCandidatesResponse> {
  try {
    const response = await axiosForBackend.get<WorkOrderHandoverCandidatesResponse>(
      '/api/work-orders/handover-candidates',
    );
    return response.data;
  } catch (error) {
    logger.error('获取可接手的人失败', error);
    throw normalizeReviewError(error, '获取可接手的人失败');
  }
}

export async function handoverWorkOrder(
  id: string,
  payload: WorkOrderHandoverRequest,
): Promise<WorkOrderDetailResponse> {
  try {
    const response = await axiosForBackend.post<WorkOrderDetailResponse>(
      `/api/work-orders/${id}/handover`,
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('工单转交失败', error);
    throw normalizeReviewError(error, '转交失败，请稍后重试');
  }
}

// ───────── 研究通过 / 经营批准 / 上架确认（11-10 A02，老板 / 管理员）─────────

export async function fetchAcceptanceOverview(
  subjectType: AcceptanceSubjectType,
  subjectId: string,
): Promise<AcceptanceOverviewResponse> {
  try {
    const response = await axiosForBackend.get<AcceptanceOverviewResponse>(
      `/api/admin/acceptance/${subjectType}/${encodeURIComponent(subjectId)}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取验收记录失败', error);
    throw normalizeReviewError(error, '获取验收记录失败');
  }
}

export async function createAcceptanceRecord(
  payload: AcceptanceRecordCreateRequest,
): Promise<AcceptanceRecordResponse> {
  try {
    const response = await axiosForBackend.post<AcceptanceRecordResponse>(
      '/api/admin/acceptance/records',
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('记验收记录失败', error);
    throw normalizeReviewError(error, '没记上，请稍后重试');
  }
}

export async function changeAcceptanceRecordState(
  id: string,
  payload: AcceptanceRecordStateRequest,
): Promise<AcceptanceRecordResponse> {
  try {
    const response = await axiosForBackend.post<AcceptanceRecordResponse>(
      `/api/admin/acceptance/records/${id}/state`,
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('改经营批准状态失败', error);
    throw normalizeReviewError(error, '没改成，请稍后重试');
  }
}
