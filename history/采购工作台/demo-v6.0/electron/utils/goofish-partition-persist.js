/**
 * persist 分区 Cookie 落盘与迁移（对齐工作台：登录态跟分区走，不靠 HTTP 灌 Cookie）。
 */
import { session } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { GOOFISH_EMBED_SHARED_PARTITION } from './goofish-embed-session-sync.js'
import { hasLiveMh5TkInPartition } from './xianyu-goofish-electron-browse-window.js'
import { repersistSessionCookiesWithExpiration } from './xianyu-playwright-cookies-to-electron.js'

function cookieSetUrl(c) {
  const domain = String(c?.domain || '').replace(/^\./, '')
  const path = String(c?.path || '/')
  if (!domain) return 'https://www.goofish.com'
  return `https://${domain}${path.startsWith('/') ? path : `/${path}`}`
}

/** @param {string} partition */
export async function flushPartitionCookieStore(partition) {
  const part = String(partition || '').trim()
  if (!part) return
  try {
    const sess = session.fromPartition(part)
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
  } catch (e) {
    console.warn('[账号分区落盘] 刷盘失败:', part, e?.message || e)
  }
}

/** @param {string} accountId */
export async function flushAccountPartitionStore(accountId) {
  await flushPartitionCookieStore(partitionForListingAccount(accountId))
}

/** 关窗/注入后：会话 Cookie → 持久 Cookie，再 flush 才能跨重启保留 */
export async function repersistAccountPartitionCookiesForDisk(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, updated: 0 }
  const part = partitionForListingAccount(id)
  const sess = session.fromPartition(part)
  const r = await repersistSessionCookiesWithExpiration(sess)
  if (r.updated > 0) {
    await flushPartitionCookieStore(part)
  }
  return r
}

/** @param {string} fromPartition @param {string} toPartition */
export async function copyPartitionCookies(fromPartition, toPartition) {
  const fromPart = String(fromPartition || '').trim()
  const toPart = String(toPartition || '').trim()
  if (!fromPart || !toPart || fromPart === toPart) return { ok: false, copied: 0 }
  const from = session.fromPartition(fromPart)
  const to = session.fromPartition(toPart)
  let list = []
  try {
    list = await from.cookies.get({})
  } catch {
    return { ok: false, copied: 0 }
  }
  let copied = 0
  for (const c of list) {
    const name = String(c?.name || '').trim()
    if (!name) continue
    try {
      await to.cookies.set({
        url: cookieSetUrl(c),
        name,
        value: String(c?.value ?? ''),
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate,
        sameSite: c.sameSite
      })
      copied += 1
    } catch {
      /* */
    }
  }
  await flushPartitionCookieStore(toPart)
  return { ok: copied > 0, copied }
}

/**
 * 升级前登录在 embed_shared；若账号分区空、旧罐有登录态，迁移一次。
 * @param {string} accountId
 */
export async function migrateLegacyEmbedSharedToAccountIfNeeded(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, skipped: true }
  const target = partitionForListingAccount(id)
  if (await hasLiveMh5TkInPartition(target)) {
    return { ok: true, skipped: true, reason: 'target_has_session' }
  }
  if (!(await hasLiveMh5TkInPartition(GOOFISH_EMBED_SHARED_PARTITION))) {
    return { ok: false, skipped: true, reason: 'legacy_empty' }
  }
  const r = await copyPartitionCookies(GOOFISH_EMBED_SHARED_PARTITION, target)
  if (r.ok) {
    console.log('[账号分区落盘] 已从 embed_shared 迁移 Cookie 到账号分区', id)
  }
  return r
}

/** 启动时：把 embed_shared 里残留登录态迁到各账号分区（须在清空 embed_shared 之前调用） */
export async function migrateLegacyEmbedSharedForAllAccounts(accountsDir) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return { ok: false, migrated: 0, reason: 'missing_accounts_dir' }
  if (!(await hasLiveMh5TkInPartition(GOOFISH_EMBED_SHARED_PARTITION))) {
    return { ok: true, migrated: 0, skipped: true, reason: 'legacy_empty' }
  }
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return { ok: false, migrated: 0, reason: 'read_dir_failed' }
  }
  let migrated = 0
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.xianyu-mtop.json') || f === 'accounts-order.json') {
      continue
    }
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const data = JSON.parse(raw)
      const id = String(data?.id || '').trim()
      if (!id) continue
      const r = await migrateLegacyEmbedSharedToAccountIfNeeded(id)
      if (r.ok && !r.skipped) migrated += 1
    } catch {
      /* */
    }
  }
  if (migrated > 0) {
    console.log('[账号分区落盘] 启动已从 embed_shared 迁移', migrated, '个账号分区')
  }
  return { ok: true, migrated }
}

/** @param {string} accountsDir */
export async function flushAllAccountPartitionStores(accountsDir) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.xianyu-mtop.json') || f === 'accounts-order.json') {
      continue
    }
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const data = JSON.parse(raw)
      const id = String(data?.id || '').trim()
      if (id) await flushAccountPartitionStore(id)
    } catch {
      /* */
    }
  }
}
