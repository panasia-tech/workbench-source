/**
 * 秒拍/锁单默认收货地址：主进程全局缓存（手动锁单、任务轮询、钉钉 Socket 均经 IPC 共用）
 * 按账号映射 deliverId；TTL 1 小时，有效期内直接读缓存，不请求地址接口。
 */

export const MIAOPAI_DEFAULT_DELIVER_ID_CACHE_TTL_MS = 60 * 60 * 1000

/** @type {Map<string, { deliverId: string, cookie: string, fetchedAt: number }>} */
const cacheByAccount = new Map()
/** @type {Map<string, Promise<{ ok: boolean, deliverId: string, error: string, cookie: string, fromCache?: boolean }>>} */
const inflightByAccount = new Map()

function normalizeAccountId(accountId) {
  return String(accountId || '').trim()
}

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

function mergeCookie(current, updated) {
  const next = String(updated || '').trim()
  return next || normalizeCookieHeader(current)
}

function isExpired(entry) {
  if (!entry) return true
  return Date.now() - entry.fetchedAt > MIAOPAI_DEFAULT_DELIVER_ID_CACHE_TTL_MS
}

export function peekMiaopaiDefaultDeliverId(accountId) {
  const id = normalizeAccountId(accountId)
  if (!id) return null
  const entry = cacheByAccount.get(id)
  if (!entry || isExpired(entry)) {
    if (entry) cacheByAccount.delete(id)
    return null
  }
  return entry
}

export function storeMiaopaiDefaultDeliverId(accountId, deliverId, cookie) {
  const id = normalizeAccountId(accountId)
  const did = String(deliverId || '').trim()
  if (!id || !did) return
  const prev = cacheByAccount.get(id)
  cacheByAccount.set(id, {
    deliverId: did,
    cookie: mergeCookie(prev?.cookie, cookie),
    fetchedAt: Date.now()
  })
}

export function touchMiaopaiDefaultDeliverIdCookie(accountId, cookie) {
  const id = normalizeAccountId(accountId)
  const entry = cacheByAccount.get(id)
  const ck = normalizeCookieHeader(cookie)
  if (!id || !entry || !ck || isExpired(entry)) return
  entry.cookie = mergeCookie(entry.cookie, ck)
}

export function invalidateMiaopaiDefaultDeliverId(accountId) {
  const id = normalizeAccountId(accountId)
  if (!id) return
  cacheByAccount.delete(id)
  inflightByAccount.delete(id)
}

/**
 * @param {string} accountId
 * @param {string} cookie
 * @param {(cookie: string) => Promise<{ ok: boolean, deliverId: string, error: string, cookie: string }>} fetchFn
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function resolveMiaopaiDefaultDeliverId(accountId, cookie, fetchFn, opts = {}) {
  const id = normalizeAccountId(accountId)
  const forceRefresh = opts.forceRefresh === true
  let ck = normalizeCookieHeader(cookie)

  if (!id) {
    return fetchFn(ck)
  }

  if (!forceRefresh) {
    const cached = peekMiaopaiDefaultDeliverId(id)
    if (cached?.deliverId) {
      return {
        ok: true,
        deliverId: cached.deliverId,
        error: '',
        cookie: mergeCookie(ck, cached.cookie),
        fromCache: true,
        cacheAgeSec: Math.round((Date.now() - cached.fetchedAt) / 1000)
      }
    }

    const existing = inflightByAccount.get(id)
    if (existing) {
      const res = await existing
      return {
        ...res,
        cookie: mergeCookie(ck, res.cookie)
      }
    }
  } else {
    invalidateMiaopaiDefaultDeliverId(id)
  }

  const inflight = (async () => {
    const res = await fetchFn(ck)
    if (res.ok && res.deliverId) {
      storeMiaopaiDefaultDeliverId(id, res.deliverId, res.cookie)
    } else {
      invalidateMiaopaiDefaultDeliverId(id)
    }
    return res
  })()

  inflightByAccount.set(id, inflight)
  try {
    const res = await inflight
    return {
      ...res,
      cookie: mergeCookie(ck, res.cookie)
    }
  } finally {
    if (inflightByAccount.get(id) === inflight) {
      inflightByAccount.delete(id)
    }
  }
}
