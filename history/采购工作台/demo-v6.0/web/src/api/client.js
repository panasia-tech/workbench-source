/**
 * 真实全栈 REST 客户端（自动附带 JWT Token，并标准化 400/401/403/409/422/429 错误提示）
 */
export const TOKEN_KEY = 'panasia_v6_jwt_token';

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiRequest(url, options = {}) {
  const token = getStoredToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Erp-Token'] = token;
  }

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.ok === false) {
    const err = new ApiError(
      resp.status,
      json.code || `HTTP_${resp.status}`,
      json.message || `请求失败 (${resp.status})`,
      json
    );
    if (resp.status === 401 && !url.includes('/api/auth/login')) {
      setStoredToken('');
    }
    throw err;
  }
  return json;
}
