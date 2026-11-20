/**
 * 本机 POST 已签名闲鱼 MTOP（登录检测、本机搜索轮询等）。
 */
import { createRequire } from 'node:module'
import {
  getChromeLikeUserAgent,
  buildSecChUa,
  clientHintPlatformQuoted
} from './goofish-electron-session-chrome-like.js'

const require = createRequire(import.meta.url)
const { getHttpClientForMtop, getHttpClientForMtopSearch } = require('../lib/xy_sxjk/http-client.js')
const { mergeSetCookieFromMtopResponse } = require('../lib/xy_sxjk/fetch-cookie-from-goofish.js')

/** idle.pc.detail / create-order：对齐浏览器抓包（Win + Chrome 149） */
const GOOFISH_BROWSER_PAGE_DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

function resolveMtopPostReferer(explicitReferer) {
  const strategy = String(process.env.XIANYU_MTOP_REFERER_STRATEGY || '')
    .trim()
    .toLowerCase()
  if (strategy === 'search' || strategy === 'page') {
    const ref =
      typeof explicitReferer === 'string' && explicitReferer.trim()
        ? explicitReferer.trim()
        : 'https://www.goofish.com/'
    return ref
  }
  return 'https://www.goofish.com/'
}

function buildMtopPostHeaders(safeCookie, referer) {
  const ref = resolveMtopPostReferer(referer)
  const ua = getChromeLikeUserAgent()
  const secChUa = buildSecChUa()
  const platform = clientHintPlatformQuoted()
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(safeCookie ? { Cookie: safeCookie } : {}),
    Referer: ref,
    Origin: 'https://www.goofish.com',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,zh-HK;q=0.7',
    'User-Agent': ua,
    Accept: 'application/json',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Sec-CH-UA': secChUa,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': platform
  }
}

/** 详情 / 创建订单页：用签名下发的 referer，不强制改回首页 */
function buildMtopPostHeadersGoofishBrowserPage(safeCookie, referer) {
  const ua =
    String(process.env.XIANYU_PC_DETAIL_UA || '').trim() || GOOFISH_BROWSER_PAGE_DEFAULT_UA
  const ref =
    typeof referer === 'string' && referer.trim()
      ? referer.trim()
      : 'https://www.goofish.com/'
  return {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,zh-HK;q=0.7',
    'content-type': 'application/x-www-form-urlencoded',
    ...(safeCookie ? { cookie: safeCookie } : {}),
    origin: 'https://www.goofish.com',
    priority: 'u=1, i',
    referer: ref,
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': ua
  }
}

/**
 * @param {unknown} bxFormParams
 * @returns {Record<string, string>}
 */
function pickBxFormParams(bxFormParams) {
  if (!bxFormParams || typeof bxFormParams !== 'object') return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const key of ['bx-ua', 'bx-umidtoken', 'bx_et']) {
    const val = String(/** @type {any} */ (bxFormParams)[key] || '').trim()
    if (val && !/^default_/i.test(val)) out[key] = val
  }
  return out
}

async function postMtopFeed({
  url,
  data,
  cookie,
  referer,
  forSearch = false,
  forPcDetail = false,
  forCreateOrder = false,
  extHeaders = null,
  bxFormParams = null
} = {}) {
  const safeCookie = String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
  const params = new URLSearchParams()
  params.set('data', String(data ?? ''))
  if (forSearch) {
    const bx = pickBxFormParams(bxFormParams)
    for (const [k, v] of Object.entries(bx)) {
      params.set(k, v)
    }
  }
  const body = params.toString()
  const httpAxios = forSearch ? getHttpClientForMtopSearch() : getHttpClientForMtop()
  const headers =
    forPcDetail || forCreateOrder
      ? buildMtopPostHeadersGoofishBrowserPage(safeCookie, referer)
      : buildMtopPostHeaders(safeCookie, referer)
  if (extHeaders && typeof extHeaders === 'object') {
    for (const [k, v] of Object.entries(extHeaders)) {
      const key = String(k || '').trim()
      const val = v == null ? '' : String(v).trim()
      if (!key || !val) continue
      headers[key] = val
    }
  }
  const res = await httpAxios.post(url, body, {
    headers,
    responseType: 'text',
    transformResponse: [(raw) => raw]
  })
  const cookieAfterResponse = mergeSetCookieFromMtopResponse(safeCookie, res.headers)
  return {
    statusCode: res.status,
    body: res.data,
    cookieAfterResponse
  }
}

function isMtopSuccess(json) {
  const ret = json?.ret
  if (!Array.isArray(ret) || ret.length === 0) return false
  return String(ret[0]).startsWith('SUCCESS::')
}

function describeMtopFailureForClient(json) {
  const ret = json?.ret
  if (Array.isArray(ret) && ret.length > 0) {
    const s = ret
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .join(' ')
    if (s) return s.slice(0, 2000)
  }
  if (ret != null && typeof ret === 'string' && String(ret).trim()) {
    return String(ret).trim().slice(0, 2000)
  }
  return '闲鱼接口返回失败（无 ret）'
}

/**
 * @param {{ requestUrl: string, mtopData: string, cookie: string, referer?: string, forSearch?: boolean, bxFormParams?: Record<string, string> | null }} body
 */
export async function postSignedMtopRequest(body = {}) {
  const requestUrl = String(body.requestUrl || '').trim()
  const mtopData = body.mtopData
  const cookie = String(body.cookie || '')
    .replace(/[\r\n\x00-\x1f\x7f]/g, '')
    .trim()
  const referer = String(body.referer || 'https://www.goofish.com/').trim() || 'https://www.goofish.com/'
  const forSearch = body?.forSearch === true
  const forPcDetail = body?.forPcDetail === true
  const forCreateOrder = body?.forCreateOrder === true
  const extHeaders =
    body?.mtopExtHeaders && typeof body.mtopExtHeaders === 'object' ? body.mtopExtHeaders : null
  const bxFormParams = forSearch ? pickBxFormParams(body?.bxFormParams) : {}

  if (!requestUrl || mtopData == null || typeof mtopData !== 'string') {
    return { ok: false, error: '缺少 requestUrl 或 mtopData', httpStatus: 0 }
  }
  if (!cookie) {
    return { ok: false, error: '缺少 Cookie', httpStatus: 0 }
  }

  let statusCode = 0
  let json = null
  let clientMtopCookieAfter = ''
  try {
    const res = await postMtopFeed({
      url: requestUrl,
      data: mtopData,
      cookie,
      referer,
      forSearch,
      forPcDetail,
      forCreateOrder,
      extHeaders,
      bxFormParams
    })
    statusCode = res.statusCode
    clientMtopCookieAfter = String(res.cookieAfterResponse || '').trim()
    try {
      json = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    } catch {
      json = { rawBody: res.body }
    }
  } catch (e) {
    return { ok: false, error: e?.message || '闲鱼请求失败', httpStatus: 0 }
  }

  const bizOk = isMtopSuccess(json)
  const out = {
    ok: bizOk,
    httpStatus: statusCode,
    mtopRawJson: json
  }
  if (!bizOk) {
    out.error = describeMtopFailureForClient(json)
  }
  const merged = clientMtopCookieAfter
  if (merged && merged !== cookie) {
    out.client_mtop_cookie_updated = merged
  }
  return out
}

export { isMtopSuccess, describeMtopFailureForClient }
