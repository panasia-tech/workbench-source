// 每个账号使用两块独立的 WebContentsView（独立持久分区）：
// 1) worker view：只给关键词行情爬虫使用，永远不挂到主窗口；
// 2) preview view：只给「闲鱼预览」页面使用，用户看得到但不参与后台导航。
// 这样即使用户正在别的软件里工作，后台搜索也不会把预览页一起带着跳转或抢焦点。
import { WebContentsView } from 'electron'
import { installSearchCapture } from './search-capture.js'

// Kept as a late-bound bridge so the pure Node session regressions can load
// this module from a data: URL without resolving Electron-only adapters.
function adsPowerBridge() {
  return globalThis.__xianyuAdsPower || null
}

function isAdsPowerAccount(account) {
  return String(account?.browserProvider || '').toLowerCase() === 'adspower' || Boolean(String(account?.adsPowerId || account?.browserProfileId || '').trim())
}

function requiredAdsPowerBridge() {
  const bridge = adsPowerBridge()
  if (!bridge) throw new Error('AdsPower adapter is not initialized')
  return bridge
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PREVIEW_HOME_URL = 'https://www.goofish.com/'

// Electron Session does not expose its originating partition. Keep the
// partition beside the view so reuse decisions are explicit and stable.
const workerViews = new Map() // accountId -> { view, partition }
const previewViews = new Map() // accountId -> { view, partition }
let baseWindow = null
let attachedId = null // 当前挂在窗口里的账号

export function initSessionManager(win) {
  if (baseWindow && baseWindow !== win) detach()
  baseWindow = win
}

function accountIdentity(account) {
  const id = String(account?.id || '').trim()
  const partition = String(account?.partition || '').trim()
  if (!id) throw new TypeError('account id is required')
  if (!isAdsPowerAccount(account) && !partition.startsWith('persist:')) throw new TypeError('account requires a persistent partition')
  return { id, partition }
}

function closeView(view) {
  if (!view || view.webContents.isDestroyed()) return
  try { view.webContents.close() } catch { /* view may already be closing */ }
}

/** 取（或惰性创建）某账号的后台工作视图 */
function getWorkerView(account) {
  const { id, partition } = accountIdentity(account)
  const current = workerViews.get(id)
  if (current && !current.view.webContents.isDestroyed() && current.partition === partition) return current.view
  if (current) recycleView(id)
  let view
  view = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false, // 后台/最小化也不降频，保证爬取继续
      contextIsolation: true,
      sandbox: true
    }
  })
  view.webContents.setUserAgent(UA)
  installSearchCapture(view.webContents)
  // 渲染进程崩溃（多为长时间连续加载页面内存不足被系统杀掉）：
  // 销毁视图，下次 getView 惰性重建全新进程，登录态在持久分区里不丢
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[session] 账号 ${account.name} 渲染进程崩溃: ${details?.reason}`)
    setImmediate(() => recycleView(id))
  })
  // worker view 永远不 addChildView 到主窗口；显式隐藏是额外保险，避免未来重构时误显示。
  view.setVisible(false)
  view.webContents.once('destroyed', () => {
    if (workerViews.get(id)?.view === view) workerViews.delete(id)
  })
  workerViews.set(id, { view, partition })
  return view
}

/** 取（或惰性创建）某账号的预览视图。它与 worker view 共享 partition，但页面状态独立。 */
function getPreviewView(account) {
  const { id, partition } = accountIdentity(account)
  const current = previewViews.get(id)
  if (current && !current.view.webContents.isDestroyed() && current.partition === partition) return current.view
  if (current) destroyPreviewView(id)
  let view
  view = new WebContentsView({
    webPreferences: {
      partition,
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  view.webContents.setUserAgent(UA)
  view.setVisible(false)
  view.webContents.on('render-process-gone', () => setImmediate(() => destroyPreviewView(id)))
  view.webContents.once('destroyed', () => {
    if (previewViews.get(id)?.view === view) previewViews.delete(id)
    if (attachedId === id) attachedId = null
  })
  // 预览视图不复用 worker 的当前 URL；首次打开时给用户一个可操作的闲鱼首页。
  // 导航发生在视图尚未挂载时，不会把主窗口带到前台。
  view.webContents.loadURL(PREVIEW_HOME_URL).catch(() => {})
  previewViews.set(id, { view, partition })
  return view
}

function destroyPreviewView(accountId) {
  const id = String(accountId || '')
  if (attachedId === id) detach()
  const preview = previewViews.get(id)?.view
  previewViews.delete(id)
  closeView(preview)
}

/** 销毁某账号视图（下次 getView 时重建），用于定期回收内存/崩溃恢复 */
export function recycleView(accountId) {
  if (attachedId === accountId) detach()
  const view = workerViews.get(accountId)?.view
  workerViews.delete(accountId)
  closeView(view)
}

export function getWebContents(account) {
  if (isAdsPowerAccount(account)) {
    const contents = requiredAdsPowerBridge().getAdsPowerWebContents(account, 'worker')
    installSearchCapture(contents)
    return contents
  }
  return getWorkerView(account).webContents
}

/** 预览页使用的独立 WebContents；后台任务不得调用它。 */
export function getPreviewWebContents(account) {
  if (isAdsPowerAccount(account)) return requiredAdsPowerBridge().getAdsPowerWebContents(account, 'preview')
  return getPreviewView(account).webContents
}

/** 把某账号视图挂进主窗口的指定 bounds（预览用） */
export async function attach(account, bounds) {
  if (isAdsPowerAccount(account)) {
    // WebContentsView cannot wrap a foreign browser process.  Keep the
    // preview controls in Electron, while opening the real fingerprinted
    // profile in AdsPower.
    const contents = requiredAdsPowerBridge().getAdsPowerWebContents(account, 'preview')
    await contents.ensureConnected()
    return { external: true, provider: 'adspower', profileId: contents.profileId }
  }
  if (!baseWindow || baseWindow.isDestroyed?.()) return { external: false }
  const { id } = accountIdentity(account)
  detach() // 先卸下当前的
  const view = getPreviewView(account)
  baseWindow.contentView.addChildView(view)
  view.setBounds(bounds)
  view.setVisible(true)
  attachedId = id
  return { external: false }
}

/** 更新当前预览视图 bounds（窗口缩放/布局变化时） */
export function setBounds(bounds) {
  if (!attachedId) return
  const view = previewViews.get(attachedId)?.view
  if (view && !view.webContents.isDestroyed()) view.setBounds(bounds)
}

/** 卸下当前预览视图（视图本身不销毁，爬取继续） */
export function detach() {
  if (!attachedId || !baseWindow) return
  const view = previewViews.get(attachedId)?.view
  if (view && !view.webContents.isDestroyed()) {
    view.setVisible(false)
    try {
      baseWindow.contentView.removeChildView(view)
    } catch {
      /* ignore */
    }
  }
  attachedId = null
}

/** 删除账号时销毁其视图 */
export async function destroyView(accountId) {
  // Account deletion is the one lifecycle operation allowed to close every
  // purpose.  Normal seller recycling is purpose-scoped in seller-worker.
  const bridge = adsPowerBridge()
  await Promise.allSettled([
    Promise.resolve().then(() => bridge?.closeAdsPowerWebContents(accountId, 'worker')),
    Promise.resolve().then(() => bridge?.closeAdsPowerWebContents(accountId, 'seller')),
    Promise.resolve().then(() => bridge?.closeAdsPowerWebContents(accountId, 'preview'))
  ])
  recycleView(accountId)
  destroyPreviewView(accountId)
  return { ok: true }
}

export function destroyAll() {
  detach()
  for (const { view } of workerViews.values()) closeView(view)
  for (const { view } of previewViews.values()) closeView(view)
  workerViews.clear()
  previewViews.clear()
  attachedId = null
  baseWindow = null
  // AdsPower target closing is asynchronous. Return its promise so the
  // main process can wait for Target.closeTarget before Electron exits.
  return adsPowerBridge()?.closeAllAdsPowerWebContents() || Promise.resolve()
}
