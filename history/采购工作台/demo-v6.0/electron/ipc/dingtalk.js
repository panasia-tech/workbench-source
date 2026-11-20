import { sendMarkdownMessage, sendActionCardMessage, sendLinkMessage } from '../utils/dingding-push.js'

/** 同一设备多开窗口时各有一条 Socket，服务端会对每条连接广播快捷指令；此处合并为一次钉钉推送 */
const SXJK_LISTEN_STATE_DEDUPE_MS = 8000
/** @type {Map<string, number>} */
const sxjkListenStateDedupeAt = new Map()

function shouldSkipSxjkListenStateDedupe(payload) {
  const raw = payload?.sxjkListenStateDedupe
  if (typeof raw !== 'string') return false
  const key = raw.trim()
  if (!key) return false
  const now = Date.now()
  const prev = sxjkListenStateDedupeAt.get(key)
  if (prev != null && now - prev < SXJK_LISTEN_STATE_DEDUPE_MS) {
    return true
  }
  sxjkListenStateDedupeAt.set(key, now)
  if (sxjkListenStateDedupeAt.size > 200) {
    for (const [k, t] of sxjkListenStateDedupeAt) {
      if (now - t > SXJK_LISTEN_STATE_DEDUPE_MS) sxjkListenStateDedupeAt.delete(k)
    }
  }
  return false
}

function stripSxjkListenStateDedupe(payload) {
  if (!payload || typeof payload !== 'object') return payload || {}
  const { sxjkListenStateDedupe: _d, ...rest } = payload
  return rest
}

export function registerDingtalkIPC(ipcMain) {
  ipcMain.handle('send-dingtalk-markdown', async (_e, payload) => {
    if (shouldSkipSxjkListenStateDedupe(payload)) {
      return { success: true, deduped: true }
    }
    const p = stripSxjkListenStateDedupe(payload)
    const title = String(p?.title || '通知')
    const text = String(p?.text || '')
    const credentialsOverride = p?.credentialsOverride
    return await sendMarkdownMessage(title, text, credentialsOverride ?? null)
  })
  ipcMain.handle('send-dingtalk-action-card', async (_e, payload) => {
    if (shouldSkipSxjkListenStateDedupe(payload)) {
      return { success: true, deduped: true }
    }
    return await sendActionCardMessage(stripSxjkListenStateDedupe(payload || {}))
  })
  ipcMain.handle('send-dingtalk-link', async (_e, payload) => {
    return await sendLinkMessage(payload || {})
  })
}
