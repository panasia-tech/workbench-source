/**
 * 嵌入 BrowserView：判断是否处于闲鱼/鱼小铺登录页或登录弹层。
 */
import { classifyGoofishSellerEmbedRoute } from './goofish-seller-hash-route.js'
import { readGoofishNavLoginStateFromWebContents } from './goofish-nav-login-state.js'

/** @param {string} url */
export function goofishUrlLooksLikeLoginPage(url) {
  const u = String(url || '').trim()
  if (!u) return false
  if (/passport\.(goofish|taobao)\.com/i.test(u)) return true
  if (/mini_login/i.test(u)) return true
  if (/seller\.goofish\.com/i.test(u) && classifyGoofishSellerEmbedRoute(u) === 'login') {
    return true
  }
  return false
}

export const GOOFISH_EMBED_LOGIN_PAGE_DETECT_JS = `(function(){
  try {
    const href = String(location.href || '')
    if (/passport\\.(goofish|taobao)\\.com/i.test(href) || /mini_login/i.test(href)) {
      return { onLoginPage: true, reason: 'url' }
    }
    const body = (document.body?.innerText || '').slice(0, 12000)
    if (
      /短信登录|手机扫码安全登录|密码登录/.test(body) &&
      (/获取验证码|扫码/.test(body) || /fm-login|login-box|passport/i.test(document.documentElement?.innerHTML || ''))
    ) {
      return { onLoginPage: true, reason: 'login_modal' }
    }
    const ifr = document.querySelector(
      'iframe[src*="passport"], iframe[src*="login.taobao"], iframe[src*="mini_login"]'
    )
    if (ifr) return { onLoginPage: true, reason: 'passport_iframe' }
    const host = String(location.hostname || '')
    if (/www\\.goofish\\.com|goofish\\.com|m\\.goofish\\.com/i.test(host)) {
      const nickEl =
        document.querySelector('[class*="user-order-container"] [class*="nick--"]') ||
        document.querySelector('[data-spm="nav"] [class*="nick--"]')
      const nt = (nickEl?.textContent || '').trim()
      if (nt === '登录') return { onLoginPage: true, reason: 'nav_login' }
    }
    if (/seller\\.goofish\\.com/i.test(host)) {
      const hash = String(location.hash || '').replace(/^#\\/?/, '').split('?')[0].toLowerCase()
      if (hash === 'login') return { onLoginPage: true, reason: 'seller_hash_login' }
    }
    return { onLoginPage: false, reason: 'ok' }
  } catch (_) {
    return { onLoginPage: false, reason: 'evaluate_error' }
  }
})()`

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 * @param {string} [pageUrl]
 */
/** @param {string} url */
export function isGoofishMainImUrl(url) {
  try {
    const u = new URL(String(url || '').trim())
    const host = u.hostname
    if (host !== 'www.goofish.com' && host !== 'goofish.com' && host !== 'm.goofish.com') {
      return false
    }
    const path = u.pathname.replace(/\/$/, '') || '/'
    return path === '/im' || path.startsWith('/im/')
  } catch {
    return false
  }
}

/** 闲鱼主站 /im：顶栏未登录，或已登录但消息区壳子空白（无列表、无「尚未选择联系人」提示） */
export const GOOFISH_IM_EMBED_BLANK_DETECT_JS = `(function(){
  try {
    const href = String(location.href || '')
    if (!/www\\.goofish\\.com|goofish\\.com|m\\.goofish\\.com/i.test(location.hostname)) {
      return { blank: false, reason: 'not_main' }
    }
    if (!/\\/im(\\/|$|\\?|#)/i.test(href) && !href.includes('/im')) {
      return { blank: false, reason: 'not_im' }
    }
    const nickEl =
      document.querySelector('[class*="user-order-container"] [class*="nick--"]') ||
      document.querySelector('[data-spm="nav"] [class*="nick--"]')
    const nt = (nickEl?.textContent || '').trim()
    if (nt === '登录') return { blank: true, reason: 'nav_login' }
    const body = (document.body?.innerText || '').slice(0, 8000)
    if (/尚未选择任何联系人|快点左侧列表聊起来/.test(body)) {
      return { blank: false, reason: 'im_empty_hint' }
    }
    const listSel =
      '[class*="conversation"], [class*="session-item"], [class*="message-list"] [class*="item"], [class*="chat-list"] li, [class*="ConvList"]'
    if (document.querySelectorAll(listSel).length > 0) {
      return { blank: false, reason: 'has_list' }
    }
    if (nt && nt !== '登录') {
      const main =
        document.querySelector('[class*="im"], [class*="message"], main') || document.body
      const t = (main?.innerText || '').replace(/\\s+/g, ' ').trim()
      if (t.length < 12) return { blank: true, reason: 'im_shell_empty' }
    }
    return { blank: false, reason: 'ok' }
  } catch (_) {
    return { blank: false, reason: 'evaluate_error' }
  }
})()`

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 * @param {string} [pageUrl]
 */
export async function readGoofishImEmbedLooksBlankFromWebContents(webContents, pageUrl) {
  let url = String(pageUrl || '').trim()
  if (!url && webContents && !webContents.isDestroyed()) {
    try {
      url = String(webContents.getURL() || '').trim()
    } catch {
      url = ''
    }
  }
  if (!isGoofishMainImUrl(url)) {
    return { blank: false, reason: 'not_im' }
  }
  const loginSt = await readGoofishEmbedShowsLoginPageFromWebContents(webContents, url)
  if (loginSt.onLoginPage) {
    return { blank: true, reason: String(loginSt.reason || 'login').trim() }
  }
  if (!webContents || webContents.isDestroyed()) {
    return { blank: false, reason: 'no_wc' }
  }
  try {
    const raw = await webContents.executeJavaScript(GOOFISH_IM_EMBED_BLANK_DETECT_JS, true)
    if (raw?.blank === true) {
      return { blank: true, reason: String(raw.reason || 'im_blank').trim() }
    }
  } catch {
    /* */
  }
  return { blank: false, reason: 'ok' }
}

export async function readGoofishEmbedShowsLoginPageFromWebContents(webContents, pageUrl) {
  let url = String(pageUrl || '').trim()
  if (!url && webContents && !webContents.isDestroyed()) {
    try {
      url = String(webContents.getURL() || '').trim()
    } catch {
      url = ''
    }
  }
  if (goofishUrlLooksLikeLoginPage(url)) {
    return { onLoginPage: true, reason: 'url' }
  }
  if (!webContents || webContents.isDestroyed()) {
    return { onLoginPage: false, reason: 'no_wc' }
  }
  try {
    const raw = await webContents.executeJavaScript(GOOFISH_EMBED_LOGIN_PAGE_DETECT_JS, true)
    if (raw?.onLoginPage === true) {
      return { onLoginPage: true, reason: String(raw.reason || 'dom').trim() }
    }
  } catch {
    /* */
  }
  try {
    const host = new URL(url).hostname
    if (host === 'www.goofish.com' || host === 'goofish.com' || host === 'm.goofish.com') {
      const nav = await readGoofishNavLoginStateFromWebContents(webContents)
      if (!nav.loggedIn) {
        return { onLoginPage: true, reason: String(nav.reason || 'nav_not_logged_in').trim() }
      }
    }
  } catch {
    /* */
  }
  return { onLoginPage: false, reason: 'ok' }
}

/** 一键/后台自动登录窗：首页灰块 + 底部「立即登录」条等 */
export const GOOFISH_HOME_BLANK_LOGIN_DETECT_JS = `(function(){
  try {
    const host = String(location.hostname || '')
    if (!/www\\.goofish\\.com|goofish\\.com|m\\.goofish\\.com/i.test(host)) {
      return { abort: false, reason: 'not_main' }
    }
    const body = (document.body?.innerText || '').slice(0, 14000)
    if (/立即登录|登录后可以更懂你|推荐你喜欢的商品/.test(body)) {
      return { abort: true, reason: 'login_banner' }
    }
    const itemLinks = document.querySelectorAll(
      'a[href*="item"], [class*="feeds"] a, [class*="Feed"] a, [class*="card"] a'
    )
    if (itemLinks.length < 2) {
      const sk = document.querySelectorAll(
        '[class*="skeleton"], [class*="placeholder"], [class*="shimmer"], [class*="empty--"]'
      )
      if (sk.length >= 1) return { abort: true, reason: 'home_skeleton' }
    }
    return { abort: false, reason: 'ok' }
  } catch (_) {
    return { abort: false, reason: 'evaluate_error' }
  }
})()`

/**
 * 一键登录 / 后台自动登录：窗口内仍为未登录或首页空白 → 应关窗且勿落盘分区。
 * @param {import('electron').WebContents | null | undefined} webContents
 */
export async function readAutoLoginBrowseWindowShouldCloseWithoutSave(webContents) {
  if (!webContents || webContents.isDestroyed()) {
    return { abort: false, reason: '', reasonText: '' }
  }
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    url = ''
  }
  const loginSt = await readGoofishEmbedShowsLoginPageFromWebContents(webContents, url)
  if (loginSt.onLoginPage) {
    const r = String(loginSt.reason || '').trim()
    const text =
      r === 'nav_login' || r === 'login_prompt'
        ? '顶栏显示登录'
        : r === 'login_banner'
          ? '底部提示需要登录'
          : '页面显示需要登录'
    return { abort: true, reason: r, reasonText: text }
  }
  const nav = await readGoofishNavLoginStateFromWebContents(webContents)
  if (nav.loggedIn) {
    return { abort: false, reason: '', reasonText: '' }
  }
  try {
    const host = new URL(url).hostname
    if (host === 'www.goofish.com' || host === 'goofish.com' || host === 'm.goofish.com') {
      const raw = await webContents.executeJavaScript(GOOFISH_HOME_BLANK_LOGIN_DETECT_JS, true)
      if (raw?.abort === true) {
        const rr = String(raw.reason || '').trim()
        const text =
          rr === 'login_banner' ? '首页空白并提示登录' : rr === 'home_skeleton' ? '首页内容未加载' : '首页未登录'
        return { abort: true, reason: rr, reasonText: text }
      }
    }
  } catch {
    /* */
  }
  return { abort: true, reason: 'nav_not_logged_in', reasonText: '顶栏仍显示登录' }
}
