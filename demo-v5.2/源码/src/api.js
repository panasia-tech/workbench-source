export async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export async function apiPost(path, payload = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `操作被业务门禁拦截 (${res.status})`);
    err.code = data.code || 'GUARD_ERROR';
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fmtYuan(cents) {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '—';
  return `¥${(Number(cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function mkIdem(prefix = 'idem') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
