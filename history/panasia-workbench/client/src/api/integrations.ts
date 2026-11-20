import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type { OptionalIntegrations } from '@shared/api.interface';

/** 读不到时按全关处理：飞书 / 豆包本来就是可选的，关着界面照样能用 */
export const ALL_INTEGRATIONS_OFF: OptionalIntegrations = {
  feishuNotify: false,
  feishuWikiSync: false,
  aiTaskReview: false,
  aiBlockDeferReview: false,
  aiWorkorderReview: false,
  aiQuickTaskDraft: false,
  aiSop: false,
  aiAgentTaskPush: false,
};

/** 飞书 / 豆包可选集成开了哪些（环境变量开关，默认全开） */
export async function fetchOptionalIntegrations(): Promise<OptionalIntegrations> {
  try {
    const response = await axiosForBackend({
      url: '/api/integrations',
      method: 'GET',
    });
    return { ...ALL_INTEGRATIONS_OFF, ...(response.data as OptionalIntegrations) };
  } catch (error) {
    logger.warn('获取可选集成开关失败，按全关处理', error);
    return ALL_INTEGRATIONS_OFF;
  }
}
