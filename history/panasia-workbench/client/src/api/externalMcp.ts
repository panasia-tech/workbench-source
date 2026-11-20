import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { isAxiosError } from 'axios';

import type {
  ExternalMcpListResponse,
  ExternalMcpServerResponse,
  ExternalMcpUpsertRequest,
} from '@shared/api.interface';

/** 服务端的错误文案原样给人看（名称重复、地址不对这类） */
function readableError(error: unknown, fallback: string): Error {
  if (isAxiosError(error)) {
    if (error.response?.status === 403) return new Error('没有权限');
    const data = error.response?.data as { message?: unknown } | undefined;
    if (typeof data?.message === 'string' && data.message) return new Error(data.message);
    if (Array.isArray(data?.message) && typeof data?.message[0] === 'string') {
      return new Error(data.message[0]);
    }
  }
  return new Error(fallback);
}

export async function listExternalMcp(): Promise<ExternalMcpListResponse> {
  try {
    const response = await axiosForBackend.get<ExternalMcpListResponse>('/api/admin/external-mcp');
    return response.data;
  } catch (error) {
    logger.error('获取外部 MCP 列表失败', error);
    throw readableError(error, '加载失败');
  }
}

export async function createExternalMcp(
  payload: ExternalMcpUpsertRequest,
): Promise<ExternalMcpServerResponse> {
  try {
    const response = await axiosForBackend.post<ExternalMcpServerResponse>(
      '/api/admin/external-mcp',
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('登记外部 MCP 失败', error);
    throw readableError(error, '没存上');
  }
}

export async function updateExternalMcp(
  id: string,
  payload: Partial<ExternalMcpUpsertRequest>,
): Promise<ExternalMcpServerResponse> {
  try {
    const response = await axiosForBackend.patch<ExternalMcpServerResponse>(
      `/api/admin/external-mcp/${id}`,
      payload,
    );
    return response.data;
  } catch (error) {
    logger.error('修改外部 MCP 失败', error);
    throw readableError(error, '没存上');
  }
}

export async function deleteExternalMcp(id: string): Promise<void> {
  try {
    await axiosForBackend.delete(`/api/admin/external-mcp/${id}`);
  } catch (error) {
    logger.error('删除外部 MCP 失败', error);
    throw readableError(error, '没删掉');
  }
}

export async function testExternalMcp(id: string): Promise<ExternalMcpServerResponse> {
  try {
    const response = await axiosForBackend.post<ExternalMcpServerResponse>(
      `/api/admin/external-mcp/${id}/test`,
    );
    return response.data;
  } catch (error) {
    logger.error('测试外部 MCP 失败', error);
    throw readableError(error, '测试没跑起来');
  }
}
