// 闲鱼登录态判断：基础风控/访客 Cookie（例如 unb、tfstk）即使退出后仍会保留，
// 不能拿它们作为“已登录”依据。这里优先检查实际登录会话 Cookie。
const STRONG_LOGIN_COOKIE_NAMES = new Set(['havana_lgc2_77', '_hvn_lgc_'])
const LEGACY_LOGIN_COOKIE_NAMES = new Set(['cookie2', 'munb', '_l_g_'])

export function hasAuthenticatedXianyuCookies(cookies) {
  const rows = Array.isArray(cookies) ? cookies : []
  const valid = new Set(rows.filter((cookie) => cookie?.value).map((cookie) => String(cookie.name || '')))
  if ([...STRONG_LOGIN_COOKIE_NAMES].some((name) => valid.has(name))) return true
  // 兼容旧版登录态：cookie2 单独不够，必须同时有用户态 Cookie。
  return valid.has('cookie2') && [...LEGACY_LOGIN_COOKIE_NAMES].some((name) => name !== 'cookie2' && valid.has(name))
}
