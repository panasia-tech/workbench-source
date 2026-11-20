/**
 * 对齐 XianyuAutoAgent/XianyuApis.hasLogin：passport.goofish.com 会话保活后再取 IM Token。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { getHttpClientForMtop } = require(join(__dirname, '../lib/xy_sxjk/http-client.js'))
const { GOOFISH_IM_MTOP_USER_AGENT } = require(join(__dirname, '../lib/xy_sxjk/mtop-constants.js'))

function parseCookieHeader(s) {
  const jar = new Map()
  for (const part of String(s || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) {
      const k = part.slice(0, i).trim()
      const v = part.slice(i + 1).trim()
      if (k) jar.set(k, v)
    }
  }
  return jar
}

function mergeSetCookieIntoHeader(cookieHeader, setCookieHeader) {
  const jar = parseCookieHeader(cookieHeader)
  const parts = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : []
  for (const line of parts) {
    const seg = String(line || '').split(';')[0]
    const i = seg.indexOf('=')
    if (i > 0) jar.set(seg.slice(0, i).trim(), seg.slice(i + 1).trim())
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * @param {string} cookieHeader
 * @param {number} [retryCount]
 * @returns {Promise<{ ok: boolean, cookieHeader: string }>}
 */
export async function postGoofishHasLogin(cookieHeader, retryCount = 0) {
  const cookie = String(cookieHeader || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
  if (!cookie) return { ok: false, cookieHeader: cookie }
  if (retryCount >= 2) return { ok: false, cookieHeader: cookie }

  const jar = parseCookieHeader(cookie)
  const body = new URLSearchParams({
    hid: jar.get('unb') || '',
    ltl: 'true',
    appName: 'xianyu',
    appEntrance: 'web',
    _csrf_token: jar.get('XSRF-TOKEN') || '',
    umidToken: '',
    hsiz: jar.get('cookie2') || '',
    bizParams: 'taobaoBizLoginFrom=web',
    mainPage: 'false',
    isMobile: 'false',
    lang: 'zh_CN',
    returnUrl: '',
    fromSite: '77',
    isIframe: 'true',
    documentReferer: 'https://www.goofish.com/',
    defaultView: 'hasLogin',
    umidTag: 'SERVER',
    deviceId: jar.get('cna') || ''
  })

  try {
    const client = getHttpClientForMtop()
    const res = await client.post(
      'https://passport.goofish.com/newlogin/hasLogin.do',
      body.toString(),
      {
        params: { appName: 'xianyu', fromSite: '77' },
        headers: {
          Cookie: cookie,
          Referer: 'https://www.goofish.com/',
          Origin: 'https://www.goofish.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': GOOFISH_IM_MTOP_USER_AGENT
        },
        responseType: 'json',
        validateStatus: () => true
      }
    )
    const merged = mergeSetCookieIntoHeader(cookie, res.headers?.['set-cookie'])
    const data = res.data
    if (data?.content?.success === true) {
      return { ok: true, cookieHeader: merged }
    }
    await new Promise((r) => setTimeout(r, 500))
    return postGoofishHasLogin(merged, retryCount + 1)
  } catch (e) {
    console.warn('[闲鱼私聊] 登录保活异常', e?.message || e)
    await new Promise((r) => setTimeout(r, 500))
    return postGoofishHasLogin(cookie, retryCount + 1)
  }
}
