import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

import { redirectToLogin } from './auth';

interface BackendErrorBody {
  error?: { code?: string; message?: string };
}

export interface BackendError extends Error {
  status?: number;
}

export function getBackendErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const status = (error as BackendError).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * 平台 axios 拦截器会把 403 降级成 resolve（错误体当正常响应返回），
 * 应用侧各页面的 catch 因此收不到错误、直接渲染出 undefined 字段。
 * 这里在应用层统一把非 2xx 响应转回 reject，让页面 catch 拿到可读错误文案。
 * 401 = 没登录或会话过期：直接跳登录页。
 */
export function installBackendErrorGuard(): void {
  axiosForBackend.interceptors.response.use(
    (response) => {
      const { status } = response;
      if (status < 400) return response;
      const body = response.data as BackendErrorBody | undefined;
      const message =
        status === 403
          ? '无操作权限，请联系管理员分配角色'
          : (body?.error?.message ?? `请求失败（${status}）`);
      const error: BackendError = new Error(message);
      error.status = status;
      return Promise.reject(error);
    },
    (error: unknown) => {
      const status = (error as { response?: { status?: number } } | null)?.response
        ?.status;
      if (status === 401) {
        redirectToLogin();
      }
      return Promise.reject(error);
    },
  );
}
