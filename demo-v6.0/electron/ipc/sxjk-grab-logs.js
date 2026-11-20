/**
 * 闲鱼上新：秒拍/抢单尝试记录 — SQLite
 */
import { randomUUID } from 'node:crypto'
import {
  getSxjkLocalDb,
  readLogEntries,
  insertLogEntry,
  clearLogEntries,
  deleteLogEntriesByIds,
  LOG_KIND
} from '../utils/sxjk-local-db.js'

const MAX_LOGS = 1000
const MAX_ERR_LEN = 2000
const MAX_TITLE_LEN = 800

function normalizeEntry(raw) {
  return {
    id: String(raw?.id || randomUUID()),
    at: String(raw?.at || new Date().toISOString()),
    ok: !!raw?.ok,
    keyword: String(raw?.keyword || '').trim().slice(0, 120),
    taskId: String(raw?.taskId || '').trim().slice(0, 64),
    itemId: String(raw?.itemId || '').trim().slice(0, 48),
    title: String(raw?.title || '').trim().slice(0, MAX_TITLE_LEN),
    price: String(raw?.price || '').trim().slice(0, 48),
    city: String(raw?.city || '').trim().slice(0, 48),
    pic: String(raw?.pic || '').trim().slice(0, 512),
    accountId: String(raw?.accountId || '').trim().slice(0, 64),
    orderId: String(raw?.orderId || '').trim().slice(0, 64),
    error: String(raw?.error || '').trim().slice(0, MAX_ERR_LEN),
    riskStepLabel: String(raw?.riskStepLabel || '').trim().slice(0, 32),
    captchaTried: !!raw?.captchaTried,
    captchaOk: !!raw?.captchaOk,
    captchaScope: String(raw?.captchaScope || '').trim().slice(0, 64),
    failedStep: String(raw?.failedStep || '').trim().slice(0, 64),
    failedApi: String(raw?.failedApi || '').trim().slice(0, 120)
  }
}

/**
 * 写入一条抢单/秒拍记录（主进程与 IPC 共用）
 * @param {unknown} payload
 * @param {unknown} [_ignoredPath] 兼容旧签名 appendSxjkGrabLogEntry(filePath, payload)
 */
export async function appendSxjkGrabLogEntry(payload, _ignoredPath) {
  // 兼容旧调用：appendSxjkGrabLogEntry(filePath, payload)
  let body = payload
  if (typeof payload === 'string' && _ignoredPath != null) {
    body = _ignoredPath
  }
  try {
    const plain = body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : {}
    const entry = normalizeEntry({
      ...plain,
      id: randomUUID(),
      at: new Date().toISOString()
    })
    if (!entry.itemId) {
      return { ok: false, error: 'missing_itemId' }
    }
    insertLogEntry(getSxjkLocalDb(), LOG_KIND.grab, entry, { maxLogs: MAX_LOGS })
    return { ok: true, entry }
  } catch (e) {
    console.error('[抢单日志] append 失败', e)
    return { ok: false, error: String(e.message || e) }
  }
}

export function registerSxjkGrabLogsIPC(ipcMain) {
  ipcMain.handle('append-sxjk-grab-log', async (_e, payload) => {
    return appendSxjkGrabLogEntry(payload)
  })

  ipcMain.handle('query-sxjk-grab-logs', async (_e, query) => {
    try {
      const page = Math.max(1, parseInt(query?.page, 10) || 1)
      const pageSize = Math.min(100, Math.max(5, parseInt(query?.pageSize, 10) || 15))
      const list = readLogEntries(getSxjkLocalDb(), LOG_KIND.grab)

      const kwRaw = String(query?.keyword ?? '').trim()
      const keyword = kwRaw ? kwRaw.toLowerCase() : ''

      let timeFrom = query?.timeFrom
      let timeTo = query?.timeTo
      if (timeFrom != null && timeFrom !== '') {
        timeFrom = Number(timeFrom)
        if (!Number.isFinite(timeFrom)) timeFrom = null
      } else {
        timeFrom = null
      }
      if (timeTo != null && timeTo !== '') {
        timeTo = Number(timeTo)
        if (!Number.isFinite(timeTo)) timeTo = null
      } else {
        timeTo = null
      }

      const okFilter = String(query?.okFilter ?? '').trim().toLowerCase()

      const filtered = list.filter((entry) => {
        if (keyword) {
          const blob = [entry.keyword, entry.title, entry.itemId, entry.accountId, entry.city]
            .join(' ')
            .toLowerCase()
          if (!blob.includes(keyword)) return false
        }
        if (timeFrom != null || timeTo != null) {
          const t = Date.parse(String(entry.at || ''))
          if (!Number.isFinite(t)) return false
          if (timeFrom != null && t < timeFrom) return false
          if (timeTo != null && t > timeTo) return false
        }
        if (okFilter === 'success') {
          if (!entry.ok) return false
        } else if (okFilter === 'fail') {
          if (entry.ok) return false
        }
        return true
      })

      const total = filtered.length
      const start = (page - 1) * pageSize
      const items = filtered.slice(start, start + pageSize)
      return { ok: true, total, items, page, pageSize }
    } catch (e) {
      return { ok: false, error: String(e.message || e), total: 0, items: [] }
    }
  })

  ipcMain.handle('clear-sxjk-grab-logs', async () => {
    try {
      clearLogEntries(getSxjkLocalDb(), LOG_KIND.grab)
      return { ok: true }
    } catch (e) {
      console.error('[抢单日志] clear 失败', e)
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('delete-sxjk-grab-logs', async (_e, payload) => {
    try {
      const raw = Array.isArray(payload) ? payload : payload?.ids
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: '请选择要删除的记录', deleted: 0 }
      }
      const idSet = new Set()
      for (const x of raw) {
        const id = String(x ?? '').trim()
        if (id) idSet.add(id)
      }
      if (idSet.size === 0) {
        return { ok: false, error: '无效的 ID', deleted: 0 }
      }
      const deleted = deleteLogEntriesByIds(getSxjkLocalDb(), LOG_KIND.grab, idSet)
      return { ok: true, deleted, requested: idSet.size }
    } catch (e) {
      return { ok: false, error: String(e.message || e), deleted: 0 }
    }
  })
}
