/**
 * 渲染进程转发主进程调试日志到 DevTools 控制台
 */
export function registerSxjkMainLogIPC(ipcMain) {
  ipcMain.handle('sxjk-main-log', async (_e, payload = {}) => {
    const level = String(payload?.level || 'info').toLowerCase()
    const tag = String(payload?.tag || 'sxjk-main').trim() || 'sxjk-main'
    const msg = payload?.msg ?? payload?.message ?? ''
    const meta = payload?.meta
    const line = meta != null ? [msg, meta] : [msg]
    if (level === 'warn') console.warn(`[${tag}]`, ...line)
    else if (level === 'error') console.error(`[${tag}]`, ...line)
    else console.info(`[${tag}]`, ...line)
    return { ok: true }
  })
}
