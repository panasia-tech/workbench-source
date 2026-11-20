/**
 * 从 Electron persist 分区读取 Cookie（与工作台多开一致，不读磁盘 JSON）。
 */
import { session } from 'electron'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { GOOFISH_COOKIE_HEADER_INJECT_URLS } from './xianyu-playwright-cookies-to-electron.js'
import { headerHasMh5Tk } from './xianyu-goofish-open-session.js'
import { flushAccountPartitionStore } from './goofish-partition-persist.js'

const COOKIE_URLS = GOOFISH_COOKIE_HEADER_INJECT_URLS
/** @param {import('electron').Session} sess */
export async function cookiesToHeaderFromSession(sess) {
  if (!sess?.cookies) return ''
  try {
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
  } catch {
    /* */
  }
  const list = await sess.cookies.get({})
  if (Array.isArray(list) && list.length) {
    const preferLongerName = (n) => {
      const x = String(n || '').trim().toLowerCase()
      return (
        x === 'x5sec' ||
        x === 'x5sectag' ||
        x === '_tb_token_' ||
        x === 'cookie2' ||
        x === 'tfstk' ||
        x === 'cna' ||
        x === 'unb'
      )
    }
    /** _m_h5_tk 打 h5api.m.goofish.com：必须优先 goofish 域，勿被淘宝域旧 token 盖掉 */
    const isMh5Name = (n) => {
      const x = String(n || '').trim().toLowerCase()
      return x === '_m_h5_tk' || x === '_m_h5_tk_enc'
    }
    /** x5sec / 过码相关：与 mh5 一样优先 goofish，勿被淘宝域旧值或「更长」误盖 */
    const isGoofishPreferName = (n) => {
      const x = String(n || '').trim().toLowerCase()
      return x === 'x5sec' || x === 'x5sectag' || isMh5Name(x)
    }
    const domainScore = (c) => {
      const d = String(c?.domain || '').toLowerCase()
      const name = String(c?.name || '').trim().toLowerCase()
      let s = 0
      if (isGoofishPreferName(name)) {
        if (d.includes('goofish')) s += 10
        else if (d.includes('taobao') || d.includes('tmall')) s += 1
        return s
      }
      if (d.includes('goofish')) s += 4
      if (d.includes('taobao') || d.includes('tmall')) s += 1
      return s
    }
    const byName = new Map()
    for (const c of list) {
      const name = String(c?.name || '').trim()
      if (!name) continue
      const value = String(c?.value ?? '')
      const prev = byName.get(name)
      const len = value.length
      const dom = domainScore(c)
      if (!prev) {
        byName.set(name, { value, len, dom })
        continue
      }
      if (isGoofishPreferName(name)) {
        if (dom > prev.dom || (dom === prev.dom && len > prev.len)) {
          byName.set(name, { value, len, dom })
        }
        continue
      }
      if (preferLongerName(name) && len > prev.len && dom >= prev.dom) {
        byName.set(name, { value, len, dom })
        continue
      }
      if (len > prev.len || (len === prev.len && dom > prev.dom)) {
        byName.set(name, { value, len, dom })
      }
    }
    return [...byName.entries()].map(([k, v]) => `${k}=${v.value}`).join('; ')
  }
  const map = new Map()
  for (const url of COOKIE_URLS) {
    try {
      const partial = await sess.cookies.get({ url })
      for (const c of partial) {
        map.set(c.name, c.value)
      }
    } catch {
      /* */
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** @param {string} accountId @param {{ fresh?: boolean }} [opts] */
export async function readAccountCookieHeader(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, cookie: '', error: 'missing_account_id' }
  try {
    if (opts.fresh === true) {
      await flushAccountPartitionStore(id)
    }
    const sess = session.fromPartition(partitionForListingAccount(id))
    const cookie = String(await cookiesToHeaderFromSession(sess)).trim()
    if (!headerHasMh5Tk(cookie)) {
      return {
        ok: false,
        cookie: '',
        error: '暂未从嵌入页读到可用登录凭证，请到账号管理打开嵌入页'
      }
    }
    return { ok: true, cookie, source: 'partition', accountId: id }
  } catch (e) {
    return { ok: false, cookie: '', error: String(e?.message || e) }
  }
}

/** @param {string} accountId */
export async function partitionHasMh5Tk(accountId) {
  const r = await readAccountCookieHeader(accountId)
  return r.ok && headerHasMh5Tk(r.cookie)
}

/** 分区是否仍有账号登录态（unb），不要求 _m_h5_tk 有效 */
export async function partitionHasAccountLogin(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return false
  try {
    const sess = session.fromPartition(partitionForListingAccount(id))
    const cookie = String(await cookiesToHeaderFromSession(sess)).trim()
    return cookieHeaderHasUnb(cookie)
  } catch {
    return false
  }
}

export function cookieHeaderHasUnb(header) {
  return /(?:^|;\s*)unb=/i.test(String(header || ''))
}

/** 从 Cookie 头取出 x5sec 值 */
export function pickX5secFromCookieHeader(cookieHeader) {
  const re = /(?:^|;\s*)x5sec=([^;]+)/i
  const match = String(cookieHeader || '').match(re)
  if (!match?.[1]) return ''
  try {
    return decodeURIComponent(match[1].trim())
  } catch {
    return match[1].trim()
  }
}

/**
 * 用新 x5sec 覆盖账号分区里的旧值并 flush 落盘（过码后调用）。
 * @param {string} accountId
 * @param {string} cookieHeader 含 x5sec 的 Cookie 头
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
export async function replaceX5secInAccountPartition(accountId, cookieHeader) {
  const id = String(accountId || '').trim()
  const x5sec = pickX5secFromCookieHeader(cookieHeader)
  if (!id || !x5sec) return { ok: false, skipped: true }

  const partition = partitionForListingAccount(id)
  try {
    const sess = session.fromPartition(partition)
    const nowSec = Math.floor(Date.now() / 1000)
    const expirationDate = nowSec + 365 * 24 * 3600
    /** 先清各 origin 上的旧 x5sec，再写入 .goofish.com 域 */
    const clearUrls = [
      'https://www.goofish.com',
      'https://goofish.com',
      'https://m.goofish.com',
      'https://h5api.m.goofish.com',
      'https://seller.goofish.com'
    ]
    for (const url of clearUrls) {
      try {
        await sess.cookies.remove(url, 'x5sec')
      } catch {
        /* */
      }
    }
    await sess.cookies.set({
      url: 'https://www.goofish.com',
      name: 'x5sec',
      value: x5sec,
      domain: '.goofish.com',
      path: '/',
      secure: true,
      expirationDate
    })
    /** h5api 主机再写一份 host-only，避免个别请求只认子域 */
    try {
      await sess.cookies.set({
        url: 'https://h5api.m.goofish.com',
        name: 'x5sec',
        value: x5sec,
        path: '/',
        secure: true,
        expirationDate
      })
    } catch {
      /* */
    }
    await flushAccountPartitionStore(id)
    console.log('[账号分区] 已用过码 x5sec 覆盖分区', id, `len=${x5sec.length}`)
    return { ok: true }
  } catch (e) {
    const error = String(e?.message || e)
    console.warn('[账号分区] 写入 x5sec 失败', id, error)
    return { ok: false, error }
  }
}

/** @param {string} accountId @param {{ requireUnb?: boolean, fresh?: boolean }} [opts] */
export async function readAccountCookieForApi(accountId, opts = {}) {
  const r = await readAccountCookieHeader(accountId, opts)
  if (!r.ok) return r
  if (opts.requireUnb && !cookieHeaderHasUnb(r.cookie)) {
    return {
      ok: false,
      cookie: r.cookie,
      error: `账号分区 Cookie 缺少 unb，请在嵌入页完成账号登录`
    }
  }
  return r
}

/** @param {string} partition */
export async function readCookieHeaderFromPartition(partition) {
  const part = String(partition || '').trim()
  if (!part) return ''
  try {
    return String(await cookiesToHeaderFromSession(session.fromPartition(part))).trim()
  } catch {
    return ''
  }
}
