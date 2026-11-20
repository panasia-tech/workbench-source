/**
 * www.goofish.com 顶栏昵称：非「登录」即视为已登录（与 Playwright 采集、应用内登录窗一致）。
 */

export const GOOFISH_NAV_LOGIN_STATE_JS = `(function(){
  try {
    const container =
      document.querySelector('[class*="user-order-container"]') ||
      document.querySelector('[data-spm="nav"]')
    if (!container) return { loggedIn: false, nick: '', reason: 'no_container' }
    const nickEl = container.querySelector('[class*="nick--"]')
    const t = (nickEl?.textContent || '').trim().replace(/\\s+/g, ' ')
    if (!t) return { loggedIn: false, nick: '', reason: 'empty_nick' }
    if (t === '登录') return { loggedIn: false, nick: '', reason: 'login_prompt' }
    return { loggedIn: true, nick: t.slice(0, 128), reason: 'ok' }
  } catch (_) {
    return { loggedIn: false, nick: '', reason: 'evaluate_error' }
  }
})()`

export const GOOFISH_NAV_NICKNAME_EXTRACT_JS = `(function(){
  try {
    const navBox =
      document.querySelector('[class*="user-order-container"]') ||
      document.querySelector('[data-spm="nav"]')
    if (navBox) {
      const n = navBox.querySelector('[class*="nick--"]')
      const tn = (n?.textContent || '').trim()
      if (tn && tn !== '登录') return tn.slice(0, 128)
    }
    const links = Array.from(document.querySelectorAll('a[href*="personal"]'))
    for (const a of links) {
      const href = String(a.getAttribute('href') || '').toLowerCase()
      if (!href.includes('personal')) continue
      const nickEl =
        a.querySelector('[class*="nick--"]') ||
        a.querySelector('div[class^="nick--"]') ||
        a.querySelector('[class*="nick"]')
      const t = (nickEl?.textContent || '').trim()
      if (t && t !== '登录') return t.slice(0, 128)
    }
    const loose = document.querySelector('header [class*="nick--"], nav [class*="nick--"]')
    const t2 = (loose?.textContent || '').trim()
    return t2 && t2 !== '登录' ? t2.slice(0, 128) : ''
  } catch (_) {
    return ''
  }
})()`

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 */
export async function readGoofishNavLoginStateFromWebContents(webContents) {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) {
    return { loggedIn: false, nick: '', reason: 'no_wc' }
  }
  try {
    const raw = await webContents.executeJavaScript(GOOFISH_NAV_LOGIN_STATE_JS, true)
    if (!raw || typeof raw !== 'object') {
      return { loggedIn: false, nick: '', reason: 'bad_result' }
    }
    return {
      loggedIn: raw.loggedIn === true,
      nick: String(raw.nick || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 64),
      reason: String(raw.reason || '')
    }
  } catch {
    return { loggedIn: false, nick: '', reason: 'evaluate_error' }
  }
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 */
export async function tryExtractGoofishNicknameFromWebContents(webContents) {
  if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) {
    return ''
  }
  try {
    const raw = await webContents.executeJavaScript(GOOFISH_NAV_NICKNAME_EXTRACT_JS, true)
    return String(raw || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 64)
  } catch {
    return ''
  }
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 */
export async function goofishHomeNavLooksLoggedIn(webContents) {
  const st = await readGoofishNavLoginStateFromWebContents(webContents)
  if (st.loggedIn && st.nick) return true
  const nick = await tryExtractGoofishNicknameFromWebContents(webContents)
  return !!(nick && nick !== '登录')
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 */
export async function resolveGoofishNicknameFromWebContents(webContents) {
  const st = await readGoofishNavLoginStateFromWebContents(webContents)
  let nick = String(st.nick || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!nick || nick === '登录') {
    nick = await tryExtractGoofishNicknameFromWebContents(webContents)
  }
  if (!nick || nick === '登录') return { loggedIn: false, nick: '' }
  return { loggedIn: true, nick: nick.slice(0, 64) }
}
