/**
 * 账号 MTOP Cookie 解析：本机分区为真源（2.0.17）。
 * 有 unb 无 _m_h5_tk 时开窗刷签名；forceRefresh 强制换新。
 */
import { BrowserWindow } from 'electron'
import { readAccountCookieHeader, partitionHasAccountLogin } from './goofish-partition-cookie.js'
import { ensureAccountMh5TkInPartition } from './goofish-partition-mh5-refresh.js'
import { notifyAccountCookiePersisted } from './goofish-account-profile-sync.js'

function resolveMainWindow() {
  try {
    return BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed()) || null
  } catch {
    return null
  }
}

/**
 * @param {string} accountId
 * @param {{ fresh?: boolean, forceRefresh?: boolean, skipRefresh?: boolean, electronDirname?: string }} [opts]
 */
export async function resolveAccountMtopCookieForTask(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) {
    return {
      ok: false,
      cookie: '',
      error: 'need_account_login',
      msg: '缺少账号 id'
    }
  }

  const forceRefresh = opts.forceRefresh === true
  const skipRefresh = opts.skipRefresh === true
  const electronDirname = String(opts.electronDirname || '').trim()
  /** @type {{ ok?: boolean, skipped?: boolean, reason?: string, elapsedMs?: number } | null} */
  let refreshMeta = null

  if (forceRefresh && !skipRefresh) {
    try {
      refreshMeta = await ensureAccountMh5TkInPartition(id, {
        force: true,
        electronDirname
      })
      if (refreshMeta?.ok && !refreshMeta?.skipped) {
        notifyAccountCookiePersisted(resolveMainWindow, id, { source: 'mh5_token_refresh' })
      }
    } catch (e) {
      console.warn('[账号Cookie] forceRefresh mh5', id, e?.message || e)
      refreshMeta = { ok: false, reason: 'error', error: String(e?.message || e) }
    }
  }

  const fresh = opts.fresh === true || forceRefresh
  let acc = await readAccountCookieHeader(id, { fresh })
  const hasLogin = await partitionHasAccountLogin(id)

  if (!acc.ok && hasLogin && !skipRefresh && !forceRefresh) {
    try {
      refreshMeta = await ensureAccountMh5TkInPartition(id, { electronDirname })
      if (refreshMeta?.ok && !refreshMeta?.skipped) {
        notifyAccountCookiePersisted(resolveMainWindow, id, { source: 'mh5_token_refresh' })
      }
      if (refreshMeta?.ok) {
        acc = await readAccountCookieHeader(id, { fresh: true })
      }
    } catch (e) {
      console.warn('[账号Cookie] 缺签名自动刷 mh5', id, e?.message || e)
      refreshMeta = { ok: false, reason: 'error', error: String(e?.message || e) }
    }
  }

  if (!acc.ok) {
    if (hasLogin) {
      return {
        ok: false,
        cookie: '',
        error: 'mh5_refresh_failed_but_unb',
        msg: acc.error || '本机签名未就绪，请到账号管理打开闲鱼页或稍后重试',
        refresh: refreshMeta
      }
    }
    return {
      ok: false,
      cookie: '',
      error: 'need_account_login',
      msg: '账号未登录或 Cookie 不可用',
      refresh: refreshMeta
    }
  }
  return {
    ok: true,
    cookie: String(acc.cookie || '').trim(),
    source: forceRefresh ? 'partition_force_mh5' : 'partition',
    refresh: refreshMeta
  }
}

/**
 * 令牌过期专用：强制刷 mh5 并返回最新 Cookie 头
 * @param {string} accountId
 * @param {{ electronDirname?: string }} [opts]
 */
export async function refreshAccountMh5TokenForExpired(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, cookie: '', error: 'missing_account_id' }
  const r = await resolveAccountMtopCookieForTask(id, {
    forceRefresh: true,
    fresh: true,
    electronDirname: opts.electronDirname
  })
  return {
    ok: r?.ok === true,
    cookie: String(r?.cookie || '').trim(),
    error: r?.error || '',
    msg: r?.msg || '',
    refresh: r?.refresh || null
  }
}
