/**
 * 秒拍相关 MTOP 仅算签（Electron 主进程）
 * 自 server/modules/goofish/miaopai-order.js 抽取签名部分。
 */
const crypto = require('crypto')
const {
  buildConfigFromCookie,
  resolveMh5Tk,
  getTokenFromMH5Tk,
  calcMtopSign,
  buildRequestUrl,
  buildPcDetailData,
  buildPcItemDetailSpmContext,
  resolveMtopSessionOptionForCookie,
  prepareClientMtopCookie
} = require('./mtop-sign')

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

const MTOP_APP_KEY = '34839810'
const MTOP_JSV = '2.7.2'
const MTOP_H5_BASE = 'https://h5api.m.goofish.com/h5'
const ADDRESS_API = 'mtop.taobao.idle.logistic.address.list.query'
const ORDER_RENDER_API = 'mtop.taobao.idle.trade.order.render'
const ORDER_CREATE_API = 'mtop.taobao.idle.trade.order.create'
/** 官网 create-order-yhb 专用（非 trade.order.*） */
const YHB_ORDER_RENDER_API = 'mtop.alibaba.idle.pc.yhb.order.create.render'
const YHB_ORDER_CREATE_API = 'mtop.alibaba.idle.pc.yhb.order.create'
/** 与 xy-site create-order-yhb 前端包一致 */
const YHB_ORDER_ASAC = '2A22C090BE30KORG6Q44JJ'

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
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

function formatPrice(raw) {
  const n = parseFloat(String(raw || '').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return ''
  return n.toFixed(2)
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

/** 列表/推送项是否像验货宝（预判走 create-order-yhb） */
function looksLikeYhbItem(item) {
  if (!item || typeof item !== 'object') return false
  const label = String(item.yanhuobaoLabel || '').trim()
  if (label && /验货/.test(label)) return true
  if (String(item.yanhuobaoIconUrl || '').trim()) return true
  const product = String(item.product || item.itemProduct || '').trim().toLowerCase()
  if (product === 'yhb') return true
  return false
}

/** 普通 create 被拒：必须走验货宝链路 */
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

/** 官网 create-order：先 render 再把 mainItem 原样 create */
function buildOrderRenderData(itemId, deliverId, opts = {}) {
  const data = { itemId: String(itemId) }
  const qty = String(opts.buyQuantity || '1').trim()
  if (qty) data.buyQuantity = qty
  const did = String(deliverId || '').trim()
  if (did) {
    data.deliverId = did
    data.deliverType = String(opts.deliverType || '1')
  }
  const skuId = String(opts.skuId || '').trim()
  if (skuId) {
    data.skuId = skuId
    const selectedPath = String(opts.selectedPath || '').trim()
    data.frontParams = {
      skuData: {
        selectedPath: skuId === '0' ? '' : selectedPath,
        skuId
      }
    }
  }
  return data
}

function buildCreateDataFromMainItem(mainItem) {
  if (!mainItem || typeof mainItem !== 'object') {
    throw new Error('缺少 render 返回的 mainItem')
  }
  return JSON.stringify({ params: JSON.stringify([mainItem]) })
}

/** 旧手拼 body：仅作无 render 时的兜底（验货宝会失败） */
function buildOrderRequestBody(itemId, price, deliverId) {
  const alipayStreamRule = JSON.stringify({
    allowedAppVersion: '7.21.30',
    deviceEnum: 'OTHERS',
    hasAlipayAppInDevice: false,
    hasBindAlipay: true,
    hasCardVo: false,
    hitAb: true,
    itemHasService: false
  })
  const wechatPayRule = JSON.stringify({
    allowedAppVersion: '7.22.90',
    crossBorderItem: false,
    deviceEnum: 'OTHERS',
    hasCardVo: false,
    hasGoldStandard: false,
    hasWechatInDevice: false,
    hitAb: false,
    idleMarketItem: false,
    itemHasService: false,
    miniGameInAppPurchaseItem: false,
    selectMeanTimeItem: false,
    selectOpenCard: false
  })
  const urlParams = JSON.stringify({
    unitPrice: price,
    totalPrice: price,
    alipayStreamRule,
    wechatPayRule
  })
  const meanTimeItemId = String(itemId)
  const inventory = '1'
  const paramObject = {
    adjust: 'true',
    buyQuantity: '1',
    changeMeanTimeItem: 'false',
    deliverId: String(deliverId),
    deliverType: '1',
    disable: 'false',
    freeze: 'none',
    inventory,
    itemId: String(itemId),
    mainItem: 'true',
    meanTimeItemId,
    price,
    renderVersion: 'DIALOG',
    urlParams
  }
  return JSON.stringify({ params: JSON.stringify([paramObject]) })
}

/**
 * 创建订单页埋点：模拟「详情页点购买」进入 /create-order 或 /create-order-yhb。
 * - spm_cnt 固定 a21ybx.create-order.0.0
 * - spm_pre = a21ybx.item.buy.1.{logId}
 * - log_id 与 spm_pre 末段一致
 */
function buildCreateOrderSpmContext(opts = {}) {
  const logId =
    opts.logId != null && String(opts.logId).trim()
      ? String(opts.logId).trim().slice(0, 48)
      : crypto.randomBytes(8).toString('hex')
  const spmPre = `a21ybx.item.buy.1.${logId}`
  return {
    spmCnt: 'a21ybx.create-order.0.0',
    spmPre,
    logId
  }
}

/** 对齐浏览器：Referer 为 create-order / create-order-yhb 页 */
function buildCreateOrderReferer(itemId, spmPre, opts = {}) {
  const q = new URLSearchParams()
  const spm = String(spmPre || '').trim()
  const id = String(itemId || '').trim()
  if (spm) q.set('spm', spm)
  if (id) q.set('itemId', id)
  const qs = q.toString()
  const path = opts.yhb ? 'create-order-yhb' : 'create-order'
  return qs ? `https://www.goofish.com/${path}?${qs}` : `https://www.goofish.com/${path}`
}

function buildOrderSpmQueryUrl(api, v, { t, sign, spmCnt, spmPre, logId }) {
  const spm = buildCreateOrderSpmContext({
    logId: logId || undefined
  })
  const q = new URLSearchParams({
    jsv: MTOP_JSV,
    appKey: MTOP_APP_KEY,
    t,
    sign,
    v,
    type: 'json',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api,
    valueType: 'string',
    sessionOption: 'AutoLoginOnly',
    spm_cnt: String(spmCnt || spm.spmCnt).trim() || spm.spmCnt,
    spm_pre: String(spmPre || spm.spmPre).trim() || spm.spmPre,
    log_id: String(logId || spm.logId).trim() || spm.logId
  })
  return `${MTOP_H5_BASE}/${api}/${v}/?${q.toString()}`
}

function buildOrderCreateUrl({ t, sign, spmCnt, spmPre, logId }) {
  return buildOrderSpmQueryUrl(ORDER_CREATE_API, '5.0', { t, sign, spmCnt, spmPre, logId })
}

function buildOrderRenderUrl({ t, sign, spmCnt, spmPre, logId }) {
  return buildOrderSpmQueryUrl(ORDER_RENDER_API, '7.0', { t, sign, spmCnt, spmPre, logId })
}

function buildYhbOrderRenderUrl({ t, sign, spmCnt, spmPre, logId }) {
  return buildOrderSpmQueryUrl(YHB_ORDER_RENDER_API, '1.0', { t, sign, spmCnt, spmPre, logId })
}

function buildYhbOrderCreateUrl({ t, sign, spmCnt, spmPre, logId }) {
  return buildOrderSpmQueryUrl(YHB_ORDER_CREATE_API, '1.0', { t, sign, spmCnt, spmPre, logId })
}

/** 验货宝确认页：仅 itemId + asac（官网 GET render） */
function buildYhbOrderRenderData(itemId) {
  return {
    itemId: String(itemId),
    asac: YHB_ORDER_ASAC
  }
}

/**
 * 验货宝下单：与 p_create-order-yhb 一致。
 * onlyYhb / 勾选验货宝时不传 demoteC2COrderId（关闭验货宝才传 TurnOffYhbService）。
 */
function buildYhbOrderCreateData(itemId, buyerAddressId) {
  return {
    itemId: String(itemId),
    optionalPromotionIdValueList: '[]',
    buyerAddressId: String(buyerAddressId),
    buyQuantity: 1,
    channel: 'web',
    channelData: JSON.stringify({ yhbVersion: 3 })
  }
}

function buildGenericMtopUrl(api, { t, sign, v = '1.0' }) {
  const q = new URLSearchParams({
    jsv: MTOP_JSV,
    appKey: MTOP_APP_KEY,
    t,
    sign,
    v,
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api,
    sessionOption: 'AutoLoginOnly',
    spm_cnt: 'a21ybx.im.0.0'
  })
  return `${MTOP_H5_BASE}/${api}/${v}/?${q.toString()}`
}

function pickMh5Token(cookieHeader) {
  const full = resolveMh5Tk(buildConfigFromCookie(normalizeCookieHeader(cookieHeader)))
  if (!full) return ''
  try {
    return getTokenFromMH5Tk(full)
  } catch {
    return ''
  }
}

function signMtop(token, data) {
  const t = String(Date.now())
  const sign = calcMtopSign({ token, t, appKey: MTOP_APP_KEY, data })
  return { t, sign }
}


async function resolveMiaopaiSignCookie(clientCookieOverride, opts = {}) {
  const skipPrepare = !!opts.skipPrepareClientCookie
  const override = normalizeCookieHeader(clientCookieOverride)
  const cookieForMtop = override
    ? skipPrepare
      ? override
      : await prepareClientMtopCookie(override)
    : ''
  if (!cookieForMtop) {
    throw new Error('无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie')
  }
  const cfg = buildConfigFromCookie(cookieForMtop)
  if (!cfg.cookie) {
    throw new Error('无法解析闲鱼 Cookie：客户端应传入登录后的 client_mtop_cookie')
  }
  return cfg
}

function toMiaopaiSignPayload(built) {
  const out = {
    requestUrl: built.requestUrl,
    mtopData: built.data ?? built.mtopData,
    referer: built.referer || 'https://www.goofish.com/',
    client_mtop_cookie_used: built.cookie
  }
  if (built.mtopExtHeaders && typeof built.mtopExtHeaders === 'object') {
    out.mtopExtHeaders = built.mtopExtHeaders
  }
  return out
}

/**
 * 秒拍：PC 商品详情 MTOP 仅算签（不发闲鱼 HTTP）
 * 查询串带 spm_cnt / spm_pre / log_id，对齐浏览器「搜索进详情」抓包。
 */
async function buildSignedMiaopaiPcItemDetailRequest(itemId, clientCookieOverride, opts = {}) {
  const id = String(itemId || '').trim()
  if (!id) throw new Error('缺少 itemId')
  const cfg = await resolveMiaopaiSignCookie(clientCookieOverride, opts)
  const t = String(Date.now())
  const data = buildPcDetailData(id)
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
  const sign = calcMtopSign({ token, t, appKey: cfg.appKey, data })
  const sessionOption = resolveMtopSessionOptionForCookie(cfg.cookie)
  const spm = buildPcItemDetailSpmContext({
    feedIndex: opts.feedIndex,
    logId: opts.logId
  })
  const requestUrl = buildRequestUrl({
    api: 'mtop.taobao.idle.pc.detail',
    v: '1.0',
    jsv: cfg.jsv,
    appKey: cfg.appKey,
    t,
    sign,
    sessionOption,
    spmCnt: spm.spmCnt,
    spmPre: spm.spmPre,
    extraParams: { log_id: spm.logId }
  })
  return toMiaopaiSignPayload({
    requestUrl,
    data,
    cookie: cfg.cookie,
    referer: 'https://www.goofish.com/'
  })
}

/**
 * 秒拍：收货地址列表 MTOP 仅算签
 */
async function buildSignedMiaopaiAddressListRequest(clientCookieOverride, opts = {}) {
  const cfg = await resolveMiaopaiSignCookie(clientCookieOverride, opts)
  const rawDataStr = JSON.stringify({})
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
  const { t, sign } = signMtop(token, rawDataStr)
  const requestUrl = buildGenericMtopUrl(ADDRESS_API, { t, sign, v: '1.0' })
  return toMiaopaiSignPayload({
    requestUrl,
    data: rawDataStr,
    cookie: cfg.cookie,
    referer: 'https://www.goofish.com/'
  })
}

/**
 * 秒拍：订单 render MTOP 仅算签
 * - 普通：trade.order.render v7
 * - 验货宝：alibaba.idle.pc.yhb.order.create.render v1 + asac
 */
async function buildSignedMiaopaiOrderRenderRequest(
  { itemId, deliverId, skuId, selectedPath, buyQuantity, deliverType },
  clientCookieOverride,
  opts = {}
) {
  const iid = String(itemId || '').trim()
  if (!iid) throw new Error('缺少 itemId')
  const yhb = !!opts.yhb
  const cfg = await resolveMiaopaiSignCookie(clientCookieOverride, opts)
  const spm = buildCreateOrderSpmContext({ logId: opts.logId })

  if (yhb) {
    const rawDataStr = JSON.stringify(buildYhbOrderRenderData(iid))
    const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
    const { t, sign } = signMtop(token, rawDataStr)
    const requestUrl = buildYhbOrderRenderUrl({
      t,
      sign,
      spmCnt: spm.spmCnt,
      spmPre: spm.spmPre,
      logId: spm.logId
    })
    return toMiaopaiSignPayload({
      requestUrl,
      data: rawDataStr,
      cookie: cfg.cookie,
      referer: buildCreateOrderReferer(iid, spm.spmPre, { yhb: true }),
      mtopExtHeaders: { asac: YHB_ORDER_ASAC }
    })
  }

  const did = String(deliverId || '').trim()
  if (!did) throw new Error('缺少 deliverId')
  const renderObj = buildOrderRenderData(iid, did, {
    skuId,
    selectedPath,
    buyQuantity,
    deliverType
  })
  const rawDataStr = JSON.stringify(renderObj)
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
  const { t, sign } = signMtop(token, rawDataStr)
  const requestUrl = buildOrderRenderUrl({
    t,
    sign,
    spmCnt: spm.spmCnt,
    spmPre: spm.spmPre,
    logId: spm.logId
  })
  return toMiaopaiSignPayload({
    requestUrl,
    data: rawDataStr,
    cookie: cfg.cookie,
    referer: buildCreateOrderReferer(iid, spm.spmPre, { yhb: false })
  })
}

/**
 * 秒拍：创建订单 MTOP 仅算签
 * - 普通：trade.order.create，优先 render 的 mainItem
 * - 验货宝：alibaba.idle.pc.yhb.order.create（buyerAddressId + channelData）
 */
async function buildSignedMiaopaiCreateOrderRequest(
  { itemId, price, deliverId, mainItem },
  clientCookieOverride,
  opts = {}
) {
  const iid = String(itemId || (mainItem && mainItem.itemId) || '').trim()
  const yhb = !!opts.yhb
  const cfg = await resolveMiaopaiSignCookie(clientCookieOverride, opts)
  const spm = buildCreateOrderSpmContext({ logId: opts.logId })

  if (yhb) {
    const did = String(deliverId || '').trim()
    if (!iid || !did) throw new Error('缺少 itemId / deliverId（验货宝 buyerAddressId）')
    const rawDataStr = JSON.stringify(buildYhbOrderCreateData(iid, did))
    const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
    const { t, sign } = signMtop(token, rawDataStr)
    const requestUrl = buildYhbOrderCreateUrl({
      t,
      sign,
      spmCnt: spm.spmCnt,
      spmPre: spm.spmPre,
      logId: spm.logId
    })
    return toMiaopaiSignPayload({
      requestUrl,
      data: rawDataStr,
      cookie: cfg.cookie,
      referer: buildCreateOrderReferer(iid, spm.spmPre, { yhb: true })
    })
  }

  let rawDataStr = ''
  if (mainItem && typeof mainItem === 'object') {
    rawDataStr = buildCreateDataFromMainItem(mainItem)
  } else {
    const p = formatPrice(price)
    const did = String(deliverId || '').trim()
    if (!iid || !p || !did) throw new Error('缺少 itemId / price / deliverId（或 mainItem）')
    rawDataStr = buildOrderRequestBody(iid, p, did)
  }
  if (!iid) throw new Error('缺少 itemId')
  const token = getTokenFromMH5Tk(resolveMh5Tk(cfg))
  const { t, sign } = signMtop(token, rawDataStr)
  const requestUrl = buildOrderCreateUrl({
    t,
    sign,
    spmCnt: spm.spmCnt,
    spmPre: spm.spmPre,
    logId: spm.logId
  })
  return toMiaopaiSignPayload({
    requestUrl,
    data: rawDataStr,
    cookie: cfg.cookie,
    referer: buildCreateOrderReferer(iid, spm.spmPre, { yhb: false })
  })
}


module.exports = {
  buildSignedMiaopaiPcItemDetailRequest,
  buildSignedMiaopaiAddressListRequest,
  buildSignedMiaopaiOrderRenderRequest,
  buildSignedMiaopaiCreateOrderRequest,
  buildCreateOrderSpmContext,
  buildCreateOrderReferer,
  pickMainItemFromRender,
  pickOrderIdFromResponse,
  formatPrice,
  looksLikeYhbItem,
  isYhbOnlyBuyError,
  firstRetMessage,
  isMtopOk,
  isMtopTokenExpiredMessage,
  pickItemBriefFromPcDetail
}
