/**
 * 本机秒拍/锁单：本机算签 + Electron 主进程 POST h5api（Cookie 来自账号分区）
 * 遇风控：直接返回提示（对齐移动端），不远程过码。
 */
import { postSignedMtopRequest } from './sxjk-post-signed-mtop.js'
import { xianyuMtop } from './xianyu-mtop-client.js'
import {
  executeLocalPcItemDetail,
  isMtopTokenExpiredMessage,
  isDetailFetchBlocked
} from './sxjk-local-pc-item-detail.js'
import { replaceX5secInAccountPartition } from './goofish-partition-cookie.js'
import { notifyAccountCookiePersisted } from './goofish-account-profile-sync.js'
import { resolveAccountMtopCookieForTask } from './goofish-account-mtop-cookie-resolve.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { syncGoofishCookiesIntoPartition } from './xianyu-goofish-electron-browse-window.js'
import { BrowserWindow } from 'electron'
import {
  invalidateMiaopaiDefaultDeliverId,
  resolveMiaopaiDefaultDeliverId,
  touchMiaopaiDefaultDeliverIdCookie
} from './miaopai-default-deliver-id-cache.js'
import {
  createAccountCookieContext,
  runMtopWithCaptchaRetry,
  formatLockOrderRiskError,
  LOCK_ORDER_RISK_STEP_LABEL,
  LOCK_ORDER_CAPTCHA_SOURCE
} from './sxjk-mtop-captcha-retry.js'

/** 锁单链路 MTOP 接口名（便于调试定位风控步骤） */
export const LOCK_ORDER_MTOP_APIS = {
  pcItemSeller: 'mtop.idle.web.user.page.head',
  pcItemDetail: 'mtop.taobao.idle.pc.detail',
  addressList: 'mtop.taobao.idle.logistic.address.list.query',
  orderRender: 'mtop.taobao.idle.trade.order.render',
  createOrder: 'mtop.taobao.idle.trade.order.create',
  yhbOrderRender: 'mtop.alibaba.idle.pc.yhb.order.create.render',
  yhbOrderCreate: 'mtop.alibaba.idle.pc.yhb.order.create'
}

const LOCK_ORDER_DEBUG_TAG = '[锁单调试]'

/** 锁单单次运行上下文（令牌过期 forceRefresh 需 electronDirname） */
let miaopaiOrderElectronDirname = ''

function mh5TkFromCookieHeader(header) {
  const m = String(header || '').match(/(?:^|;\s*)_m_h5_tk=([^;]+)/i)
  return m ? String(m[1] || '').trim() : ''
}

/** 令牌过期：强刷分区 _m_h5_tk 后重试一次 */
async function refreshMtopCookieAfterTokenExpiry(accountId, beforeCookie) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, cookie: '', error: '缺少账号 id' }
  const beforeTk = mh5TkFromCookieHeader(beforeCookie)
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '令牌过期，强制刷 mh5',
    accountId: id.slice(0, 32),
    beforeTk: beforeTk ? `${beforeTk.slice(0, 8)}…` : ''
  })
  const refreshed = await resolveAccountMtopCookieForTask(id, {
    fresh: true,
    forceRefresh: true,
    electronDirname: miaopaiOrderElectronDirname
  })
  const afterTk = mh5TkFromCookieHeader(refreshed.cookie)
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '刷 mh5 结果',
    accountId: id.slice(0, 32),
    ok: !!refreshed.ok,
    afterTk: afterTk ? `${afterTk.slice(0, 8)}…` : '',
    tokenChanged: !!(beforeTk && afterTk && beforeTk !== afterTk),
    refreshReason: refreshed?.refresh?.reason || ''
  })
  if (!refreshed.ok || !String(refreshed.cookie || '').trim()) {
    return {
      ok: false,
      cookie: '',
      error: refreshed.msg || refreshed.error || '登录凭证不可用，请重新登录'
    }
  }
  if (!afterTk) {
    return {
      ok: false,
      cookie: '',
      error: '登录凭证未更新，请重新登录'
    }
  }
  return { ok: true, cookie: refreshed.cookie, error: '' }
}

function recordLockOrderDebugStep(debugSteps, payload) {
  const row = {
    step: String(payload?.step || '').trim() || '—',
    api: String(payload?.api || '').trim() || '—',
    ok: !!payload?.ok,
    itemId: String(payload?.itemId || '').trim().slice(0, 32),
    accountId: String(payload?.accountId || '').trim().slice(0, 32)
  }
  if (payload?.fromCache === true) row.fromCache = true
  if (payload?.deliverId) row.deliverId = String(payload.deliverId).trim().slice(0, 32)
  if (Number.isFinite(payload?.cacheAgeSec)) row.cacheAgeSec = payload.cacheAgeSec
  if (!row.ok) {
    row.error = String(payload?.error || '').trim().slice(0, 500)
    if (isDetailFetchBlocked(row.error)) row.risk = true
  }
  if (payload?.captchaTried) row.captchaTried = true
  if (payload?.captchaScope) row.captchaScope = String(payload.captchaScope).trim()
  if (payload?.riskStepLabel && !row.ok) row.riskStepLabel = String(payload.riskStepLabel).trim()
  if (Array.isArray(debugSteps)) debugSteps.push(row)
  if (row.ok) console.info(LOCK_ORDER_DEBUG_TAG, row)
  else console.warn(LOCK_ORDER_DEBUG_TAG, row)
  return row
}

function attachLockOrderDebugFail(base, debugSteps, step, api, error, extra = {}) {
  return {
    ...base,
    failedStep: step,
    failedApi: api,
    riskStepLabel: String(extra.riskStepLabel || base.riskStepLabel || '').trim(),
    captchaTried: !!(extra.captchaTried ?? base.captchaTried),
    captchaOk: !!(extra.captchaOk ?? base.captchaOk),
    captchaScope: String(extra.captchaScope || base.captchaScope || '').trim(),
    debugSteps: Array.isArray(debugSteps) ? [...debugSteps] : []
  }
}

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

function formatPrice(raw) {
  const n = parseFloat(String(raw || '').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return ''
  return n.toFixed(2)
}

function pickItemBriefFromPcDetail(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return { title: '', price: '' }
  const norm = (v) => (v == null || v === '' ? '' : String(v).trim())
  const item = d.itemDO || d.itemInfo || d.item || {}
  let title = norm(item.title || item.subject || item.itemTitle || item.desc)
  let price = norm(
    item.soldPrice ||
      item.price ||
      item.currentPrice ||
      item.displayPrice ||
      item.originalPrice ||
      item.originalPriceString
  )
  if (!price && d.priceInfo && typeof d.priceInfo === 'object') {
    price = norm(d.priceInfo.price || d.priceInfo.text)
  }
  return { title, price }
}

function firstRetMessage(json) {
  const ret = json?.ret
  if (Array.isArray(ret) && ret.length) return String(ret[0] || '').trim()
  if (typeof ret === 'string') return ret.trim()
  return ''
}

function isMtopOk(json) {
  return String(firstRetMessage(json) || '').includes('SUCCESS')
}

function pickOrderIdFromResponse(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return ''
  const keys = ['orderId', 'order_id', 'bizOrderId', 'biz_order_id', 'mainOrderId']
  for (const k of keys) {
    const v = String(d[k] ?? '').trim()
    if (v) return v
  }
  if (d.orderDO && typeof d.orderDO === 'object') {
    for (const k of keys) {
      const v = String(d.orderDO[k] ?? '').trim()
      if (v) return v
    }
  }
  return ''
}

function mergeCookie(current, updated) {
  const next = String(updated || '').trim()
  return next || normalizeCookieHeader(current)
}

async function writebackAccountMtopCookie(accountId, cookieHeader) {
  const id = String(accountId || '').trim()
  const header = String(cookieHeader || '').trim()
  if (!id || !header) return
  try {
    await syncGoofishCookiesIntoPartition(partitionForListingAccount(id), header, [], {
      clearBeforeInject: false
    })
    /** 过码得到的 x5sec：显式覆盖分区旧值并 flush，避免只留在内存 Cookie 头里 */
    if (/(?:^|;\s*)x5sec=/i.test(header)) {
      const x5 = await replaceX5secInAccountPartition(id, header)
      if (x5?.ok) {
        // 云端是真源：不过码上行，下次 pull 会盖掉本机 x5sec
        const getWin = () => {
          try {
            return BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed()) || null
          } catch {
            return null
          }
        }
        notifyAccountCookiePersisted(getWin, id, { source: 'x5sec_captcha' })
      }
    }
  } catch (e) {
    console.warn('[本机秒拍] cookie writeback', id, e?.message || e)
  }
}

async function signMiaopai(path, cookie, extraBody = {}) {
  const client_mtop_cookie = normalizeCookieHeader(cookie)
  const p = String(path || '')
  let signed
  if (p.includes('signMiaopaiAddressList')) {
    signed = await xianyuMtop.signMiaopaiAddressList(client_mtop_cookie)
  } else if (p.includes('signMiaopaiOrderRender')) {
    signed = await xianyuMtop.signMiaopaiOrderRender(
      {
        itemId: extraBody.item_id || extraBody.itemId,
        deliverId: extraBody.deliver_id || extraBody.deliverId,
        skuId: extraBody.sku_id || extraBody.skuId,
        selectedPath: extraBody.selected_path || extraBody.selectedPath,
        buyQuantity: extraBody.buy_quantity || extraBody.buyQuantity,
        deliverType: extraBody.deliver_type || extraBody.deliverType
      },
      client_mtop_cookie,
      { yhb: !!(extraBody.yhb === 1 || extraBody.yhb === true || extraBody.yhb === '1') }
    )
  } else if (p.includes('signMiaopaiCreateOrder')) {
    signed = await xianyuMtop.signMiaopaiCreateOrder(
      {
        itemId: extraBody.item_id || extraBody.itemId,
        price: extraBody.price,
        deliverId: extraBody.deliver_id || extraBody.deliverId,
        mainItem: extraBody.main_item || extraBody.mainItem
      },
      client_mtop_cookie,
      { yhb: !!(extraBody.yhb === 1 || extraBody.yhb === true || extraBody.yhb === '1') }
    )
  } else if (p.includes('signMiaopaiPcItemDetail')) {
    signed = await xianyuMtop.signMiaopaiPcItemDetail(
      client_mtop_cookie,
      extraBody.item_id || extraBody.itemId
    )
  } else {
    throw new Error(`未知秒拍签名路径: ${p}`)
  }
  if (!signed?.requestUrl || signed.mtopData == null) {
    throw new Error('签名结果不完整')
  }
  return signed
}

async function signAndPost(path, cookie, extraBody = {}, postOpts = {}) {
  let ck = normalizeCookieHeader(cookie)
  const signed = await signMiaopai(path, ck, extraBody)
  const signCookie = String(signed.client_mtop_cookie_used || '').trim()
  ck = signCookie || mergeCookie(ck, signed.client_mtop_cookie_used)
  const postRes = await postSignedMtopRequest({
    requestUrl: signed.requestUrl,
    mtopData: String(signed.mtopData),
    cookie: ck,
    referer: signed.referer || 'https://www.goofish.com/',
    ...(signed.mtopExtHeaders && typeof signed.mtopExtHeaders === 'object'
      ? { mtopExtHeaders: signed.mtopExtHeaders }
      : {}),
    ...postOpts
  })
  ck = mergeCookie(ck, postRes.client_mtop_cookie_updated)
  return { postRes, cookie: ck }
}

/** 单次详情请求（不含过码重试） */
async function fetchPcItemDetailOnce(cookie, itemId, accountId, tokenRetried = false) {
  const id = String(itemId || '').trim()
  if (!id) return { ok: false, json: null, price: '', title: '', error: '缺少商品 ID', cookie }

  const raw = await executeLocalPcItemDetail({
    itemId: id,
    cookie,
    accountId
  })
  let ck = raw.cookie || normalizeCookieHeader(cookie)

  if (raw.ok && raw.json) {
    const brief = pickItemBriefFromPcDetail(raw.json)
    const price = formatPrice(brief.price)
    const title = String(brief.title || '').trim()
    if (!price) {
      return { ok: false, json: raw.json, price: '', title, error: '无法解析商品价格', cookie: ck }
    }
    return { ok: true, json: raw.json, price, title, error: '', cookie: ck }
  }

  const err = raw.error || '商品详情获取失败'
  if (isMtopTokenExpiredMessage(err) && accountId && !tokenRetried) {
    const again = await refreshMtopCookieAfterTokenExpiry(accountId, ck)
    if (again.ok && again.cookie) {
      return fetchPcItemDetailOnce(again.cookie, itemId, accountId, true)
    }
  }
  return { ok: false, json: raw.json || null, price: '', title: '', error: err, cookie: ck }
}

async function fetchPcItemDetailWithCaptcha(cookieCtx, itemId, accountId) {
  return runMtopWithCaptchaRetry({
    accountId,
    cookieCtx,
    source: LOCK_ORDER_CAPTCHA_SOURCE.detail,
    riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail,
    onCookieUpdated: (ck) => writebackAccountMtopCookie(accountId, ck),
    execute: async (ck) => fetchPcItemDetailOnce(ck, itemId, accountId)
  })
}

/** 单次地址请求（不含过码重试） */
async function fetchDefaultDeliverIdOnce(cookie, accountId, tokenRetried = false) {
  let ck = normalizeCookieHeader(cookie)
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '地址签名请求',
    api: 'signMiaopaiAddressList',
    accountId: String(accountId || '').trim().slice(0, 32),
    tokenRetried: !!tokenRetried
  })
  let { postRes, cookie: nextCk } = await signAndPost('/app/xy-sxjk/signMiaopaiAddressList', ck)
  ck = nextCk

  const json = postRes.mtopRawJson
  const addrOk = isMtopOk(json)
  const err = addrOk ? '' : postRes.error || firstRetMessage(json) || '收货地址获取失败'
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '地址MTOP响应',
    api: LOCK_ORDER_MTOP_APIS.addressList,
    accountId: String(accountId || '').trim().slice(0, 32),
    ok: addrOk,
    ...(addrOk ? {} : { error: String(err).slice(0, 300) })
  })
  if (!addrOk) {
    if (isMtopTokenExpiredMessage(err) && accountId && !tokenRetried) {
      invalidateMiaopaiDefaultDeliverId(accountId)
      const again = await refreshMtopCookieAfterTokenExpiry(accountId, ck)
      if (again.ok && again.cookie) {
        return fetchDefaultDeliverIdOnce(again.cookie, accountId, true)
      }
    }
    return { ok: false, deliverId: '', error: err, cookie: ck, json }
  }
  const responseData = json?.data || {}
  const innerData = responseData.data || {}
  const addressList = innerData.addressList || responseData.addressList || []
  const list = parseDeliverAddressList(addressList)
  if (!list.length) {
    return { ok: false, deliverId: '', list: [], error: '账号未配置收货地址', cookie: ck, json }
  }
  const deliverId = String(list[0]?.addressId ?? '').trim()
  if (!deliverId) {
    return { ok: false, deliverId: '', list, error: '收货地址 ID 无效', cookie: ck, json }
  }
  return { ok: true, deliverId, list, error: '', cookie: ck, json }
}

function formatDeliverAddressLabel(row) {
  if (!row || typeof row !== 'object') return ''
  const name = String(row.name || row.fullName || row.consignee || '').trim()
  const mobile = String(row.mobile || row.phone || row.mobilePhone || '').trim()
  const prov = String(row.prov || row.province || row.provinceName || '').trim()
  const city = String(row.city || row.cityName || '').trim()
  const area = String(row.area || row.district || row.areaName || '').trim()
  const detail = String(row.addressDetail || row.address || row.detailAddress || '').trim()
  const place = [prov, city, area, detail].filter(Boolean).join('')
  return [name, mobile, place].filter(Boolean).join(' · ') || String(row.addressId || '').trim()
}

function parseDeliverAddressList(addressList) {
  if (!Array.isArray(addressList)) return []
  const out = []
  for (const row of addressList) {
    const addressId = String(row?.addressId ?? '').trim()
    if (!addressId) continue
    out.push({ addressId, label: formatDeliverAddressLabel(row) })
  }
  return out
}

/**
 * 编辑任务绑定时列出账号收货地址
 * @param {{ accountId: string, electronDirname?: string }} opts
 */
export async function listLocalMiaopaiDeliverAddresses(opts = {}) {
  const accountId = String(opts?.accountId || '').trim()
  if (!accountId) return { ok: false, list: [], deliverId: '', error: '缺少秒拍账号' }
  miaopaiOrderElectronDirname = String(opts?.electronDirname || '').trim()
  try {
    const snap = await resolveAccountMtopCookieForTask(accountId, {
      electronDirname: miaopaiOrderElectronDirname
    })
    if (!snap.ok) {
      return {
        ok: false,
        list: [],
        deliverId: '',
        error: snap.msg || snap.error || '该账号无有效登录凭证'
      }
    }
    const cookieCtx = createAccountCookieContext(accountId, snap.cookie)
    const out = await fetchDefaultDeliverIdWithCaptcha(cookieCtx, accountId)
    if (out.cookie && out.cookie !== snap.cookie) {
      await writebackAccountMtopCookie(accountId, out.cookie)
    }
    if (!out.ok) {
      return { ok: false, list: [], deliverId: '', error: out.error || '收货地址获取失败' }
    }
    return {
      ok: true,
      list: Array.isArray(out.list) ? out.list : [],
      deliverId: String(out.deliverId || '').trim(),
      error: ''
    }
  } finally {
    miaopaiOrderElectronDirname = ''
  }
}

async function fetchDefaultDeliverIdWithCaptcha(cookieCtx, accountId) {
  return runMtopWithCaptchaRetry({
    accountId,
    cookieCtx,
    source: LOCK_ORDER_CAPTCHA_SOURCE.address,
    riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.address,
    onCookieUpdated: (ck) => writebackAccountMtopCookie(accountId, ck),
    execute: async (ck) => fetchDefaultDeliverIdOnce(ck, accountId)
  })
}

async function resolveDefaultDeliverId(cookieCtx, accountId, opts = {}) {
  const preferred = String(opts.deliverId || '').trim()
  if (preferred) {
    return { ok: true, deliverId: preferred, error: '', cookie: cookieCtx.get(), fromCache: true }
  }
  return resolveMiaopaiDefaultDeliverId(
    accountId,
    cookieCtx.get(),
    async (ck) => {
      cookieCtx.set(ck)
      return fetchDefaultDeliverIdWithCaptcha(cookieCtx, accountId)
    },
    opts
  )
}

/** 列表项是否像验货宝（预判走 create-order-yhb） */
function looksLikeYhbItem(item) {
  if (!item || typeof item !== 'object') return false
  const label = String(item.yanhuobaoLabel || '').trim()
  if (label && /验货/.test(label)) return true
  if (String(item.yanhuobaoIconUrl || '').trim()) return true
  const product = String(item.product || item.itemProduct || '').trim().toLowerCase()
  if (product === 'yhb') return true
  return false
}

/** 普通 create 被拒：必须走验货宝 */
function isYhbOnlyBuyError(msg) {
  const s = String(msg || '')
  if (!s) return false
  const u = s.toUpperCase()
  return (
    u.includes('ONLY_YHB') ||
    u.includes('YHB_BUY') ||
    s.includes('必走验货宝') ||
    s.includes('不支持普通链路')
  )
}

function pickMainItemFromRender(json) {
  const list = json?.data?.commonData?.itemBuyInfo
  if (!Array.isArray(list)) return null
  return list.find((row) => String(row?.mainItem) === 'true') || list[0] || null
}

/** 验货宝 render 价：itemInfo.price / totalAmount */
function pickPriceFromYhbRender(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return ''
  const fromItem = formatPrice(d.itemInfo?.price)
  if (fromItem) return fromItem
  return formatPrice(d.totalAmount || d.price)
}

function mtopApiForLockOrder(step, yhb) {
  if (step === 'render') {
    return yhb ? LOCK_ORDER_MTOP_APIS.yhbOrderRender : LOCK_ORDER_MTOP_APIS.orderRender
  }
  return yhb ? LOCK_ORDER_MTOP_APIS.yhbOrderCreate : LOCK_ORDER_MTOP_APIS.createOrder
}

/** 单次订单 render（不含过码重试） */
async function renderOrderOnce(cookie, itemId, deliverId, accountId, opts = {}) {
  const yhb = !!opts.yhb
  const tokenRetried = !!opts.tokenRetried
  let ck = normalizeCookieHeader(cookie)
  const renderApi = mtopApiForLockOrder('render', yhb)
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '订单确认签名请求',
    api: 'signMiaopaiOrderRender',
    mtopApi: renderApi,
    accountId: String(accountId || '').trim().slice(0, 32),
    itemId: String(itemId || '').trim().slice(0, 32),
    deliverId: String(deliverId || '').trim().slice(0, 32),
    yhb,
    tokenRetried
  })
  let { postRes, cookie: nextCk } = await signAndPost(
    '/app/xy-sxjk/signMiaopaiOrderRender',
    ck,
    {
      item_id: itemId,
      deliver_id: deliverId,
      yhb: yhb ? 1 : 0,
      sku_id: opts.skuId || '',
      selected_path: opts.selectedPath || ''
    },
    { forCreateOrder: true }
  )
  ck = nextCk

  const json = postRes.mtopRawJson
  const renderOk = isMtopOk(json)
  const err = renderOk ? '' : postRes.error || firstRetMessage(json) || '订单确认失败'
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '订单确认MTOP响应',
    api: renderApi,
    accountId: String(accountId || '').trim().slice(0, 32),
    itemId: String(itemId || '').trim().slice(0, 32),
    yhb,
    ok: renderOk,
    ...(renderOk ? {} : { error: String(err).slice(0, 300) })
  })
  if (!renderOk) {
    if (isMtopTokenExpiredMessage(err) && accountId && !tokenRetried) {
      invalidateMiaopaiDefaultDeliverId(accountId)
      const again = await refreshMtopCookieAfterTokenExpiry(accountId, ck)
      if (again.ok && again.cookie) {
        return renderOrderOnce(again.cookie, itemId, deliverId, accountId, {
          ...opts,
          tokenRetried: true
        })
      }
    }
    return { ok: false, json, mainItem: null, error: err, cookie: ck, yhb }
  }
  // 验货宝 render 结构不同，不依赖 commonData.itemBuyInfo
  if (yhb) {
    return {
      ok: true,
      json,
      mainItem: null,
      price: pickPriceFromYhbRender(json),
      error: '',
      cookie: ck,
      yhb
    }
  }
  const mainItem = pickMainItemFromRender(json)
  if (!mainItem) {
    return {
      ok: false,
      json,
      mainItem: null,
      error: '订单确认结果缺少商品信息',
      cookie: ck,
      yhb
    }
  }
  return { ok: true, json, mainItem, error: '', cookie: ck, yhb }
}

async function renderOrderWithCaptcha(cookieCtx, itemId, deliverId, accountId, opts = {}) {
  return runMtopWithCaptchaRetry({
    accountId,
    cookieCtx,
    source: LOCK_ORDER_CAPTCHA_SOURCE.orderRender,
    riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.orderRender,
    onCookieUpdated: (ck) => writebackAccountMtopCookie(accountId, ck),
    execute: async (ck) => renderOrderOnce(ck, itemId, deliverId, accountId, opts)
  })
}

/** 单次下单（不含过码重试）；普通用 render 的 mainItem，验货宝用 buyerAddressId */
async function submitCreateOrderOnce(cookie, opts = {}) {
  const {
    itemId,
    price,
    deliverId,
    mainItem,
    yhb = false,
    accountId,
    tokenRetried = false
  } = opts
  let ck = normalizeCookieHeader(cookie)
  const createApi = mtopApiForLockOrder('create', !!yhb)
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '下单签名请求',
    api: 'signMiaopaiCreateOrder',
    mtopApi: createApi,
    accountId: String(accountId || '').trim().slice(0, 32),
    itemId: String(itemId || '').trim().slice(0, 32),
    deliverId: String(deliverId || '').trim().slice(0, 32),
    yhb: !!yhb,
    hasMainItem: !!(mainItem && typeof mainItem === 'object'),
    tokenRetried: !!tokenRetried
  })
  const body = {
    item_id: itemId,
    yhb: yhb ? 1 : 0
  }
  if (yhb) {
    body.deliver_id = deliverId
  } else if (mainItem && typeof mainItem === 'object') {
    body.main_item = mainItem
  } else {
    body.price = price
    body.deliver_id = deliverId
  }
  let { postRes, cookie: nextCk } = await signAndPost(
    '/app/xy-sxjk/signMiaopaiCreateOrder',
    ck,
    body,
    { forCreateOrder: true }
  )
  ck = nextCk

  const json = postRes.mtopRawJson
  const orderOk = isMtopOk(json)
  const err = orderOk ? '' : postRes.error || firstRetMessage(json) || '下单失败'
  console.info(LOCK_ORDER_DEBUG_TAG, {
    step: '下单MTOP响应',
    api: createApi,
    accountId: String(accountId || '').trim().slice(0, 32),
    itemId: String(itemId || '').trim().slice(0, 32),
    yhb: !!yhb,
    ok: orderOk,
    ...(orderOk ? {} : { error: String(err).slice(0, 300) })
  })
  if (!orderOk) {
    if (isMtopTokenExpiredMessage(err) && accountId && !tokenRetried) {
      invalidateMiaopaiDefaultDeliverId(accountId)
      const again = await refreshMtopCookieAfterTokenExpiry(accountId, ck)
      if (again.ok && again.cookie) {
        return submitCreateOrderOnce(again.cookie, { ...opts, tokenRetried: true })
      }
    }
    return { ok: false, json, error: err, cookie: ck, yhb: !!yhb }
  }
  return {
    ok: true,
    json,
    orderId: pickOrderIdFromResponse(json),
    error: '',
    cookie: ck,
    yhb: !!yhb
  }
}

async function submitCreateOrderWithCaptcha(cookieCtx, opts = {}) {
  const accountId = opts.accountId
  return runMtopWithCaptchaRetry({
    accountId,
    cookieCtx,
    source: LOCK_ORDER_CAPTCHA_SOURCE.createOrder,
    riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.createOrder,
    onCookieUpdated: (ck) => writebackAccountMtopCookie(accountId, ck),
    execute: async (ck) => submitCreateOrderOnce(ck, opts)
  })
}

/**
 * render → create；列表预判验货宝，或撞 ONLY_YHB 后再切 YHB 重试一次
 */
async function renderAndCreateOrder(cookieCtx, {
  itemId,
  price,
  deliverId,
  accountId,
  yhbPreferred = false,
  debugSteps
}) {
  let yhb = !!yhbPreferred
  let captchaMeta = { captchaTried: false, captchaOk: false, captchaScope: '', riskStepLabel: '' }

  const runOnce = async (useYhb) => {
    const renderApi = mtopApiForLockOrder('render', useYhb)
    const createApi = mtopApiForLockOrder('create', useYhb)
    recordLockOrderDebugStep(debugSteps, {
      step: useYhb ? '开始确认订单（验货宝）' : '开始确认订单',
      api: renderApi,
      ok: true,
      itemId,
      accountId,
      deliverId
    })
    const renderOut = await renderOrderWithCaptcha(cookieCtx, itemId, deliverId, accountId, {
      yhb: useYhb
    })
    captchaMeta = mergeCaptchaMeta(captchaMeta, renderOut)
    if (renderOut.cookie) cookieCtx.set(renderOut.cookie)

    if (!renderOut.ok) {
      const err = formatLockOrderRiskError(
        LOCK_ORDER_RISK_STEP_LABEL.orderRender,
        renderOut.error || '订单确认失败'
      )
      recordLockOrderDebugStep(debugSteps, {
        step: '确认订单',
        api: renderApi,
        ok: false,
        error: err,
        itemId,
        accountId,
        captchaTried: renderOut.captchaTried,
        captchaScope: renderOut.captchaScope,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.orderRender
      })
      return {
        ok: false,
        stage: 'render',
        error: err,
        rawError: renderOut.error || '',
        cookie: renderOut.cookie || cookieCtx.get(),
        mainItem: null,
        orderId: '',
        yhb: useYhb,
        ...captchaMeta,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.orderRender,
        captchaTried: renderOut.captchaTried,
        captchaOk: renderOut.captchaOk,
        captchaScope: renderOut.captchaScope
      }
    }

    recordLockOrderDebugStep(debugSteps, {
      step: useYhb ? '确认订单（验货宝）' : '确认订单',
      api: renderApi,
      ok: true,
      itemId,
      accountId,
      captchaTried: renderOut.captchaTried,
      captchaScope: renderOut.captchaScope
    })

    const mainItem = renderOut.mainItem
    const renderPrice =
      (useYhb ? formatPrice(renderOut.price) : '') ||
      formatPrice(mainItem?.price) ||
      price

    recordLockOrderDebugStep(debugSteps, {
      step: useYhb ? '开始创建订单（验货宝）' : '开始创建订单',
      api: createApi,
      ok: true,
      itemId,
      accountId,
      deliverId
    })
    const orderOut = await submitCreateOrderWithCaptcha(cookieCtx, {
      itemId,
      price: renderPrice,
      deliverId,
      mainItem: useYhb ? null : mainItem,
      yhb: useYhb,
      accountId
    })
    captchaMeta = mergeCaptchaMeta(captchaMeta, orderOut)
    if (orderOut.cookie) cookieCtx.set(orderOut.cookie)

    if (!orderOut.ok) {
      const rawErr = orderOut.error || '下单失败'
      const err = formatLockOrderRiskError(LOCK_ORDER_RISK_STEP_LABEL.createOrder, rawErr)
      recordLockOrderDebugStep(debugSteps, {
        step: '创建订单',
        api: createApi,
        ok: false,
        error: err,
        itemId,
        accountId,
        captchaTried: orderOut.captchaTried,
        captchaScope: orderOut.captchaScope,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.createOrder
      })
      return {
        ok: false,
        stage: 'create',
        error: err,
        rawError: rawErr,
        cookie: orderOut.cookie || cookieCtx.get(),
        mainItem,
        price: renderPrice,
        orderId: '',
        yhb: useYhb,
        ...captchaMeta,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.createOrder,
        captchaTried: orderOut.captchaTried,
        captchaOk: orderOut.captchaOk,
        captchaScope: orderOut.captchaScope
      }
    }

    recordLockOrderDebugStep(debugSteps, {
      step: '创建订单',
      api: createApi,
      ok: true,
      itemId,
      accountId,
      captchaTried: orderOut.captchaTried,
      captchaScope: orderOut.captchaScope,
      riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.createOrder
    })
    return {
      ok: true,
      stage: 'create',
      error: '',
      rawError: '',
      cookie: orderOut.cookie || cookieCtx.get(),
      mainItem,
      price: renderPrice,
      orderId: orderOut.orderId || '',
      yhb: useYhb,
      ...captchaMeta,
      riskStepLabel: ''
    }
  }

  let out = await runOnce(yhb)
  if (
    !out.ok &&
    !yhb &&
    isYhbOnlyBuyError(out.rawError || out.error)
  ) {
    console.info(LOCK_ORDER_DEBUG_TAG, {
      step: '检测到必走验货宝，切换验货宝链路重试',
      itemId: String(itemId || '').trim().slice(0, 32),
      accountId: String(accountId || '').trim().slice(0, 32),
      prevStage: out.stage,
      prevError: String(out.rawError || out.error || '').slice(0, 200)
    })
    recordLockOrderDebugStep(debugSteps, {
      step: '切换验货宝链路重试',
      api: LOCK_ORDER_MTOP_APIS.orderRender,
      ok: true,
      itemId,
      accountId
    })
    out = await runOnce(true)
  }
  return out
}

function isOrderMissingSkuError(msg) {
  const s = String(msg || '')
  const u = s.toUpperCase()
  return u.includes('MISSING_SKU') || s.includes('需要选择sku') || s.includes('需要选择SKU')
}

function mergeCaptchaMeta(acc, stepResult) {
  return {
    captchaTried: !!(acc.captchaTried || stepResult?.captchaTried),
    captchaOk: stepResult?.captchaTried ? !!stepResult?.captchaOk : !!acc.captchaOk,
    captchaScope: String(stepResult?.captchaScope || acc.captchaScope || '').trim(),
    riskStepLabel: String(stepResult?.riskStepLabel || acc.riskStepLabel || '').trim()
  }
}

async function runMiaopaiSingleSkuOrder(opts) {
  const accountId = String(opts?.accountId || '').trim()
  let cookie = normalizeCookieHeader(opts?.cookie)
  const item = opts?.item && typeof opts.item === 'object' ? opts.item : {}
  const itemId = String(item.itemId || item.item_id || opts?.itemId || '').trim()
  /** @type {Array<{ step: string, api: string, ok: boolean, error?: string, risk?: boolean }>} */
  const debugSteps = []
  let captchaMeta = { captchaTried: false, captchaOk: false, captchaScope: '', riskStepLabel: '' }

  if (!cookie) {
    return attachLockOrderDebugFail(
      { ok: false, itemId, title: '', price: '', orderId: '', error: '秒拍账号 Cookie 无效', msg: '秒拍账号 Cookie 无效' },
      debugSteps,
      '读取账号 Cookie',
      '—',
      '秒拍账号 Cookie 无效'
    )
  }
  if (!itemId) {
    return attachLockOrderDebugFail(
      { ok: false, itemId: '', title: '', price: '', orderId: '', error: '缺少商品 ID', msg: '缺少商品 ID' },
      debugSteps,
      '参数校验',
      '—',
      '缺少商品 ID'
    )
  }

  const cookieCtx = createAccountCookieContext(accountId, cookie)
  const onCookie = (ck) => writebackAccountMtopCookie(accountId, ck)

  let title = String(item.title || '').trim()
  let price = formatPrice(item.price)

  const preDetail = opts?.preDetail
  let detail = null
  if (preDetail && typeof preDetail === 'object') {
    detail = preDetail
    if (detail.cookie) {
      cookieCtx.set(detail.cookie)
      cookie = detail.cookie
    }
  } else if (price) {
    // 推送/秒拍已带价格：跳过 pc.detail，少一次最易风控的请求
    recordLockOrderDebugStep(debugSteps, {
      step: '跳过拉商品详情（已有价格）',
      api: LOCK_ORDER_MTOP_APIS.pcItemDetail,
      ok: true,
      itemId,
      accountId
    })
  } else {
    detail = await fetchPcItemDetailWithCaptcha(cookieCtx, itemId, accountId)
    captchaMeta = mergeCaptchaMeta(captchaMeta, detail)
    if (detail.cookie) {
      cookie = detail.cookie
      await onCookie(cookie)
    }
  }

  if (detail) {
    if (!detail.ok) {
      const err = formatLockOrderRiskError(
        LOCK_ORDER_RISK_STEP_LABEL.detail,
        detail.error || '商品详情获取失败'
      )
      recordLockOrderDebugStep(debugSteps, {
        step: '拉商品详情',
        api: LOCK_ORDER_MTOP_APIS.pcItemDetail,
        ok: false,
        error: err,
        itemId,
        accountId,
        captchaTried: detail.captchaTried,
        captchaScope: detail.captchaScope,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
      })
      return attachLockOrderDebugFail(
        {
          ok: false,
          itemId,
          title,
          price: '',
          orderId: '',
          error: err,
          msg: err,
          cookie: detail.cookie || cookie,
          ...captchaMeta,
          riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
        },
        debugSteps,
        '拉商品详情',
        LOCK_ORDER_MTOP_APIS.pcItemDetail,
        err,
        {
          riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail,
          captchaTried: detail.captchaTried,
          captchaOk: detail.captchaOk,
          captchaScope: detail.captchaScope
        }
      )
    }

    if (detail.ok && detail.price) {
      price = detail.price
      if (detail.title) title = detail.title
      recordLockOrderDebugStep(debugSteps, {
        step: '拉商品详情',
        api: LOCK_ORDER_MTOP_APIS.pcItemDetail,
        ok: true,
        itemId,
        accountId,
        captchaTried: detail.captchaTried,
        captchaScope: detail.captchaScope,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
      })
    } else if (!price) {
      const err = formatLockOrderRiskError(
        LOCK_ORDER_RISK_STEP_LABEL.detail,
        detail.error || '无法获取商品价格'
      )
      recordLockOrderDebugStep(debugSteps, {
        step: '拉商品详情',
        api: LOCK_ORDER_MTOP_APIS.pcItemDetail,
        ok: false,
        error: err,
        itemId,
        accountId,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
      })
      return attachLockOrderDebugFail(
        {
          ok: false,
          itemId,
          title,
          price: '',
          orderId: '',
          error: err,
          msg: err,
          cookie,
          ...captchaMeta,
          riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
        },
        debugSteps,
        '拉商品详情',
        LOCK_ORDER_MTOP_APIS.pcItemDetail,
        err,
        { riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail }
      )
    }
  }

  if (!price) {
    const err = formatLockOrderRiskError(LOCK_ORDER_RISK_STEP_LABEL.detail, '无法获取商品价格')
    return attachLockOrderDebugFail(
      {
        ok: false,
        itemId,
        title,
        price: '',
        orderId: '',
        error: err,
        msg: err,
        cookie,
        ...captchaMeta,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail
      },
      debugSteps,
      '拉商品详情',
      LOCK_ORDER_MTOP_APIS.pcItemDetail,
      err,
      { riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.detail }
    )
  }

  recordLockOrderDebugStep(debugSteps, {
    step: '开始拉收货地址',
    api: LOCK_ORDER_MTOP_APIS.addressList,
    ok: true,
    itemId,
    accountId
  })
  const addr = await resolveDefaultDeliverId(cookieCtx, accountId, {
    deliverId: opts.deliverId
  })
  captchaMeta = mergeCaptchaMeta(captchaMeta, addr)
  if (addr.cookie) {
    cookie = addr.cookie
    /** 缓存命中无需再整头注入分区，避免无意义刷屏 */
    if (!addr.fromCache) await onCookie(cookie)
  }
  if (addr.ok && accountId) touchMiaopaiDefaultDeliverIdCookie(accountId, cookie)
  if (!addr.ok) {
    const err = formatLockOrderRiskError(
      LOCK_ORDER_RISK_STEP_LABEL.address,
      addr.error || '无法获取收货地址'
    )
    recordLockOrderDebugStep(debugSteps, {
      step: '拉收货地址',
      api: LOCK_ORDER_MTOP_APIS.addressList,
      ok: false,
      error: err,
      itemId,
      accountId,
      captchaTried: addr.captchaTried,
      captchaScope: addr.captchaScope,
      riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.address
    })
    return attachLockOrderDebugFail(
      {
        ok: false,
        itemId,
        title,
        price,
        orderId: '',
        error: err,
        msg: err,
        cookie,
        ...captchaMeta,
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.address
      },
      debugSteps,
      '拉收货地址',
      LOCK_ORDER_MTOP_APIS.addressList,
      err,
      {
        riskStepLabel: LOCK_ORDER_RISK_STEP_LABEL.address,
        captchaTried: addr.captchaTried,
        captchaOk: addr.captchaOk,
        captchaScope: addr.captchaScope
      }
    )
  }
  recordLockOrderDebugStep(debugSteps, {
    step: addr.fromCache ? '使用缓存收货地址' : '拉收货地址',
    api: LOCK_ORDER_MTOP_APIS.addressList,
    ok: true,
    itemId,
    accountId,
    fromCache: !!addr.fromCache,
    deliverId: addr.deliverId,
    cacheAgeSec: addr.cacheAgeSec,
    captchaTried: addr.captchaTried,
    captchaScope: addr.captchaScope
  })

  const yhbPreferred = looksLikeYhbItem(item)
  if (yhbPreferred) {
    recordLockOrderDebugStep(debugSteps, {
      step: '列表识别为验货宝，走验货宝下单',
      api: LOCK_ORDER_MTOP_APIS.orderRender,
      ok: true,
      itemId,
      accountId
    })
  }

  const orderOut = await renderAndCreateOrder(cookieCtx, {
    itemId,
    price,
    deliverId: addr.deliverId,
    accountId,
    yhbPreferred,
    debugSteps
  })
  captchaMeta = mergeCaptchaMeta(captchaMeta, orderOut)
  if (orderOut.cookie) {
    cookie = orderOut.cookie
    await onCookie(cookie)
  }
  if (orderOut.price) price = orderOut.price

  if (!orderOut.ok) {
    const rawErr = orderOut.rawError || orderOut.error || '下单失败'
    if (isOrderMissingSkuError(rawErr)) {
      const multiErr = '该商品有多规格，当前不支持多规格秒拍'
      recordLockOrderDebugStep(debugSteps, {
        step: orderOut.stage === 'render' ? '确认订单' : '创建订单',
        api:
          orderOut.stage === 'render'
            ? LOCK_ORDER_MTOP_APIS.orderRender
            : LOCK_ORDER_MTOP_APIS.createOrder,
        ok: false,
        error: multiErr,
        itemId,
        accountId,
        riskStepLabel:
          orderOut.stage === 'render'
            ? LOCK_ORDER_RISK_STEP_LABEL.orderRender
            : LOCK_ORDER_RISK_STEP_LABEL.createOrder
      })
      return attachLockOrderDebugFail(
        {
          ok: false,
          itemId,
          title,
          price,
          orderId: '',
          error: multiErr,
          msg: multiErr,
          cookie,
          ...captchaMeta,
          riskStepLabel:
            orderOut.stage === 'render'
              ? LOCK_ORDER_RISK_STEP_LABEL.orderRender
              : LOCK_ORDER_RISK_STEP_LABEL.createOrder
        },
        debugSteps,
        orderOut.stage === 'render' ? '确认订单' : '创建订单',
        orderOut.stage === 'render'
          ? LOCK_ORDER_MTOP_APIS.orderRender
          : LOCK_ORDER_MTOP_APIS.createOrder,
        multiErr,
        {
          riskStepLabel:
            orderOut.stage === 'render'
              ? LOCK_ORDER_RISK_STEP_LABEL.orderRender
              : LOCK_ORDER_RISK_STEP_LABEL.createOrder
        }
      )
    }
    const stepLabel =
      orderOut.stage === 'render'
        ? LOCK_ORDER_RISK_STEP_LABEL.orderRender
        : LOCK_ORDER_RISK_STEP_LABEL.createOrder
    const stepApi =
      orderOut.stage === 'render'
        ? LOCK_ORDER_MTOP_APIS.orderRender
        : LOCK_ORDER_MTOP_APIS.createOrder
    const stepName = orderOut.stage === 'render' ? '确认订单' : '创建订单'
    const err = orderOut.error || formatLockOrderRiskError(stepLabel, rawErr)
    return attachLockOrderDebugFail(
      {
        ok: false,
        itemId,
        title,
        price,
        orderId: '',
        error: err,
        msg: err,
        cookie,
        ...captchaMeta,
        riskStepLabel: orderOut.riskStepLabel || stepLabel
      },
      debugSteps,
      stepName,
      stepApi,
      err,
      {
        riskStepLabel: orderOut.riskStepLabel || stepLabel,
        captchaTried: orderOut.captchaTried,
        captchaOk: orderOut.captchaOk,
        captchaScope: orderOut.captchaScope
      }
    )
  }
  if (accountId) touchMiaopaiDefaultDeliverIdCookie(accountId, orderOut.cookie || cookie)

  const orderId = orderOut.orderId || ''
  const msg = orderId ? `锁单成功，订单 ${orderId}` : '锁单成功'
  return {
    ok: true,
    itemId,
    title,
    price,
    orderId,
    error: '',
    msg,
    accountId,
    cookie: orderOut.cookie || cookie,
    debugSteps,
    ...captchaMeta,
    riskStepLabel: ''
  }
}

/**
 * @param {{ accountId?: string, cookie?: string, item?: object, itemId?: string }} opts
 */
export async function runLocalMiaopaiOrder(opts) {
  const accountId = String(opts?.accountId || '').trim()
  miaopaiOrderElectronDirname = String(opts?.electronDirname || '').trim()
  let cookie = normalizeCookieHeader(opts?.cookie)
  const item = opts?.item && typeof opts.item === 'object' ? opts.item : {}
  const itemId = String(item.itemId || item.item_id || opts?.itemId || '').trim()

  try {
    if (!cookie && accountId) {
      const snap = await resolveAccountMtopCookieForTask(accountId, {
        electronDirname: miaopaiOrderElectronDirname
      })
      if (!snap.ok) {
        return {
          ok: false,
          itemId,
          error: snap.msg || snap.error || '该账号无有效登录凭证',
          msg: snap.msg || snap.error || '该账号无有效登录凭证'
        }
      }
      cookie = snap.cookie
    }

    if (!cookie) {
      return { ok: false, itemId, title: '', price: '', orderId: '', error: '秒拍账号 Cookie 无效', msg: '秒拍账号 Cookie 无效' }
    }
    if (!itemId) {
      return { ok: false, itemId: '', title: '', price: '', orderId: '', error: '缺少商品 ID', msg: '缺少商品 ID' }
    }

    return runMiaopaiSingleSkuOrder({
      accountId,
      cookie,
      item,
      itemId,
      deliverId: String(opts?.deliverId || '').trim()
    })
  } finally {
    miaopaiOrderElectronDirname = ''
  }
}
