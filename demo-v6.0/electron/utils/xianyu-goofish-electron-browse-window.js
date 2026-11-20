/**
 * 应用内闲鱼浏览：独立 BrowserWindow + persist partition（与写入 Cookie 的 session 一致），
 * 直接 loadURL；拦截 window.open 在同一窗口内跳转，不弹新窗。
 */
import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  applyCookieHeaderStringToElectronPartition,
  applyPlaywrightCookiesToElectronSession,
  removeAllCookiesForUrls,
  GOOFISH_COOKIE_HEADER_INJECT_URLS,
  repersistSessionCookiesWithExpiration
} from './xianyu-playwright-cookies-to-electron.js'
import { GOOFISH_ELECTRON_BROWSE_USER_AGENT } from './xianyu-playwright-config.js'
import { ensureGoofishPartitionChromeLike } from './goofish-electron-session-chrome-like.js'
import { attachGoofishLoginAssistAutoClick } from './goofish-seller-embed-hooks.js'
import {
  GOOFISH_IM_VERIFY_OPENED_HINT,
  buildGoofishImVerifyBannerSuffix
} from './goofish-im-user-hints.js'
import {
  GUEST_COOKIE_AUTH_BANNER_MAIN,
  GUEST_COOKIE_AUTH_BANNER_SUB,
  GUEST_COOKIE_AUTH_WINDOW_TITLE
} from '../../shared/sxjkGuestCookieHints.js'

/** @type {Map<string, import('electron').BrowserWindow>} */
const goofishBrowseWindows = new Map()

function focusGoofishBrowseWindow(win) {
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (typeof win.moveTop === 'function') win.moveTop()
  } catch {
    /* */
  }
}

/** 该 browserKey 是否仍有应用内闲鱼窗口（续期/写分区时应避免清空 Cookie 罐） */
export function isGoofishBrowseWindowOpenForBrowserKey(browserKey) {
  const key = String(browserKey || '').trim() || '__global__'
  const win = goofishBrowseWindows.get(key)
  try {
    return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed())
  } catch {
    return false
  }
}

/** 用户是否正在该账号的应用内闲鱼窗口中浏览（后台任务不得抢载首页） */
export function isUserGoofishBrowseWindowActive(browserKey) {
  const key = String(browserKey || '').trim() || '__global__'
  const win = goofishBrowseWindows.get(key)
  if (!win || win.isDestroyed?.() || !webContentsAlive(win.webContents)) return false
  try {
    return win.isVisible() === true
  } catch {
    return false
  }
}

/**
 * 关闭所有应用内闲鱼弹窗（批量一键登录时：避免上一账号窗口未关完就打开下一账号导致「窗口已关闭」）。
 * @param {{ keepBrowserKey?: string, gapMs?: number }} [opts]
 */
export async function closeAllGoofishBrowseWindows(opts = {}) {
  const keepKey = String(opts.keepBrowserKey || '').trim()
  const gapMs = Number.isFinite(Number(opts.gapMs)) ? Math.max(0, Number(opts.gapMs)) : 350
  const waits = []
  for (const [key, win] of [...goofishBrowseWindows.entries()]) {
    if (keepKey && key === keepKey) continue
    if (!win) {
      goofishBrowseWindows.delete(key)
      continue
    }
    try {
      if (win.isDestroyed?.()) {
        goofishBrowseWindows.delete(key)
        continue
      }
    } catch {
      goofishBrowseWindows.delete(key)
      continue
    }
    waits.push(
      new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve(undefined)
        }
        const timer = setTimeout(finish, 12_000)
        try {
          win.once('closed', () => {
            clearTimeout(timer)
            finish()
          })
          win.close()
        } catch {
          clearTimeout(timer)
          finish()
        }
      })
    )
    goofishBrowseWindows.delete(key)
  }
  if (waits.length) await Promise.all(waits)
  if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
}

/** 关窗并等待 closed（批量登录每个账号结束后调用） */
export async function closeGoofishBrowseWindowAndWait(win, timeoutMs = 10_000) {
  if (!win) return
  try {
    if (win.isDestroyed?.()) return
  } catch {
    return
  }
  await new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(undefined)
    }
    const timer = setTimeout(finish, Math.max(500, Number(timeoutMs) || 10_000))
    try {
      win.once('closed', () => {
        clearTimeout(timer)
        finish()
      })
      win.close()
    } catch {
      clearTimeout(timer)
      finish()
    }
  })
  await new Promise((r) => setTimeout(r, 350))
}

import { partitionPersistIdForGoofishBrowseShell } from './xianyu-session-partition.js'

export { partitionPersistIdForGoofishBrowseShell }

function resolveBrowseWindowIcon(electronDirname) {
  const dir = String(electronDirname || '').trim()
  if (!dir) return undefined
  const fromSrc = join(dir, '..', 'src', 'assets', 'image.png')
  if (existsSync(fromSrc)) return fromSrc
  const fromBuild = join(dir, '..', 'build', 'icon.png')
  if (existsSync(fromBuild)) return fromBuild
  return undefined
}

/**
 * 把账号会话文件里的 Cookie 灌进本窗口 partition：先清相关站点的旧罐再写，避免脏 HttpOnly 挡写入；
 * 顺序为「整段 Cookie 头 → Playwright 快照」，快照覆盖同名键的域名/HttpOnly，与采集环境一致。
 */
export async function syncGoofishCookiesIntoPartition(
  partition,
  cookieHeader,
  playwrightCookies,
  opts = {}
) {
  const sess = session.fromPartition(partition)
  try {
    await sess.setUserAgent(GOOFISH_ELECTRON_BROWSE_USER_AGENT)
  } catch {
    /* */
  }
  if (opts.clearBeforeInject !== false) {
    const header = String(cookieHeader || '').trim()
    const pw = Array.isArray(playwrightCookies) ? playwrightCookies : []
    if (!header && !pw.length) {
      /* 无注入内容时禁止清空分区，避免误删登录态 */
    } else {
      await removeAllCookiesForUrls(sess, GOOFISH_COOKIE_HEADER_INJECT_URLS)
    }
  }

  const header = String(cookieHeader || '').trim()
  const pw = Array.isArray(playwrightCookies) ? playwrightCookies : []
  if (header) {
    await applyCookieHeaderStringToElectronPartition(sess, header, GOOFISH_COOKIE_HEADER_INJECT_URLS)
  }
  if (pw.length) {
    await applyPlaywrightCookiesToElectronSession(sess, pw)
  }
  if (header || pw.length) {
    await repersistSessionCookiesWithExpiration(sess)
    try {
      if (typeof sess.cookies.flushStore === 'function') {
        await sess.cookies.flushStore()
      }
    } catch {
      /* */
    }
  }
}

export async function hasLiveMh5TkInPartition(partition) {
  try {
    const sess = session.fromPartition(partition)
    const nowSec = Date.now() / 1000
    for (const url of GOOFISH_COOKIE_HEADER_INJECT_URLS) {
      const list = await sess.cookies.get({ url })
      for (const c of list) {
        if (String(c?.name || '').toLowerCase() !== '_m_h5_tk') continue
        if (!String(c?.value || '').trim()) continue
        if (typeof c.expirationDate === 'number' && c.expirationDate > 0 && c.expirationDate <= nowSec) {
          continue
        }
        return true
      }
    }
  } catch {
    /* */
  }
  return false
}

/** @param {import('electron').WebContents | null | undefined} wc */
function webContentsAlive(wc) {
  try {
    return !!(wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed())
  } catch {
    return false
  }
}

/** 预热关窗 / 导航被中止时常见，不打 warn 以免误导 */
function isBenignGoofishLoadAbort(errOrMsg, win) {
  if (win?.isDestroyed?.() || !webContentsAlive(win?.webContents)) return true
  const msg = String(errOrMsg?.message || errOrMsg || '')
  if (/destroyed/i.test(msg)) return true
  // Chromium: ERR_FAILED(-2)、ERR_ABORTED(-3) — 关窗打断 loadURL 时极常见
  if (/ERR_FAILED|ERR_ABORTED|\(-2\)|\(-3\)/i.test(msg)) return true
  return false
}

function attachGoofishBrowseNavigationHandlers(win) {
  if (win.__sxjkGoofishBrowseNavBound) return
  win.__sxjkGoofishBrowseNavBound = true
  win.webContents.setWindowOpenHandler((details) => {
    const next = String(details.url || '').trim()
    if (!next) return { action: 'deny' }
    try {
      const parsed = new URL(next)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { action: 'deny' }
    } catch {
      return { action: 'deny' }
    }
    if (win.isDestroyed?.() || !webContentsAlive(win.webContents)) return { action: 'deny' }
    win.loadURL(next, { userAgent: GOOFISH_ELECTRON_BROWSE_USER_AGENT }).catch((err) => {
      if (isBenignGoofishLoadAbort(err, win)) return
      console.warn('[闲鱼浏览] 页面加载失败:', next, String(err?.message || err))
    })
    return { action: 'deny' }
  })
}

/**
 * 风控通过后常被重定向到淘宝/天猫「首页壳」；拉回闲鱼 IM 以便同一分区里保留 goofish 会话，关窗写 Cookie 才完整。
 * 不得对 sm / risk / passport / h5api 等域名在 did-finish-load 时抢跳，否则人机页刚加载就被顶到 goofish/im，表现为验证窗「秒没」。
 */
function shouldBounceTaobaoHostToGoofish(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (!h || h.includes('goofish')) return false
  const allow = new Set([
    'taobao.com',
    'www.taobao.com',
    'www.tmall.com',
    'm.taobao.com',
    'm.tmall.com'
  ])
  return allow.has(h)
}

/**
 * MTOP 验证页专用：若闲鱼把页面带到淘宝/天猫「首页壳」，自动改跳 goofish.com/im（拉回闲鱼侧会话，关窗写 Cookie 才稳）。
 * @param {import('electron').BrowserWindow} win
 */
function attachPostSliderTaobaoFallbackToGoofishIm(win) {
  if (!win) return
  const wc = win.webContents
  try {
    if (typeof win.__sxjkPostSliderBounceCleanup === 'function') {
      win.__sxjkPostSliderBounceCleanup()
    }
  } catch {
    /* */
  }
  let bounced = false
  const IM_URL = 'https://www.goofish.com/im'
  const handler = () => {
    if (bounced || !webContentsAlive(wc)) return
    let href = ''
    try {
      href = String(wc.getURL() || '').trim()
    } catch {
      return
    }
    if (!href || /^about:/i.test(href)) return
    let host = ''
    try {
      host = new URL(href).hostname.toLowerCase()
    } catch {
      return
    }
    if (!shouldBounceTaobaoHostToGoofish(host)) return
    bounced = true
    console.log('[闲鱼浏览] 验证后落在淘宝系页面，自动跳回闲鱼消息页:', host)
    wc.loadURL(IM_URL, { userAgent: GOOFISH_ELECTRON_BROWSE_USER_AGENT, timeout: 120_000 }).catch((e) => {
      console.warn('[闲鱼浏览] 跳回 goofish/im 失败', e?.message || e)
    })
  }
  wc.on('did-finish-load', handler)
  const onClosed = () => {
    try {
      wc.removeListener('did-finish-load', handler)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkPostSliderBounceCleanup = null
  }
  win.once('closed', onClosed)
  win.__sxjkPostSliderBounceCleanup = () => {
    try {
      wc.removeListener('did-finish-load', handler)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkPostSliderBounceCleanup = null
  }
}

const IM_VERIFY_HINT_BANNER_ID = '__sxjk_im_verify_hint_banner__'
const IM_VERIFY_HINT_BODY_PAD_ATTR = 'data-sxjk-im-verify-pad'
const GUEST_AUTH_HINT_BANNER_ID = '__sxjk_guest_auth_hint_banner__'
const GUEST_AUTH_HINT_BODY_PAD_ATTR = 'data-sxjk-guest-auth-pad'

/**
 * 闲鱼浏览窗内固定顶部黄条（主进程注入，避免被闲鱼页盖住主界面 toast）。
 * @param {import('electron').WebContents} wc
 * @param {string} bannerId
 * @param {string} bodyPadAttr
 * @param {string} mainLine
 * @param {string} subLine
 */
function injectGoofishPageHintBannerContents(wc, bannerId, bodyPadAttr, mainLine, subLine) {
  if (!webContentsAlive(wc)) return
  const main = String(mainLine || '').trim()
  if (!main) return
  const sub = String(subLine || '').trim()
  const barHeight = sub ? 56 : 44
  const js = `(function(){
    try {
      var id = ${JSON.stringify(bannerId)};
      var main = ${JSON.stringify(main)};
      var sub = ${JSON.stringify(sub)};
      var h = ${barHeight};
      var old = document.getElementById(id);
      if (old) old.remove();
      var bar = document.createElement('div');
      bar.id = id;
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;box-sizing:border-box;padding:10px 14px;background:#fff8e6;color:#663c00;font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif;border-bottom:1px solid #f0d78c;box-shadow:0 2px 8px rgba(0,0,0,.12);';
      var esc = function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); };
      var html = '<div style="font-weight:600;">' + esc(main) + '</div>';
      if (sub) html += '<div style="margin-top:4px;font-size:12px;opacity:.92;">' + esc(sub) + '</div>';
      bar.innerHTML = html;
      var body = document.body;
      if (!body) return;
      body.insertBefore(bar, body.firstChild);
      body.style.setProperty('padding-top', h + 'px', 'important');
      body.setAttribute(${JSON.stringify(bodyPadAttr)}, String(h));
    } catch (e) {}
  })()`
  void wc.executeJavaScript(js, true).catch(() => {})
}

function injectImVerifyHintBannerContents(wc, mainLine, subLine) {
  injectGoofishPageHintBannerContents(
    wc,
    IM_VERIFY_HINT_BANNER_ID,
    IM_VERIFY_HINT_BODY_PAD_ATTR,
    mainLine,
    subLine
  )
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} [source]
 */
function attachImVerifyHintBanner(win, source = '') {
  if (!win || win.isDestroyed?.()) return
  const wc = win.webContents
  if (!webContentsAlive(wc)) return
  const src = String(source || '').trim()
  try {
    if (typeof win.__sxjkImVerifyHintCleanup === 'function') {
      win.__sxjkImVerifyHintCleanup()
    }
  } catch {
    /* */
  }
  const mainLine = GOOFISH_IM_VERIFY_OPENED_HINT
  const subLine = buildGoofishImVerifyBannerSuffix(src)
  const inject = () => {
    if (win.isDestroyed?.() || !webContentsAlive(wc)) return
    injectImVerifyHintBannerContents(wc, mainLine, subLine)
  }
  wc.on('did-finish-load', inject)
  wc.on('did-navigate-in-page', inject)
  const onClosed = () => {
    try {
      wc.removeListener('did-finish-load', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-navigate-in-page', inject)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkImVerifyHintCleanup = null
  }
  win.once('closed', onClosed)
  win.__sxjkImVerifyHintCleanup = () => {
    try {
      wc.removeListener('did-finish-load', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-navigate-in-page', inject)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkImVerifyHintCleanup = null
  }
  inject()
}

/**
 * 游客授权窗：顶部黄条说明「不用登录、等加载完自动关窗」。
 * @param {import('electron').BrowserWindow} win
 */
function attachGuestAuthHintBanner(win) {
  if (!win) return
  const wc = win.webContents
  try {
    win.setTitle(GUEST_COOKIE_AUTH_WINDOW_TITLE)
  } catch {
    /* */
  }
  try {
    if (typeof win.__sxjkGuestAuthHintCleanup === 'function') {
      win.__sxjkGuestAuthHintCleanup()
    }
  } catch {
    /* */
  }
  const inject = () =>
    injectGoofishPageHintBannerContents(
      wc,
      GUEST_AUTH_HINT_BANNER_ID,
      GUEST_AUTH_HINT_BODY_PAD_ATTR,
      GUEST_COOKIE_AUTH_BANNER_MAIN,
      GUEST_COOKIE_AUTH_BANNER_SUB
    )
  wc.on('did-finish-load', inject)
  wc.on('did-navigate-in-page', inject)
  wc.on('did-start-loading', inject)
  const onClosed = () => {
    try {
      wc.removeListener('did-finish-load', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-navigate-in-page', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-start-loading', inject)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkGuestAuthHintCleanup = null
  }
  win.once('closed', onClosed)
  win.__sxjkGuestAuthHintCleanup = () => {
    try {
      wc.removeListener('did-finish-load', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-navigate-in-page', inject)
    } catch {
      /* */
    }
    try {
      wc.removeListener('did-start-loading', inject)
    } catch {
      /* */
    }
    try {
      win.removeListener('closed', onClosed)
    } catch {
      /* */
    }
    win.__sxjkGuestAuthHintCleanup = null
  }
  inject()
}

/** 定时续期等场景下首轮 ERR_FAILED（-2）较常见，短暂重试减轻瞬时网络问题 */
const GOOFISH_LOAD_URL_MAX_ATTEMPTS = 3
const GOOFISH_LOAD_URL_RETRY_GAP_MS = 1200

/**
 * @param {import('electron').WebContents} wc
 * @param {string} url
 * @param {{ timeout?: number, userAgent?: string }} loadOpts
 * @param {import('electron').BrowserWindow | null} [win]
 * @returns {Promise<{ ok: boolean, error?: string, aborted?: boolean }>}
 */
async function loadGoofishUrlWithRetries(wc, url, loadOpts, win = null) {
  let lastErr = ''
  for (let attempt = 1; attempt <= GOOFISH_LOAD_URL_MAX_ATTEMPTS; attempt++) {
    if (!webContentsAlive(wc) || win?.isDestroyed?.()) {
      return { ok: false, error: '窗口已关闭', aborted: true }
    }
    try {
      await wc.loadURL(url, loadOpts)
      return { ok: true }
    } catch (e) {
      lastErr = String(e?.message || e)
      const destroyed = /destroyed/i.test(lastErr) || !webContentsAlive(wc) || !!win?.isDestroyed?.()
      if (destroyed) {
        return { ok: false, error: lastErr, aborted: true }
      }
      // 关窗/同窗改址打断：短暂确认后勿再 loadURL，否则销毁过程中重试易 SIGSEGV
      if (/ERR_FAILED|ERR_ABORTED|\(-2\)|\(-3\)/i.test(lastErr)) {
        await new Promise((r) => setTimeout(r, 80))
        if (!webContentsAlive(wc) || win?.isDestroyed?.()) {
          return { ok: false, error: lastErr, aborted: true }
        }
        // 窗口仍在：仅再试一次（不跑满 3 次），避免关窗竞态连环 load
        if (attempt >= 2) {
          return { ok: false, error: lastErr, aborted: true }
        }
      }
      console.warn(`[闲鱼浏览] 加载重试 ${attempt}/${GOOFISH_LOAD_URL_MAX_ATTEMPTS}`, lastErr)
      if (attempt < GOOFISH_LOAD_URL_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, GOOFISH_LOAD_URL_RETRY_GAP_MS))
        if (!webContentsAlive(wc) || win?.isDestroyed?.()) {
          return { ok: false, error: '窗口已关闭', aborted: true }
        }
      }
    }
  }
  return { ok: false, error: lastErr || 'loadURL failed' }
}

/**
 * MTOP 风控 punish 链常在淘宝统一壳里打开（看起来像「阿里巴巴集团」整页），与官网叠在搜索页上的弹层是同一套验证，只是展示壳不同。
 * 先打开闲鱼首页再进 punish，有利于带上 goofish 站点上下文（不保证皮肤与官网一致）。
 */
async function loadGoofishUrlWithRetriesAfterOptionalPrewarm(wc, url, loadOpts, doRiskPrewarm, win = null) {
  const u = String(url || '').trim()
  if (doRiskPrewarm && /punish|_____tmd_____|x5sec/i.test(u)) {
    try {
      if (webContentsAlive(wc) && !win?.isDestroyed?.()) {
        await wc.loadURL('https://www.goofish.com/', loadOpts)
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (e) {
      if (!isBenignGoofishLoadAbort(e, win)) {
        console.warn('[闲鱼浏览] 验证页预打开闲鱼首页跳过', e?.message || e)
      }
    }
  }
  return loadGoofishUrlWithRetries(wc, u, loadOpts, win)
}

/**
 * @param {{ url: string, cookieHeader?: string, playwrightCookies?: unknown[] | null, electronDirname?: string, browserKey?: string, sessionPartition?: string, allowEmptyCookieHeader?: boolean, preferExistingSession?: boolean, navigateOnReuse?: boolean, taskWindow?: boolean, postSliderBounceToGoofishIm?: boolean, imVerifyHintSource?: string, guestAuthHint?: boolean, silentBackground?: boolean, ephemeralPartition?: boolean }} opts
 * @returns {Promise<{ ok: boolean, error?: string, window?: import('electron').BrowserWindow, reused?: boolean, taskWindow?: boolean }>}
 */
export async function openGoofishUrlInAppBrowseWindow({
  url,
  cookieHeader = '',
  playwrightCookies,
  electronDirname = '',
  browserKey = '__global__',
  sessionPartition = '',
  allowEmptyCookieHeader = false,
  preferExistingSession = false,
  navigateOnReuse,
  taskWindow = false,
  postSliderBounceToGoofishIm = false,
  imVerifyHintSource = '',
  guestAuthHint = false,
  silentBackground = false,
  ephemeralPartition = false
}) {
  const u = String(url || '').trim()
  const header = String(cookieHeader || '').trim()
  const pwArr = Array.isArray(playwrightCookies) ? playwrightCookies : []
  const key = String(browserKey || '').trim() || '__global__'
  if (!u) return { ok: false, error: '链接无效' }
  /** 仅有 Playwright Cookie 快照、无整段 Cookie 头时也要写入分区（与 resolveGoofishOpenSessionCredentials 可推导 header 不同，此处必须显式同步） */
  if (!header && !pwArr.length && !allowEmptyCookieHeader) {
    return { ok: false, error: '没有可注入的 Cookie' }
  }

  const partition =
    String(sessionPartition || '').trim() ||
    (ephemeralPartition === true
      ? `goofish-ephem-${randomUUID()}`
      : partitionPersistIdForGoofishBrowseShell(key))
  ensureGoofishPartitionChromeLike(partition)
  const dir = String(electronDirname || '').trim()

  const shouldReuseExisting =
    !taskWindow &&
    !ephemeralPartition &&
    preferExistingSession === true &&
    (await hasLiveMh5TkInPartition(partition))
  const shouldInjectBeforeLoad = !shouldReuseExisting && (header || pwArr.length)

  const imHintSource = String(imVerifyHintSource || '').trim()
  const shouldAttachImVerifyHint = postSliderBounceToGoofishIm || !!imHintSource
  const shouldAttachGuestAuthHint = guestAuthHint === true

  const userWinActive = !taskWindow && !ephemeralPartition && isUserGoofishBrowseWindowActive(key)
  const useTaskWindow = taskWindow === true || (silentBackground && userWinActive)

  let win = useTaskWindow ? null : goofishBrowseWindows.get(key)
  if (ephemeralPartition) {
    win = null
  } else if (win && (win.isDestroyed?.() || !webContentsAlive(win.webContents))) {
    goofishBrowseWindows.delete(key)
    win = null
  }

  const loadOpts = { timeout: 120_000, userAgent: GOOFISH_ELECTRON_BROWSE_USER_AGENT }
  const shouldNavigateOnReuse =
    navigateOnReuse !== undefined ? navigateOnReuse !== false : !preferExistingSession

  // 复用且不导航：禁止先清 Cookie（否则 SPA 会掉登录并跳回首页）
  if (win && !shouldNavigateOnReuse) {
    if (!silentBackground) focusGoofishBrowseWindow(win)
    if (shouldAttachGuestAuthHint) attachGuestAuthHintBanner(win)
    return { ok: true, window: win, reused: true }
  }

  if (shouldInjectBeforeLoad) {
    try {
      await syncGoofishCookiesIntoPartition(partition, header, playwrightCookies)
    } catch (e) {
      return { ok: false, error: `写入 Cookie 失败：${String(e?.message || e)}` }
    }
  }

  if (win) {
    attachGoofishLoginAssistAutoClick(win.webContents)
    if (win.isDestroyed?.() || !webContentsAlive(win.webContents)) {
      goofishBrowseWindows.delete(key)
      return { ok: false, error: '窗口已关闭' }
    }
    try {
      win.webContents.setUserAgent(GOOFISH_ELECTRON_BROWSE_USER_AGENT)
    } catch {
      return { ok: false, error: '窗口已关闭' }
    }
    if (postSliderBounceToGoofishIm) {
      try {
        win.setTitle('闲鱼安全验证')
      } catch {
        /* */
      }
    }
    if (!silentBackground) focusGoofishBrowseWindow(win)
    const lr = await loadGoofishUrlWithRetriesAfterOptionalPrewarm(
      win.webContents,
      u,
      loadOpts,
      postSliderBounceToGoofishIm,
      win
    )
    if (!lr.ok) {
      if (lr.aborted) return { ok: false, error: '窗口已关闭' }
      return { ok: false, error: lr.error || '打开页面失败' }
    }
    // Cookie 已在首载前写入分区，禁止二次 loadURL（会把用户刚点开的页拽回首页）
    if (win.isDestroyed?.()) {
      goofishBrowseWindows.delete(key)
      return { ok: true, closedDuringOpen: true }
    }
    if (postSliderBounceToGoofishIm) attachPostSliderTaobaoFallbackToGoofishIm(win)
    if (shouldAttachGuestAuthHint) attachGuestAuthHintBanner(win)
    if (shouldAttachImVerifyHint) attachImVerifyHintBanner(win, imHintSource || 'warmup')
    return { ok: true, window: win }
  }

  const icon = resolveBrowseWindowIcon(dir)
  const keepHidden = useTaskWindow || silentBackground
  try {
    // 不用 parent 挂主窗：macOS 上子窗关闭时偶发拖垮主进程（SIGSEGV）
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      autoHideMenuBar: true,
      ...(icon ? { icon } : {}),
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false
      }
    })
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }

  if (postSliderBounceToGoofishIm) {
    try {
      win.setTitle('闲鱼安全验证')
    } catch {
      /* */
    }
  } else if (shouldAttachGuestAuthHint) {
    try {
      win.setTitle(GUEST_COOKIE_AUTH_WINDOW_TITLE)
    } catch {
      /* */
    }
  }

  attachGoofishBrowseNavigationHandlers(win)
  attachGoofishLoginAssistAutoClick(win.webContents)
  if (shouldAttachGuestAuthHint) attachGuestAuthHintBanner(win)
  if (!useTaskWindow && !ephemeralPartition) {
    goofishBrowseWindows.set(key, win)
    win.once('closed', () => {
      if (goofishBrowseWindows.get(key) === win) {
        goofishBrowseWindows.delete(key)
      }
    })
  }

  win.webContents.on('did-fail-load', (_e, ec, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return
    // -3 ERR_ABORTED / -2 ERR_FAILED：关窗或同窗改址打断，预热场景勿刷屏
    if (ec === -2 || ec === -3) return
    if (win.isDestroyed?.() || !webContentsAlive(win.webContents)) return
    console.warn('[闲鱼浏览] 页面加载失败', ec, desc, failedUrl)
  })

  win.webContents.setUserAgent(GOOFISH_ELECTRON_BROWSE_USER_AGENT)
  if (!keepHidden) focusGoofishBrowseWindow(win)
  const lrNew = await loadGoofishUrlWithRetriesAfterOptionalPrewarm(
    win.webContents,
    u,
    loadOpts,
    postSliderBounceToGoofishIm,
    win
  )
  if (!lrNew.ok) {
    if (!useTaskWindow && !ephemeralPartition) {
      goofishBrowseWindows.delete(key)
    }
    if (lrNew.aborted) {
      try {
        if (win && !win.isDestroyed()) win.destroy()
      } catch {
        /* */
      }
      return { ok: false, error: '窗口已关闭' }
    }
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {
      /* */
    }
    return { ok: false, error: `打开页面失败：${lrNew.error || ''}` }
  }

  // Cookie 已在创建窗前写入分区；勿再二次 loadURL，否则首屏可点进详情后会被拽回首页

  if (win.isDestroyed?.()) {
    if (!useTaskWindow && !ephemeralPartition) {
      goofishBrowseWindows.delete(key)
    }
    return { ok: true, closedDuringOpen: true }
  }
  if (postSliderBounceToGoofishIm) attachPostSliderTaobaoFallbackToGoofishIm(win)
  if (shouldAttachImVerifyHint) attachImVerifyHintBanner(win, imHintSource || 'warmup')
  if (!keepHidden) focusGoofishBrowseWindow(win)
  return { ok: true, window: win, taskWindow: useTaskWindow }
}
