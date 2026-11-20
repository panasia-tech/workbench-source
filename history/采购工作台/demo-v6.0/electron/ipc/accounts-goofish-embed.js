/**
 * 账号管理「嵌入」模式：主窗内 BrowserView（对齐闲鱼工作台多开）。
 * 每账号三套视图（工作台 / 鱼小铺消息 / 闲鱼主站消息），各自 persist:xianyu_sxjk_<id>，切换 Tab 只换挂视图。
 */
import { BrowserView } from 'electron'
import { promises as fs } from 'node:fs'
import { accountFilePath, readAccountJson, touchAccountGoofishPageOpenedAt } from './accounts.js'
import {
  migrateLegacyEmbedSharedToAccountIfNeeded,
  migrateLegacyEmbedSharedForAllAccounts,
  flushAccountPartitionStore
} from '../utils/goofish-partition-persist.js'
import {
  syncAccountProfileFromPartition,
  notifyAccountProfileSynced
} from '../utils/goofish-account-profile-sync.js'
import { readGoofishNavLoginStateFromWebContents } from '../utils/goofish-nav-login-state.js'
import { partitionForListingAccount } from '../utils/xianyu-session-partition.js'
import {
  clearEmbedSharedPartitionActiveAccountId,
  clearLegacyEmbedSharedPartitionOnce,
  getEmbedSharedPartitionActiveAccountId,
  setEmbedSharedPartitionActiveAccountId
} from '../utils/goofish-embed-session-sync.js'
import { ensureGoofishPartitionChromeLike } from '../utils/goofish-electron-session-chrome-like.js'
import { GOOFISH_ELECTRON_BROWSE_USER_AGENT } from '../utils/xianyu-playwright-config.js'
import {
  GOOFISH_SELLER_URL,
  GOOFISH_IM_URL,
  GOOFISH_IM_PUBLIC_URL
} from '../config/goofish.js'
import { attachGoofishSellerEmbedPageHooks } from '../utils/goofish-seller-embed-hooks.js'
import {
  classifyGoofishSellerEmbedRoute,
  parseGoofishSellerMainHashRoute
} from '../utils/goofish-seller-hash-route.js'
import {
  isGoofishMainImUrl,
  readGoofishImEmbedLooksBlankFromWebContents
} from '../utils/goofish-embed-login-page.js'

/** @type {null | ((accountId: string) => void)} */
let embedImWarmupTrigger = null

const embedImWarmupTimers = new Map()

/** @param {null | ((accountId: string) => Promise<{ ok?: boolean, msg?: string }>)} _fn */
export function setGoofishEmbedLoggedInAutoCapture(_fn) {
  /* workbench refactor: disk auto-capture removed */
}

/** @param {null | ((accountId: string) => void)} fn */
export function setGoofishEmbedImWarmupTrigger(fn) {
  embedImWarmupTrigger = typeof fn === 'function' ? fn : null
}

/** @param {null | ((accountId: string) => Promise<{ ok?: boolean, msg?: string, skip?: boolean }>)} _fn */
export function setGoofishEmbedLoginPageRenewHandler(_fn) {
  /* workbench refactor: HTTP renew removed */
}

function scheduleEmbedImWarmupAfterMessagePage(accountId, webContents) {
  const id = String(accountId || '').trim()
  if (!id || !embedImWarmupTrigger || !webContents || webContents.isDestroyed()) return
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    return
  }
  if (!/\/im/i.test(url) && !/seller\.goofish\.com/i.test(url)) return
  const prev = embedImWarmupTimers.get(id)
  if (prev) clearTimeout(prev)
  embedImWarmupTimers.set(
    id,
    setTimeout(() => {
      embedImWarmupTimers.delete(id)
      if (webContents.isDestroyed()) return
      try {
        embedImWarmupTrigger(id)
      } catch (e) {
        console.warn('[账号嵌入页] 私聊预热触发失败:', id, e?.message || e)
      }
    }, 2500)
  )
}

function attachEmbedImWarmupOnLoad(webContents, accountId) {
  if (!webContents || webContents.isDestroyed()) return
  if (webContents.__sxjkAccountEmbedImWarmup) return
  webContents.__sxjkAccountEmbedImWarmup = true
  const run = () => scheduleEmbedImWarmupAfterMessagePage(accountId, webContents)
  webContents.on('did-finish-load', run)
  webContents.on('did-navigate-in-page', run)
}

const embedImGoofishBlankTimers = new Map()
/** @type {Map<string, number>} 每次挂上「闲鱼消息」嵌入页递增，用于每切换一次最多自动 reload 一次 */
const embedImGoofishReloadSeq = new Map()
/** @type {Map<string, number>} 已为该 seq 执行过空白刷新，防止同一次切换重复 reload */
const embedImGoofishBlankSpentSeq = new Map()
/** @type {Map<string, number>} 账号维度空白刷新时间戳，防止续期/切 Tab 连环刷新 */
const embedImGoofishBlankLastReloadAt = new Map()
const EMBED_IM_GOOFISH_BLANK_RELOAD_COOLDOWN_MS = 60 * 1000
const EMBED_WEBCONTENTS_AUTO_RELOAD_COOLDOWN_MS = 45 * 1000

/** @type {string} */
let embedAccountsDirRef = ''
/** @type {null | (() => import('electron').BrowserWindow | null | undefined)} */
let embedGetMainWindowRef = null

const embedLastRouteState = new Map()
const embedProfileSyncTimers = new Map()
const embedProfileSyncInflight = new Set()
const embedProfileSyncLastAt = new Map()
const EMBED_PROFILE_SYNC_COOLDOWN_MS = 15 * 1000

/** @typedef {'seller' | 'im' | 'imGoofish'} EmbedViewKind */

/** @type {Map<string, { seller: BrowserView | null, im: BrowserView | null, imGoofish: BrowserView | null }>} */
const accountEmbedPairs = new Map()

/** @type {{ x: number, y: number, width: number, height: number } | null} */
let embedBounds = null

/** 后台自动登录等：禁止挂上嵌入 BrowserView */
let workbenchEmbedOverlayLocked = false

function notifyWorkbenchEmbedOverlayLock(getMainWindow, locked) {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sxjk-workbench-embed-overlay-lock', { locked: !!locked })
  } catch {
    /* */
  }
}

export function setWorkbenchEmbedOverlayLocked(locked, getMainWindow) {
  workbenchEmbedOverlayLocked = !!locked
  if (workbenchEmbedOverlayLocked) {
    detachEmbedFromMain(getMainWindow)
    clearEmbedSharedPartitionActiveAccountId()
  }
  notifyWorkbenchEmbedOverlayLock(getMainWindow, workbenchEmbedOverlayLocked)
}

export function isWorkbenchEmbedOverlayLocked() {
  return workbenchEmbedOverlayLocked
}

/** @param {string | undefined} initialUrl @returns {EmbedViewKind} */
function embedKindFromInitialUrl(initialUrl) {
  const u =
    typeof initialUrl === 'string' && initialUrl.trim() ? initialUrl.trim() : GOOFISH_SELLER_URL
  if (u.includes('#/im')) return 'im'
  try {
    const parsed = new URL(u)
    const host = parsed.hostname
    const path = parsed.pathname.replace(/\/$/, '') || '/'
    if (
      (host === 'www.goofish.com' || host === 'goofish.com' || host === 'm.goofish.com') &&
      (path === '/im' || path.startsWith('/im/'))
    ) {
      return 'imGoofish'
    }
  } catch {
    /* */
  }
  return 'seller'
}

function emptyEmbedPair() {
  return { seller: null, im: null, imGoofish: null }
}

function getEmbedPair(accountId) {
  const id = String(accountId || '').trim()
  let pair = accountEmbedPairs.get(id)
  if (!pair) {
    pair = emptyEmbedPair()
    accountEmbedPairs.set(id, pair)
  }
  return pair
}

async function fileExists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function isNavigationAbortError(e) {
  if (e == null) return false
  const code = e.errno ?? e.code
  if (code === -3) return true
  const msg = String(e.message || e)
  return msg.includes('ERR_ABORTED') || msg.includes('(-3)')
}

async function loadUrlTolerateAbort(wc, url) {
  try {
    await wc.loadURL(url)
  } catch (e) {
    if (isNavigationAbortError(e)) return
    throw e
  }
}

/** 销毁指定类型的嵌入视图（切换底部导航时不用缓存页） */
function destroyEmbedBrowserViewForKind(pair, kind, getMainWindow) {
  const bv = pair[kind]
  if (!bv) return
  const main = getMainWindow?.()
  if (main && !main.isDestroyed()) {
    try {
      if (main.getBrowserView() === bv) {
        main.setBrowserView(null)
      }
    } catch {
      /* */
    }
  }
  try {
    if (!bv.webContents.isDestroyed()) {
      bv.webContents.destroy()
    }
  } catch (e) {
    console.warn('[账号嵌入页] 刷新前销毁视图失败:', e?.message || e)
  }
  pair[kind] = null
}

function embedNavCanGoBack(wc) {
  if (!wc || wc.isDestroyed()) return false
  try {
    if (typeof wc.navigationHistory?.canGoBack === 'function') {
      return wc.navigationHistory.canGoBack()
    }
  } catch {
    /* */
  }
  return wc.canGoBack()
}

function embedNavCanGoForward(wc) {
  if (!wc || wc.isDestroyed()) return false
  try {
    if (typeof wc.navigationHistory?.canGoForward === 'function') {
      return wc.navigationHistory.canGoForward()
    }
  } catch {
    /* */
  }
  return wc.canGoForward()
}

function attachEmbedWindowOpenHandler(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (webContents.__sxjkAccountEmbedOpenHandler) return
  webContents.__sxjkAccountEmbedOpenHandler = true
  webContents.setWindowOpenHandler((details) => {
    const raw = String(details.url || '').trim()
    if (!raw) return { action: 'deny' }
    try {
      const p = new URL(raw)
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return { action: 'deny' }
    } catch {
      return { action: 'deny' }
    }
    loadUrlTolerateAbort(webContents, raw).catch(() => {})
    return { action: 'deny' }
  })
}

function emitEmbedNavState(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sxjk-goofish-embed-history', {
      accountId: String(accountId || '').trim(),
      canGoBack: embedNavCanGoBack(webContents),
      canGoForward: embedNavCanGoForward(webContents)
    })
  } catch {
    /* */
  }
}

function emitEmbedLoginUiRoute(accountId, state, url, getMainWindow) {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  const st = String(state || '').trim()
  if (!st) return
  try {
    win.webContents.send('sxjk-goofish-embed-seller-route', {
      accountId: String(accountId || '').trim(),
      route: '',
      state: st,
      url: String(url || '').trim()
    })
  } catch {
    /* */
  }
}

function isGoofishMainSiteUrl(url) {
  try {
    const h = new URL(String(url || '').trim()).hostname
    return h === 'www.goofish.com' || h === 'goofish.com' || h === 'm.goofish.com'
  } catch {
    return false
  }
}

async function accountSessionMarkedExpired(accountsDir, accountId) {
  try {
    const acc = await readAccountJson(accountsDir, accountId)
    return acc?.loginCheckSessionValid === false
  } catch {
    return false
  }
}

async function ensureExpiredAccountEmbedOnSellerDesk(webContents, accountsDir, accountId) {
  if (!webContents || webContents.isDestroyed()) return
  const expired = await accountSessionMarkedExpired(accountsDir, accountId)
  if (!expired) return
  let curUrl = ''
  try {
    curUrl = String(webContents.getURL() || '').trim()
  } catch {
    return
  }
  if (!isGoofishMainSiteUrl(curUrl)) return
  try {
    await loadUrlTolerateAbort(webContents, GOOFISH_SELLER_URL)
  } catch (e) {
    if (!isNavigationAbortError(e)) {
      console.warn('[账号嵌入页] 过期账号跳转卖家页失败:', e?.message || e)
    }
  }
}

function emitEmbedSellerRoute(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    return
  }
  if (!/seller\.goofish\.com/i.test(url)) return
  const id = String(accountId || '').trim()
  const state = classifyGoofishSellerEmbedRoute(url)
  const prev = embedLastRouteState.get(id)
  embedLastRouteState.set(id, state)
  emitEmbedLoginUiRoute(accountId, state, url, getMainWindow)
  if (state === 'logged_in' && prev !== 'logged_in') {
    scheduleEmbedProfileSync(id, getMainWindow)
  } else if (state === 'logged_in') {
    void accountSessionMarkedExpired(embedAccountsDirRef, id).then((expired) => {
      if (expired) scheduleEmbedProfileSync(id, getMainWindow)
    })
  }
}

function scheduleEmbedProfileSync(accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  if (!id || !embedAccountsDirRef) return
  const prev = embedProfileSyncTimers.get(id)
  if (prev) clearTimeout(prev)
  embedProfileSyncTimers.set(
    id,
    setTimeout(() => {
      embedProfileSyncTimers.delete(id)
      void runEmbedProfileSyncIfNeeded(id, getMainWindow)
    }, 900)
  )
}

async function runEmbedProfileSyncIfNeeded(accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  if (!id || !embedAccountsDirRef || embedProfileSyncInflight.has(id)) return
  const lastAt = embedProfileSyncLastAt.get(id) || 0
  if (Date.now() - lastAt < EMBED_PROFILE_SYNC_COOLDOWN_MS) return
  embedProfileSyncInflight.add(id)
  embedProfileSyncLastAt.set(id, Date.now())
  try {
    const expired = await accountSessionMarkedExpired(embedAccountsDirRef, id)
    const result = await syncAccountProfileFromPartition(embedAccountsDirRef, id, {
      preserveSessionOnFail: expired
    })
    if (result.ok) {
      await flushAccountPartitionStore(id)
      notifyAccountProfileSynced(getMainWindow || embedGetMainWindowRef, id, result)
    }
  } catch (e) {
    console.warn('[账号嵌入页] 资料同步失败:', id, e?.message || e)
  } finally {
    embedProfileSyncInflight.delete(id)
  }
}

async function checkEmbedGoofishMainNavRoute(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    return
  }
  if (!isGoofishMainSiteUrl(url)) return
  const id = String(accountId || '').trim()
  const st = await readGoofishNavLoginStateFromWebContents(webContents)
  const state = st.loggedIn ? 'logged_in' : 'login'
  const prev = embedLastRouteState.get(id)
  embedLastRouteState.set(id, state)
  emitEmbedLoginUiRoute(accountId, state, url, getMainWindow)
  if (state === 'logged_in' && prev !== 'logged_in') {
    scheduleEmbedProfileSync(id, getMainWindow)
  } else if (state === 'logged_in') {
    void accountSessionMarkedExpired(embedAccountsDirRef, id).then((expired) => {
      if (expired) scheduleEmbedProfileSync(id, getMainWindow)
    })
  }
}

function attachEmbedSellerRouteWatcher(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  if (webContents.__sxjkAccountEmbedSellerRoute) return
  webContents.__sxjkAccountEmbedSellerRoute = true
  const run = () => emitEmbedSellerRoute(webContents, accountId, getMainWindow)
  webContents.on('did-finish-load', run)
  webContents.on('did-navigate-in-page', run)
  webContents.on('did-navigate', run)
}

function attachEmbedGoofishMainNavRouteWatcher(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  if (webContents.__sxjkAccountEmbedGoofishMainNav) return
  webContents.__sxjkAccountEmbedGoofishMainNav = true
  const run = () => {
    void checkEmbedGoofishMainNavRoute(webContents, accountId, getMainWindow)
  }
  webContents.on('did-finish-load', run)
  webContents.on('did-navigate-in-page', run)
  webContents.on('did-navigate', run)
}

/** @param {string} accountId @param {import('electron').WebContents} webContents */
function embedKindForWebContents(accountId, webContents) {
  const id = String(accountId || '').trim()
  const pair = accountEmbedPairs.get(id)
  if (pair?.imGoofish?.webContents === webContents) return 'imGoofish'
  if (pair?.im?.webContents === webContents) return 'im'
  if (pair?.seller?.webContents === webContents) return 'seller'
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    return 'seller'
  }
  return embedKindFromInitialUrl(url)
}

function isEmbedViewAttachedToMain(accountId, webContents, getMainWindow) {
  const main = getMainWindow?.()
  if (!main || main.isDestroyed()) return false
  try {
    const bv = main.getBrowserView()
    return !!(bv && bv.webContents === webContents)
  } catch {
    return false
  }
}

function embedWebContentsInAutoReloadCooldown(webContents) {
  if (!webContents || webContents.isDestroyed()) return false
  const until = Number(webContents.__sxjkEmbedAutoReloadCooldownUntil || 0)
  return until > Date.now()
}

function markEmbedWebContentsAutoReloadCooldown(webContents, ms = EMBED_WEBCONTENTS_AUTO_RELOAD_COOLDOWN_MS) {
  if (!webContents || webContents.isDestroyed()) return
  webContents.__sxjkEmbedAutoReloadCooldownUntil = Date.now() + Math.max(5000, Number(ms) || 0)
}

function nextEmbedImGoofishReloadSeq(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return 0
  const n = (embedImGoofishReloadSeq.get(id) || 0) + 1
  embedImGoofishReloadSeq.set(id, n)
  return n
}

function scheduleEmbedImGoofishBlankReloadOnce(webContents, accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  if (!id || !webContents || webContents.isDestroyed()) return
  if (embedWebContentsInAutoReloadCooldown(webContents)) return
  const lastReload = embedImGoofishBlankLastReloadAt.get(id) || 0
  if (Date.now() - lastReload < EMBED_IM_GOOFISH_BLANK_RELOAD_COOLDOWN_MS) return
  const seq = nextEmbedImGoofishReloadSeq(id)
  const prev = embedImGoofishBlankTimers.get(id)
  if (prev) clearTimeout(prev)
  embedImGoofishBlankTimers.set(
    id,
    setTimeout(() => {
      embedImGoofishBlankTimers.delete(id)
      void runEmbedImGoofishBlankReloadOnce(webContents, id, getMainWindow, seq)
    }, 2000)
  )
}

async function runEmbedImGoofishBlankReloadOnce(webContents, accountId, getMainWindow, seq) {
  if (embedImGoofishReloadSeq.get(accountId) !== seq) return
  if (embedImGoofishBlankSpentSeq.get(accountId) === seq) return
  if (!webContents || webContents.isDestroyed()) return
  if (embedWebContentsInAutoReloadCooldown(webContents)) return
  if (!isEmbedViewAttachedToMain(accountId, webContents, getMainWindow)) return
  if (embedKindForWebContents(accountId, webContents) !== 'imGoofish') return
  if (isWorkbenchEmbedOverlayLocked()) return
  const lastReload = embedImGoofishBlankLastReloadAt.get(accountId) || 0
  if (Date.now() - lastReload < EMBED_IM_GOOFISH_BLANK_RELOAD_COOLDOWN_MS) return
  let url = ''
  try {
    url = String(webContents.getURL() || '').trim()
  } catch {
    return
  }
  if (!isGoofishMainImUrl(url)) return
  const blankSt = await readGoofishImEmbedLooksBlankFromWebContents(webContents, url)
  if (!blankSt.blank) return

  embedImGoofishBlankSpentSeq.set(accountId, seq)
  embedImGoofishBlankLastReloadAt.set(accountId, Date.now())
  markEmbedWebContentsAutoReloadCooldown(webContents)

  console.info(
    '[账号嵌入页] 闲鱼主站消息嵌入空白，自动刷新一次（本切换不再重复）',
    accountId,
    blankSt.reason || ''
  )
  try {
    webContents.reload()
  } catch (e) {
    console.warn('[账号嵌入页] 闲鱼嵌入空白刷新失败', accountId, e?.message || e)
  }
}

function attachEmbedNavHistory(webContents, accountId, getMainWindow) {
  if (!webContents || webContents.isDestroyed()) return
  if (webContents.__sxjkAccountEmbedNav) return
  webContents.__sxjkAccountEmbedNav = true
  const emit = () => emitEmbedNavState(webContents, accountId, getMainWindow)
  webContents.on('did-navigate', emit)
  webContents.on('did-navigate-in-page', emit)
  webContents.on('did-finish-load', emit)
}

function createAccountEmbedBrowserView(partition, initialUrl, accountId, getMainWindow, kind) {
  const view = new BrowserView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: true
    }
  })
  try {
    view.webContents.setUserAgent(GOOFISH_ELECTRON_BROWSE_USER_AGENT)
  } catch {
    /* */
  }
  attachEmbedWindowOpenHandler(view.webContents)
  attachGoofishSellerEmbedPageHooks(view.webContents)
  attachEmbedNavHistory(view.webContents, accountId, getMainWindow)
  if (kind === 'seller' || kind === 'im') {
    attachEmbedSellerRouteWatcher(view.webContents, accountId, getMainWindow)
  }
  if (kind === 'seller' || kind === 'im' || kind === 'imGoofish') {
    attachEmbedGoofishMainNavRouteWatcher(view.webContents, accountId, getMainWindow)
  }
  if (kind === 'im') {
    attachEmbedImWarmupOnLoad(view.webContents, accountId)
  }
  const url =
    typeof initialUrl === 'string' && initialUrl.trim() ? initialUrl.trim() : GOOFISH_SELLER_URL
  loadUrlTolerateAbort(view.webContents, url).catch((e) => {
    if (!isNavigationAbortError(e)) {
      console.warn('[账号嵌入页] 首次加载失败:', e?.message || e)
    }
  })
  return view
}

function resolveAttachedEmbedView(accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  const main = getMainWindow?.()
  const pair = accountEmbedPairs.get(id)
  if (!main || main.isDestroyed() || !pair) return null
  try {
    const attached = main.getBrowserView()
    if (attached === pair.seller && pair.seller && !pair.seller.webContents.isDestroyed()) {
      return pair.seller
    }
    if (attached === pair.im && pair.im && !pair.im.webContents.isDestroyed()) {
      return pair.im
    }
    if (
      attached === pair.imGoofish &&
      pair.imGoofish &&
      !pair.imGoofish.webContents.isDestroyed()
    ) {
      return pair.imGoofish
    }
  } catch {
    /* */
  }
  return null
}

function resolveActiveEmbedWebContents(accountId, getMainWindow) {
  const bv = resolveAttachedEmbedView(accountId, getMainWindow)
  if (!bv) {
    return { ok: false, error: 'embed_not_active' }
  }
  return { ok: true, wc: bv.webContents }
}

export function destroyAccountEmbedView(accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  if (getEmbedSharedPartitionActiveAccountId() === id) {
    clearEmbedSharedPartitionActiveAccountId()
  }
  const t = embedImWarmupTimers.get(id)
  if (t) {
    clearTimeout(t)
    embedImWarmupTimers.delete(id)
  }
  const imBlankT = embedImGoofishBlankTimers.get(id)
  if (imBlankT) {
    clearTimeout(imBlankT)
    embedImGoofishBlankTimers.delete(id)
  }
  embedImGoofishReloadSeq.delete(id)
  embedImGoofishBlankSpentSeq.delete(id)
  embedImGoofishBlankLastReloadAt.delete(id)
  embedLastRouteState.delete(id)
  const profileTimer = embedProfileSyncTimers.get(id)
  if (profileTimer) {
    clearTimeout(profileTimer)
    embedProfileSyncTimers.delete(id)
  }
  embedProfileSyncInflight.delete(id)
  embedProfileSyncLastAt.delete(id)
  const pair = accountEmbedPairs.get(id)
  if (!pair) return
  accountEmbedPairs.delete(id)
  const main = getMainWindow?.()
  for (const k of ['seller', 'im', 'imGoofish']) {
    const bv = pair[k]
    if (!bv) continue
    if (main && !main.isDestroyed()) {
      try {
        if (main.getBrowserView() === bv) {
          main.setBrowserView(null)
        }
      } catch {
        /* */
      }
    }
    try {
      if (!bv.webContents.isDestroyed()) {
        bv.webContents.destroy()
      }
    } catch (e) {
      console.warn('[账号嵌入页] 销毁视图失败:', e?.message || e)
    }
  }
}

function detachEmbedFromMain(getMainWindow) {
  const mainWin = getMainWindow?.()
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setBrowserView(null)
  }
}

/** 该账号任一嵌入 BrowserView 仍存在 */
export function isAccountGoofishEmbedViewAlive(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return false
  const pair = accountEmbedPairs.get(id)
  if (!pair) return false
  for (const k of ['seller', 'im', 'imGoofish']) {
    const bv = pair[k]
    try {
      if (bv && !bv.webContents.isDestroyed()) return true
    } catch {
      /* */
    }
  }
  return false
}

async function showAccountGoofishInEmbed(accountsDir, getMainWindow, accountId, initialUrl, opts = {}) {
  if (isWorkbenchEmbedOverlayLocked() && opts.forceShow !== true) {
    return { ok: true, skipped: true, reason: 'embed_overlay_locked' }
  }
  const mainWin = getMainWindow?.()
  if (!mainWin || mainWin.isDestroyed()) {
    return { ok: false, error: 'main_window_unavailable' }
  }
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, error: 'missing_id' }
  if (!(await fileExists(accountFilePath(accountsDir, id)))) {
    return { ok: false, error: 'not_found' }
  }

  const partition = partitionForListingAccount(id)
  ensureGoofishPartitionChromeLike(partition)
  await migrateLegacyEmbedSharedToAccountIfNeeded(id)

  const startUrl =
    typeof initialUrl === 'string' && initialUrl.trim() ? initialUrl.trim() : GOOFISH_SELLER_URL
  const kind = embedKindFromInitialUrl(startUrl)

  const forceLoad = opts.forceLoad === true
  setEmbedSharedPartitionActiveAccountId(id)

  const pair = getEmbedPair(id)
  if (forceLoad) {
    destroyEmbedBrowserViewForKind(pair, kind, getMainWindow)
  }
  let bv = pair[kind]
  if (!bv || bv.webContents.isDestroyed()) {
    if (bv) pair[kind] = null
    bv = createAccountEmbedBrowserView(partition, startUrl, id, getMainWindow, kind)
    pair[kind] = bv
    accountEmbedPairs.set(id, pair)
  }

  mainWin.setBrowserView(bv)
  if (embedBounds && embedBounds.width > 2 && embedBounds.height > 2) {
    bv.setBounds(embedBounds)
  }
  if (kind === 'seller' && !forceLoad) {
    void ensureExpiredAccountEmbedOnSellerDesk(bv.webContents, accountsDir, id)
  }
  emitEmbedNavState(bv.webContents, id, getMainWindow)
  if (kind === 'seller' || kind === 'im') {
    emitEmbedSellerRoute(bv.webContents, id, getMainWindow)
  } else if (kind === 'imGoofish') {
    void checkEmbedGoofishMainNavRoute(bv.webContents, id, getMainWindow)
    if (opts.skipImGoofishBlankAutoReload !== true) {
      scheduleEmbedImGoofishBlankReloadOnce(bv.webContents, id, getMainWindow)
    }
  }
  return { ok: true }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {string} accountsDir
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 */
export function registerAccountsGoofishEmbedIPC(ipcMain, accountsDir, getMainWindow) {
  embedAccountsDirRef = String(accountsDir || '').trim()
  embedGetMainWindowRef = getMainWindow
  /** 从「共用 embed_shared」迁到每账号分区：销毁旧 BrowserView，下次打开按账号 id 新建 */
  for (const id of [...accountEmbedPairs.keys()]) {
    destroyAccountEmbedView(id, getMainWindow)
  }
  void (async () => {
    await migrateLegacyEmbedSharedForAllAccounts(accountsDir)
    await clearLegacyEmbedSharedPartitionOnce()
  })()

  ipcMain.handle('open-login-session', async (_e, payload = {}) => {
    try {
      const id = String(payload?.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id' }
      if (payload.mode === 'embed') {
        const initialUrl =
          typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : undefined
        return await showAccountGoofishInEmbed(accountsDir, getMainWindow, id, initialUrl, {
          forceLoad: payload.forceLoad === true
        })
      }
      return { ok: false, error: 'embed_mode_only' }
    } catch (e) {
      console.error('[账号嵌入页] 打开登录会话失败:', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('set-workbench-embed-bounds', (_e, bounds) => {
    try {
      if (!bounds || typeof bounds !== 'object') return { ok: false, error: 'invalid_bounds' }
      embedBounds = {
        x: Math.round(Number(bounds.x) || 0),
        y: Math.round(Number(bounds.y) || 0),
        width: Math.round(Number(bounds.width) || 0),
        height: Math.round(Number(bounds.height) || 0)
      }
      const main = getMainWindow?.()
      if (main && !main.isDestroyed()) {
        const v = main.getBrowserView()
        if (v && embedBounds.width > 2 && embedBounds.height > 2) {
          v.setBounds(embedBounds)
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('hide-workbench-embed', () => {
    detachEmbedFromMain(getMainWindow)
    clearEmbedSharedPartitionActiveAccountId()
    return { ok: true }
  })

  ipcMain.handle('set-workbench-embed-overlay-lock', (_e, payload = {}) => {
    setWorkbenchEmbedOverlayLocked(!!payload?.locked, getMainWindow)
    return { ok: true, locked: workbenchEmbedOverlayLocked }
  })

  ipcMain.handle('workbench-navigate', async (_e, payload = {}) => {
    if (isWorkbenchEmbedOverlayLocked()) {
      return { ok: true, skipped: true, reason: 'embed_overlay_locked' }
    }
    try {
      const id = String(payload?.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id' }
      const target =
        typeof payload.url === 'string' && payload.url.trim()
          ? payload.url.trim()
          : GOOFISH_SELLER_URL
      const res = await showAccountGoofishInEmbed(accountsDir, getMainWindow, id, target, {
        forceLoad: payload.forceLoad !== false
      })
      if (res?.ok && !res.skipped) {
        await touchAccountGoofishPageOpenedAt(accountsDir, id, getMainWindow)
      }
      return res
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('workbench-embed-get-nav-state', async (_e, payload = {}) => {
    try {
      const id = String(payload?.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id', canGoBack: false, canGoForward: false }
      const resolved = resolveActiveEmbedWebContents(id, getMainWindow)
      if (!resolved.ok) {
        return { ok: true, canGoBack: false, canGoForward: false }
      }
      const wc = resolved.wc
      return {
        ok: true,
        canGoBack: embedNavCanGoBack(wc),
        canGoForward: embedNavCanGoForward(wc)
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), canGoBack: false, canGoForward: false }
    }
  })

  ipcMain.handle('workbench-embed-go-back', async (_e, payload = {}) => {
    try {
      const id = String(payload?.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id' }
      const resolved = resolveActiveEmbedWebContents(id, getMainWindow)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      const wc = resolved.wc
      if (!embedNavCanGoBack(wc)) return { ok: false, error: 'no_history' }
      wc.goBack()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('workbench-embed-reload', async (_e, payload = {}) => {
    try {
      const id = String(payload?.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id' }
      const resolved = resolveActiveEmbedWebContents(id, getMainWindow)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      resolved.wc.reloadIgnoringCache()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
}

export { GOOFISH_SELLER_URL, GOOFISH_IM_URL, GOOFISH_IM_PUBLIC_URL }
