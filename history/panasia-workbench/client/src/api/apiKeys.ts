import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  ApiKeyIssueResponse,
  ApiKeyListResponse,
  OAuthGrantListResponse,
} from '@shared/api.interface';

export async function fetchApiKeys(): Promise<ApiKeyListResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/api-keys',
      method: 'GET',
    });
    return response.data as ApiKeyListResponse;
  } catch (error) {
    logger.error('获取 API Key 列表失败', error);
    throw error;
  }
}

/** 签发：返回里的 key 只此一次，之后列表只有前缀 */
export async function issueApiKey(name: string): Promise<ApiKeyIssueResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/api-keys',
      method: 'POST',
      data: { name },
    });
    return response.data as ApiKeyIssueResponse;
  } catch (error) {
    logger.error('签发 API Key 失败', error);
    throw error;
  }
}

export async function revokeApiKey(id: string): Promise<void> {
  try {
    await axiosForBackend({
      url: `/api/my/api-keys/${id}/revoke`,
      method: 'POST',
    });
  } catch (error) {
    logger.error('吊销 API Key 失败', error);
    throw error;
  }
}

/** 用 OAuth 授权过的 AI 应用（ChatGPT 网页版等不填 key 的） */
export async function fetchOAuthGrants(): Promise<OAuthGrantListResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/oauth-grants',
      method: 'GET',
    });
    return response.data as OAuthGrantListResponse;
  } catch (error) {
    logger.error('获取已授权应用失败', error);
    throw error;
  }
}

export async function revokeOAuthGrant(id: string): Promise<void> {
  try {
    await axiosForBackend({
      url: `/api/my/oauth-grants/${id}/revoke`,
      method: 'POST',
    });
  } catch (error) {
    logger.error('收回授权失败', error);
    throw error;
  }
}
