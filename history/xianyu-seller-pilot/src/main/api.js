// ERP 后端客户端：crawler-login / refresh / crawl-tasks / prices
import axios from 'axios'
import { getServerBaseUrl, getToken } from './store.js'

export const WMS_REQUEST_TIMEOUT_MS = 15000

function boundedSignal(timeoutMs = WMS_REQUEST_TIMEOUT_MS, parentSignal = null) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || WMS_REQUEST_TIMEOUT_MS))
  const abortFromParent = () => controller.abort()
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', abortFromParent, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parentSignal?.removeEventListener?.('abort', abortFromParent)
    }
  }
}

function client() {
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: 20000 })
  inst.interceptors.request.use((config) => {
    const token = getToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })
  return inst
}

/**
 * 执行单元聚合（群控服务端 GET /gc/units）。
 *
 * 群控是独立服务但验的是**主 ERP 签发的同一个 JWT**（同 jwt_secret、HS256），
 * 所以这里复用 client() 的 token 拦截器，不需要第二次登录或换票。
 * 路径前缀走 /gc/ 反代，不能写成 /api/gc（那会打到 ERP 的旧内嵌路由）。
 */
/**
 * 群控服务端客户端。baseURL 已含 /gc 前缀（经 nginx 反代到后端 /api/gc/），
 * 所以下面各接口的路径**不要**再写 /api/gc —— 那会拼成 /gc/api/gc/...。
 */
function gcClient() {
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/gc', timeout: 20000 })
  inst.interceptors.request.use((config) => {
    const token = getToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })
  return inst
}

/** 群控的裸 GET（日志待办这类小接口用，不必每条都包一个函数）。 */
export async function gcGet(path, params = {}) {
  const { data } = await gcClient().get(path, { params })
  return data
}

/** 群控的裸 JSON POST（影子上报这类小接口用）。 */
export async function gcPostJson(path, body) {
  const { data } = await gcClient().post(path, body)
  return data
}

/** 把日志包交回群控服务端（多表单）。 */
export async function gcUploadLogs(requestId, blob, filename = 'logs.gz') {
  const form = new FormData()
  form.append('request_id', requestId)
  form.append('file', new Blob([blob], { type: 'application/gzip' }), filename)
  const { data } = await gcClient().post('/logs/upload', form)
  return data
}

export async function fetchGcUnits(kind) {
  const { data } = await gcClient().get('/units', { params: kind ? { kind } : {} })
  return Array.isArray(data) ? data : []
}

/**
 * 解冻账号：status 回 ACTIVE，连带清掉风控（risk_state 回 NORMAL、risk_note 置空）。
 * 命中风控时群控把这两个一起冻，调度器两个都看，只改 status 解不开。
 */
export async function unfreezeGcAccount(accountId) {
  const { data } = await gcClient().patch(`/accounts/${encodeURIComponent(accountId)}`,
    { status: 'ACTIVE', risk_state: 'NORMAL', risk_note: '' })
  return data
}

/**
 * 远程更新指定工位的 AdsPower 执行端：服务端给设备下发 update_code 控制指令，
 * 端侧尽力下载新代码后优雅退出进程，由 supervisor 拉起换新（约 1 分钟，期间该账号
 * 任务暂停；浏览器窗口不杀）。老执行端没有这条 cmd 分支会静默忽略——任务停在
 * DISPATCHED，那种机器没有热更加载器，仍需重装 exe。
 */
export async function updateDeviceCode(deviceId) {
  const { data } = await gcClient().post(`/devices/${encodeURIComponent(deviceId)}/update-code`)
  return data
}

/**
 * 执行端维护报备：更新执行端（重启进程）前报，调度器从此不给它派新活；返回它手上还在跑的任务，
 * 有就先等它跑完再报一次。超过 minutes 没收尾报备自动失效。
 */
export async function beginDeviceMaintenance(deviceId, { reason = 'update_code', minutes = 10 } = {}) {
  const { data } = await gcClient().post(`/devices/${encodeURIComponent(deviceId)}/maintenance`, { reason, minutes })
  return data
}

/** 维护收尾：撤报备，服务端把窗口里因重启失败的任务放回队列重新派。返回 { requeued: [taskId] }。 */
export async function endDeviceMaintenance(deviceId) {
  const { data } = await gcClient().delete(`/devices/${encodeURIComponent(deviceId)}/maintenance`)
  return data
}

// ---------- 消息聚合台（M1） ----------

export async function fetchChatConversations(accountId, { page = 1, size = 100 } = {}) {
  const { data } = await gcClient().get('/chat/conversations', {
    params: { account_id: accountId || undefined, page, size }
  })
  return Array.isArray(data) ? data : []
}

export async function fetchChatMessages(conversationId, { page = 1, size = 200 } = {}) {
  const { data } = await gcClient().get(
    `/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    { params: { page, size } })
  return Array.isArray(data) ? data : []
}

/**
 * 回复是**异步**的：这里只建一条 chat_reply 任务，真正发出由调度器派发到该账号的
 * 执行端，且受 op_min_interval_sec 反风控节流。返回的是 job_id，不是「已发送」。
 */
export async function replyChatConversation(conversationId, text) {
  const { data } = await gcClient().post(
    `/chat/conversations/${encodeURIComponent(conversationId)}/reply`, { text })
  return data
}

export async function markChatRead(conversationId) {
  const { data } = await gcClient().post(
    `/chat/conversations/${encodeURIComponent(conversationId)}/read`)
  return data
}

export async function fetchChatReplyRate(accountId, byAccount = false) {
  const { data } = await gcClient().get('/chat/reply-rate', {
    params: { account_id: accountId || undefined, by_account: byAccount || undefined }
  })
  return data
}

// ---------- 上下架 ----------
// 打的是 ERP 既有的那套接口（小程序上架页用的同一套），不另起一条路：
// 上架状态的真源是 SkuShopListing，多一条写入口就多一处会对不上的地方。

/** 待上架的货：已入库、已议价、还没发布出去的。 */
export async function fetchPendingListings() {
  const { data } = await client().get('/listing/pending')
  return Array.isArray(data) ? data : []
}

/** 这件货在各店铺的上架状态（含 device_kind：手机还是浏览器）。 */
export async function fetchSkuShops(skuCode) {
  const { data } = await client().get(`/listing/skus/${encodeURIComponent(skuCode)}/shops`)
  return Array.isArray(data) ? data : []
}

/** 发布到所选店铺。不传店铺 = 全部可上架的店铺。 */
export async function publishSku(skuCode, saleShopIds = null) {
  const { data } = await client().post(`/listing/skus/${encodeURIComponent(skuCode)}/publish`,
    { sale_shop_ids: saleShopIds })
  return data
}

/** 下架所选店铺。不传店铺 = 全部在架店铺。 */
export async function delistSku(skuCode, saleShopIds = null) {
  const { data } = await client().post(`/listing/skus/${encodeURIComponent(skuCode)}/delist`,
    { sale_shop_ids: saleShopIds })
  return data
}

// ---------- 浏览器环境 ↔ 店铺 ----------
// 删 AdsPower 环境时要把它对应的店铺一并停用：群控没有删账号的接口，环境删了
// 账号和店铺都还在，不停店铺的话上架会一直往一个永远发不出去的号里派货。

/** 店铺对账（管理员）：每家启用店铺 + 它的群控账号当前在哪台设备上（device_hw_id = 环境 ID）。 */
export async function fetchGcBindShops() {
  const { data } = await client().get('/gc-bind/shops')
  return Array.isArray(data) ? data : []
}

/** 停用一家店铺（管理员）。店铺同步不会把人工停用的店再打开。 */
export async function disableSaleShop(shopId) {
  const { data } = await client().patch(`/master/sale-shops/${encodeURIComponent(shopId)}`, { enabled: false })
  return data
}

// ---------- 密码库填进 AdsPower ----------
// 服务端只把要填的密码按这台电脑的公钥加密发过来（vault-ads.js / vault-ads-core.js），这几条只搬密文和回执。

/** 登记这台电脑的公钥；新的、换了的都要密码库主人在台账页批准。 */
export async function vaultStationRegister(body) {
  const { data } = await client().post('/ledger/vault/stations', body)
  return data
}

export async function vaultStationState(stationId) {
  const { data } = await client().get(`/ledger/vault/stations/${encodeURIComponent(stationId)}/state`)
  return data
}

/** 本机 AdsPower 有这些环境：领要填的（加密包）。 */
export async function vaultAdsPoll(stationId, adsUserIds) {
  const { data } = await client().post('/ledger/vault/ads/poll', { station_id: stationId, ads_user_ids: adsUserIds })
  return data.items || []
}

export async function vaultAdsResult(body) {
  const { data } = await client().post('/ledger/vault/ads/result', body)
  return data
}

// ---------- 工作台设备与爬虫租约 ----------
// 互斥由服务端判：同一个爬虫任何时候只能在一台电脑上开着。端上只负责心跳、
// 续期，以及把"抢不到"那句话原样带回界面——不本地猜谁在跑。

/** 心跳：登记这台电脑，顺带取回两个爬虫此刻分别归谁。 */
export async function leaseHeartbeat(body) {
  const { data } = await client().post('/workbench/devices/heartbeat', body)
  return data
}

// ---------- 行情采集轮次 ----------
// 服务端记「谁跑的、跑得怎么样」，采集本身仍在端上跑。一轮几十分钟、中途断点
// 续跑，做成服务端队列会把端上跑了三个月的调度推倒重来。

/** 登记一轮（管理员点的、或端上到点自动跑之前来登记）。 */
export async function createCrawlRun(body) {
  const { data } = await client().post('/workbench/crawl/runs', body)
  return data
}

/** 认领：服务端要同时确认「这轮派给你」和「租约此刻还在你手上」。 */
export async function claimCrawlRun(runId, deviceId, localRunId = null) {
  const { data } = await client().post(`/workbench/crawl/runs/${runId}/claim`,
    { device_id: deviceId, local_run_id: localRunId })
  return data
}

/** 跑完上报。服务端不校验租约——跑到一半被转走，结果照样得记下来。 */
export async function finishCrawlRun(runId, deviceId, result) {
  const { data } = await client().post(`/workbench/crawl/runs/${runId}/finish`,
    { device_id: deviceId, ...result })
  return data
}

/** 取回某一轮的现场（管理员点的）。 */
export async function requestRunSnapshot(runId) {
  const { data } = await client().post(`/workbench/crawl/runs/${runId}/snapshot`)
  return data
}

/** 这一轮的现场取回到哪一步了。 */
export async function getRunSnapshot(runId) {
  const { data } = await client().get(`/workbench/crawl/runs/${runId}/snapshot`)
  return data
}

/**
 * 端上把打好的包传回去。
 *
 * multipart 是手拼的：本仓没装 form-data，而为传一个文件加一个依赖不划算——
 * 何况桌面端打包时多一个依赖就多一份出问题的可能。协议本身很简单，
 * 边界串 + 两段 part，Node 自带的 Buffer 就够。
 */
export async function uploadSnapshot(requestId, deviceId, filePath) {
  const { readFileSync } = await import('fs')
  const body = readFileSync(filePath)
  const boundary = `----workbench${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="device_id"\r\n\r\n${deviceId}\r\n` +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="snapshot.tar.gz"\r\n' +
    'Content-Type: application/gzip\r\n\r\n'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const payload = Buffer.concat([head, body, tail])
  await client().post(`/workbench/crawl/snapshots/${requestId}/upload`, payload, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000
  })
  return body.length
}

/** 找不到那一轮的快照时回一句，否则这条待办永远挂着。 */
export async function failSnapshot(requestId, deviceId, reason) {
  await client().post(`/workbench/crawl/snapshots/${requestId}/fail`, { device_id: deviceId, reason })
}

/** 最近几轮（管理员看板用）。 */
export async function listCrawlRuns(limit = 20) {
  const { data } = await client().get('/workbench/crawl/runs', { params: { limit } })
  return data
}

/** AdsPower 分组归属（服务端那份唯一说明书）。登录后推进本机代理。 */
export async function fetchEnvPurposes() {
  const { data } = await client().get('/workbench/env-purposes')
  return data
}

/** 两个爬虫的全局现状 + 所有登记过的电脑（管理员开关页用）。 */
export async function listLeases() {
  const { data } = await client().get('/workbench/leases')
  return data
}

export async function acquireLease(feature, deviceId) {
  const { data } = await client().post(`/workbench/leases/${feature}/acquire`, { device_id: deviceId })
  return data
}

export async function renewLease(feature, deviceId) {
  const { data } = await client().post(`/workbench/leases/${feature}/renew`, { device_id: deviceId })
  return data
}

export async function releaseLease(feature, deviceId) {
  const { data } = await client().post(`/workbench/leases/${feature}/release`, { device_id: deviceId })
  return data
}

/** 转移到另一台。服务端只写让位请求，不掐断正在跑的那一轮。 */
export async function transferLease(feature, toDeviceId) {
  const { data } = await client().post(`/workbench/leases/${feature}/transfer`, { to_device_id: toDeviceId })
  return data
}

/**
 * 工作台登录：销售 / 采购 / 管理员各用**自己的员工账号**。
 *
 * 以前打的是 /auth/crawler-login —— 那条只认设备账号（CRAWLER/MARKET_BOT），
 * 于是整个应用不管谁在用，身份都是同一个机器账号：审计查不出是谁干的，菜单也
 * 只能一套给所有人看。工作台前面坐的是人，改打 /auth/workbench-login。
 *
 * 服务端放行哪些角色，端上 menu.js 的 ROLES 表就必须有哪些——漏一个的症状是
 * 「登录成功却被弹回登录页」（菜单为空 → 落地页算不出来）。那条已由服务端回归
 * 直接读 menu.js 钉住，不再靠人记得同步。
 */
/**
 * 设备账号登录（无人值守那条路）。
 *
 * 和上面的工作台登录是**两扇门**：工作台那扇只放行销售/采购/管理员，
 * 而本机 erp-private.json 里存的是设备账号（MARKET_BOT）。2026-09-16 把工作台
 * 改成按人登录时，这条兜底跟着打到了那扇门上——设备账号自然被拒，而调方
 * 「拿不到 token 就跳过上报」，于是断得一声不响。
 *
 * 它现在是**兜底**而非主路：采集要跑得先有租约，有租约就先有人登录，
 * 那时用的是人的令牌。这条只在没人登录、而某些后台动作仍需身份时才走到。
 */
export async function deviceLogin(username, password) {
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: 20000 })
  const { data } = await inst.post('/auth/crawler-login', { username, password })
  return data
}

export async function login(username, password) {
  // 不带 token 调用（登录前 store 里可能有旧 token，这里显式新建）
  const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: 20000 })
  const { data } = await inst.post('/auth/workbench-login', { username, password })
  return data // { token, staff }
}

// WMS 专用管理登录：CRAWLER 账号没有库存可见性，该接口服务端只放行 ADMIN 角色
// （非 ADMIN 一律 403「非管理员账号」，仓管账号同样进不来）。
// 该 token 只用于本次 WMS 同步，不覆盖 App 的爬虫登录态。
export async function adminLogin(username, password, { timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const bounded = boundedSignal(timeoutMs, signal)
  try {
    const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
    const { data } = await inst.post('/auth/admin-login', { username, password })
    return data
  } finally {
    bounded.cleanup()
  }
}

/**
 * 把型号清单推给 ERP，更新行情监控列表。
 *
 * 走 ERP 既有的 /market/products/import 接口。固定 replace=false（合并导入）：
 * 巡航台的清单只是它自己的任务集，不是 ERP 的完整监控名单；覆盖模式会删掉 ERP 里
 * 其余型号，并连带删除它们的历史行情。服务端对 CRAWLER 角色同样强制了这一点。
 *
 * 用 CRAWLER token 即可，不需要 ADMIN——桌面端不应持有能读全部库存/财务的凭据。
 */
export async function importCrawlProducts(fileBuffer, fileName, { token, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  if (!fileBuffer) throw new Error('没有可导入的 Excel 内容')
  if (!token) throw new Error('缺少 ERP 登录态，无法同步型号列表')

  const form = new FormData()
  const bytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer)
  form.append('file', new Blob([bytes]), fileName || 'tasks.xlsx')

  const bounded = boundedSignal(timeoutMs, signal)
  try {
    const inst = axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
    const { data } = await inst.post('/market/products/import', form, {
      params: { replace: false },
      headers: { Authorization: `Bearer ${token}` }
    })
    return data // { total, created, updated, skipped, deleted }
  } finally {
    bounded.cleanup()
  }
}

export async function refresh() {
  const { data } = await client().post('/auth/refresh')
  return data
}

export async function fetchTasks() {
  const { data } = await client().get('/market/crawl-tasks')
  return data // [{ id, name, keyword }]
}

export async function uploadPrice({ productId, productName, price, trendDelta, searchHeat, raw }) {
  // Excel 任务没有 ERP 的 product_id，按型号名上报；服务端查不到会自动登记监控商品。
  const body = { price }
  if (productId) body.product_id = productId
  else body.product_name = productName
  if (trendDelta != null) body.trend_delta = trendDelta
  if (searchHeat != null) body.search_heat = searchHeat
  if (raw) body.raw = raw
  const { data } = await client().post('/market/prices', body)
  return data
}

// ---------- 公司 WMS（库存 SKU / 型号） ----------
// 返回 { items, total, page, size }；items 为 SkuOut（含 sku_code/brand/model/product_name/spu_code/spec/suggest_price/status）。
export async function fetchInventorySkus({ q = '', status = '', page = 1, size = 100, token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const safePage = Number(page)
  const safeSize = Number(size)
  if (!Number.isInteger(safePage) || safePage < 1) throw new Error('WMS 分页 page 必须是正整数')
  if (!Number.isInteger(safeSize) || safeSize < 1 || safeSize > 100) throw new Error('WMS 分页 size 必须是 1-100')
  const bounded = boundedSignal(timeoutMs, signal)
  const inst = token
    ? axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal, headers: { Authorization: `Bearer ${token}` } })
    : axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
  try {
    const { data } = await inst.get('/inventory/skus', {
      params: { q: q || undefined, status: status || undefined, page: safePage, size: safeSize },
      signal: bounded.signal
    })
    return data
  } finally {
    bounded.cleanup()
  }
}

/**
 * Converge a paged inventory response without treating a fixed page count as
 * business completeness.  This pure helper is intentionally injectable so
 * offline regressions can exercise 10k rows and malformed upstream responses
 * without putting credentials or a live server in a fixture.
 */
export async function convergeInventoryPages({
  fetchPage,
  status = 'IN_STOCK',
  pageSize = 100,
  maxRows = 1_000_000
} = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('WMS 分页缺少 fetchPage')
  if (status !== 'IN_STOCK') throw new Error('库存同步只允许读取 IN_STOCK')
  const safePageSize = Number(pageSize)
  const safeMaxRows = Number(maxRows)
  if (!Number.isInteger(safePageSize) || safePageSize < 1 || safePageSize > 100) throw new Error('WMS 分页 size 必须是 1-100')
  if (!Number.isInteger(safeMaxRows) || safeMaxRows < safePageSize) throw new Error('WMS 分页 maxRows 无效')

  const items = []
  const pageSignatures = new Set()
  let page = 1
  let total = null
  let lastHasMore = null
  while (true) {
    const data = await fetchPage({ status, page, size: safePageSize })
    if (!data || !Array.isArray(data.items)) throw new Error(`WMS 第 ${page} 页响应缺少 items`)
    const batch = data.items
    const reportedPage = Number(data.page)
    if (Number.isFinite(reportedPage) && reportedPage !== page) {
      throw new Error(`WMS 分页响应不一致（请求第 ${page} 页，返回第 ${reportedPage} 页）`)
    }
    const reportedTotal = data.total == null || data.total === '' ? null : Number(data.total)
    if (reportedTotal != null && (!Number.isInteger(reportedTotal) || reportedTotal < 0)) {
      throw new Error(`WMS 第 ${page} 页 total 无效`)
    }
    if (total != null && reportedTotal != null && total !== reportedTotal) {
      throw new Error('WMS 分页 total 在不同页面不一致')
    }
    if (reportedTotal != null) total = reportedTotal
    const hasMoreValue = data.has_more ?? data.hasMore
    const hasMore = hasMoreValue == null ? null : Boolean(hasMoreValue)
    if (lastHasMore === false) throw new Error('WMS 分页在 has_more=false 后仍返回后续页面')
    const signature = JSON.stringify(batch.map((row) => [row?.sku_code, row?.spu_code, row?.model, row?.status]))
    if (pageSignatures.has(signature)) throw new Error(`WMS 分页重复（第 ${page} 页）`)
    pageSignatures.add(signature)
    if (batch.some((row) => String(row?.status || '').trim().toUpperCase() !== 'IN_STOCK')) {
      throw new Error(`WMS 第 ${page} 页包含非 IN_STOCK 商品`)
    }
    items.push(...batch)
    if (items.length > safeMaxRows) throw new Error(`WMS 商品数量超过安全上限 ${safeMaxRows}`)
    if (total != null && items.length > total) throw new Error('WMS 分页返回数量超过 total')

    if (!batch.length) {
      if (page === 1 && total !== 0) throw new Error('WMS 首页为空但 total 不是 0')
      if (hasMore === true) throw new Error('WMS 空页仍声明 has_more=true')
      break
    }
    if (total === 0) throw new Error('WMS total=0 但返回了商品')
    if (total != null && items.length === total) {
      if (hasMore === true) throw new Error('WMS 已达到 total 但仍声明 has_more=true')
      break
    }
    if (hasMore === false) {
      if (total != null && items.length !== total) throw new Error('WMS has_more=false 但未收齐 total')
      break
    }
    // A short page is terminal only when the server explicitly omits a
    // contradictory has_more=true. This supports APIs that do not expose
    // totals while still detecting truncated responses when total is known.
    if (batch.length < safePageSize && hasMore !== true) {
      if (total != null && items.length !== total) throw new Error('WMS 短页未收齐 total')
      break
    }
    lastHasMore = hasMore
    page += 1
  }
  return { items, total: total ?? items.length, pageCount: page, page }
}

// 全量拉取在库型号。REST 每页最多 100 行，收敛依据是 total/has_more/完整页语义；
// maxRows 只是防止异常服务端无限增量，不代表业务页数上限。
export async function fetchAllInventorySkus({ status = 'IN_STOCK', token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null, maxRows = 1_000_000 } = {}) {
  return convergeInventoryPages({
    status,
    maxRows,
    fetchPage: ({ status: pageStatus, page, size }) => fetchInventorySkus({ status: pageStatus, page, size, token, timeoutMs, signal })
  })
}

// 回写字段：与服务端窄接口 SkuMarketInfoIn 一一对应。
// 去掉了 search_terms —— 服务端压根没有这个字段，之前一直是白送（现在窄接口
// extra=forbid，再送会 422，不如在这里就说清楚只有三个字段）。
export const INVENTORY_WRITEBACK_FIELDS = Object.freeze(['product_name', 'brand', 'model'])
export const INVENTORY_FORBIDDEN_WRITEBACK_FIELDS = Object.freeze([
  'spu_code', 'spuCode', 'sku_code', 'skuCode', 'spec', 'sale_price', 'selling_price',
  'price', 'suggest_price', 'cost_price', 'purchase_price', 'listing_price', 'listingPrice'
])

export function sanitizeInventorySkuPatch(patch = {}) {
  const forbidden = Object.keys(patch || {}).filter((field) => INVENTORY_FORBIDDEN_WRITEBACK_FIELDS.includes(field))
  if (forbidden.length) throw new Error(`WMS 回写禁止字段：${forbidden.join(', ')}`)
  const body = {}
  for (const field of INVENTORY_WRITEBACK_FIELDS) {
    if (patch[field] === undefined) continue
    body[field] = field === 'search_terms'
      ? [...new Set((Array.isArray(patch[field]) ? patch[field] : [patch[field]])
        .flatMap((value) => String(value ?? '').split(/[\n,，;；]/).map((item) => item.trim()).filter(Boolean)))].slice(0, 12)
      : String(patch[field] ?? '').trim().slice(0, 240)
  }
  if (!Object.keys(body).length) throw new Error('WMS 回写缺少允许的商品信息字段')
  return body
}

export function inventoryVersion(row = {}, headers = {}) {
  const headerValue = headers.etag || headers.ETag || headers['x-version'] || headers['X-Version']
  return [row.updated_at, row.updatedAt, row.version, row.revision, row.etag, row.ETag, headerValue].find(value => String(value ?? '').trim()) || null
}

export async function fetchInventorySku(skuCode, { token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const code = String(skuCode || '').trim()
  if (!code) throw new Error('WMS 查询缺少 SKU')
  const bounded = boundedSignal(timeoutMs, signal)
  const inst = token
    ? axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal, headers: { Authorization: `Bearer ${token}` } })
    : axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
  try {
    const response = await inst.get(`/inventory/skus/${encodeURIComponent(code)}`, { signal: bounded.signal })
    return { item: response.data, headers: response.headers || {} }
  } finally {
    bounded.cleanup()
  }
}

// 按唯一 SKU 回写清洗后的商品描述。SPU、SKU、规格、成本价和任何销售价都
// 不是该入口的可写字段；调用方应在 PATCH 前做业务门禁并在 PATCH 后 GET 验证。
/**
 * 回写商品名/品牌/型号，走服务端**窄接口**（PATCH /inventory/skus/{code}/market-info）。
 *
 * 以前打的是仓管全量编辑接口，因此必须换一把管理员令牌——那把钥匙还能改货号和 69 码，
 * 而且得把管理员密码存在每台工位上。现在用工作台自己的登录态（MARKET_BOT 角色），
 * 能写的字段由服务端 schema 限死，审计也记在设备账号自己头上。
 */
export async function updateSkuMarketInfo(skuCode, patch = {}, { token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null, expectedVersion = null, etag = '' } = {}) {
  const code = String(skuCode || '').trim()
  if (!code) throw new Error('WMS 回写缺少 SKU')
  const body = sanitizeInventorySkuPatch(patch)
  const bounded = boundedSignal(timeoutMs, signal)
  const inst = token
    ? axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal, headers: { Authorization: `Bearer ${token}` } })
    : axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
  try {
    const headers = {}
    if (etag) headers['If-Match'] = String(etag)
    if (expectedVersion != null) headers['X-Expected-Version'] = String(expectedVersion)
    const { data } = await inst.patch(`/inventory/skus/${encodeURIComponent(code)}/market-info`, body, { signal: bounded.signal, headers })
    return data
  } finally {
    bounded.cleanup()
  }
}

// ---------- Listing price contract ----------
// Listing price is a separate resource from inventory.suggest_price.  The
// latter is a cost-derived suggestion and must never be used as the current
// sale price or as a fallback for a price PUT.
export function listingRequestPath(skuCode) {
  const code = String(skuCode || '').trim()
  if (!code) throw new Error('listing 查询缺少 SKU')
  return `/listing/skus/${encodeURIComponent(code)}`
}

export function buildListingConditionalHeaders({ contract = null, idempotencyKey = '' } = {}) {
  if (!contract?.header || contract.value === null || contract.value === undefined || !String(contract.value).trim()) return null
  const key = String(idempotencyKey || '').trim()
  if (!key) return null
  return {
    [contract.header]: String(contract.value),
    'Idempotency-Key': key
  }
}

function listingClient(token, timeoutMs, signal) {
  const bounded = boundedSignal(timeoutMs, signal)
  const inst = token
    ? axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal, headers: { Authorization: `Bearer ${token}` } })
    : axios.create({ baseURL: getServerBaseUrl() + '/api', timeout: timeoutMs, signal: bounded.signal })
  return { inst, bounded }
}

export async function fetchListingSku(skuCode, { token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const { inst, bounded } = listingClient(token, timeoutMs, signal)
  try {
    const response = await inst.get(listingRequestPath(skuCode), { signal: bounded.signal })
    return { item: response.data, headers: response.headers || {}, status: response.status }
  } finally {
    bounded.cleanup()
  }
}

export async function updateListingSku(skuCode, body, { token = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null, headers = null, contract = null, idempotencyKey = '' } = {}) {
  const requestHeaders = headers || buildListingConditionalHeaders({ contract, idempotencyKey })
  if (!requestHeaders) throw new Error('listing PUT 缺少条件版本/ETag 或幂等键')
  const { inst, bounded } = listingClient(token, timeoutMs, signal)
  try {
    const response = await inst.put(listingRequestPath(skuCode), body, { signal: bounded.signal, headers: requestHeaders })
    return { item: response.data, headers: response.headers || {}, status: response.status }
  } finally {
    bounded.cleanup()
  }
}
