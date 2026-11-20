// 每个账号一个 WebContentsView（独立持久分区）。视图常驻：爬取在其内执行，
// 无论是否 attach 到窗口、窗口是否可见都照常跑。预览时才把视图挂进主窗口。
import { WebContentsView } from 'electron'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const views = new Map() // accountId -> WebContentsView
let baseWindow = null
let attachedId = null // 当前挂在窗口里的账号

export function initSessionManager(win) {
  baseWindow = win
}

/** 取（或惰性创建）某账号的视图 */
export function getView(account) {
  let view = views.get(account.id)
  if (view && !view.webContents.isDestroyed()) return view
  view = new WebContentsView({
    webPreferences: {
      partition: account.partition,
      backgroundThrottling: false, // 后台/最小化也不降频，保证爬取继续
      contextIsolation: true,
      sandbox: true
    }
  })
  view.webContents.setUserAgent(UA)
  // 渲染进程崩溃（多为长时间连续加载页面内存不足被系统杀掉）：
  // 销毁视图，下次 getView 惰性重建全新进程，登录态在持久分区里不丢
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[session] 账号 ${account.name} 渲染进程崩溃: ${details?.reason}`)
    setImmediate(() => recycleView(account.id))
  })
  view.setVisible(false)
  views.set(account.id, view)
  return view
}

/** 销毁某账号视图（下次 getView 时重建），用于定期回收内存/崩溃恢复 */
export function recycleView(accountId) {
  if (attachedId === accountId) detach()
  const view = views.get(accountId)
  views.delete(accountId)
  if (view && !view.webContents.isDestroyed()) {
    try {
      view.webContents.close()
    } catch {
      /* ignore */
    }
  }
}

export function getWebContents(account) {
  return getView(account).webContents
}

/** 把某账号视图挂进主窗口的指定 bounds（预览用） */
export function attach(account, bounds) {
  if (!baseWindow) return
  detach() // 先卸下当前的
  const view = getView(account)
  baseWindow.contentView.addChildView(view)
  view.setBounds(bounds)
  view.setVisible(true)
  attachedId = account.id
}

/** 更新当前预览视图 bounds（窗口缩放/布局变化时） */
export function setBounds(bounds) {
  if (!attachedId) return
  const view = views.get(attachedId)
  if (view && !view.webContents.isDestroyed()) view.setBounds(bounds)
}

/** 卸下当前预览视图（视图本身不销毁，爬取继续） */
export function detach() {
  if (!attachedId || !baseWindow) return
  const view = views.get(attachedId)
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
export function destroyView(accountId) {
  recycleView(accountId)
}

export function destroyAll() {
  for (const view of views.values()) {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  views.clear()
  attachedId = null
}
