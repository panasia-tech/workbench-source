/**
 * 本机拉取 idle.pc.detail：本机算签 + POST h5api
 */
import { postSignedMtopRequest, isMtopSuccess, describeMtopFailureForClient } from './sxjk-post-signed-mtop.js'
import { readAccountCookieHeader } from './goofish-partition-cookie.js'
import { ensureAccountMh5TkInPartition } from './goofish-partition-mh5-refresh.js'
import { xianyuMtop } from './xianyu-mtop-client.js'

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

function mergeCookie(current, updated) {
  const next = String(updated || '').trim()
  return next || normalizeCookieHeader(current)
}

function buildPcItemDetailReferer() {
  return 'https://www.goofish.com/'
}

function desktopCookieWarmEnabled() {
  const v = String(process.env.XIANYU_DESKTOP_COOKIE_WARM || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** 对齐 server prepareClientMtopCookie 默认行为：normalize；warm 仅 env 开启时在本机分区执行 */
async function prepareClientMtopCookieLocally(cookie, accountId) {
  let ck = normalizeCookieHeader(cookie)
  if (!ck) return ''
  if (!desktopCookieWarmEnabled()) return ck
  const id = String(accountId || '').trim()
  if (!id) return ck
  try {
    await ensureAccountMh5TkInPartition(id, {})
    const snap = await readAccountCookieHeader(id, { fresh: true })
    if (snap.ok && snap.cookie) {
      ck = normalizeCookieHeader(snap.cookie)
    }
  } catch (e) {
    console.warn('[本机商品详情] cookie warm', e?.message || e)
  }
  return ck
}

function isMtopTokenExpiredMessage(msg) {
  const s = String(msg || '')
  if (!s) return false
  const u = s.toUpperCase()
  return (
    u.includes('FAIL_SYS_TOKEN') ||
    u.includes('TOKEN_EXOIRED') ||
    u.includes('TOKEN_EXPIRED') ||
    u.includes('SESSION_EXPIRED') ||
    s.includes('令牌过期')
  )
}

function isDetailFetchBlocked(msg) {
  const s = String(msg || '')
  const u = s.toUpperCase()
  return u.includes('RGV587') || u.includes('USER_VALIDATE') || s.includes('挤爆') || s.includes('被挤爆')
}

async function signPcItemDetailOnly(cookie, itemId) {
  const id = String(itemId || '').trim()
  if (!id) throw new Error('缺少商品 ID')
  const client_mtop_cookie = normalizeCookieHeader(cookie)
  if (!client_mtop_cookie) throw new Error('缺少 Cookie')

  const signed = await xianyuMtop.signMiaopaiPcItemDetail(client_mtop_cookie, id)
  const requestUrl = String(signed?.requestUrl || '').trim()
  const mtopData = signed?.mtopData ?? signed?.data
  if (!requestUrl || mtopData == null || typeof mtopData !== 'string') {
    throw new Error('商品详情签名结果不完整')
  }

  const signCookie = mergeCookie('', signed?.client_mtop_cookie_used)
  return {
    requestUrl,
    mtopData: String(mtopData),
    referer: String(signed?.referer || buildPcItemDetailReferer()).trim() || buildPcItemDetailReferer(),
    cookie: signCookie || client_mtop_cookie
  }
}

/**
 * 本机 POST h5api 拉商品详情
 * @param {{ itemId: string, cookie: string, accountId?: string }} opts
 */
export async function executeLocalPcItemDetail({ itemId, cookie, accountId }) {
  const id = String(itemId || '').trim()
  if (!id) {
    return { ok: false, json: null, error: '缺少商品 ID', cookie: normalizeCookieHeader(cookie) }
  }

  let ck = await prepareClientMtopCookieLocally(cookie, accountId)
  if (!ck) {
    return { ok: false, json: null, error: '缺少 Cookie', cookie: '' }
  }

  let signed
  try {
    signed = await signPcItemDetailOnly(ck, id)
  } catch (e) {
    return { ok: false, json: null, error: String(e?.message || e || '商品详情签名失败'), cookie: ck }
  }

  ck = signed.cookie

  const postRes = await postSignedMtopRequest({
    requestUrl: signed.requestUrl,
    mtopData: signed.mtopData,
    cookie: ck,
    referer: signed.referer,
    forPcDetail: true
  })

  ck = mergeCookie(ck, postRes.client_mtop_cookie_updated)
  const json = postRes.mtopRawJson

  if (postRes.ok && isMtopSuccess(json)) {
    return { ok: true, json, error: '', cookie: ck, httpStatus: postRes.httpStatus || 0 }
  }

  const err = postRes.error || describeMtopFailureForClient(json) || '商品详情获取失败'
  return {
    ok: false,
    json,
    error: err,
    cookie: ck,
    httpStatus: postRes.httpStatus || 0,
    blocked: isDetailFetchBlocked(err)
  }
}

export { isMtopTokenExpiredMessage, isDetailFetchBlocked, buildPcItemDetailReferer, prepareClientMtopCookieLocally }
