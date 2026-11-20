/**
 * 轮询「本页商品」快照 — SQLite
 */
import {
  getSxjkLocalDb,
  readListingSnapshot,
  writeListingSnapshot,
  deleteListingSnapshot,
  clearListingSnapshots
} from '../utils/sxjk-local-db.js'

const MAX_ITEMS_PER_SNAPSHOT = 120

function stripItemForSnapshot(it) {
  if (!it || typeof it !== 'object') return null
  const itemId = String(it.itemId ?? it.id ?? '').trim()
  if (!itemId) return null
  const pics = Array.isArray(it.pics) ? it.pics.slice(0, 2) : []
  return {
    itemId,
    title: String(it.detailTitle || it.title || '').trim().slice(0, 600),
    price: String(it.price ?? '').trim().slice(0, 64),
    publishTimeMs: String(it.publishTimeMs ?? '').trim().slice(0, 24),
    publishLabel: String(it.publishLabel ?? '').trim().slice(0, 100),
    timeDisplay: String(it.timeDisplay ?? '').trim().slice(0, 200),
    sellerUserId: String(it.sellerUserId ?? '').trim().slice(0, 256),
    sellerBlacklistId: String(it.sellerBlacklistId ?? '').trim().slice(0, 256),
    pics: pics.map((u) => String(u || '').trim().slice(0, 400)).filter(Boolean)
  }
}

function mergeShopSnapshotLibraryItems(prevItems, pageItems) {
  const byId = new Map()
  for (const x of prevItems) {
    const row = stripItemForSnapshot(x)
    if (!row?.itemId || byId.has(row.itemId)) continue
    byId.set(row.itemId, row)
  }
  for (const row of pageItems) {
    if (!row?.itemId) continue
    byId.set(row.itemId, row)
  }
  return Array.from(byId.values())
}

/**
 * @param {import('electron').IpcMain} ipcMain
 */
export function registerSxjkListingSnapshotsIPC(ipcMain) {
  ipcMain.handle('sxjk-listing-snapshot-diff-and-save', async (_e, body = {}) => {
    try {
      const kindRaw = String(body.kind || '').toLowerCase()
      const kind = kindRaw === 'shop' ? 'shop' : 'task'
      const id = String(body.id || '').trim()
      if (!id) {
        return { ok: false, error: 'missing_id', bootstrapped: false, newItemIds: [], snapshotPageIdCount: 0 }
      }
      const fingerprint = String(body.fingerprint ?? '').trim()
      if (!fingerprint) {
        return {
          ok: false,
          error: 'missing_fingerprint',
          bootstrapped: false,
          newItemIds: [],
          snapshotPageIdCount: 0
        }
      }

      const rawItems = Array.isArray(body.items) ? body.items : []
      const stripped = []
      const seen = new Set()
      for (const x of rawItems) {
        const row = stripItemForSnapshot(x)
        if (!row || seen.has(row.itemId)) continue
        seen.add(row.itemId)
        stripped.push(row)
        if (stripped.length >= MAX_ITEMS_PER_SNAPSHOT) break
      }

      const db = getSxjkLocalDb()
      const prev = readListingSnapshot(db, kind, id)

      let bootstrapped = false
      /** @type {string[]} */
      let newItemIds = []
      const prevFp = prev && typeof prev === 'object' ? String(prev.fingerprint || '').trim() : ''
      const prevItems = prev && Array.isArray(prev.items) ? prev.items : []

      if (!prev || prevFp !== fingerprint) {
        bootstrapped = true
        newItemIds = []
      } else {
        const prevSet = new Set(
          prevItems.map((x) => String(x?.itemId || '').trim()).filter(Boolean)
        )
        for (const row of stripped) {
          if (!prevSet.has(row.itemId)) newItemIds.push(row.itemId)
        }
      }

      const nextItems =
        kind === 'shop' && !bootstrapped && prevFp === fingerprint && prevItems.length
          ? mergeShopSnapshotLibraryItems(prevItems, stripped)
          : stripped

      const payload = {
        v: 1,
        kind,
        id,
        fingerprint,
        savedAt: new Date().toISOString(),
        items: nextItems
      }
      writeListingSnapshot(db, payload)

      return {
        ok: true,
        bootstrapped,
        newItemIds,
        snapshotPageIdCount: stripped.length,
        snapshotLibraryItemCount: nextItems.length,
        filePath: ''
      }
    } catch (e) {
      console.error('[店铺快照差分]', e)
      return {
        ok: false,
        error: String(e?.message || e),
        bootstrapped: false,
        newItemIds: [],
        snapshotPageIdCount: 0
      }
    }
  })

  ipcMain.handle('sxjk-listing-snapshot-merge-items', async (_e, body = {}) => {
    try {
      const kindRaw = String(body.kind || '').toLowerCase()
      const kind = kindRaw === 'shop' ? 'shop' : 'task'
      const id = String(body.id || '').trim()
      if (!id) {
        return { ok: false, error: 'missing_id', itemCount: 0, addedCount: 0, pageMergedCount: 0 }
      }
      const fingerprint = String(body.fingerprint ?? '').trim()
      if (!fingerprint) {
        return {
          ok: false,
          error: 'missing_fingerprint',
          itemCount: 0,
          addedCount: 0,
          pageMergedCount: 0
        }
      }
      const mode = String(body.mode || 'append').toLowerCase() === 'replace' ? 'replace' : 'append'

      const rawItems = Array.isArray(body.items) ? body.items : []
      const pageRows = []
      const pageSeen = new Set()
      for (const x of rawItems) {
        const row = stripItemForSnapshot(x)
        if (!row || pageSeen.has(row.itemId)) continue
        pageSeen.add(row.itemId)
        pageRows.push(row)
      }

      const db = getSxjkLocalDb()
      let prev = null
      if (mode !== 'replace') {
        prev = readListingSnapshot(db, kind, id)
      }

      const prevFp = prev && typeof prev === 'object' ? String(prev.fingerprint || '').trim() : ''
      const prevItems =
        mode === 'replace' || !prev || prevFp !== fingerprint
          ? []
          : Array.isArray(prev.items)
            ? prev.items
            : []

      const merged = []
      const seen = new Set()
      for (const row of prevItems) {
        const iid = String(row?.itemId || '').trim()
        if (!iid || seen.has(iid)) continue
        seen.add(iid)
        merged.push(row)
      }
      let addedCount = 0
      for (const row of pageRows) {
        if (seen.has(row.itemId)) continue
        seen.add(row.itemId)
        merged.push(row)
        addedCount += 1
      }

      const payload = {
        v: 1,
        kind,
        id,
        fingerprint,
        savedAt: new Date().toISOString(),
        items: merged
      }
      writeListingSnapshot(db, payload)

      return {
        ok: true,
        itemCount: merged.length,
        addedCount,
        pageMergedCount: pageRows.length
      }
    } catch (e) {
      console.error('[店铺快照合并]', e)
      return {
        ok: false,
        error: String(e?.message || e),
        itemCount: 0,
        addedCount: 0,
        pageMergedCount: 0
      }
    }
  })

  ipcMain.handle('sxjk-clear-listing-snapshots', async (_e, payload = {}) => {
    try {
      const scopeRaw = String(payload.scope || 'all').toLowerCase()
      const scope =
        scopeRaw === 'task' || scopeRaw === 'shop' || scopeRaw === 'all' ? scopeRaw : 'all'
      const db = getSxjkLocalDb()
      const before = db.prepare('SELECT COUNT(*) AS c FROM listing_snapshots').get()
      clearListingSnapshots(db, scope)
      const after = db.prepare('SELECT COUNT(*) AS c FROM listing_snapshots').get()
      const cleared = Math.max(0, Number(before?.c || 0) - Number(after?.c || 0))
      return { ok: true, cleared }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), cleared: 0 }
    }
  })

  ipcMain.handle('sxjk-delete-listing-snapshot', async (_e, body = {}) => {
    try {
      const kindRaw = String(body.kind || '').toLowerCase()
      const kind = kindRaw === 'shop' ? 'shop' : 'task'
      const id = String(body.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id' }
      deleteListingSnapshot(getSxjkLocalDb(), kind, id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-remove-listing-snapshot-items', async (_e, body = {}) => {
    try {
      const kindRaw = String(body.kind || '').toLowerCase()
      const kind = kindRaw === 'shop' ? 'shop' : 'task'
      const id = String(body.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id', removed: 0 }
      const removeSet = new Set(
        (Array.isArray(body.itemIds) ? body.itemIds : body.itemId ? [body.itemId] : [])
          .map((x) => String(x || '').trim())
          .filter(Boolean)
      )
      if (!removeSet.size) return { ok: true, removed: 0 }

      const db = getSxjkLocalDb()
      const prev = readListingSnapshot(db, kind, id)
      if (!prev) return { ok: true, removed: 0, notFound: true }
      const prevItems = Array.isArray(prev.items) ? prev.items : []
      const nextItems = prevItems.filter((x) => {
        const iid = String(x?.itemId || '').trim()
        return iid && !removeSet.has(iid)
      })
      const removed = prevItems.length - nextItems.length
      if (!removed) return { ok: true, removed: 0 }

      const payload = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        v: prev?.v ?? 1,
        kind,
        id,
        fingerprint: String(prev?.fingerprint || '').trim(),
        savedAt: new Date().toISOString(),
        items: nextItems
      }
      writeListingSnapshot(db, payload)
      return { ok: true, removed, savedAt: payload.savedAt, itemCount: nextItems.length }
    } catch (e) {
      console.error('[店铺快照删除]', e)
      return { ok: false, error: String(e?.message || e), removed: 0 }
    }
  })

  ipcMain.handle('sxjk-read-listing-snapshot', async (_e, body = {}) => {
    try {
      const kindRaw = String(body.kind || '').toLowerCase()
      const kind = kindRaw === 'shop' ? 'shop' : 'task'
      const id = String(body.id || '').trim()
      if (!id) return { ok: false, error: 'missing_id', notFound: false }
      const data = readListingSnapshot(getSxjkLocalDb(), kind, id)
      if (!data) {
        return { ok: false, error: 'not_found', notFound: true, data: null, filePath: '' }
      }
      return { ok: true, data, filePath: '', notFound: false }
    } catch (e) {
      return { ok: false, error: String(e?.message || e), notFound: false, data: null, filePath: '' }
    }
  })
}
