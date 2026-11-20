/**
 * 登录相关的站内地址（独立部署：登录页 /login，统一登录 /auth/oidc/login，退出 /auth/logout）。
 * 都是整页跳转，不走 axios。
 */
const BASE_PATH = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');

export const LOGIN_PATH = `${BASE_PATH}/login`;

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function isOnLoginPage(): boolean {
  return window.location.pathname === LOGIN_PATH;
}

export function loginUrl(next: string = currentPath()): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

export function oidcLoginUrl(next: string): string {
  return `${BASE_PATH}/auth/oidc/login?next=${encodeURIComponent(next)}`;
}

export function devLoginUrl(params: {
  userId: string;
  name: string;
  roles: string[];
  next: string;
}): string {
  const query = new URLSearchParams({
    userId: params.userId,
    name: params.name,
    roles: params.roles.join(','),
    next: params.next,
  });
  return `${BASE_PATH}/auth/dev-login?${query.toString()}`;
}

export function logoutUrl(): string {
  return `${BASE_PATH}/auth/logout`;
}

let redirecting = false;

/** 接口 401（没登录或会话过期）：整页跳登录页，登录完回到当前页 */
export function redirectToLogin(): void {
  if (redirecting || isOnLoginPage()) return;
  redirecting = true;
  window.location.assign(loginUrl());
}
