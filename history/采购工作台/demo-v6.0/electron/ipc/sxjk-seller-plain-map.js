/**
 * 闲鱼上新：本地「加密卖家标识 → 明文 userId」映射 — SQLite
 */
import {
  getSxjkLocalDb,
  loadSellerPlainMap,
  upsertSellerPlainMapEntry,
  deleteSellerPlainMapKeys
} from '../utils/sxjk-local-db.js'

const MAX_KEY_LEN = 256
const MAX_NICK_LEN = 120
const MAX_AVATAR_LEN = 512
const MAX_ENTRIES = 6000
const TRIM_TARGET = 5200

function isPlainNumericSellerId(s) {
  const t = String(s ?? '').trim()
  if (!t || t.length > 20) return false
  return /^\d{6,20}$/.test(t)
}

function normalizeSellerKey(raw) {
  const k = String(raw ?? '').trim().slice(0, MAX_KEY_LEN)
  if (!k || isPlainNumericSellerId(k)) return ''
  return k
}

function normalizePutBody(body) {
  const sellerKey = normalizeSellerKey(body?.sellerKey)
  const plainUserId = String(body?.plainUserId ?? '').trim()
  const nick = String(body?.nick ?? '').trim().slice(0, MAX_NICK_LEN)
  const avatar = String(body?.avatar ?? '').trim().slice(0, MAX_AVATAR_LEN)
  if (!sellerKey) return { ok: false, error: '缺少有效的卖家映射键（加密 id）' }
  if (!isPlainNumericSellerId(plainUserId)) return { ok: false, error: 'plainUserId 须为 6～20 位数字' }
  return { ok: true, sellerKey, plainUserId, nick, avatar }
}

/** @type {{ v: number, entries: Record<string, { plainUserId: string, nick?: string, avatar?: string, updatedAt: string }> } | null} */
let memory = null
let loadPromise = null
let writeChain = Promise.resolve()

async function ensureLoaded() {
  if (memory) return memory
  if (!loadPromise) {
    loadPromise = Promise.resolve().then(() => {
      memory = loadSellerPlainMap(getSxjkLocalDb())
      return memory
    })
  }
  return loadPromise
}

function trimEntriesIfNeeded(entries) {
  const keys = Object.keys(entries)
  if (keys.length <= MAX_ENTRIES) return []
  const scored = keys.map((k) => ({
    k,
    t: String(entries[k]?.updatedAt || '').trim() || '1970-01-01T00:00:00.000Z'
  }))
  scored.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  const drop = Math.max(0, keys.length - TRIM_TARGET)
  /** @type {string[]} */
  const dropped = []
  for (let i = 0; i < drop && i < scored.length; i++) {
    delete entries[scored[i].k]
    dropped.push(scored[i].k)
  }
  return dropped
}

export function registerSxjkSellerPlainMapIPC(ipcMain) {
  ipcMain.handle('sxjk-seller-plain-map-batch-lookup', async (_e, body = {}) => {
    try {
      const raw = Array.isArray(body?.sellerKeys) ? body.sellerKeys : []
      const MAX_BATCH = 100
      const keys = [
        ...new Set(raw.map((k) => normalizeSellerKey(k)).filter(Boolean))
      ].slice(0, MAX_BATCH)
      const data = await ensureLoaded()
      /** @type {Record<string, string>} */
      const bySellerKey = {}
      /** @type {Record<string, string>} */
      const nickBySellerKey = {}
      for (const sellerKey of keys) {
        const row = data.entries[sellerKey]
        const plainUserId = String(row?.plainUserId || '').trim()
        const nick = String(row?.nick || '').trim().slice(0, MAX_NICK_LEN)
        if (isPlainNumericSellerId(plainUserId)) {
          bySellerKey[sellerKey] = plainUserId
        }
        if (nick) nickBySellerKey[sellerKey] = nick
      }
      return { ok: true, bySellerKey, nickBySellerKey }
    } catch (e) {
      return { ok: false, bySellerKey: {}, nickBySellerKey: {}, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-seller-plain-map-lookup', async (_e, body = {}) => {
    try {
      const sellerKey = normalizeSellerKey(body?.sellerKey)
      if (!sellerKey) return { ok: true, hit: false, plainUserId: '' }
      const data = await ensureLoaded()
      const row = data.entries[sellerKey]
      const plainUserId = String(row?.plainUserId || '').trim()
      if (!isPlainNumericSellerId(plainUserId)) return { ok: true, hit: false, plainUserId: '' }
      return {
        ok: true,
        hit: true,
        plainUserId,
        nick: String(row?.nick || '').trim().slice(0, MAX_NICK_LEN),
        avatar: String(row?.avatar || '').trim().slice(0, MAX_AVATAR_LEN)
      }
    } catch (e) {
      return { ok: false, hit: false, plainUserId: '', error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sxjk-seller-plain-map-put', async (_e, body = {}) => {
    const norm = normalizePutBody(body)
    if (!norm.ok) return norm
    const { sellerKey, plainUserId, nick, avatar } = norm
    writeChain = writeChain.then(async () => {
      await ensureLoaded()
      if (!memory) memory = { v: 1, entries: {} }
      const updatedAt = new Date().toISOString()
      memory.entries[sellerKey] = {
        plainUserId,
        ...(nick ? { nick } : {}),
        ...(avatar ? { avatar } : {}),
        updatedAt
      }
      const dropped = trimEntriesIfNeeded(memory.entries)
      const db = getSxjkLocalDb()
      upsertSellerPlainMapEntry(db, {
        sellerKey,
        plainUserId,
        nick,
        avatar,
        updatedAt
      })
      if (dropped.length) deleteSellerPlainMapKeys(db, dropped)
    })
    try {
      await writeChain
      return { ok: true }
    } catch (e) {
      console.error('[卖家明文映射] 写入失败', e)
      return { ok: false, error: String(e?.message || e) }
    }
  })
}
