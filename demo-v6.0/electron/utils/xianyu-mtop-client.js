/**
 * 闲鱼 MTOP 本机客户端：主进程算签 + POST h5api（不再打后端 /sign*）。
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postSignedMtopRequest, isMtopSuccess, describeMtopFailureForClient } from './sxjk-post-signed-mtop.js'
import {
  pickDisplayNameFromUserPageNavJson,
  pickAvatarFromUserPageNavJson,
  buildGoofishUserAvatarUrl,
  normalizeGoofishAvatarUrl
} from './goofish-account-profile.js'
import { generateSearchBxParamsByEnv } from './goofish-bx-env-sign.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import {
  getChromeLikeUserAgent,
  buildSecChUa,
  clientHintPlatformQuoted
} from './goofish-electron-session-chrome-like.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const libDir = join(__dirname, '..', 'lib', 'xy_sxjk')

const {
  buildSignedSearchMtopRequest,
  buildSignedSearchSuggestMtopRequest,
  buildSignedUserPageNavMtopRequest,
  buildSignedUserPageHeadMtopRequest,
  buildSignedXyhItemListMtopRequest,
  pickSearchSuggestTextsFromMtopJson,
  pickPlainUserIdFromUserPageHead,
  pickSellerNickAvatarFromUserPageHead,
  pickSpmItemWantFromPcDetail,
  buildGoofishImWebUrl
} = require(join(libDir, 'mtop-sign.js'))

const { buildSearchOptionsFromTaskBody } = require(join(libDir, 'build-prop-search-filter.js'))
const { fetchShopXyhItemListWithFallback } = require(join(libDir, 'shop-xyh-list-fetch.js'))

const {
  buildSignedMiaopaiPcItemDetailRequest,
  buildSignedMiaopaiAddressListRequest,
  buildSignedMiaopaiOrderRenderRequest,
  buildSignedMiaopaiCreateOrderRequest
} = require(join(libDir, 'miaopai-mtop-sign.js'))

function normalizeCookie(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

function cookieGetValue(cookieHeader, name) {
  const s = String(cookieHeader || '')
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i')
  const m = s.match(re)
  if (!m) return ''
  let v = String(m[1] || '').trim()
  if (!v || /^deleted$/i.test(v)) return ''
  try {
    v = decodeURIComponent(v)
  } catch {
    /* */
  }
  return v
}

function toSignApiShape(built) {
  return {
    requestUrl: built.requestUrl,
    mtopData: built.data ?? built.mtopData,
    referer: built.referer || 'https://www.goofish.com/',
    client_mtop_cookie_used: built.cookie
  }
}

function parseMtopPostResult(statusCode, bodyText, cookieBefore = '') {
  let json = null
  try {
    json = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText
  } catch {
    json = { rawBody: bodyText }
  }
  const bizOk = isMtopSuccess(json)
  const out = {
    ok: bizOk,
    httpStatus: Number(statusCode) || 0,
    mtopRawJson: json
  }
  if (!bizOk) {
    out.error = describeMtopFailureForClient(json)
  }
  return out
}

/**
 * 账号分区 session.fetch（Chromium 网络栈），带 bx form 字段。
 * @returns {Promise<object|null>}
 */
async function postSearchViaAccountSessionFetch(accountId, built, cookie, bxFormParams) {
  const id = String(accountId || '').trim()
  if (!id) return null
  try {
    const { session } = await import('electron')
    const sess = session.fromPartition(partitionForListingAccount(id))
    if (typeof sess.fetch !== 'function') return null
    const params = new URLSearchParams()
    params.set('data', String(built.data ?? built.mtopData ?? ''))
    if (bxFormParams && typeof bxFormParams === 'object') {
      for (const key of ['bx-ua', 'bx-umidtoken', 'bx_et']) {
        const v = String(bxFormParams[key] || '').trim()
        if (v && !/^default_/i.test(v)) params.set(key, v)
      }
    }
    const referer =
      String(built.referer || '').trim() || 'https://www.goofish.com/'
    const ck = normalizeCookie(cookie)
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(ck ? { Cookie: ck } : {}),
      Referer: referer,
      Origin: 'https://www.goofish.com',
      'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,zh-HK;q=0.7',
      Accept: 'application/json',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': getChromeLikeUserAgent(),
      'Sec-CH-UA': buildSecChUa(),
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': clientHintPlatformQuoted()
    }
    const res = await sess.fetch(String(built.requestUrl || ''), {
      method: 'POST',
      headers,
      body: params.toString()
    })
    const text = await res.text()
    return parseMtopPostResult(res.status, text, ck)
  } catch (e) {
    console.warn('[本机搜索] session.fetch 失败', id, e?.message || e)
    return null
  }
}

async function signAndPost(built, postOpts = {}) {
  const signed = toSignApiShape(built)
  const cookie = normalizeCookie(signed.client_mtop_cookie_used || built.cookie)
  const { bxFormParams, ...restPostOpts } = postOpts || {}
  const postRes = await postSignedMtopRequest({
    requestUrl: signed.requestUrl,
    mtopData: signed.mtopData,
    cookie,
    referer: signed.referer,
    ...(bxFormParams && typeof bxFormParams === 'object' ? { bxFormParams } : {}),
    ...restPostOpts
  })
  return { signed, postRes, cookie }
}

/** 搜索页码：仅「最新」语义固定第 1 页 */
function pickSearchPageNumber(body = {}) {
  const sm = String(body?.sort_mode ?? body?.sortMode ?? '').trim()
  const pd = String(body?.publish_days ?? body?.publishDays ?? '').trim()
  if (sm === 'create_desc' || sm === 'publish_latest') return 1
  if (!sm && pd === 'latest') return 1
  const raw = body?.pageNumber
  if (raw == null || raw === '') return 1
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n)) return 1
  return Math.min(50, Math.max(1, n))
}

function pickSearchRowsPerPage(body = {}) {
  const raw = body?.rowsPerPage ?? body?.rows_per_page ?? body?.searchRowsPerPage
  if (raw == null || raw === '') return 90
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1) return 90
  return Math.min(150, Math.max(1, n))
}

export class XianyuMtopClient {
  /**
   * @param {string} cookie
   * @param {object} [taskBody] 与后端 signSearch body 对齐（含 keyword / sort_mode / quick_filters 等）
   * @param {{ accountId?: string }} [opts]
   */
  async search(cookie, taskBody = {}, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) return { ok: false, error: '缺少 Cookie' }
    const keyword = String(taskBody.keyword || '').trim()
    if (!keyword) return { ok: false, error: '缺少关键词 keyword' }

    const fo = buildSearchOptionsFromTaskBody(taskBody)
    const pageNumber = pickSearchPageNumber(taskBody)
    const rowsPerPage = pickSearchRowsPerPage(taskBody)
    const accountId = String(
      opts?.accountId || taskBody?.accountId || taskBody?.pollAccountId || taskBody?.poll_account_id || ''
    ).trim()

    let built
    try {
      built = await buildSignedSearchMtopRequest(
        keyword,
        pageNumber,
        rowsPerPage,
        {
          sortField: fo.sortField,
          sortValue: fo.sortValue,
          propValueStr: fo.propValueStr,
          extraFilterValue: fo.extraFilterValue,
          userPositionJson: fo.userPositionJson
        },
        ck,
        { skipPrepareClientCookie: true }
      )
    } catch (e) {
      return { ok: false, error: String(e?.message || e || '签名失败') }
    }

    const signed = toSignApiShape(built)
    let postRes = null
    let bxAttached = false
    let transport = 'axios'

    /** 仅本地补环境生成 bx-*（不再开隐藏窗 / 页内取参） */
    let bxFormParams = null
    try {
      bxFormParams = await generateSearchBxParamsByEnv({
        requestUrl: built.requestUrl
      })
    } catch (e) {
      console.warn('[本机搜索] 补环境取 bx 异常', e?.message || e)
    }
    bxAttached = !!(bxFormParams && bxFormParams['bx-ua'])

    /** 账号：分区 session.fetch + 本地 bx；否则 axios + 本地 bx */
    if (accountId) {
      const sessPost = await postSearchViaAccountSessionFetch(
        accountId,
        built,
        signed.client_mtop_cookie_used || ck,
        bxFormParams
      )
      if (sessPost) {
        postRes = sessPost
        transport = bxAttached ? 'session-fetch+env-bx' : 'session-fetch'
      }
    }
    if (!postRes) {
      const axiosOut = await signAndPost(built, {
        forSearch: true,
        ...(bxFormParams ? { bxFormParams } : {})
      })
      postRes = axiosOut.postRes
      transport = bxAttached ? 'axios+env-bx' : 'axios'
    }

    console.log('[本机搜索] 传输', {
      accountId: accountId || undefined,
      transport,
      bxAttached,
      ok: postRes?.ok === true,
      httpStatus: postRes?.httpStatus || 0
    })

    return {
      ok: postRes?.ok === true,
      error: postRes?.ok ? '' : String(postRes?.error || '闲鱼请求失败'),
      httpStatus: postRes?.httpStatus || 0,
      mtopRawJson: postRes?.mtopRawJson ?? null,
      client_mtop_cookie_updated: postRes?.client_mtop_cookie_updated || '',
      requestUrl: signed.requestUrl,
      mtopData: signed.mtopData,
      referer: signed.referer,
      client_mtop_cookie_used: signed.client_mtop_cookie_used,
      pageNumber,
      rowsPerPage,
      code: postRes?.code || '',
      bxAttached,
      transport
    }
  }

  /** 仅算签（供仍走「签名包 + execute」的旧 IPC） */
  async signSearch(cookie, taskBody = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) throw new Error('缺少 Cookie')
    const keyword = String(taskBody.keyword || '').trim()
    if (!keyword) throw new Error('缺少关键词 keyword')
    const fo = buildSearchOptionsFromTaskBody(taskBody)
    const pageNumber = pickSearchPageNumber(taskBody)
    const rowsPerPage = pickSearchRowsPerPage(taskBody)
    const built = await buildSignedSearchMtopRequest(
      keyword,
      pageNumber,
      rowsPerPage,
      {
        sortField: fo.sortField,
        sortValue: fo.sortValue,
        propValueStr: fo.propValueStr,
        extraFilterValue: fo.extraFilterValue,
        userPositionJson: fo.userPositionJson
      },
      ck,
      { skipPrepareClientCookie: true }
    )
    return {
      ...toSignApiShape(built),
      pageNumber,
      rowsPerPage
    }
  }

  async xyhItemList(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) return { ok: false, error: '缺少 Cookie' }
    const userId = String(opts.userId ?? opts.seller_user_id ?? opts.sellerUserId ?? '').trim()
    if (!userId) return { ok: false, error: '缺少 seller_user_id' }

    const requestOnce = async (cookieIn, reqOpts) => {
      let built
      try {
        built = await buildSignedXyhItemListMtopRequest(normalizeCookie(cookieIn), reqOpts)
      } catch (e) {
        return { ok: false, error: String(e?.message || e || '签名失败') }
      }
      const { signed, postRes } = await signAndPost(built, { forSearch: false })
      return {
        ok: postRes?.ok === true,
        error: postRes?.ok ? '' : String(postRes?.error || '闲鱼请求失败'),
        httpStatus: postRes?.httpStatus || 0,
        mtopRawJson: postRes?.mtopRawJson ?? null,
        client_mtop_cookie_updated: postRes?.client_mtop_cookie_updated || '',
        requestUrl: signed.requestUrl,
        mtopData: signed.mtopData,
        referer: signed.referer,
        client_mtop_cookie_used: signed.client_mtop_cookie_used,
        code: postRes?.code || ''
      }
    }

    return fetchShopXyhItemListWithFallback(ck, userId, opts, { requestOnce })
  }

  async signXyhItemList(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) throw new Error('缺少 Cookie')
    const userId = String(opts.userId ?? opts.seller_user_id ?? opts.sellerUserId ?? '').trim()
    if (!userId) throw new Error('缺少 seller_user_id')
    const built = await buildSignedXyhItemListMtopRequest(ck, {
      ...opts,
      userId,
      seller_user_id: userId,
      skipPrepareClientCookie: true
    })
    return toSignApiShape(built)
  }

  async userPageNav(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) return { ok: false, error: 'empty_cookie', displayName: '', avatar: '' }
    if (!/(?:^|;\s*)_m_h5_tk=/i.test(ck)) {
      return { ok: false, error: 'missing_mh5_tk', displayName: '', avatar: '' }
    }

    let built
    try {
      built = await buildSignedUserPageNavMtopRequest(ck, {
        sessionOption: opts.sessionOption || 'AutoLoginOnly',
        skipPrepareClientCookie: true,
        spmCnt: opts.spmCnt,
        spmPre: opts.spmPre,
        logId: opts.logId,
        referer: opts.referer
      })
    } catch (e) {
      return { ok: false, error: String(e?.message || e || 'sign_fail'), displayName: '', avatar: '' }
    }

    const { signed, postRes } = await signAndPost(built)
    const json = postRes?.mtopRawJson ?? null
    const ok = postRes?.ok === true
    const cookieUsed = normalizeCookie(
      postRes?.client_mtop_cookie_updated || signed.client_mtop_cookie_used || ck
    )
    const displayName = ok ? pickDisplayNameFromUserPageNavJson(json) : ''
    const avatar = ok ? pickAvatarFromUserPageNavJson(json, cookieUsed) : ''
    return {
      ok,
      displayName,
      ...(avatar ? { avatar } : {}),
      json,
      mtopRawJson: json,
      client_mtop_cookie_updated: postRes?.client_mtop_cookie_updated || '',
      ...(ok ? {} : { error: String(postRes?.error || 'mtop_fail') })
    }
  }

  /**
   * 账号资料：nav + unb/tracknick 兜底（对齐 fetchGoofishAccountProfile）
   */
  async fetchProfile(cookie, opts = {}) {
    const nav = await this.userPageNav(cookie, { sessionOption: 'AutoLoginOnly', ...opts })
    const ck = normalizeCookie(
      nav.client_mtop_cookie_updated || cookie
    )
    let displayName = String(nav.displayName || '').trim()
    let avatar = normalizeGoofishAvatarUrl(nav.avatar || '')
    let avatarSource = avatar ? 'nav' : 'none'
    const navOk = nav.ok === true

    if (!avatar) {
      const unb = cookieGetValue(ck, 'unb')
      if (unb) {
        avatar = buildGoofishUserAvatarUrl(unb)
        if (avatar) avatarSource = 'unb_fallback'
      }
    }
    if (!displayName) {
      displayName = cookieGetValue(ck, 'tracknick').slice(0, 64)
    }

    const unb = cookieGetValue(ck, 'unb')
    const softOnly = !navOk && !!unb
    return {
      ok: navOk || softOnly,
      navOk,
      softOnly,
      displayName,
      avatar,
      avatarSource,
      error: navOk ? '' : String(nav.error || 'mtop_fail'),
      client_mtop_cookie_updated: nav.client_mtop_cookie_updated || '',
      mtopRawJson: nav.mtopRawJson ?? null
    }
  }

  /**
   * 批量检测过期（本机 Cookie + nav）
   * @param {Array<{ accountId?: string, id?: string, cookie: string }>} items
   */
  async verifyLoginBatch(items = []) {
    const list = Array.isArray(items) ? items : []
    const results = []
    for (const it of list) {
      const accountId = String(it?.accountId || it?.id || it?.client_id || '').trim()
      const cookie = normalizeCookie(it?.cookie)
      if (!cookie) {
        results.push({
          accountId,
          client_id: accountId,
          ok: false,
          outcome: 'no_cookie',
          hint: '本机无 Cookie',
          nickname: '',
          avatar: ''
        })
        continue
      }
      try {
        const nav = await this.userPageNav(cookie, { sessionOption: 'AutoLoginOnly' })
        if (nav.ok) {
          results.push({
            accountId,
            client_id: accountId,
            ok: true,
            outcome: 'ok',
            hint: '登录有效',
            nickname: String(nav.displayName || '').trim(),
            avatar: String(nav.avatar || '').trim(),
            client_mtop_cookie_updated: nav.client_mtop_cookie_updated || ''
          })
        } else {
          results.push({
            accountId,
            client_id: accountId,
            ok: false,
            outcome: nav.error === 'missing_mh5_tk' ? 'no_cookie' : 'mtop_fail',
            hint: String(nav.error || '登录无效').slice(0, 200),
            nickname: '',
            avatar: '',
            client_mtop_cookie_updated: nav.client_mtop_cookie_updated || ''
          })
        }
      } catch (e) {
        results.push({
          accountId,
          client_id: accountId,
          ok: false,
          outcome: 'error',
          hint: String(e?.message || e || '检测失败').slice(0, 200),
          nickname: '',
          avatar: ''
        })
      }
    }
    return { results }
  }

  async userPageHead(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) return { ok: false, error: '缺少 Cookie' }
    const userId = String(opts.userId ?? opts.seller_user_id ?? opts.sellerUserId ?? '').trim()
    if (!userId) return { ok: false, error: '缺少 userId' }

    let built
    try {
      built = await buildSignedUserPageHeadMtopRequest(ck, {
        userId,
        seller_user_id: userId,
        self: opts.self,
        referer: opts.referer,
        skipPrepareClientCookie: true
      })
    } catch (e) {
      return { ok: false, error: String(e?.message || e || '签名失败') }
    }

    const { postRes } = await signAndPost(built)
    const json = postRes?.mtopRawJson ?? null
    const ok = postRes?.ok === true
    const { nick, avatar } = ok
      ? pickSellerNickAvatarFromUserPageHead(json)
      : { nick: '', avatar: '' }
    return {
      ok,
      error: ok ? '' : String(postRes?.error || describeMtopFailureForClient(json) || '请求失败'),
      httpStatus: postRes?.httpStatus || 0,
      mtopRawJson: json,
      nick: String(nick || '').trim().slice(0, 120),
      avatar: normalizeGoofishAvatarUrl(avatar).slice(0, 512),
      client_mtop_cookie_updated: postRes?.client_mtop_cookie_updated || ''
    }
  }

  /**
   * 卖家明文 id：user.page.head（sellerKey 为加密卖家标识）
   */
  async pcItemSeller(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    const itemId = String(opts.itemId || opts.item_id || '').trim()
    const sellerKey = String(opts.sellerKey || opts.seller_key || '').trim().slice(0, 256)
    const empty = {
      ok: false,
      sellerUserId: '',
      spm: '',
      imUrl: '',
      nick: '',
      avatar: '',
      error: '',
      httpStatus: 0
    }
    if (!itemId) return { ...empty, error: '缺少商品 ID' }
    if (!sellerKey || /^item:/i.test(sellerKey)) {
      return { ...empty, error: '缺少列表侧卖家标识，无法用 user.page.head 解析' }
    }
    if (!ck) return { ...empty, error: '缺少闲鱼登录 Cookie' }

    const head = await this.userPageHead(ck, { userId: sellerKey, self: false })
    if (!head.ok || !isMtopSuccess(head.mtopRawJson)) {
      return {
        ...empty,
        error: head.error || describeMtopFailureForClient(head.mtopRawJson),
        httpStatus: head.httpStatus || 0,
        client_mtop_cookie_updated: head.client_mtop_cookie_updated || ''
      }
    }
    const sellerUserId = String(pickPlainUserIdFromUserPageHead(head.mtopRawJson) || '').trim()
    const spm = pickSpmItemWantFromPcDetail({ data: {} })
    const imUrl =
      sellerUserId && itemId
        ? buildGoofishImWebUrl({ itemId, peerUserId: sellerUserId, spm }) || ''
        : ''
    return {
      ok: !!sellerUserId,
      sellerUserId,
      spm,
      imUrl,
      nick: head.nick,
      avatar: head.avatar,
      httpStatus: head.httpStatus || 0,
      fromUserPageHead: true,
      error: sellerUserId ? '' : '未解析到卖家明文 id',
      client_mtop_cookie_updated: head.client_mtop_cookie_updated || '',
      mtopRawJson: head.mtopRawJson
    }
  }

  async searchSuggest(cookie, opts = {}) {
    const ck = normalizeCookie(cookie)
    if (!ck) return { ok: false, error: '缺少 Cookie', suggestions: [] }
    const inputWords = String(opts.inputWords ?? opts.q ?? '')
      .trim()
      .slice(0, 120)
    if (!inputWords) return { ok: false, error: '缺少联想词 inputWords', suggestions: [] }

    let built
    try {
      built = await buildSignedSearchSuggestMtopRequest(ck, inputWords, {
        searchReqFromPage: opts.searchReqFromPage,
        bucketId: opts.bucketId,
        type: opts.type,
        skipPrepareClientCookie: true
      })
    } catch (e) {
      return { ok: false, error: String(e?.message || e || '签名失败'), suggestions: [] }
    }

    const { postRes } = await signAndPost(built, { forSearch: true })
    const json = postRes?.mtopRawJson ?? null
    const ok = postRes?.ok === true
    const suggestions = ok ? pickSearchSuggestTextsFromMtopJson(json) : []
    return {
      ok,
      suggestions,
      error: ok ? '' : String(postRes?.error || '联想请求失败'),
      httpStatus: postRes?.httpStatus || 0,
      client_mtop_cookie_updated: postRes?.client_mtop_cookie_updated || '',
      mtopRawJson: json
    }
  }

  async signMiaopaiPcItemDetail(cookie, itemId, opts = {}) {
    return buildSignedMiaopaiPcItemDetailRequest(itemId, normalizeCookie(cookie), {
      ...opts,
      skipPrepareClientCookie: true
    })
  }

  async signMiaopaiAddressList(cookie, opts = {}) {
    return buildSignedMiaopaiAddressListRequest(normalizeCookie(cookie), {
      ...opts,
      skipPrepareClientCookie: true
    })
  }

  async signMiaopaiOrderRender(payload, cookie, opts = {}) {
    return buildSignedMiaopaiOrderRenderRequest(payload, normalizeCookie(cookie), {
      ...opts,
      skipPrepareClientCookie: true
    })
  }

  async signMiaopaiCreateOrder(payload, cookie, opts = {}) {
    return buildSignedMiaopaiCreateOrderRequest(payload, normalizeCookie(cookie), {
      ...opts,
      skipPrepareClientCookie: true
    })
  }
}

/** 单例，供 IPC / 其它主进程模块复用 */
export const xianyuMtop = new XianyuMtopClient()
