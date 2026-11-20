import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { PerformanceOverview } from '@shared/api.interface';

export async function fetchPerformanceOverview(): Promise<PerformanceOverview> {
  try {
    const response = await axiosForBackend({
      url: '/api/performance',
      method: 'GET',
    });
    return response.data as PerformanceOverview;
  } catch (error) {
    logger.error('获取绩效数据失败', error);
    throw error;
  }
}
