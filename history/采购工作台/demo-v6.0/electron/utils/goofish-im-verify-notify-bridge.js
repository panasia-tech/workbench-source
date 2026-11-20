/** 主进程：验证窗打开后通知渲染进程统一弹提示 */

let getMainWindowRef = null

/**
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow | null | undefined }} opts
 */
export function initGoofishImVerifyNotifyBridge(opts = {}) {
  getMainWindowRef = typeof opts.getMainWindow === 'function' ? opts.getMainWindow : null
}

/**
 * @param {{ accountId?: string, source?: string, fallback?: boolean, bannerShown?: boolean }} [payload]
 */
export function broadcastGoofishImVerifyOpened(payload = {}) {
  const win = getMainWindowRef?.()
  if (!win || win.isDestroyed?.()) return
  try {
    win.webContents.send('sxjk-goofish-im-verify-opened', {
      accountId: String(payload?.accountId || '').trim(),
      source: String(payload?.source || '').trim(),
      fallback: payload?.fallback === true,
      bannerShown: payload?.bannerShown === true
    })
  } catch (e) {
    console.warn('[闲鱼私聊验证通知] 广播失败', e?.message || e)
  }
}
