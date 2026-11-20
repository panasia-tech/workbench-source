/**
 * Cookie 请求头中某键是否有非空值（名不区分大小写）
 * @param {string} header
 * @param {string} cookieName 如 _m_h5_tk
 */
export function cookieHeaderHasNamedValue(header, cookieName) {
  const target = String(cookieName || '').trim().toLowerCase()
  if (!target) return false
  for (const part of String(header || '').split(';')) {
    const s = part.trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const name = s.slice(0, eq).trim().toLowerCase()
    if (name !== target) continue
    const value = s.slice(eq + 1).trim()
    return value.length > 0
  }
  return false
}

/**
 * 是否含可用的 _m_h5_tk（MTOP 签名）
 */
export function cookieHeaderHasMh5Tk(header) {
  return cookieHeaderHasNamedValue(header, '_m_h5_tk')
}

/**
 * 监听 / 会话是否算「已登录」（_task 管理、拉取 Cookie 给 pollSearch 等）
 * 以非空 _m_h5_tk（MTOP 签名）为准。
 */
export function cookieHeaderOkForXianyuListen(header) {
  return cookieHeaderHasMh5Tk(header)
}
