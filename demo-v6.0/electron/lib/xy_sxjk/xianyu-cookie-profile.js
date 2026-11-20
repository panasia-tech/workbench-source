/**
 * 从浏览器复制的 Cookie 串推断：是否为「淘宝账号已登录」闲鱼（区别于仅带 _m_h5_tk 的匿名浏览）。
 * 启发式，非官方枚举；用于选用 MTOP 查询参数 sessionOption 等。
 */

function cookieGetValue(cookieHeader, name) {
  const s = String(cookieHeader || '')
  const re = new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, 'i')
  const m = s.match(re)
  if (!m) return ''
  let v = String(m[1] || '').trim()
  try {
    v = decodeURIComponent(v)
  } catch {
    /* 保持 */
  }
  return v
}

/**
 * @param {string} cookieHeader
 * @returns {{ accountLoggedIn: boolean, confidence: 'high'|'low', hints: string[] }}
 */
function inferXianyuAccountLoginFromCookieHeader(cookieHeader) {
  const hints = []
  const tracknick = cookieGetValue(cookieHeader, 'tracknick')
  const unb = cookieGetValue(cookieHeader, 'unb')
  const lgc = cookieGetValue(cookieHeader, 'lgc')

  if (tracknick && tracknick.length > 0 && !/^deleted$/i.test(tracknick)) {
    hints.push('tracknick')
  }
  if (/^\d{5,20}$/.test(unb)) {
    hints.push('unb')
  }
  if (lgc && lgc.length > 0) {
    hints.push('lgc')
  }

  /** tracknick 为淘宝昵称，有则高置信账号已登录 */
  const strong = hints.includes('tracknick')
  /** 仅有 unb / lgc 等也可能表示会话，置信度低 */
  const weak = hints.includes('unb') || hints.includes('lgc')

  const accountLoggedIn = strong || weak
  return {
    accountLoggedIn,
    confidence: strong ? 'high' : weak ? 'low' : 'none',
    hints
  }
}

/**
 * MTOP URL 上的 sessionOption：按 Cookie 是否像「账号已登录」分支（与仅 _m_h5_tk 匿名浏览区分）。
 * 覆盖：XIANYU_MTOP_FORCE_SESSION_OPTION=AutoLoginOnly 时不再分支。
 * 单项覆盖：XIANYU_MTOP_SESSION_OPTION_ACCOUNT / XIANYU_MTOP_SESSION_OPTION_GUEST
 */
function resolveMtopSessionOptionForCookie(cookieHeader) {
  const force = String(process.env.XIANYU_MTOP_FORCE_SESSION_OPTION || '').trim()
  if (force) return force
  const { accountLoggedIn } = inferXianyuAccountLoginFromCookieHeader(cookieHeader)
  if (accountLoggedIn) {
    return String(process.env.XIANYU_MTOP_SESSION_OPTION_ACCOUNT || '').trim() || 'AutoLoginOnly'
  }
  return String(process.env.XIANYU_MTOP_SESSION_OPTION_GUEST || '').trim() || 'OptionalLogin'
}

module.exports = {
  inferXianyuAccountLoginFromCookieHeader,
  resolveMtopSessionOptionForCookie,
  cookieGetValue
}
