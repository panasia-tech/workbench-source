// 卖家主页专用的隐藏、正常 Chromium 窗口。
//
// 关键词行情仍由 session-manager 的 WebContentsView 承载；这里不安装
// search-capture，也不会把窗口挂到主窗口。BrowserWindow 在首次取 worker
// 时才动态加载，使纯 Node 回归可以注入一个无凭据的假窗口。
import { closeAdsPowerWebContents, getAdsPowerWebContents, isAdsPowerAccount } from './adspower.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const SELLER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const ITEM_DETAIL_PATH = /(?:^|\/)(?:item|detail|auction)\b|item\.htm/i
const SELLER_PATH = /(?:^|\/)(?:personal|user|seller|shop)(?:\/|$)/i
const LOGIN_PATH = /(?:login|passport|member\/login)/i
const RISK_PATH = /(?:captcha|verify|punish|risk|security)/i

function approvedHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'goofish.com' || host.endsWith('.goofish.com') || host === 'taobao.com' || host.endsWith('.taobao.com')
}

function isGoofishHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'goofish.com' || host.endsWith('.goofish.com')
}

export function sellerNavigationKind(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    return 'blocked'
  }
  if (url.protocol !== 'https:' || url.port || !approvedHost(url.hostname)) return 'blocked'
  // Seller IDs are data, not navigation routes. Do not classify an otherwise
  // valid seller homepage as login/risk merely because its userId contains a
  // word such as "login" or "risk".
  const route = `${url.hostname}${url.pathname}`
  if (RISK_PATH.test(route)) return 'risk'
  if (LOGIN_PATH.test(route)) return 'login'
  if (ITEM_DETAIL_PATH.test(url.pathname)) return 'item_detail'
  if (isGoofishHost(url.hostname) && (url.pathname === '' || url.pathname === '/')) return 'public_home'
  // 卖家采集只允许闲鱼卖家主页。淘宝域名只用来识别登录/风控跳转，
  // 不能因为路径里恰好有 seller/user 就获得采集权限。
  if (isGoofishHost(url.hostname) && SELLER_PATH.test(url.pathname)) return 'seller'
  return 'blocked'
}

export function normalizeSellerHomeUrl(value) {
  const raw = String(value || '').trim()
  let sellerId = SELLER_ID_PATTERN.test(raw) ? raw : ''
  if (!sellerId) {
    let url
    try {
      url = new URL(raw)
    } catch {
      throw new TypeError('seller URL or seller ID is invalid')
    }
    if (url.protocol !== 'https:' || url.port || !approvedHost(url.hostname) || sellerNavigationKind(url.href) !== 'seller') {
      throw new TypeError('seller URL is outside the approved seller-home boundary')
    }
    sellerId = String(url.searchParams.get('userId') || url.searchParams.get('userid') || '').trim()
  }
  if (!SELLER_ID_PATTERN.test(sellerId)) throw new TypeError('seller ID is invalid')
  return `https://www.goofish.com/personal?userId=${encodeURIComponent(sellerId)}`
}

function reasonForNavigation(kind) {
  return {
    item_detail: 'ITEM_DETAIL_BLOCKED',
    public_home: 'PUBLIC_HOME_FALLBACK',
    login: 'LOGIN_EXPIRED',
    risk: 'RISK_CONTROL',
    blocked: 'NAVIGATION_BLOCKED'
  }[kind] || null
}

async function defaultBrowserWindowResolver() {
  const electron = await import('electron')
  const BrowserWindow = electron.BrowserWindow || electron.default?.BrowserWindow
  if (!BrowserWindow) throw new Error('Electron BrowserWindow is unavailable')
  return BrowserWindow
}

export function createSellerWorkerController({ BrowserWindow = null, resolveBrowserWindow = null, onNavigationEvidence = null } = {}) {
  const windows = new Map()
  const pendingWindows = new Map()
  const partitions = new Map()
  const bitContents = new Map()
  const bitEvidenceHandlers = new Map()
  const recycling = new Map()
  const evidenceByWebContents = new WeakMap()
  let generation = 0

  const recordEvidence = (webContents, accountId, url, kind, extra = {}) => {
    const reasonCode = reasonForNavigation(kind)
    if (!reasonCode) return null
    const entry = {
      accountId: String(accountId || ''),
      kind,
      reasonCode,
      urlHost: (() => { try { return new URL(url).hostname } catch { return '' } })(),
      observedAt: new Date().toISOString(),
      ...extra
    }
    evidenceByWebContents.set(webContents, entry)
    if (typeof onNavigationEvidence === 'function') {
      try { onNavigationEvidence(entry) } catch { /* evidence hooks must not break navigation guards */ }
    }
    return entry
  }

  const guardNavigation = (webContents, accountId, event, url, source) => {
    const kind = sellerNavigationKind(url)
    if (kind === 'seller') return true
    event?.preventDefault?.()
    recordEvidence(webContents, accountId, url, kind, { source })
    return false
  }

  async function createWindow(account, creationGeneration) {
    const accountId = String(account?.id || '').trim()
    const partition = String(account?.partition || '').trim()
    if (!accountId) throw new TypeError('seller worker account id is required')
    if (!partition.startsWith('persist:')) throw new TypeError('seller worker requires a persistent account partition')
    const WindowClass = BrowserWindow || await (resolveBrowserWindow ? resolveBrowserWindow() : defaultBrowserWindowResolver())
    if (creationGeneration !== generation) throw new Error('seller worker creation was cancelled by controller teardown')
    const win = new WindowClass({
      show: false,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        partition,
        backgroundThrottling: false,
        focusOnNavigation: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    // 重申一次，防止平台差异忽略构造参数。
    win.setSkipTaskbar?.(true)
    const wc = win.webContents
    wc.setUserAgent(UA)
    wc.on('will-navigate', (event, url) => guardNavigation(wc, accountId, event, url, 'will-navigate'))
    wc.on('will-redirect', (event, url) => guardNavigation(wc, accountId, event, url, 'will-redirect'))
    wc.setWindowOpenHandler?.(({ url }) => {
      guardNavigation(wc, accountId, null, url, 'window-open')
      return { action: 'deny' }
    })
    wc.on('did-navigate', (_event, url) => {
      const kind = sellerNavigationKind(url)
      if (kind !== 'seller') recordEvidence(wc, accountId, url, kind, { source: 'did-navigate' })
    })
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return
      const description = String(errorDescription || '')
      const reasonCode = /429|too many requests/i.test(description) ? 'HTTP_429' : 'NAV_TRANSIENT'
      const entry = {
        accountId,
        kind: reasonCode === 'HTTP_429' ? 'risk' : 'navigation_failure',
        reasonCode,
        urlHost: (() => { try { return new URL(validatedURL).hostname } catch { return '' } })(),
        errorCode: Number(errorCode) || null,
        observedAt: new Date().toISOString(),
        source: 'did-fail-load'
      }
      evidenceByWebContents.set(wc, entry)
      if (typeof onNavigationEvidence === 'function') {
        try { onNavigationEvidence(entry) } catch { /* evidence hooks must not break worker lifecycle */ }
      }
    })
    wc.on('render-process-gone', () => {
      setImmediate(() => { void recycleSellerWorker(accountId) })
    })
    win.on('closed', () => {
      if (windows.get(accountId) === win) {
        windows.delete(accountId)
        partitions.delete(accountId)
      }
    })
    if (creationGeneration !== generation) {
      try { win.destroy() } catch { /* stale construction is never retained */ }
      throw new Error('seller worker creation was cancelled by controller teardown')
    }
    windows.set(accountId, win)
    partitions.set(accountId, partition)
    return win
  }

  async function getSellerWebContents(account) {
    const accountId = String(account?.id || '').trim()
    const partition = String(account?.partition || '').trim()
    if (!accountId) throw new TypeError('seller worker account id is required')
    // Recycling a AdsPower target is asynchronous: the old target must be
    // confirmed closed before a replacement can be created.  Callers in the
    // scheduler intentionally do not need to know this implementation detail;
    // every get waits on the account-local barrier.
    while (recycling.has(accountId)) {
      await recycling.get(accountId).catch(() => {})
    }
    if (isAdsPowerAccount(account)) {
      if (!String(account?.adsPowerId || account?.browserProfileId || '').trim()) throw new TypeError('AdsPower account requires adsPowerId')
      let current = bitContents.get(accountId)
      if (current?.isDestroyed?.()) {
        bitContents.delete(accountId)
        current = null
      }
      const wc = current || getAdsPowerWebContents(account, 'seller')
      if (!current) {
        const handler = (_event, url) => {
          const kind = sellerNavigationKind(url)
          if (kind !== 'seller') recordEvidence(wc, accountId, url, kind, { source: 'did-navigate' })
        }
        bitContents.set(accountId, wc)
        bitEvidenceHandlers.set(accountId, handler)
        wc.on('did-navigate', handler)
      }
      await wc.ensureConnected()
      return wc
    }
    if (!partition.startsWith('persist:')) throw new TypeError('seller worker requires a persistent account partition')
    let win = windows.get(accountId)
    if (win && partitions.get(accountId) !== partition) {
      recycleSellerWorker(accountId)
      win = null
    }
    if (!win || win.isDestroyed?.() || win.webContents?.isDestroyed?.()) {
      let pendingEntry = pendingWindows.get(accountId)
      if (pendingEntry && pendingEntry.partition !== partition) {
        await pendingEntry.promise.catch(() => {})
        recycleSellerWorker(accountId)
        pendingEntry = null
      }
      if (!pendingEntry) {
        const creationGeneration = generation
        let promise
        promise = createWindow(account, creationGeneration).finally(() => {
          if (pendingWindows.get(accountId)?.promise === promise) pendingWindows.delete(accountId)
        })
        pendingEntry = { partition, promise }
        pendingWindows.set(accountId, pendingEntry)
      }
      win = await pendingEntry.promise
    }
    return win.webContents
  }

  function recycleSellerWorker(accountId) {
    const id = String(accountId || '')
    if (recycling.has(id)) return recycling.get(id)
    const bit = bitContents.get(id)
    const handler = bitEvidenceHandlers.get(id)
    if (bit && handler) bit.removeListener('did-navigate', handler)
    bitContents.delete(id)
    bitEvidenceHandlers.delete(id)
    // Seller workers own only the seller-purpose target.  A preview target
    // may be open for the same account and must remain usable.
    const closePromise = closeAdsPowerWebContents(id, 'seller')
    const win = windows.get(id)
    windows.delete(id)
    partitions.delete(id)
    if (win && !win.isDestroyed?.()) {
      try { win.destroy() } catch { /* already closing */ }
    }
    const operation = Promise.resolve(closePromise).catch(() => {})
    recycling.set(id, operation)
    operation.finally(() => {
      if (recycling.get(id) === operation) recycling.delete(id)
    }).catch(() => {})
    return operation
  }

  async function destroySellerWorkers() {
    generation += 1
    const pending = [...pendingWindows.values()].map((entry) => entry.promise)
    pendingWindows.clear()
    const recyclePromises = []
    for (const id of [...windows.keys()]) recyclePromises.push(recycleSellerWorker(id))
    for (const id of [...bitContents.keys()]) recyclePromises.push(recycleSellerWorker(id))
    for (const promise of recycling.values()) recyclePromises.push(promise)
    await Promise.allSettled(recyclePromises)
    await Promise.allSettled(pending)
    for (const id of [...windows.keys()]) await recycleSellerWorker(id)
    for (const id of [...bitContents.keys()]) await recycleSellerWorker(id)
  }

  function consumeSellerNavigationEvidence(webContents) {
    const entry = evidenceByWebContents.get(webContents) || null
    if (entry) evidenceByWebContents.delete(webContents)
    return entry
  }

  return { getSellerWebContents, recycleSellerWorker, destroySellerWorkers, consumeSellerNavigationEvidence }
}

const singleton = createSellerWorkerController()

export const getSellerWebContents = singleton.getSellerWebContents
export const recycleSellerWorker = singleton.recycleSellerWorker
export const destroySellerWorkers = singleton.destroySellerWorkers
export const consumeSellerNavigationEvidence = singleton.consumeSellerNavigationEvidence
