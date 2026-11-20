import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { AuthOptionsResponse } from '@shared/api.interface';

export async function fetchAuthOptions(): Promise<AuthOptionsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/auth/options',
      method: 'GET',
    });
    return response.data as AuthOptionsResponse;
  } catch (error) {
    logger.error('获取登录方式失败', error);
    throw error;
  }
}
