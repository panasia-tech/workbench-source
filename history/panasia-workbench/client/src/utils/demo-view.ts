import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

const DEMO_VIEW_STORAGE_KEY = 'demo-view-as';

export function getDemoAs(): string | null {
  try {
    return window.localStorage.getItem(DEMO_VIEW_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setDemoAs(userId: string): void {
  window.localStorage.setItem(DEMO_VIEW_STORAGE_KEY, userId);
}

export function clearDemoAs(): void {
  window.localStorage.removeItem(DEMO_VIEW_STORAGE_KEY);
}

export function installDemoViewInterceptor(): void {
  axiosForBackend.interceptors.request.use((config) => {
    const demoAs = getDemoAs();
    if (demoAs && !config.headers['x-demo-as']) {
      config.headers['x-demo-as'] = demoAs;
    }
    return config;
  });
}
