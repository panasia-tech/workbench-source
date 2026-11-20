import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { WorkOverview } from '@shared/api.interface';

export async function fetchWorkOverview(): Promise<WorkOverview> {
  try {
    const response = await axiosForBackend({
      url: '/api/work',
      method: 'GET',
    });
    return response.data as WorkOverview;
  } catch (error) {
    logger.error('获取工作台数据失败', error);
    throw error;
  }
}
