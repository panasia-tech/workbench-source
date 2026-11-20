/**
 * 账号分区 _m_h5_tk 静默刷新：登录态（unb）仍在但 MTOP 签名过期时，后台打开闲鱼主页下发新 token。
 */
import { session } from 'electron'
import { GOOFISH_HOME_URL } from '../config/goofish.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import {
  openGoofishUrlInAppBrowseWindow,
  hasLiveMh5TkInPartition,
  closeGoofishBrowseWindowAndWait
} from './xianyu-goofish-electron-browse-window.js'
import { cookieHeaderHasUnb, cookiesToHeaderFromSession } from './goofish-partition-cookie.js'
import { flushAccountPartitionStore } from './goofish-partition-persist.js'
import { GOOFISH_COOKIE_HEADER_INJECT_URLS } from './xianyu-playwright-cookies-to-electron.js'

/** 单账号软刷最小间隔（强制刷不受限）；对齐 2.0.17 */
const MIN_INTERVAL_MS = 180_000
const DEFAULT_TIMEOUT_MS = 25_000
const POLL_INTERVAL_MS = 800

/** @type {Map<string, number>} */
const lastRefreshAtByAccount = new Map()
/** 非强制 / 强制 分开，避免 force 复用「已有 cookie 就 skipped」的 Promise */
/** @type {Map<string, Promise<{ ok: boolean, skipped?: boolean, reason?: string, elapsedMs?: number, error?: string, forced?: boolean }>>} */
const inflightSoftByAccount = new Map()
/** @type {Map<string, Promise<{ ok: boolean, skipped?: boolean, reason?: string, elapsedMs?: number, error?: string, forced?: boolean }>>} */
const inflightForceByAccount = new Map()

const MH5_COOKIE_NAMES = ['_m_h5_tk', '_m_h5_tk_enc']

function isSilentRefreshEnabled() {
  const v = String(process.env.XIANYU_MH5_SILENT_REFRESH ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

function refreshTimeoutMs() {
  const n = parseInt(String(process.env.XIANYU_MH5_SILENT_REFRESH_TIMEOUT_MS || '25000'), 10)
  return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_TIMEOUT_MS
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function mh5TkFromCookieHeader(header) {
  const m = String(header || '').match(/(?:^|;\s*)_m_h5_tk=([^;]+)/i)
  return m ? String(m[1] || '').trim() : ''
}

/** @param {string} accountId */
async function partitionCookieHeader(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return ''
  try {
    const sess = session.fromPartition(partitionForListingAccount(id))
    return String(await cookiesToHeaderFromSession(sess)).trim()
  } catch {
    return ''
  }
}

/**
 * 强制刷新前清掉旧签名 Cookie，逼页面重新下发（否则过期值仍占着会「假成功」）
 * @param {string} partition
 */
async function clearMh5CookiesInPartition(partition) {
  try {
    const sess = session.fromPartition(partition)
    for (const url of GOOFISH_COOKIE_HEADER_INJECT_URLS) {
      for (const name of MH5_COOKIE_NAMES) {
        try {
          await sess.cookies.remove(url, name)
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* */
  }
}

/** @param {string} partition @param {number} timeoutMs */
async function waitForLiveMh5(partition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await hasLiveMh5TkInPartition(partition)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * force 刷新：等出现非空且与 prev 不同的 _m_h5_tk
 * @param {string} accountId
 * @param {string} prevValue 清 cookie 前的旧值；清后 prev 视为空也可
 * @param {number} timeoutMs
 */
async function waitForMh5ValueChanged(accountId, prevValue, timeoutMs) {
  const prev = String(prevValue || '').trim()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cur = mh5TkFromCookieHeader(await partitionCookieHeader(accountId))
    if (cur && cur !== prev) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * @param {string} accountId
 * @param {{ electronDirname?: string, force?: boolean }} [opts]
 */
async function runEnsureAccountMh5TkInPartition(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, reason: 'missing_account_id' }
  if (!isSilentRefreshEnabled()) return { ok: false, reason: 'disabled' }

  const force = opts.force === true
  const partition = partitionForListingAccount(id)
  const prevMh5 = mh5TkFromCookieHeader(await partitionCookieHeader(id))

  // 非强制：分区已有未过期 cookie 则跳过（注意：cookie 未删但 token 值可能已对 MTOP 失效）
  if (!force && (await hasLiveMh5TkInPartition(partition))) {
    return { ok: true, skipped: true }
  }

  const header = await partitionCookieHeader(id)
  if (!cookieHeaderHasUnb(header)) {
    return { ok: false, reason: 'need_login' }
  }

  const now = Date.now()
  const lastAt = lastRefreshAtByAccount.get(id) || 0
  if (!force && now - lastAt < MIN_INTERVAL_MS) {
    return { ok: false, reason: 'cooldown' }
  }

  const started = Date.now()
  const electronDirname = String(opts.electronDirname || '').trim()
  /** @type {import('electron').BrowserWindow | null | undefined} */
  let openedWin = null

  try {
    // 强制：先清旧 _m_h5_tk，再开页，必须等到新值
    if (force) {
      await clearMh5CookiesInPartition(partition)
      await flushAccountPartitionStore(id)
    }

    const openRes = await openGoofishUrlInAppBrowseWindow({
      url: GOOFISH_HOME_URL,
      browserKey: id,
      sessionPartition: partition,
      taskWindow: true,
      allowEmptyCookieHeader: true,
      preferExistingSession: false,
      silentBackground: true,
      electronDirname
    })
    if (!openRes.ok) {
      lastRefreshAtByAccount.set(id, Date.now())
      console.warn('[签名凭证刷新] 失败 账号=%s 原因=打开失败 %s', id, openRes.error || '')
      return { ok: false, reason: 'open_failed', error: openRes.error }
    }

    openedWin = openRes.window
    const got = force
      ? await waitForMh5ValueChanged(id, prevMh5, refreshTimeoutMs())
      : await waitForLiveMh5(partition, refreshTimeoutMs())

    if (openedWin && !openedWin.isDestroyed()) {
      try {
        openedWin.close()
      } catch {
        /* */
      }
      await closeGoofishBrowseWindowAndWait(openedWin, 3000).catch(() => {})
    }

    await flushAccountPartitionStore(id)
    lastRefreshAtByAccount.set(id, Date.now())

    const elapsedMs = Date.now() - started
    const afterMh5 = mh5TkFromCookieHeader(await partitionCookieHeader(id))

    if (force) {
      if (afterMh5 && afterMh5 !== prevMh5) {
        console.log('[签名凭证刷新] 成功 账号=%s 强制=是 耗时毫秒=%d', id, elapsedMs)
        return { ok: true, elapsedMs, forced: true }
      }
      console.warn(
        '[签名凭证刷新] 失败 账号=%s 原因=强制刷新后 token 未换新 耗时毫秒=%d',
        id,
        elapsedMs
      )
      return { ok: false, reason: 'token_unchanged', elapsedMs, forced: true }
    }

    if (got || afterMh5) {
      console.log('[签名凭证刷新] 成功 账号=%s 强制=否 耗时毫秒=%d', id, elapsedMs)
      return { ok: true, elapsedMs, forced: false }
    }

    console.warn('[签名凭证刷新] 失败 账号=%s 原因=超时 耗时毫秒=%d', id, elapsedMs)
    return { ok: false, reason: 'timeout', elapsedMs }
  } catch (e) {
    lastRefreshAtByAccount.set(id, Date.now())
    if (openedWin && !openedWin.isDestroyed()) {
      try {
        openedWin.close()
      } catch {
        /* */
      }
    }
    const msg = String(e?.message || e)
    console.warn('[签名凭证刷新] 失败 账号=%s 原因=异常 %s', id, msg)
    return { ok: false, reason: 'error', error: msg }
  }
}

/**
 * @param {string} accountId
 * @param {{ electronDirname?: string, force?: boolean }} [opts]
 */
export async function ensureAccountMh5TkInPartition(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, reason: 'missing_account_id' }

  const force = opts.force === true
  const map = force ? inflightForceByAccount : inflightSoftByAccount
  const existing = map.get(id)
  if (existing) return existing

  const p = runEnsureAccountMh5TkInPartition(id, opts).finally(() => {
    map.delete(id)
  })
  map.set(id, p)
  return p
}
