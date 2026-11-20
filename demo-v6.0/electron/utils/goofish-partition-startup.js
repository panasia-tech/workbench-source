/**
 * 冷启动：迁移旧 embed 分区 → flush → 尽快开窗；mh5 签名预热放后台（2.0.17：本机开窗刷签名）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  migrateLegacyEmbedSharedForAllAccounts,
  flushAccountPartitionStore
} from './goofish-partition-persist.js'
import { partitionHasAccountLogin, cookiesToHeaderFromSession, cookieHeaderHasUnb } from './goofish-partition-cookie.js'
import { applyCookieHeaderStringToElectronPartition } from './xianyu-playwright-cookies-to-electron.js'
import { xianyuMtopSessionPath } from '../ipc/accounts.js'
import { clearLegacyEmbedSharedPartitionOnce } from './goofish-embed-session-sync.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { ensureAccountMh5TkInPartition } from './goofish-partition-mh5-refresh.js'
import { refreshGoofishFeedBrowseWarmupFromDisk } from './goofish-feed-browse-warmup-scheduler.js'
import { hasLiveMh5TkInPartition } from './xianyu-goofish-electron-browse-window.js'
import { session } from 'electron'

let startupFastDone = false
/** @type {Promise<{ ok: boolean, accounts?: number }> | null} */
let startupFastPromise = null

let startupPrepDone = false
/** @type {Promise<{ ok: boolean, accounts?: number }> | null} */
let mh5WarmupPromise = null

export function isPartitionStartupPrepDone() {
  return startupPrepDone
}

export function isPartitionStartupFastDone() {
  return startupFastDone
}

async function listAccountIdsFromDir(accountsDir) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return []
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const ids = []
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.xianyu-mtop.json') || f === 'accounts-order.json') {
      continue
    }
    try {
      const raw = await fs.readFile(join(dir, f), 'utf-8')
      const data = JSON.parse(raw)
      const id = String(data?.id || '').trim()
      if (id) ids.push(id)
    } catch {
      /* */
    }
  }
  return ids
}

/**
 * 分区无 unb 时用 Cookie 头补回登录态（带过期时间写入 + flush，跨重启保留）。
 * 分区已有 unb 时不覆盖。
 * @param {string} accountId
 * @param {string} cookieHeader
 */
async function restorePartitionLoginFromCookieHeader(accountId, cookieHeader) {
  const id = String(accountId || '').trim()
  const header = String(cookieHeader || '').trim()
  if (!id || !cookieHeaderHasUnb(header)) return { ok: false, restored: false, reason: 'no_unb' }
  if (await partitionHasAccountLogin(id)) return { ok: true, restored: false, reason: 'has_login' }
  await applyCookieHeaderStringToElectronPartition(session.fromPartition(partitionForListingAccount(id)), header)
  await flushAccountPartitionStore(id)
  const restored = await partitionHasAccountLogin(id)
  return { ok: restored, restored }
}

/** 本机备份 {id}.xianyu-mtop.json（风控桥接关窗时写入） */
async function restorePartitionLoginFromLocalBackup(accountsDir, accountId) {
  try {
    const raw = await fs.readFile(xianyuMtopSessionPath(accountsDir, accountId), 'utf-8')
    return await restorePartitionLoginFromCookieHeader(accountId, JSON.parse(raw)?.cookieHeader)
  } catch {
    return { ok: false, restored: false, reason: 'no_backup' }
  }
}

/**
 * 开窗前快速路径：迁移 + flush（不打开闲鱼页刷 mh5）
 * @param {string} accountsDir
 */
export async function runAccountPartitionsStartupFast(accountsDir) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return { ok: false, reason: 'missing_accounts_dir' }

  await migrateLegacyEmbedSharedForAllAccounts(dir)
  await clearLegacyEmbedSharedPartitionOnce()

  const ids = await listAccountIdsFromDir(dir)
  for (const id of ids) {
    const hasUnb = await partitionHasAccountLogin(id)
    if (hasUnb) {
      await flushAccountPartitionStore(id)
    } else {
      const r = await restorePartitionLoginFromLocalBackup(dir, id)
      if (r.restored) console.log('[账号分区启动] 分区无登录态，已从本机备份恢复', id)
    }
  }

  startupFastDone = true
  return { ok: true, accounts: ids.length }
}

/**
 * 后台 mh5 预热（逐账号，不阻塞主窗口）：有 unb 无签名时开窗刷 _m_h5_tk
 * @param {string} accountsDir
 * @param {string} electronDirname
 */
export async function runAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname) {
  const dir = String(accountsDir || '').trim()
  if (!dir) return { ok: false, reason: 'missing_accounts_dir' }

  const ids = await listAccountIdsFromDir(dir)
  for (const id of ids) {
    const hasUnb = await partitionHasAccountLogin(id)
    const partition = partitionForListingAccount(id)
    const liveMh5 = await hasLiveMh5TkInPartition(partition)
    let cookieLen = 0
    try {
      const header = String(
        await cookiesToHeaderFromSession(session.fromPartition(partition))
      ).trim()
      cookieLen = header.length
    } catch {
      /* */
    }

    if (hasUnb && !liveMh5) {
      await ensureAccountMh5TkInPartition(id, {
        electronDirname: String(electronDirname || '').trim(),
        force: true
      })
      await flushAccountPartitionStore(id)
    }

    const mh5After = await hasLiveMh5TkInPartition(partition)
    console.log(
      `[账号分区启动] 账号=${id} unb=${hasUnb ? '有' : '无'} mh5=${mh5After ? '有' : '无'} Cookie长度=${cookieLen}`
    )
  }

  startupPrepDone = true
  void refreshGoofishFeedBrowseWarmupFromDisk(dir, {
    electronDirname: String(electronDirname || '').trim()
  })
  return { ok: true, accounts: ids.length }
}

/**
 * mh5 后台预热结束后通知渲染进程做一次批量 syncCookies（强刷后的 token 此时才稳定）
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 * @param {{ accounts?: number }} [payload]
 */
export function notifyAccountsMh5WarmupDone(getMainWindow, payload = {}) {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sxjk-accounts-mh5-warmup-done', {
      accounts: Number(payload?.accounts) || 0,
      at: new Date().toISOString()
    })
  } catch {
    /* */
  }
}

export function ensureAccountPartitionsStartupFast(accountsDir) {
  if (startupFastDone) {
    return Promise.resolve({ ok: true, ready: true })
  }
  if (!startupFastPromise) {
    startupFastPromise = runAccountPartitionsStartupFast(accountsDir).catch((e) => {
      console.warn('[账号分区启动] 快速预热失败', e?.message || e)
      startupFastDone = true
      return { ok: false, error: String(e?.message || e) }
    })
  }
  return startupFastPromise
}

export function ensureAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname) {
  if (startupPrepDone) {
    return Promise.resolve({ ok: true, ready: true })
  }
  if (!mh5WarmupPromise) {
    mh5WarmupPromise = ensureAccountPartitionsStartupFast(accountsDir)
      .then(() => runAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname))
      .catch((e) => {
        console.warn('[账号分区启动] mh5 后台预热失败', e?.message || e)
        startupPrepDone = true
        return { ok: false, error: String(e?.message || e) }
      })
      .finally(() => {
        startupPrepDone = true
      })
  }
  return mh5WarmupPromise
}

/** 完整预热（快速 + mh5），兼容旧调用 */
export function ensureAccountPartitionsStartupPrep(accountsDir, electronDirname) {
  return ensureAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname)
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ accountsDir: string, electronDirname?: string }} opts
 */
export function registerAccountPartitionStartupIPC(ipcMain, opts) {
  const accountsDir = String(opts?.accountsDir || '').trim()
  const electronDirname = String(opts?.electronDirname || '').trim()

  ipcMain.handle('sxjk-accounts-partition-startup-ready', async () => {
    const r = await ensureAccountPartitionsStartupFast(accountsDir)
    void ensureAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname)
    return { ok: r?.ok !== false, ready: true }
  })

  ipcMain.handle('sxjk-accounts-partition-mh5-warmup-ready', async () => {
    const r = await ensureAccountPartitionsStartupMh5Warmup(accountsDir, electronDirname)
    return { ok: r?.ok !== false, ready: true, accounts: Number(r?.accounts) || 0 }
  })

  /** 渲染进程拉到云端 mtop_cookie 后调用：分区无 unb 时补回，并后台刷新 _m_h5_tk */
  ipcMain.handle('account-partition-restore-login', async (_e, body = {}) => {
    const id = String(body?.accountId || body?.id || '').trim()
    if (!id) return { ok: false, restored: false, reason: 'missing_id' }
    try {
      const r = await restorePartitionLoginFromCookieHeader(id, body?.cookieHeader)
      if (r.restored) {
        console.log('[账号分区启动] 分区无登录态，已从云端 Cookie 恢复', id)
        void ensureAccountMh5TkInPartition(id, { electronDirname, force: true })
          .then(() => flushAccountPartitionStore(id))
          .catch(e => console.warn('[账号分区启动] 恢复后刷新 mh5 失败', id, e?.message || e))
      }
      return r
    } catch (e) {
      return { ok: false, restored: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('account-partition-has-login', async (_e, body = {}) => {
    const id = String(body?.accountId || body?.id || '').trim()
    if (!id) return { ok: false, hasLogin: false }
    try {
      const hasLogin = await partitionHasAccountLogin(id)
      return { ok: true, hasLogin }
    } catch {
      return { ok: false, hasLogin: false }
    }
  })
}
