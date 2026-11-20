/**
 * 打开闲鱼前：解析 https 链接、从账号分区或传入 Cookie 解析凭证。
 */
import { readAccountCookieHeader } from './goofish-partition-cookie.js'
import { cookiesArrayToHeader } from './xianyu-playwright-cookies-to-electron.js'

export function headerHasMh5Tk(header) {
  return /(?:^|;\s*)_m_h5_tk=/i.test(String(header || ''))
}

/**
 * @param {string} rawUrl
 * @returns {{ ok: true, url: string } | { ok: false, msg: string }}
 */
export function parseAndValidateGoofishHttpsUrl(rawUrl) {
  const u = String(rawUrl || '').trim()
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') {
      return { ok: false, msg: '仅支持 https 链接' }
    }
    if (!(parsed.hostname || '').endsWith('goofish.com')) {
      return { ok: false, msg: '仅支持打开 goofish.com 站内链接' }
    }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false, msg: '链接无效' }
  }
}

/**
 * @param {{
 *   accountsDir?: string
 *   accountId?: string
 *   optsCookieHeader?: string
 *   optsPlaywrightCookies?: unknown[] | null
 *   readGlobalMeta?: () => Promise<{ cookieHeader?: string, playwrightCookies?: unknown[] }>
 * }} p
 */
export async function resolveGoofishOpenSessionCredentials(p) {
  let header = String(p.optsCookieHeader || '').trim()
  let playwrightCookies = Array.isArray(p.optsPlaywrightCookies) ? p.optsPlaywrightCookies : null
  const accountId = String(p.accountId || '').trim()

  if (accountId) {
    const snap = await readAccountCookieHeader(accountId)
    if (snap.ok && headerHasMh5Tk(snap.cookie)) {
      if (!header) header = String(snap.cookie || '').trim()
    }
  }
  if (!accountId && !header && !playwrightCookies?.length && typeof p.readGlobalMeta === 'function') {
    try {
      const meta = await p.readGlobalMeta()
      header = String(meta?.cookieHeader || '').trim()
      if (Array.isArray(meta?.playwrightCookies) && meta.playwrightCookies.length) {
        playwrightCookies = meta.playwrightCookies
      }
    } catch {
      /* */
    }
  }
  if (!headerHasMh5Tk(header) && playwrightCookies?.length) {
    header = cookiesArrayToHeader(playwrightCookies)
  }
  if (!headerHasMh5Tk(header)) {
    return {
      ok: false,
      msg: '缺少有效闲鱼 Cookie。请先在账号管理嵌入页完成登录。'
    }
  }
  return {
    ok: true,
    cookieHeader: header,
    playwrightCookies,
    browserKey: accountId || '__global__'
  }
}
