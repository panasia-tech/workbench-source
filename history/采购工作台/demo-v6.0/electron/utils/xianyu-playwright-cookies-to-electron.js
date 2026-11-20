export const GOOFISH_COOKIE_HEADER_INJECT_URLS = [
  'https://www.goofish.com',
  'https://goofish.com',
  'https://m.goofish.com',
  'https://seller.goofish.com',
  'https://h5api.m.goofish.com',
  'https://passport.goofish.com',
  'https://login.taobao.com',
  'https://passport.taobao.com',
  'https://www.taobao.com',
  'https://h5.m.taobao.com',
  'https://login.m.taobao.com',
  'https://api.m.taobao.com',
  'https://eco.taobao.com',
  'https://market.m.taobao.com',
  /** punish / 滑块链常见落 Cookie 子域，仅扫固定 www 会漏 x5sec */
  'https://sec.taobao.com',
  'https://sm.taobao.com'
]

/**
 * 从注入 URL 推导 Cookie domain（带前导点），与 Playwright syntheticCookiesFromHeader 对齐。
 * 仅写 host-only 时 SPA / 子域 API 读不到登录态，表现为首页白屏、推荐流 0 条。
 * @param {string} url
 * @returns {string}
 */
export function cookieDomainForInjectUrl(url) {
  try {
    const host = String(new URL(url).hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '')
    if (!host) return ''
    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 2) return `.${parts.slice(-2).join('.')}`
    return `.${host}`
  } catch {
    return ''
  }
}

/** 从 Cookie 头注入时默认有效期（秒）；不设 expirationDate 会变成会话 Cookie，重启即丢 */
const DEFAULT_HEADER_COOKIE_TTL_SEC = 365 * 24 * 3600

/** @param {import('electron').Cookie | { domain?: string, path?: string, secure?: boolean }} c */
export function cookieRecordToSetUrl(c) {
  const domain = String(c?.domain || '').replace(/^\./, '')
  const path = String(c?.path || '/')
  const host = domain || 'www.goofish.com'
  const secure = c?.secure !== false
  return `${secure ? 'https' : 'http'}://${host}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 把分区里仍是「会话 Cookie」的项改写为带过期时间，否则 flushStore 重启后读不到。
 * @param {import('electron').Session} sess
 * @param {number} [defaultTtlSec]
 */
export async function repersistSessionCookiesWithExpiration(sess, defaultTtlSec = DEFAULT_HEADER_COOKIE_TTL_SEC) {
  if (!sess?.cookies) return { ok: false, updated: 0 }
  let list = []
  try {
    list = await sess.cookies.get({})
  } catch {
    return { ok: false, updated: 0 }
  }
  if (!Array.isArray(list) || !list.length) return { ok: false, updated: 0 }

  const nowSec = Date.now() / 1000
  let updated = 0
  for (const c of list) {
    const name = String(c?.name || '').trim()
    if (!name) continue
    const exp = typeof c.expirationDate === 'number' ? c.expirationDate : 0
    const isSession = !exp || exp <= 0
    if (!isSession && exp > nowSec) continue

    const expirationDate = isSession || exp <= nowSec ? nowSec + defaultTtlSec : exp
    try {
      await sess.cookies.set({
        url: cookieRecordToSetUrl(c),
        name,
        value: String(c?.value ?? ''),
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate
      })
      updated += 1
    } catch (e) {
      console.warn('[闲鱼Cookie] repersist cookie skip:', name, e?.message || e)
    }
  }
  return { ok: updated > 0, updated }
}

export function parseCookieHeaderString(header) {
  const out = []
  for (const part of String(header).split(';')) {
    const s = part.trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const name = s.slice(0, eq).trim()
    const value = s.slice(eq + 1).trim()
    if (!name) continue
    out.push({ name, value })
  }
  return out
}

/** Cookie 对象数组 → 请求头串（与历史 Playwright 采集格式一致，供 MTOP / 分区注入） */
export function cookiesArrayToHeader(list) {
  const map = new Map()
  for (const c of list || []) {
    if (c?.name) map.set(c.name, c.value ?? '')
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 将 Cookie 头写入 Electron 分区（多 origin 各写一份，与站点拉 Cookie 行为对齐）。
 * @param {import('electron').Session} sess
 * @param {string} cookieHeader
 * @param {string[]} [urls]
 * @param {{ skipCookieNames?: Set<string> }} [opts] 小写 cookie 名：已由 Playwright 快照以 HttpOnly 等形式写入时跳过，避免「非 HttpOnly 覆盖 HttpOnly」整批失败。
 */
export async function applyCookieHeaderStringToElectronPartition(sess, cookieHeader, urls, opts = {}) {
  const pairs = parseCookieHeaderString(cookieHeader)
  if (!pairs.length || !sess) return
  const list =
    Array.isArray(urls) && urls.length
      ? urls
      : GOOFISH_COOKIE_HEADER_INJECT_URLS
  const skip = opts.skipCookieNames
  const isHttpOnlyOverwriteErr = (msg) => /HttpOnly|EXCLUDE_OVERWRITE/i.test(String(msg || ''))
  const nowSec = Math.floor(Date.now() / 1000)
  const defaultExp = nowSec + DEFAULT_HEADER_COOKIE_TTL_SEC

  /** 每个 eTLD+1 只写一次（带 domain），避免仅 host-only 导致子域/API 丢登录态 */
  const domainToUrl = new Map()
  for (const url of list) {
    const domain = cookieDomainForInjectUrl(url)
    if (!domain || domainToUrl.has(domain)) continue
    domainToUrl.set(domain, url)
  }
  if (!domainToUrl.size) {
    domainToUrl.set('.goofish.com', 'https://www.goofish.com')
  }

  let written = 0
  let skipped = 0
  for (const [domain, url] of domainToUrl) {
    for (const p of pairs) {
      const nameKey = String(p.name || '')
        .trim()
        .toLowerCase()
      if (skip && nameKey && skip.has(nameKey)) continue

      const details = {
        url,
        name: p.name,
        value: p.value,
        domain,
        path: '/',
        secure: true,
        expirationDate: defaultExp
      }
      try {
        await sess.cookies.set(details)
        written += 1
      } catch (e) {
        const msg = String(e?.message || e)
        if (isHttpOnlyOverwriteErr(msg)) {
          try {
            await sess.cookies.remove(url, p.name)
            await sess.cookies.set(details)
            written += 1
          } catch (e2) {
            skipped += 1
            console.warn('[闲鱼Cookie] Cookie 写入分区跳过:', p.name, domain, String(e2?.message || e2))
          }
        } else {
          skipped += 1
          console.warn('[闲鱼Cookie] Cookie 写入分区跳过:', p.name, domain, msg)
        }
      }
    }
  }
  if (written > 0 || skipped > 0) {
    // 批量 pull 会逐账号调用；默认不刷屏，需要排查时设 XIANYU_COOKIE_INJECT_DEBUG=1
    if (process.env.XIANYU_COOKIE_INJECT_DEBUG === '1') {
      console.log(
        '[闲鱼Cookie] Cookie 头注入完成 pairs=',
        pairs.length,
        'domains=',
        domainToUrl.size,
        'written=',
        written,
        'skipped=',
        skipped
      )
    }
  }
}

/**
 * 将 Playwright context.cookies() 结果写入 Electron session（含 httpOnly / sameSite）。
 * 与「整段 Cookie 头」同用时：建议先写头再写本函数，由快照覆盖同名键的域名/HttpOnly 等元数据。
 * @param {import('electron').Session} sess
 * @param {Array<{ name: string, value: string, domain?: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean, sameSite?: string }>} pwCookies
 */
export async function applyPlaywrightCookiesToElectronSession(sess, pwCookies) {
  if (!sess || !Array.isArray(pwCookies)) return
  for (const c of pwCookies) {
    try {
      let domain = String(c.domain || '').trim()
      if (!domain) continue
      if (domain.startsWith('.')) domain = domain.slice(1)
      const hostOnly = domain.split(':')[0]
      const url = hostOnly.startsWith('http') ? hostOnly : `https://${hostOnly}`
      const path = c.path || '/'

      let sameSite = 'unspecified'
      const ss = String(c.sameSite || '').toLowerCase()
      if (ss === 'strict') sameSite = 'strict'
      else if (ss === 'lax') sameSite = 'lax'
      else if (ss === 'none') sameSite = 'no_restriction'

      /** @type {import('electron').CookiesSetDetails} */
      const details = {
        url,
        name: c.name,
        value: c.value,
        path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite
      }
      if (typeof c.expires === 'number' && c.expires > 0) {
        details.expirationDate = c.expires
      }
      await sess.cookies.set(details)
    } catch (e) {
      console.warn('[闲鱼Cookie] Playwright→Electron Cookie 跳过:', c?.name, e?.message || e)
    }
  }
}

/**
 * Export all cookies from an Electron session into Playwright-compatible objects.
 * @param {import('electron').Session} sess
 * @returns {Promise<Array<{ name: string, value: string, domain: string, path: string, httpOnly?: boolean, secure?: boolean, sameSite?: string, expires?: number }>>}
 */
export async function exportPlaywrightCookiesFromElectronSession(sess) {
  if (!sess?.cookies) return []
  try {
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
  } catch {
    /* */
  }
  let list
  try {
    list = await sess.cookies.get({})
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const out = []
  for (const c of list) {
    const name = String(c?.name || '').trim()
    if (!name) continue
    const domain = String(c?.domain || '').trim()
    if (!domain) continue

    let sameSite = 'Lax'
    const ss = String(c?.sameSite || '').toLowerCase()
    if (ss === 'strict') sameSite = 'Strict'
    else if (ss === 'lax') sameSite = 'Lax'
    else if (ss === 'no_restriction' || ss === 'none') sameSite = 'None'

    const item = {
      name,
      value: String(c?.value ?? ''),
      domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite
    }
    if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
      item.expires = c.expirationDate
    }
    out.push(item)
  }
  return out
}

/** 仅清空 session 里全部 Cookie（不动 localStorage / cache 等分区存储）。 */
export async function clearAllCookiesInElectronSession(sess) {
  if (!sess?.cookies) return
  try {
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
  } catch {
    /* */
  }
  let list = []
  try {
    list = await sess.cookies.get({})
  } catch {
    return
  }
  if (!Array.isArray(list)) return
  for (const c of list) {
    const name = String(c?.name || '').trim()
    if (!name) continue
    let domain = String(c.domain || '').trim()
    if (!domain) continue
    if (domain.startsWith('.')) domain = domain.slice(1)
    const protocol = c.secure ? 'https:' : 'http:'
    const path = c.path || '/'
    const url = `${protocol}//${domain}${path.startsWith('/') ? path : `/${path}`}`
    try {
      await sess.cookies.remove(url, name)
    } catch {
      try {
        await sess.cookies.remove(`${protocol}//${domain}/`, name)
      } catch {
        /* */
      }
    }
  }
  try {
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
  } catch {
    /* */
  }
}

/** @param {import('electron').Session} sess @param {string[]} urls */
export async function removeAllCookiesForUrls(sess, urls) {
  if (!sess || !Array.isArray(urls)) return
  for (const url of urls) {
    try {
      const list = await sess.cookies.get({ url })
      for (const c of list) {
        try {
          await sess.cookies.remove(url, c.name)
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }
}
