/**
 * 本机 SQLite KV（节流时间戳等）+ 客户端偏好（全局轮询间隔）
 */
import {
  getSxjkLocalDb,
  getAppLocalState,
  setAppLocalState,
  getPcClientPref,
  upsertPcClientPref
} from '../utils/sxjk-local-db.js'

export function registerSxjkLocalStateIPC(ipcMain) {
  ipcMain.handle('sxjk-local-state-get', async (_e, body = {}) => {
    try {
      const key = String(body?.key || '').trim()
      if (!key) return { ok: false, error: 'missing_key', value: '' }
      const value = getAppLocalState(getSxjkLocalDb(), key)
      return { ok: true, key, value }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), value: '' }
    }
  })

  ipcMain.handle('sxjk-local-state-set', async (_e, body = {}) => {
    try {
      const key = String(body?.key || '').trim()
      if (!key) return { ok: false, error: 'missing_key' }
      setAppLocalState(getSxjkLocalDb(), key, body?.value ?? '')
      return { ok: true, key }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-pc-client-pref-get', async () => {
    try {
      const pref = getPcClientPref(getSxjkLocalDb())
      return { ok: true, ...pref }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-pc-client-pref-set', async (_e, body = {}) => {
    try {
      const pref = upsertPcClientPref(getSxjkLocalDb(), body || {})
      return { ok: true, ...pref }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })
}
