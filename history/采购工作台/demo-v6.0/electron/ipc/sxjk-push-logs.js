/**
 * 闲鱼上新：钉钉推送记录 — SQLite
 */
import { reportRoundLog } from '../utils/sxjk-round-log-uploader.js'
import { randomUUID } from 'node:crypto'
import { humanizeListingField } from '../utils/humanizeListingField.js'
import {
  getSxjkLocalDb,
  readLogEntries,
  insertLogEntry,
  clearLogEntries,
  deleteLogEntriesByIds,
  prunePushedItemIds,
  replacePushedItemIds,
  LOG_KIND,
  PUSHED_SCOPE
} from '../utils/sxjk-local-db.js'

const MAX_LOGS = 1000

function stripPushItemsFromLogEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const { pushItems, ...rest } = entry
  const pis = Array.isArray(pushItems) ? pushItems : []
  const icRaw = parseInt(rest?.itemCount, 10)
  const itemCount =
    Number.isFinite(icRaw) && icRaw > 0 ? Math.max(0, Math.min(500, icRaw)) : pis.length
  return { ...rest, itemCount }
}

function collectItemIdsFromDoomedPushEntries(doomedEntries) {
  const out = new Set()
  for (const ent of Array.isArray(doomedEntries) ? doomedEntries : []) {
    const pis = Array.isArray(ent?.pushItems) ? ent.pushItems : []
    for (const p of pis) {
      const iid = String(p?.itemId || '').trim()
      if (iid) out.add(iid)
    }
  }
  return out
}

function pruneGlobalPushedForItemIds(itemIdSet, syncPushedIds) {
  const meta = {
    syncedItemIdCount: itemIdSet.size,
    pushedIdsRemoved: 0,
    error: ''
  }
  if (!itemIdSet.size) return meta
  if (!syncPushedIds) {
    meta.error = '未启用全局已推同步，无法从已推列表中移除对应商品 ID'
    return meta
  }
  try {
    meta.pushedIdsRemoved = prunePushedItemIds(
      getSxjkLocalDb(),
      PUSHED_SCOPE.global,
      itemIdSet
    )
  } catch (e) {
    meta.error = `全局已推: ${String(e?.message || e)}`
  }
  return meta
}

function collectItemIdsFromLogs(list) {
  const out = new Set()
  for (const ent of Array.isArray(list) ? list : []) {
    const items = Array.isArray(ent?.pushItems) ? ent.pushItems : []
    for (const it of items) {
      const id = String(it?.itemId || '').trim()
      if (id) out.add(id)
    }
  }
  return [...out]
}

const MAX_PUSH_ITEMS = 30
const MAX_PICS_PER_ITEM = 12
const MAX_PUSH_ITEM_TITLE_LEN = 8000
const MAX_PUSH_PREVIEW_LEN = 4000
const MAX_PUSH_ERROR_LEN = 4000
const MAX_PUSH_FILTER_SUMMARY_LEN = 8000

function slicePicUrl(s) {
  let t = String(s || '').trim().slice(0, 512)
  if (!t) return ''
  if (t.startsWith('//')) t = `https:${t}`
  return t
}

function normalizeServiceLabels(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const s of raw) {
    const t = String(s || '').trim().slice(0, 48)
    if (t) out.push(t)
  }
  return out.slice(0, 8)
}

function normalizeServiceIcons(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const x of raw) {
    const url = slicePicUrl(x?.url)
    const label = String(x?.label || '').trim().slice(0, 32)
    if (url) out.push({ label, url })
  }
  return out.slice(0, 8)
}

function normalizePicsForItem(x) {
  const seen = new Set()
  const urls = []
  if (Array.isArray(x?.pics)) {
    for (const u of x.pics) {
      const n = slicePicUrl(u)
      if (n && !seen.has(n)) {
        seen.add(n)
        urls.push(n)
      }
    }
  }
  const main = slicePicUrl(x?.pic)
  if (main && !seen.has(main)) {
    urls.unshift(main)
  }
  return urls.slice(0, MAX_PICS_PER_ITEM)
}

function normalizePushItems(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const x of raw.slice(0, MAX_PUSH_ITEMS)) {
    const itemId = String(x?.itemId || '').trim().slice(0, 48)
    if (!itemId) continue
    const pics = normalizePicsForItem(x)
    out.push({
      itemId,
      title: String(x?.title || '').trim().slice(0, MAX_PUSH_ITEM_TITLE_LEN),
      price: String(x?.price || '').trim().slice(0, 48),
      city: String(x?.city || '').trim().slice(0, 48),
      timeDisplay: String(x?.timeDisplay || '').trim().slice(0, 100),
      pic: pics[0] || '',
      pics,
      seller: String(x?.seller || '').trim().slice(0, 80),
      sellerUserId: String(x?.sellerUserId || '').trim().slice(0, 256),
      sellerBlacklistId: String(x?.sellerBlacklistId || '').trim().slice(0, 256),
      sellerPlainUserId: String(x?.sellerPlainUserId || '').trim().slice(0, 256),
      sellerAvatar: slicePicUrl(x?.sellerAvatar),
      yanhuobaoLabel: humanizeListingField(x?.yanhuobaoLabel, 48),
      yanhuobaoIconUrl: slicePicUrl(x?.yanhuobaoIconUrl),
      sellerCredit: humanizeListingField(x?.sellerCredit, 40),
      wantLabel: humanizeListingField(x?.wantLabel, 32),
      buyerCreditLabel: humanizeListingField(x?.buyerCreditLabel, 40),
      serviceLabels: normalizeServiceLabels(x?.serviceLabels),
      serviceIcons: normalizeServiceIcons(x?.serviceIcons)
    })
  }
  return out
}

function normalizeEntry(raw) {
  const dingtalkSkipped =
    raw?.dingtalkSkipped === true ||
    raw?.dingtalkSkipped === '1' ||
    raw?.dingtalkSkipped === 1
  const pollAccountId = String(raw?.pollAccountId ?? '').trim().slice(0, 64)
  const pollProxyHostPort = String(raw?.pollProxyHostPort ?? '').trim().slice(0, 96)
  const filterSummary = String(raw?.filterSummary ?? '').trim().slice(0, MAX_PUSH_FILTER_SUMMARY_LEN)
  return {
    id: String(raw?.id || randomUUID()),
    at: String(raw?.at || new Date().toISOString()),
    taskId: String(raw?.taskId || '').trim().slice(0, 64),
    keyword: String(raw?.keyword || '').trim().slice(0, 120),
    ...(pollAccountId ? { pollAccountId } : {}),
    ...(pollProxyHostPort ? { pollProxyHostPort } : {}),
    ...(filterSummary ? { filterSummary } : {}),
    itemCount: Math.max(0, Math.min(500, parseInt(raw?.itemCount, 10) || 0)),
    success: raw?.success !== false && raw?.success !== '0',
    dingtalkSkipped,
    error: String(raw?.error || '').trim().slice(0, MAX_PUSH_ERROR_LEN),
    preview: String(raw?.preview || '').trim().slice(0, MAX_PUSH_PREVIEW_LEN),
    pushItems: normalizePushItems(raw?.pushItems)
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ syncPushedIds?: boolean }} [opts]
 */
export function registerSxjkPushLogsIPC(ipcMain, opts = {}) {
  const syncPushedIds = opts?.syncPushedIds !== false

  ipcMain.handle('append-sxjk-push-log', async (_e, payload) => {
    try {
      const plain =
        payload && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : {}
      const entry = normalizeEntry({
        ...plain,
        id: randomUUID(),
        at: new Date().toISOString()
      })
      insertLogEntry(getSxjkLocalDb(), LOG_KIND.push, entry, { maxLogs: MAX_LOGS })
      reportRoundLog('push', entry)
      return { ok: true, entry }
    } catch (e) {
      console.error('[推送日志] append 失败', e)
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('query-sxjk-push-logs', async (_e, query) => {
    try {
      const page = Math.max(1, parseInt(query?.page, 10) || 1)
      const pageSize = Math.min(100, Math.max(5, parseInt(query?.pageSize, 10) || 15))
      const list = readLogEntries(getSxjkLocalDb(), LOG_KIND.push)

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

      const successFilter = String(query?.successFilter ?? '').trim().toLowerCase()

      const filtered = list.filter((entry) => {
        if (keyword) {
          const rowKw = String(entry.keyword || '').toLowerCase()
          if (!rowKw.includes(keyword)) return false
        }
        if (timeFrom != null || timeTo != null) {
          const t = Date.parse(String(entry.at || ''))
          if (!Number.isFinite(t)) return false
          if (timeFrom != null && t < timeFrom) return false
          if (timeTo != null && t > timeTo) return false
        }
        const ic = Math.max(0, Math.min(500, parseInt(entry?.itemCount, 10) || 0))
        const skipped = entry.dingtalkSkipped === true
        if (successFilter === 'success') {
          if (!entry.success || skipped) return false
        } else if (successFilter === 'partial') {
          if (entry.success) return false
          if (ic === 0) return false
        } else if (successFilter === 'fail') {
          if (entry.success) return false
          if (ic > 0) return false
        } else if (successFilter === 'skipped') {
          if (!skipped) return false
        }
        return true
      })

      const total = filtered.length
      const start = (page - 1) * pageSize
      const items = filtered.slice(start, start + pageSize).map(stripPushItemsFromLogEntry)
      return { ok: true, total, items, page, pageSize }
    } catch (e) {
      return { ok: false, error: String(e.message || e), total: 0, items: [] }
    }
  })

  ipcMain.handle('get-sxjk-push-log-item-ids', async () => {
    try {
      const list = readLogEntries(getSxjkLocalDb(), LOG_KIND.push)
      return { ok: true, ids: collectItemIdsFromLogs(list) }
    } catch (e) {
      return { ok: false, error: String(e.message || e), ids: [] }
    }
  })

  ipcMain.handle('get-sxjk-push-log-detail', async (_e, payload) => {
    try {
      const logId = String(payload?.id || '').trim()
      if (!logId) return { ok: false, error: '缺少日志 id' }
      const list = readLogEntries(getSxjkLocalDb(), LOG_KIND.push)
      const entry = list.find((row) => String(row?.id || '') === logId)
      if (!entry) return { ok: false, error: '记录不存在' }
      return { ok: true, entry }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('clear-sxjk-push-logs', async () => {
    try {
      const db = getSxjkLocalDb()
      clearLogEntries(db, LOG_KIND.push)
      if (syncPushedIds) {
        replacePushedItemIds(db, PUSHED_SCOPE.global, [])
      }
      return {
        ok: true,
        clearedPushedItemIds: !!syncPushedIds,
        clearedTaskSeenIds: false,
        tasksSeenResetCount: 0
      }
    } catch (e) {
      console.error('[推送日志] clear 失败', e)
      return { ok: false, error: String(e.message || e) }
    }
  })

  ipcMain.handle('delete-sxjk-push-logs', async (_e, payload) => {
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
      const db = getSxjkLocalDb()
      const list = readLogEntries(db, LOG_KIND.push)
      const doomed = list.filter((e) => idSet.has(String(e?.id || '')))
      const itemIdSet = collectItemIdsFromDoomedPushEntries(doomed)

      let sync = {
        syncedItemIdCount: itemIdSet.size,
        seenIdsRemoved: 0,
        tasksUpdated: 0,
        pushedIdsRemoved: 0,
        error: ''
      }
      if (itemIdSet.size) {
        sync = pruneGlobalPushedForItemIds(itemIdSet, syncPushedIds)
        if (sync.error) {
          return {
            ok: false,
            error: `删除前同步失败：${sync.error}`,
            deleted: 0,
            requested: idSet.size
          }
        }
      }

      const deleted = deleteLogEntriesByIds(db, LOG_KIND.push, idSet)
      return {
        ok: true,
        deleted,
        requested: idSet.size,
        syncedItemIdCount: sync.syncedItemIdCount,
        seenIdsRemoved: 0,
        tasksUpdated: 0,
        pushedIdsRemoved: sync.pushedIdsRemoved
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e), deleted: 0 }
    }
  })

  ipcMain.handle('delete-sxjk-push-logs-by-task-id', async (_e, payload) => {
    try {
      const tid = String(payload?.taskId ?? payload ?? '').trim()
      if (!tid) {
        return { ok: false, error: '缺少任务 id', deleted: 0 }
      }
      const db = getSxjkLocalDb()
      const list = readLogEntries(db, LOG_KIND.push)
      const doomed = list.filter((e) => String(e?.taskId || '').trim() === tid)
      const itemIdSet = collectItemIdsFromDoomedPushEntries(doomed)

      let pushedIdsRemoved = 0
      if (itemIdSet.size) {
        const sync = pruneGlobalPushedForItemIds(itemIdSet, syncPushedIds)
        pushedIdsRemoved = sync.pushedIdsRemoved
        if (sync.error) {
          return {
            ok: false,
            error: `删除前同步失败：${sync.error}`,
            deleted: 0
          }
        }
      }

      const idSet = new Set(doomed.map((e) => String(e?.id || '').trim()).filter(Boolean))
      const deleted = deleteLogEntriesByIds(db, LOG_KIND.push, idSet)
      return {
        ok: true,
        deleted,
        taskId: tid,
        pushedIdsRemoved
      }
    } catch (e) {
      return { ok: false, error: String(e.message || e), deleted: 0 }
    }
  })
}
