import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { isAxiosError } from 'axios';

import type {
  CreateDevRequestRequest,
  DevRequestAcceptRequest,
  DevRequestActionResponse,
  DevRequestClarifyRequest,
  DevRequestDeliverRequest,
  DevRequestDetail,
  DevRequestDevelopersResponse,
  DevRequestLedgerResponse,
  DevRequestListResponse,
  DevRequestOptionsResponse,
  DevRequestQuoteRequest,
  DevRequestStage,
} from '@shared/api.interface';

export type DevRequestScope = 'mine' | 'assigned' | 'all';

/** 后端报错原话（400 / 403 / 404 都是中文人话），拿不到用兜底文案 */
export function devRequestErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as
      | { message?: unknown; error?: { message?: unknown } }
      | undefined;
    const message = data?.error?.message ?? data?.message;
    if (typeof message === 'string' && message !== '' && message !== '服务器内部错误') {
      return message;
    }
  }
  if (error instanceof Error && error.message && !error.message.startsWith('Request failed')) {
    return error.message;
  }
  return fallback;
}

export function devRequestErrorStatus(error: unknown): number | undefined {
  if (isAxiosError(error)) return error.response?.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

async function request<T>(
  method: 'GET' | 'POST',
  url: string,
  label: string,
  data?: unknown,
): Promise<T> {
  try {
    const response = await axiosForBackend({ url, method, data });
    return response.data as T;
  } catch (error) {
    logger.error(label, error);
    throw error;
  }
}

export function fetchDevRequests(scope: DevRequestScope): Promise<DevRequestListResponse> {
  return request('GET', `/api/dev-requests?scope=${scope}`, '获取开发需求列表失败');
}

export function fetchDevRequestTodoCount(): Promise<{ count: number }> {
  return request('GET', '/api/dev-requests/todo-count', '获取开发需求待办数失败');
}

export function fetchDevRequestOptions(): Promise<DevRequestOptionsResponse> {
  return request('GET', '/api/dev-requests/options', '获取开发类项目失败');
}

export function fetchDevRequestDevelopers(
  projectId: string,
): Promise<DevRequestDevelopersResponse> {
  return request(
    'GET',
    `/api/dev-requests/options/developers?projectId=${encodeURIComponent(projectId)}`,
    '获取项目开发者失败',
  );
}

export function fetchDevRequest(id: string): Promise<DevRequestDetail> {
  return request('GET', `/api/dev-requests/${encodeURIComponent(id)}`, '获取开发需求详情失败');
}

export function createDevRequest(
  body: CreateDevRequestRequest,
): Promise<DevRequestActionResponse> {
  return request('POST', '/api/dev-requests', '发布开发需求失败', body);
}

function action(
  id: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<DevRequestActionResponse> {
  return request('POST', `/api/dev-requests/${encodeURIComponent(id)}/${path}`, label, body ?? {});
}

export const quoteDevRequest = (id: string, body: DevRequestQuoteRequest) =>
  action(id, 'quote', '报价失败', body);
export const returnDevRequest = (id: string, reason: string) =>
  action(id, 'return', '退回补充失败', { reason });
export const clarifyDevRequest = (id: string, body: DevRequestClarifyRequest) =>
  action(id, 'clarify', '补充需求失败', body);
export const confirmDevRequestQuote = (id: string) =>
  action(id, 'confirm-quote', '确认报价失败');
export const rejectDevRequestQuote = (id: string, reason: string) =>
  action(id, 'reject-quote', '退回报价失败', { reason });
export const deliverDevRequest = (id: string, body: DevRequestDeliverRequest) =>
  action(id, 'deliver', '交付失败', body);
export const acceptDevRequest = (id: string, body: DevRequestAcceptRequest) =>
  action(id, 'accept', '验收失败', body);
export const rejectDevRequestDelivery = (id: string, reason: string) =>
  action(id, 'reject-delivery', '打回失败', { reason });
export const cancelDevRequest = (id: string, reason: string) =>
  action(id, 'cancel', '撤销失败', { reason });

// ───────── 管理端 ─────────

export function fetchAdminDevRequests(
  stage?: DevRequestStage,
): Promise<DevRequestListResponse> {
  return request(
    'GET',
    `/api/admin/dev-requests${stage ? `?stage=${stage}` : ''}`,
    '获取全部开发需求失败',
  );
}

export function fetchDevRequestLedger(query: {
  month: string;
  developerId: string;
  projectId: string;
}): Promise<DevRequestLedgerResponse> {
  const params = new URLSearchParams();
  params.set('month', query.month || 'all');
  if (query.developerId) params.set('developerId', query.developerId);
  if (query.projectId) params.set('projectId', query.projectId);
  return request(
    'GET',
    `/api/admin/dev-requests/ledger?${params.toString()}`,
    '获取开发需求台账失败',
  );
}
