/**
 * 按账号循环后台强刷 _m_h5_tk（清旧签名 → 开闲鱼页 → 等新值）。
 * 每轮结束后再等约 10 分钟；账号之间错开几秒，避免同时开窗。
 */
import { BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { partitionHasAccountLogin, readAccountCookieHeader } from './goofish-partition-cookie.js'
import { ensureAccountMh5TkInPartition } from './goofish-partition-mh5-refresh.js'
import { isUserGoofishBrowseWindowActive } from './xianyu-goofish-electron-browse-window.js'
import { getEmbedSharedPartitionActiveAccountId } from './goofish-embed-session-sync.js'
import { verifyGoofishMtopWithUserPageNav } from './xianyu-goofish-mtop-verify.js'

const ACCOUNTS_ORDER_FILE = 'accounts-order.json'
const LOOP_INTERVAL_MS = 600_000
const STAGGER_MS = 4000

/** @type {Map<string, { token: symbol, nextAt: number }>} */
const loopsByAccountId = new Map()
/** @type {Set<string>} */
const runningAccountIds = new Set()

let schedulerElectronDirname = ''
let schedulerAccountsDir = ''

export function stopAccountFeedBrowseLoop(accountId) {
  loopsByAccountId.delete(String(accountId || '').trim())
}

/** @deprecated 兼容旧调用 */
export function clearAccountTimer(accountId) {
  stopAccountFeedBrowseLoop(accountId)
}

export function stopAllGoofishFeedBrowseWarmupTimers() {
  loopsByAccountId.clear()
}

function notifyCookiePersisted(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return
  try {
    const win = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed())
    if (!win) return
    win.webContents.send('sxjk-account-cookie-persisted', {
      accountId: id,
      source: 'mh5_force_interval',
      at: new Date().toISOString()
    })
  } catch {
    /* */
  }
}

async function tickAccount(accountId) {
  const id = String(accountId || '').trim()
  if (!id || runningAccountIds.has(id)) return
  if (isUserGoofishBrowseWindowActive(id)) {
    console.log('[账号签名强刷] 跳过：用户正在浏览', id)
    return
  }
  if (getEmbedSharedPartitionActiveAccountId() === id) {
    console.log('[账号签名强刷] 跳过：嵌入页正在使用该账号', id)
    return
  }
  if (!(await partitionHasAccountLogin(id))) {
    const expired = await readAccountExpiredFlag(id)
    console.log(
      '[账号签名强刷] 跳过：分区无 unb',
      id,
      expired ? '（已过期，请重新登录）' : ''
    )
    return
  }

  runningAccountIds.add(id)
  try {
    const r = await ensureAccountMh5TkInPartition(id, {
      force: true,
      electronDirname: schedulerElectronDirname
    })
    if (r?.ok && !r?.skipped) {
      notifyCookiePersisted(id)
      console.log('[账号签名强刷] 成功', id, `耗时毫秒=${r.elapsedMs || 0}`)
      await tryRecoverExpiredAfterMh5(id)
    } else {
      console.warn(
        '[账号签名强刷] 未完成',
        id,
        String(r?.reason || r?.error || 'unknown').slice(0, 120)
      )
    }
  } catch (e) {
    console.warn('[账号签名强刷] 本轮失败', id, e?.message || e)
  } finally {
    runningAccountIds.delete(id)
  }
}

async function runAccountFeedBrowseLoop(accountId, token, initialDelayMs = 0) {
  const id = String(accountId || '').trim()
  if (!id) return
  if (initialDelayMs > 0) {
    const cur = loopsByAccountId.get(id)
    if (cur?.token === token) {
      loopsByAccountId.set(id, { token, nextAt: Date.now() + initialDelayMs })
    }
    await sleep(initialDelayMs)
  }
  while (loopsByAccountId.get(id)?.token === token) {
    const cur = loopsByAccountId.get(id)
    if (cur?.token === token) {
      loopsByAccountId.set(id, { token, nextAt: 0 })
    }
    await tickAccount(id)
    if (loopsByAccountId.get(id)?.token !== token) break
    const nextAt = Date.now() + LOOP_INTERVAL_MS
    const after = loopsByAccountId.get(id)
    if (after?.token === token) {
      loopsByAccountId.set(id, { token, nextAt })
    }
    await sleep(LOOP_INTERVAL_MS)
  }
}

function startAccountFeedBrowseLoop(accountId, initialDelayMs = 0) {
  const id = String(accountId || '').trim()
  if (!id) return
  const token = Symbol('goofish-feed-browse-loop')
  loopsByAccountId.set(id, { token, nextAt: Date.now() + Math.max(0, initialDelayMs) })
  void runAccountFeedBrowseLoop(id, token, initialDelayMs)
}

/** 给账号页倒计时：下一轮最早唤醒时间 */
export function getMh5ForceRefreshSchedule() {
  let nextAt = 0
  let running = 0
  for (const [id, st] of loopsByAccountId) {
    if (runningAccountIds.has(id)) running += 1
    const at = Number(st?.nextAt) || 0
    if (at > 0 && (!nextAt || at < nextAt)) nextAt = at
  }
  return {
    ok: true,
    nextAt,
    running: running > 0,
    intervalMs: LOOP_INTERVAL_MS,
    accountCount: loopsByAccountId.size
  }
}

/**
 * @param {string} _accountsDir
 * @param {string[]} enabledAccountIds
 * @param {{ electronDirname?: string }} [opts]
 */
export function syncGoofishFeedBrowseWarmupLoops(_accountsDir, enabledAccountIds, opts = {}) {
  const dir = String(_accountsDir || '').trim()
  if (dir) schedulerAccountsDir = dir
  if (opts.electronDirname != null) {
    schedulerElectronDirname = String(opts.electronDirname || '').trim()
  }

  const want = new Set(
    (Array.isArray(enabledAccountIds) ? enabledAccountIds : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  )

  for (const id of [...loopsByAccountId.keys()]) {
    if (!want.has(id)) stopAccountFeedBrowseLoop(id)
  }

  let staggerIdx = 0
  for (const id of want) {
    if (loopsByAccountId.has(id)) continue
    startAccountFeedBrowseLoop(id, LOOP_INTERVAL_MS + staggerIdx * STAGGER_MS)
    staggerIdx += 1
  }
}

async function readAccountJsonSafe(accountId) {
  const dir = String(schedulerAccountsDir || '').trim()
  const id = String(accountId || '').trim()
  if (!dir || !id) return null
  try {
    const raw = await fs.readFile(join(dir, `${id}.json`), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readAccountExpiredFlag(accountId) {
  const data = await readAccountJsonSafe(accountId)
  return data?.loginCheckSessionValid === false
}

/** 强刷成功后：过期号补一次 nav，能恢复才标回已登录 */
async function tryRecoverExpiredAfterMh5(accountId) {
  const id = String(accountId || '').trim()
  const dir = String(schedulerAccountsDir || '').trim()
  if (!id || !dir) return
  if (!(await readAccountExpiredFlag(id))) return
  const snap = await readAccountCookieHeader(id, { fresh: true })
  if (!snap.ok) {
    console.log('[账号签名强刷] 过期仍无效', id, String(snap.error || 'no_cookie').slice(0, 80))
    return
  }
  const nav = await verifyGoofishMtopWithUserPageNav(snap.cookie)
  if (nav.ok !== true) {
    console.log('[账号签名强刷] 过期仍无效', id, String(nav.error || 'nav_fail').slice(0, 80))
    return
  }
  try {
    const { applyAccountMtopLoginVerifyResult } = await import('../ipc/accounts.js')
    await applyAccountMtopLoginVerifyResult(dir, id, {
      sessionValid: true,
      ...(nav.displayName ? { goofishNickname: nav.displayName } : {}),
      ...(nav.avatar ? { goofishAvatar: nav.avatar } : {})
    })
    console.log('[账号签名强刷] 过期已恢复', id)
    notifySessionRecovered(id)
  } catch (e) {
    console.warn('[账号签名强刷] 过期恢复写回失败', id, e?.message || e)
  }
}

function notifySessionRecovered(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return
  try {
    const win = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed())
    if (!win) return
    win.webContents.send('sxjk-account-profile-synced', {
      accountId: id,
      sessionVerified: true,
      source: 'mh5_force_recover',
      at: new Date().toISOString()
    })
  } catch {
    /* */
  }
}

async function listRefreshableAccountIds(accountsDir) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return []
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  /** @type {{ id: string, expired: boolean }[]} */
  const parsed = []
  for (const f of names) {
    if (!f.endsWith('.json') || f === ACCOUNTS_ORDER_FILE || f.endsWith('.xianyu-mtop.json')) continue
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const data = JSON.parse(raw)
      const id = String(data?.id || '').trim()
      if (!id) continue
      parsed.push({ id, expired: data?.loginCheckSessionValid === false })
    } catch {
      /* */
    }
  }
  const out = []
  let expiredQueued = 0
  let expiredNoUnb = 0
  for (const row of parsed) {
    try {
      const hasUnb = await partitionHasAccountLogin(row.id)
      if (hasUnb) {
        out.push(row.id)
        if (row.expired) expiredQueued += 1
        continue
      }
      if (row.expired) expiredNoUnb += 1
    } catch {
      /* */
    }
  }
  console.log(
    '[账号签名强刷] 已排程',
    out.length,
    '个（含过期',
    expiredQueued,
    '个）',
    expiredNoUnb ? `；过期且无 unb 跳过 ${expiredNoUnb} 个，需重新登录` : ''
  )
  return out
}

export async function refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, opts = {}) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return
  schedulerAccountsDir = dir
  try {
    const enabled = await listRefreshableAccountIds(dir)
    syncGoofishFeedBrowseWarmupLoops(dir, enabled, opts)
  } catch (e) {
    console.warn('[账号签名强刷] 从磁盘刷新循环失败', e?.message || e)
  }
}
