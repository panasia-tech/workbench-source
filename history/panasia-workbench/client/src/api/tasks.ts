import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  TaskActionResult,
  TaskAssistRequest,
  TaskBlockRequest,
  TaskDetail,
  TaskEvidenceRequest,
  TaskHistoryQuery,
  TaskHistoryResponse,
  TaskStatusUpdateRequest,
  TasksOverview,
} from '@shared/api.interface';

export async function fetchTasksOverview(): Promise<TasksOverview> {
  try {
    const response = await axiosForBackend({
      url: '/api/tasks',
      method: 'GET',
    });
    return response.data as TasksOverview;
  } catch (error) {
    logger.error('获取任务总览失败', error);
    throw error;
  }
}

export async function fetchTaskDetail(
  taskId: string,
  projectId?: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  try {
    const response = await axiosForBackend({
      url: projectId
        ? `/api/tasks/${taskId}?projectId=${projectId}`
        : `/api/tasks/${taskId}`,
      method: 'GET',
      signal,
    });
    return response.data as TaskDetail;
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.error('获取任务详情失败', error);
    throw error;
  }
}

export async function updateTaskStatus(
  taskId: string,
  body: TaskStatusUpdateRequest,
): Promise<TaskActionResult> {
  try {
    const response = await axiosForBackend({
      url: `/api/tasks/${taskId}/status`,
      method: 'POST',
      data: body,
    });
    return response.data as TaskActionResult;
  } catch (error) {
    logger.error('更新任务状态失败', error);
    throw error;
  }
}

export async function submitTaskBlock(
  taskId: string,
  body: TaskBlockRequest,
): Promise<TaskActionResult> {
  try {
    const response = await axiosForBackend({
      url: `/api/tasks/${taskId}/block`,
      method: 'POST',
      data: body,
    });
    return response.data as TaskActionResult;
  } catch (error) {
    logger.error('提交阻塞失败', error);
    throw error;
  }
}

export async function submitTaskEvidence(
  taskId: string,
  body: TaskEvidenceRequest,
): Promise<TaskActionResult> {
  try {
    const response = await axiosForBackend({
      url: `/api/tasks/${taskId}/evidence`,
      method: 'POST',
      data: body,
    });
    return response.data as TaskActionResult;
  } catch (error) {
    logger.error('提交验收凭证失败', error);
    throw error;
  }
}

export async function requestTaskAssist(
  taskId: string,
  body: TaskAssistRequest,
): Promise<TaskActionResult> {
  try {
    const response = await axiosForBackend({
      url: `/api/tasks/${taskId}/assist`,
      method: 'POST',
      data: body,
    });
    return response.data as TaskActionResult;
  } catch (error) {
    logger.error('申请协助失败', error);
    throw error;
  }
}

export async function fetchTaskHistory(
  query: TaskHistoryQuery,
): Promise<TaskHistoryResponse> {
  try {
    const params = new URLSearchParams();
    if (query.date) params.set('date', query.date);
    if (query.scope) params.set('scope', query.scope);
    if (query.keyword) params.set('keyword', query.keyword);
    const qs = params.toString();
    const response = await axiosForBackend({
      url: `/api/tasks/history${qs ? `?${qs}` : ''}`,
      method: 'GET',
    });
    return response.data as TaskHistoryResponse;
  } catch (error) {
    logger.error('获取历史任务失败', error);
    throw error;
  }
}
