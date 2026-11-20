/**
 * 主进程经渲染进程代发已登录的后端 API（复用 axios 加密/签名/token）。
 */
import { randomUUID } from 'node:crypto'

/** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
const pending = new Map()

/**
 * @param {import('electron').IpcMain} ipcMain
 */
export function registerSxjkBackendBridgeIPC(ipcMain) {
  ipcMain.on('sxjk-backend-bridge-res', (_e, payload = {}) => {
    const requestId = String(payload?.requestId || '').trim()
    if (!requestId) return
    const p = pending.get(requestId)
    if (!p) return
    pending.delete(requestId)
    clearTimeout(p.timer)
    // preload 包装为 { requestId, result: { ok, data|error } }
    const res = payload?.result && typeof payload.result === 'object' ? payload.result : payload
    if (res?.ok === false) {
      p.reject(new Error(String(res?.error || '后端请求失败')))
      return
    }
    p.resolve(res?.data)
  })
}

/**
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 */
export function createSxjkBackendPost(getMainWindow) {
  /**
   * @param {string} path 如 /app/xy-sxjk/goofish/accountProfile
   * @param {Record<string, unknown>} [body]
   * @param {{ timeoutMs?: number }} [opts]
   */
  return async function sxjkBackendPost(path, body = {}, opts = {}) {
    const win = getMainWindow?.()
    if (!win || win.isDestroyed()) {
      throw new Error('客户端窗口未就绪，请先完成登录')
    }
    const requestId = randomUUID()
    const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || 120000)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('请求后端超时'))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      win.webContents.send('sxjk-backend-bridge-req', { requestId, path, body })
    })
  }
}
