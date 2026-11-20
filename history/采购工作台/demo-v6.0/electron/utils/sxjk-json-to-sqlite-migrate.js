/**
 * 首次启动：把本机 monitoring JSON 迁入 SQLite，校验通过后删除 JSON。
 * 幂等：migrate_meta 已标记则跳过；失败不删文件。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import {
  getMigrateMeta,
  setMigrateMeta,
  replaceAllLogEntries,
  readLogEntries,
  replacePushedItemIds,
  getPushedItemIds,
  replaceSellerPlainMap,
  loadSellerPlainMap,
  writeListingSnapshot,
  LOG_KIND,
  PUSHED_SCOPE
} from './sxjk-local-db.js'

const MIGRATE_VERSION = 'json_to_sqlite_v1'

function safeReadJson(filePath) {
  if (!filePath || !existsSync(filePath)) return { ok: true, missing: true, data: null }
  try {
    const text = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(text)
    return { ok: true, missing: false, data }
  } catch (e) {
    return { ok: false, missing: false, error: String(e?.message || e), data: null }
  }
}

function asArray(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.ids)) return data.ids
  return null
}

/** 日志条目补齐 id 并按 id 去重（保留靠前/较新的） */
function ensureLogEntries(arr) {
  const seen = new Set()
  const out = []
  for (const x of Array.isArray(arr) ? arr : []) {
    if (!x || typeof x !== 'object') continue
    const id = String(x.id || '').trim() || randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id === x.id ? x : { ...x, id })
  }
  return out
}

/**
 * 删除已迁文件；失败则 rename 为 .migrated-bak 以免业务再读。
 * @param {string} filePath
 */
function removeMigratedFile(filePath) {
  if (!filePath || !existsSync(filePath)) return
  try {
    unlinkSync(filePath)
    return
  } catch (e) {
    console.warn('[本机SQL迁移] 删除失败，尝试改名', filePath, e?.message || e)
  }
  try {
    const bak = `${filePath}.migrated-bak`
    if (existsSync(bak)) unlinkSync(bak)
    renameSync(filePath, bak)
  } catch (e2) {
    console.warn('[本机SQL迁移] 改名失败', filePath, e2?.message || e2)
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} metaKey
 * @param {() => { imported: number, sourceCount: number, filePath?: string|null }} run
 */
function migrateOne(db, metaKey, run) {
  const fullKey = `${MIGRATE_VERSION}:${metaKey}`
  if (getMigrateMeta(db, fullKey) === 'done') {
    return { skipped: true, metaKey }
  }
  try {
    const r = run()
    const sourceCount = Number(r?.sourceCount || 0)
    const imported = Number(r?.imported || 0)
    if (sourceCount > 0 && imported < sourceCount) {
      throw new Error(`校验失败 ${metaKey}: source=${sourceCount} imported=${imported}`)
    }
    setMigrateMeta(db, fullKey, 'done')
    if (r?.filePath) removeMigratedFile(r.filePath)
    if (Array.isArray(r?.filePaths)) {
      for (const fp of r.filePaths) removeMigratedFile(fp)
    }
    console.log(`[本机SQL迁移] ${metaKey} ok imported=${imported}`)
    return { skipped: false, metaKey, imported }
  } catch (e) {
    console.error(`[本机SQL迁移] ${metaKey} 失败，保留 JSON`, e?.message || e)
    return { skipped: false, metaKey, error: String(e?.message || e) }
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sxjkPushLogsFile?: string|null,
 *   sxjkPollCheckLogsFile?: string|null,
 *   sxjkGrabLogsFile?: string|null,
 *   sxjkShopPushLogsFile?: string|null,
 *   sxjkPushedItemIdsFile?: string|null,
 *   sxjkShopPushedItemIdsFile?: string|null,
 *   sxjkSellerPlainMapFile?: string|null,
 *   sxjkListingSnapshotsDir?: string|null
 * }} paths
 */
export function migrateSxjkJsonToSqlite(db, paths = {}) {
  const results = []

  results.push(
    migrateOne(db, 'push_logs', () => {
      const filePath = paths.sxjkPushLogsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      const arr = ensureLogEntries(asArray(r.data))
      if (!Array.isArray(asArray(r.data))) throw new Error('push_logs 不是数组')
      replaceAllLogEntries(db, LOG_KIND.push, arr)
      const after = readLogEntries(db, LOG_KIND.push).length
      return { imported: after, sourceCount: arr.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'poll_check_logs', () => {
      const filePath = paths.sxjkPollCheckLogsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      if (!Array.isArray(asArray(r.data))) throw new Error('poll_check_logs 不是数组')
      const arr = ensureLogEntries(asArray(r.data))
      replaceAllLogEntries(db, LOG_KIND.pollCheck, arr)
      const after = readLogEntries(db, LOG_KIND.pollCheck).length
      return { imported: after, sourceCount: arr.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'grab_logs', () => {
      const filePath = paths.sxjkGrabLogsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      if (!Array.isArray(asArray(r.data))) throw new Error('grab_logs 不是数组')
      const arr = ensureLogEntries(asArray(r.data))
      replaceAllLogEntries(db, LOG_KIND.grab, arr)
      const after = readLogEntries(db, LOG_KIND.grab).length
      return { imported: after, sourceCount: arr.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'shop_push_logs', () => {
      const filePath = paths.sxjkShopPushLogsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      if (!Array.isArray(asArray(r.data))) throw new Error('shop_push_logs 不是数组')
      const arr = ensureLogEntries(asArray(r.data))
      replaceAllLogEntries(db, LOG_KIND.shopPush, arr)
      const after = readLogEntries(db, LOG_KIND.shopPush).length
      return { imported: after, sourceCount: arr.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'pushed_item_ids', () => {
      const filePath = paths.sxjkPushedItemIdsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      const arr = asArray(r.data)
      if (!arr) throw new Error('pushed_item_ids 格式无效')
      const ids = arr.map((x) => String(x || '').trim()).filter(Boolean)
      replacePushedItemIds(db, PUSHED_SCOPE.global, ids)
      const after = getPushedItemIds(db, PUSHED_SCOPE.global).length
      return { imported: after, sourceCount: ids.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'shop_pushed_item_ids', () => {
      const filePath = paths.sxjkShopPushedItemIdsFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      const arr = asArray(r.data)
      if (!arr) throw new Error('shop_pushed_item_ids 格式无效')
      const ids = arr.map((x) => String(x || '').trim()).filter(Boolean)
      replacePushedItemIds(db, PUSHED_SCOPE.shop, ids)
      const after = getPushedItemIds(db, PUSHED_SCOPE.shop).length
      return { imported: after, sourceCount: ids.length, filePath }
    })
  )

  results.push(
    migrateOne(db, 'seller_plain_map', () => {
      const filePath = paths.sxjkSellerPlainMapFile || ''
      const r = safeReadJson(filePath)
      if (!r.ok) throw new Error(r.error || 'read_fail')
      if (r.missing) return { imported: 0, sourceCount: 0, filePath: null }
      const entries =
        r.data && typeof r.data.entries === 'object' && !Array.isArray(r.data.entries)
          ? r.data.entries
          : {}
      const sourceCount = Object.keys(entries).length
      replaceSellerPlainMap(db, entries)
      const after = Object.keys(loadSellerPlainMap(db).entries).length
      return { imported: after, sourceCount, filePath }
    })
  )

  results.push(
    migrateOne(db, 'listing_snapshots', () => {
      const dir = String(paths.sxjkListingSnapshotsDir || '').trim()
      if (!dir || !existsSync(dir)) {
        return { imported: 0, sourceCount: 0, filePaths: [] }
      }
      const names = readdirSync(dir).filter((f) => {
        if (!f.endsWith('.json')) return false
        if (f.includes('.tmp')) return false
        if (f.includes('.migrated-bak')) return false
        return /^(task|shop)-.+\.json$/i.test(f)
      })
      /** @type {string[]} */
      const filePaths = []
      let imported = 0
      for (const name of names) {
        const fp = join(dir, name)
        const r = safeReadJson(fp)
        if (!r.ok || r.missing || !r.data || typeof r.data !== 'object') {
          throw new Error(`snapshot 读取失败: ${name} ${r.error || ''}`)
        }
        const kindRaw = String(r.data.kind || '').toLowerCase()
        let kind = kindRaw === 'shop' ? 'shop' : kindRaw === 'task' ? 'task' : ''
        if (!kind) {
          if (name.startsWith('shop-')) kind = 'shop'
          else if (name.startsWith('task-')) kind = 'task'
        }
        const id = String(r.data.id || '').trim() || basename(name, '.json').replace(/^(task|shop)-/i, '')
        if (!kind || !id) throw new Error(`snapshot 缺 kind/id: ${name}`)
        const payload = {
          v: 1,
          kind,
          id,
          fingerprint: String(r.data.fingerprint || ''),
          savedAt: String(r.data.savedAt || new Date().toISOString()),
          items: Array.isArray(r.data.items) ? r.data.items : []
        }
        writeListingSnapshot(db, payload)
        imported += 1
        filePaths.push(fp)
      }
      return { imported, sourceCount: names.length, filePaths }
    })
  )

  const failed = results.filter((x) => x?.error)
  if (failed.length) {
    console.warn(`[本机SQL迁移] 部分失败 ${failed.length}/${results.length}`, failed.map((f) => f.metaKey))
  } else {
    console.log('[本机SQL迁移] 全部完成')
  }
  return { ok: failed.length === 0, results }
}
