/**
 * 闲鱼上新：每次搜索/检查记录 — SQLite
 */
import { reportRoundLog } from '../utils/sxjk-round-log-uploader.js'
import { randomUUID } from 'node:crypto'
import {
  getSxjkLocalDb,
  readLogEntries,
  insertLogEntry,
  clearLogEntries,
  deleteLogEntriesByIds,
  LOG_KIND
} from '../utils/sxjk-local-db.js'

const MAX_LOGS = 3000
const MAX_FILTER_SUMMARY_LEN = 8000
const MAX_ERR_LEN = 2000

function normalizeEntry(raw) {
  const filterSummary = String(raw?.filterSummary ?? '').trim().slice(0, MAX_FILTER_SUMMARY_LEN)
  const pollAid = String(raw?.pollAccountId || '').trim().slice(0, 64)
  const proxyHp = String(raw?.pollProxyHostPort || '').trim().slice(0, 96)
  return {
    id: String(raw?.id || randomUUID()),
    at: String(raw?.at || new Date().toISOString()),
    taskId: String(raw?.taskId || '').trim().slice(0, 64),
    keyword: String(raw?.keyword || '').trim().slice(0, 120),
    ...(pollAid ? { pollAccountId: pollAid } : {}),
    ...(proxyHp ? { pollProxyHostPort: proxyHp } : {}),
    success: !!raw?.success,
    error: String(raw?.error || '').trim().slice(0, MAX_ERR_LEN),
    ...(filterSummary ? { filterSummary } : {})
  }
}

export function registerSxjkPollCheckLogsIPC(ipcMain) {
  ipcMain.handle('append-sxjk-poll-check-log', async (_e, payload) => {
    try {
      const plain =
        payload && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : {}
      const entry = normalizeEntry({
        ...plain,
        id: randomUUID(),
        at:
          plain.at && String(plain.at).trim()
            ? String(plain.at).trim()
            : new Date().toISOString()
      })
      if (!entry.taskId && !entry.keyword) {
        return { ok: false, error: 'missing_task' }
      }
      insertLogEntry(getSxjkLocalDb(), LOG_KIND.pollCheck, entry, { maxLogs: MAX_LOGS })
      reportRoundLog('check', entry)
      return { ok: true, entry }
    } catch (e) {
      console.error('[轮询检查日志] append 失败', e)
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('query-sxjk-poll-check-logs', async (_e, query) => {
    try {
      const page = Math.max(1, parseInt(query?.page, 10) || 1)
      const pageSize = Math.min(100, Math.max(5, parseInt(query?.pageSize, 10) || 15))
      const list = readLogEntries(getSxjkLocalDb(), LOG_KIND.pollCheck)

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

      const okFilter = String(query?.successFilter ?? '').trim().toLowerCase()

      const filtered = list.filter((entry) => {
        if (keyword) {
          const blob = [entry.keyword, entry.pollAccountId, entry.pollProxyHostPort, entry.error]
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
          if (!entry.success) return false
        } else if (okFilter === 'fail') {
          if (entry.success) return false
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

  ipcMain.handle('clear-sxjk-poll-check-logs', async () => {
    try {
      clearLogEntries(getSxjkLocalDb(), LOG_KIND.pollCheck)
      return { ok: true }
    } catch (e) {
      console.error('[轮询检查日志] clear 失败', e)
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('delete-sxjk-poll-check-logs', async (_e, payload) => {
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
      const deleted = deleteLogEntriesByIds(getSxjkLocalDb(), LOG_KIND.pollCheck, idSet)
      return { ok: true, deleted, requested: idSet.size }
    } catch (e) {
      return { ok: false, error: String(e.message || e), deleted: 0 }
    }
  })
}
