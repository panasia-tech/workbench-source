/**
 * 主进程：本机算签 + POST user.page.nav，判断 Cookie 是否仍有效
 */
import { xianyuMtop } from './xianyu-mtop-client.js'

/**
 * @param {string} cookieHeader
 * @returns {Promise<{ ok: boolean, displayName: string, avatar?: string, error?: string, json?: any }>}
 */
export async function verifyGoofishMtopWithUserPageNav(cookieHeader) {
  const s = String(cookieHeader || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
  if (!s) return { ok: false, displayName: '', error: 'empty_cookie' }
  if (!/(?:^|;\s*)_m_h5_tk=/i.test(s)) {
    return { ok: false, displayName: '', error: 'missing_mh5_tk' }
  }
  try {
    const nav = await xianyuMtop.userPageNav(s, { sessionOption: 'AutoLoginOnly' })
    return {
      ok: nav.ok === true,
      displayName: String(nav.displayName || '').trim(),
      ...(nav.avatar ? { avatar: nav.avatar } : {}),
      json: nav.json ?? nav.mtopRawJson ?? null,
      ...(nav.ok ? {} : { error: String(nav.error || 'mtop_fail') })
    }
  } catch (e) {
    return { ok: false, displayName: '', error: String(e?.message || e) }
  }
}
