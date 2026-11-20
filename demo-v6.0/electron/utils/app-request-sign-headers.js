/**
 * 主进程若直连本仓库后端 `/app/*` 时复用（与渲染进程 `src/service/request/apiRequestSign.js`、服务端 `utils.appRequestSign` 同算法）。
 * 依赖 `.env` 中 `VITE_API_REQ_SIGN_SECRET`（dotenv 已在 main 加载）。
 * 当前项目主进程以 MTOP/闲鱼为主，一般不在此发业务 API；保留与「闲鱼工作台多开」主进程实现一致，便于以后扩展。
 */
import crypto from 'node:crypto'

/** @param {string} pathname */
export function normalizePathForAppSign(pathname) {
  if (!pathname || typeof pathname !== 'string') return '/'
  let p = pathname.trim().split('?')[0]
  if (!p.startsWith('/')) p = '/' + p
  return p.replace(/\/{2,}/g, '/') || '/'
}

/**
 * @param {string} method GET / POST …
 * @param {string} pathname 与 Express req.path 一致，不含 query
 * @param {string} secret
 */
export function buildAppHttpSignHeaders(method, pathname, secret) {
  const ts = String(Math.floor(Date.now() / 1000))
  const M = String(method || 'GET').toUpperCase()
  const P = normalizePathForAppSign(pathname)
  const raw = `APP|${M}|${P}|${ts}|${String(secret).trim()}`
  const sign = crypto.createHash('md5').update(raw, 'utf8').digest('hex')
  return {
    'X-App-Req-Ts': ts,
    'X-App-Req-Sign': sign
  }
}

/** @param {string} fullUrl */
export function pathnameFromRequestUrl(fullUrl) {
  try {
    return new URL(fullUrl).pathname || '/'
  } catch {
    return '/'
  }
}
