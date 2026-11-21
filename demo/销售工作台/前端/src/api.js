// 取数：ERP 接口。演示时指向本机演示后端；换成正式地址就是真数据（见 vite.config.js）。
export const REAL = typeof window !== 'undefined' && window.__REAL__ === true
export async function api(path, opt = {}) {
  const method = (opt.method || 'GET').toUpperCase()
  if (REAL && method !== 'GET' && !path.startsWith('/auth/') && !/^\/(virtual|demo)/.test(path)) throw new Error('真实数据模式只读：这里不会写入生产系统')
  const r = await fetch('/api' + path, {
    ...opt,
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || ''), 'Content-Type': 'application/json' }
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401 && !path.startsWith('/auth/')) {
    localStorage.removeItem('erp_token')
    if (!sessionStorage.getItem('relogin')) { sessionStorage.setItem('relogin', '1'); location.reload() }
  }
  if (r.ok) sessionStorage.removeItem('relogin')
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`)
  return data
}
export const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) })
export const me = () => { try { return JSON.parse(localStorage.getItem('erp_staff') || '{}') } catch { return {} } }
export const ROLE = { SALES: '销售', ADMIN: '管理员', WAREHOUSE: '仓管', PURCHASER: '采购', OUTSOURCE_CS: '外部外包客服' }
