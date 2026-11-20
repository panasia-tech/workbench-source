// 库存 API 对接：拉取在库 SKU，聚合为 API-SPU 主数据并供任务精确关联。
// 纯身份逻辑在 wms-match.js（可独立回归），本文件负责同步、缓存与分页查询。
import * as taskStore from './task-store.js'
import * as appStore from './store.js'
import { assertWritebackTaskReady, buildSpuCatalog, canonicalSpu, decorateTaskWithWms, enrichSkuBrand, matchTaskToSku, normalizeInStockSkus, parseMcpQueryResult, safeWmsErrorReason, wmsMatchSummary } from './wms-match.js'
import {
  assertExplicitWmsCorrection,
  assertVerifiedWmsWriteback,
  buildWmsCorrectionAudit,
  buildWmsWritebackAudit,
  correctionVersionFor,
  sanitizeWmsApiWritebackPatch,
  sanitizeWmsCorrectionPatch
} from './wms-writeback.js'

export { assertWritebackTaskReady, buildSpuCatalog, decorateTaskWithWms, matchTaskToSku, normalizeInStockSkus, parseMcpQueryResult, safeWmsErrorReason, wmsMatchSummary }
export { assertExplicitWmsCorrection, assertVerifiedWmsWriteback, buildWmsCorrectionAudit, buildWmsWritebackAudit, sanitizeWmsApiWritebackPatch, sanitizeWmsCorrectionPatch }

const MAX_MCP_ROWS = 10000
const WMS_REQUEST_TIMEOUT_MS = 15000
// ERP 的 MCP 端点挂在 api 子域（服务端 /api/config/mcp-info 返回的就是
// http://127.0.0.1:8000）。主域只跑 admin-web 静态站，POST /mcp 会被 nginx 405，
// 所以只放行主域等于把 MCP 兜底整条路堵死。主域仍留在名单里，兼容早期填了主域的本机配置。
const MCP_BUILTIN_HOSTS = Object.freeze(['service.example.invalid', 'panasia.fun'])

/**
 * 允许的 MCP 主机名 = 内置生产域 + 当前配置的服务器域（及其 api 子域）。
 *
 * 服务器地址已经是配置项，白名单再钉死在生产域，换一套部署时 MCP 这条路必然被拒。
 * 这里只跟随用户自己填的 ERP 服务器，不接受 MCP URL 里出现的任意主机，
 * 允许集合仍然是有限、可枚举的，桌面端不会变成通用的 SSRF 客户端。
 */
function mcpAllowedHosts() {
  const hosts = new Set(MCP_BUILTIN_HOSTS)
  try {
    const { hostname } = new URL(appStore.getServerBaseUrl?.() || '')
    if (hostname) {
      hosts.add(hostname)
      if (!hostname.startsWith('api.')) hosts.add(`api.${hostname}`)
    }
  } catch { /* 服务器地址没配好时退回内置名单 */ }
  return hosts
}

function mcpUnsafeUrlReason(hosts) {
  return `MCP 数据源 URL 不安全：仅允许 ${[...hosts].map((host) => `https://${host}`).join(' / ')}（标准端口）`
}

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Validate the configured MCP endpoint before any network operation.  MCP is
 * a read-only fallback, but the URL is still user-editable local state and
 * must never turn the desktop app into a generic SSRF client.  Keep the
 * allowlist deliberately narrow: HTTPS on the default port, and only the hosts
 * mcpAllowedHosts() enumerates (built-in production domains plus the server the
 * user configured).  Error messages intentionally do not include the rejected
 * URL, which may contain credentials or query secrets.
 */
export function validateMcpUrl(value) {
  const allowed = mcpAllowedHosts()
  const raw = text(value)
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(mcpUnsafeUrlReason(allowed))
  }
  if (
    parsed.protocol !== 'https:' ||
    !allowed.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443')
  ) {
    throw new Error(mcpUnsafeUrlReason(allowed))
  }
  // streamable-http 的挂载点带尾斜杠：少写一个斜杠，服务端 307 跳到带斜杠的地址，
  // 而 boundedFetch 用 redirect:'error' 不跟随重定向，请求会直接失败。补齐是纯路径
  // 规范化，主机名已经过上面的白名单，不会因此指向别的站点。
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.toString()
}

// ---------- MCP 只读数据源（临时预览通道，后续可整体换 REST API） ----------
// 服务端返回 SSE 流：event: message\ndata: {jsonrpc...}；工具调用统一走 tools/call。
// 文本解析逻辑见 wms-match.js 的 parseMcpQueryResult（纯函数，可离线回归）。

function boundedFetch(url, options = {}, timeoutMs = WMS_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || WMS_REQUEST_TIMEOUT_MS))
  const parentSignal = options.signal
  const abortFromParent = () => controller.abort()
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', abortFromParent, { once: true })
  }
  const signal = controller.signal
  // Never follow redirects: an allowed endpoint must not redirect the
  // application to localhost, a private IP, or another untrusted host.
  return fetch(url, { ...options, redirect: 'error', signal }).finally(() => {
    clearTimeout(timeout)
    parentSignal?.removeEventListener?.('abort', abortFromParent)
  })
}

async function mcpRequest(url, key, payload, { timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const safeUrl = validateMcpUrl(url)
  let response
  try {
    response = await boundedFetch(safeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(payload),
      signal
    }, timeoutMs)
  } catch (error) {
    const timeout = error?.name === 'AbortError' || error?.code === 'ECONNABORTED' || /timeout|aborted/i.test(text(error?.message))
    throw Object.assign(new Error(timeout ? `MCP 请求超时（${timeoutMs}ms）` : 'MCP 请求失败，请检查数据源配置'), { safeReason: timeout ? `MCP 请求超时（${timeoutMs}ms）` : 'MCP 请求失败，请检查数据源配置' })
  }
  if (!response.ok) throw new Error(`MCP 数据源返回 HTTP ${response.status}`)
  const responseText = await response.text()
  for (const line of responseText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      try {
        return JSON.parse(trimmed.slice(5).trim())
      } catch {
        /* 继续找下一条 data 事件 */
      }
    }
  }
  throw new Error('MCP 数据源无有效响应')
}

export function assertValidWmsRows(rows = [], { allowEmpty = false } = {}) {
  const normalized = normalizeInStockSkus(rows)
  if (!normalized.length && !allowEmpty) throw new Error('WMS 数据源没有返回有效的 IN_STOCK 型号')
  return normalized
}

// 只拉在库（IN_STOCK）；出库按要求不纳入对应。
export async function fetchInventorySkusViaMcp({ url, key, limit = MAX_MCP_ROWS, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  if (!url || !key) throw new Error('未配置 MCP 数据源（URL/密钥）')
  // Validate synchronously at the adapter boundary as well as in mcpRequest;
  // malformed/unsafe configuration must fail before entering the request loop.
  const safeUrl = validateMcpUrl(url)
  const safeLimit = Math.min(MAX_MCP_ROWS, Math.max(1, Number(limit) || MAX_MCP_ROWS))
  const queries = [
    // 新版 MCP 允许直接读取当前销售价；旧版只读表可能没有该列，下面保留
    // 已知字段查询作为兼容兜底，不能因临时 MCP schema 落后而阻断 REST/API 主链路。
    `SELECT sku_code, spu_code, brand, model, product_name, spec, suggest_price, sale_price, location_code, product_type, status FROM sku WHERE status='IN_STOCK' ORDER BY created_at DESC LIMIT ${safeLimit}`,
    `SELECT sku_code, spu_code, brand, model, product_name, spec, suggest_price, location_code, product_type, status FROM sku WHERE status='IN_STOCK' ORDER BY created_at DESC LIMIT ${safeLimit}`
  ]
  let lastError = null
  for (const sql of queries) {
    try {
      const result = await mcpRequest(safeUrl, key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'query_database', arguments: { sql, limit: safeLimit } }
      }, { timeoutMs, signal })
      const content = Array.isArray(result?.result?.content) ? result.result.content : []
      let responseText = ''
      for (const item of content) {
        if (item?.type === 'text') responseText += item.text
      }
      const rows = parseMcpQueryResult(responseText)
      if (rows.length) return assertValidWmsRows(rows)
      lastError = new Error('MCP 数据源没有返回有效的 IN_STOCK 型号')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('MCP 数据源没有返回有效的 IN_STOCK 型号')
}

/**
 * 同步公司 WMS 在库型号，成功后才进行一次完整缓存替换。
 * 数据源：auto=先 REST（/api/inventory/skus，需登录 token），失败自动回退 MCP 只读通道；
 * rest=仅 REST；mcp=仅 MCP。MCP 是临时预览通道，拿到 REST 凭据后可切回。
 */
function wmsConnectionSettings() {
  const settings = taskStore.getSettings()
  const protectedSecrets = appStore.getWmsSecrets?.() || {}
  return {
    ...settings,
    // Do not read newly configured credentials from task-center settings. The
    // legacy fields are only retained for migration compatibility and are not
    // used by the production transport.
    wmsMcpKey: protectedSecrets.mcpKey || '',
    wmsRestUsername: protectedSecrets.restUsername || '',
    wmsRestPassword: protectedSecrets.restPassword || ''
  }
}

/**
 * 取一枚能读库存的令牌：就用工作台自己的 ERP 登录态。
 *
 * 服务端已放行设备账号读全部在库型号，含库存成本价（调价的成本底价要用它）。这里
 * 曾经还支持「配了回写管理账号就优先用它」——那是回写只放行 ADMIN/仓管时留下的
 * 权宜之计，代价是每台工位上存着一份能读全部成本/财务的管理员密码。窄接口上线后
 * 回写也用自身令牌了，这条分支连同那组凭据一起下线：桌面端**只有一个身份**。
 */
async function resolveRestReadToken(_settings, { timeoutMs, signal } = {}) {
  const { ensureCrawlerToken } = await import('./erp-sync.js')
  const token = text(await ensureCrawlerToken())
  if (!token) throw new Error('尚未登录 ERP：请先在登录页重新登录')
  return { token, privileged: false }
}

export async function syncWmsSkus({ status = '', source = null, timeoutMs = WMS_REQUEST_TIMEOUT_MS, signal = null } = {}) {
  // Keep REST client loading lazy: the pure MCP/filter/security regressions can
  // run under Node without Electron's named safeStorage export, while the real
  // Electron main process still loads the same API adapter before syncing.
  const { fetchAllInventorySkus } = await import('./api.js')
  const settings = wmsConnectionSettings()
  const chosen = source || settings.wmsSource || 'auto'
  if (!['auto', 'rest', 'mcp'].includes(chosen)) throw new Error('WMS 数据源类型无效')
  // 安全合同不允许同步出库行；保留 status 参数仅为旧 IPC 兼容，任何值均强制 IN_STOCK。
  void status
  let items = []
  let usedSource = ''
  let restError = null
  if (chosen !== 'mcp') {
    try {
      // 读库存用工作台自己的登录态（服务端已放行设备账号读全部在库型号，含成本价——
      // 调价要拿它算成本底价；只读爬虫角色的成本价仍然脱敏）。
      const { token: restToken, privileged } = await resolveRestReadToken(settings, { timeoutMs, signal })
      const data = await fetchAllInventorySkus({ status: 'IN_STOCK', token: restToken, timeoutMs, signal })
      // A complete REST snapshot with total=0 is valid and retires prior API
      // identities. Partial/malformed pages fail inside the convergence
      // helper before this point, so an empty first page cannot wipe cache.
      //
      // 但用工作台自身登录态时，「200 + 0 条」还有另一种解释：服务端尚未放行这个
      // 角色读库存，于是按验货人过滤成了空集。两种情况在响应上无法区分，而误判的
      // 代价是把整份快照清空。所以这条路径下不接受空结果，宁可报错保留上次数据。
      const rows = Array.isArray(data?.items) ? data.items : []
      if (!privileged && rows.length === 0) {
        throw new Error('库存接口返回 0 条：服务端可能尚未放行当前账号读库存，已保留上次快照')
      }
      items = assertValidWmsRows(rows, { allowEmpty: privileged })
      usedSource = 'rest'
    } catch (error) {
      restError = error
      if (chosen === 'rest') {
        const safe = new Error(safeWmsErrorReason(error, 'REST WMS 同步失败'))
        safe.safeReason = safe.message
        throw safe
      }
      // auto：REST 不可用时回退 MCP；不触碰已有缓存。
    }
  }
  if (!usedSource && chosen !== 'rest') {
    try {
      items = await fetchInventorySkusViaMcp({ url: settings.wmsMcpUrl, key: settings.wmsMcpKey, timeoutMs, signal })
      usedSource = restError ? 'mcp-fallback' : 'mcp'
    } catch (error) {
      // auto 模式两条路都断时，只报 MCP 的原因会把真正的死因（REST 凭据/角色不对）
      // 藏起来，页面上就只剩一句「同步均失败」。两条原因都带上。
      const safe = new Error(restError
        ? `REST：${safeWmsErrorReason(restError, 'REST WMS 同步失败')}；MCP：${safeWmsErrorReason(error, 'MCP WMS 同步失败')}`
        : safeWmsErrorReason(error, 'MCP WMS 同步失败'))
      safe.safeReason = safe.message
      throw safe
    }
  }
  const normalized = assertValidWmsRows(items, { allowEmpty: usedSource === 'rest' }).map(enrichSkuBrand)
  const syncedAt = new Date().toISOString()
  const catalog = buildSpuCatalog(normalized)
  // Replace only after complete validation; this preserves the last valid cache on
  // timeout, malformed pagination, empty responses, or rejected inventory rows.
  // The compatibility name `replaceWmsCache(normalized, syncedAt)` remains
  // encapsulated by replaceWmsSnapshot for older task-center readers.
  taskStore.replaceWmsSnapshot(normalized, syncedAt, {
    source: usedSource,
    status: 'synced',
    lastSuccessAt: syncedAt,
    counts: {
      skuTotal: normalized.length,
      spuTotal: catalog.items.length,
      invalidSpuRows: catalog.invalidRows.length
    }
  })
  return {
    ok: true,
    total: normalized.length,
    skuTotal: normalized.length,
    spuTotal: catalog.items.length,
    invalidSpuRows: catalog.invalidRows.length,
    syncedAt: taskStore.getWmsSyncedAt(),
    source: usedSource
  }
}

export function getWmsState() {
  const skus = taskStore.getWmsSkus()
  const catalog = buildSpuCatalog(skus)
  return {
    available: catalog.items.length > 0,
    total: catalog.items.length,
    spuTotal: catalog.items.length,
    skuTotal: skus.length,
    invalidSpuRows: catalog.invalidRows.length,
    conflictSpuCount: catalog.items.filter((item) => item.api_data_conflict).length,
    syncedAt: taskStore.getWmsSyncedAt()
  }
}

/** 返回 API-SPU 主表分页；查询只影响展示，不改变 SPU 关联主键。 */
export function getWmsCatalog({ q = '', page = 1, pageSize = 200 } = {}) {
  const catalog = buildSpuCatalog(taskStore.getWmsSkus())
  const query = text(q).toLowerCase()
  const filtered = query
    ? catalog.items.filter((item) => [item.spu_code, item.sku_codes?.join(' '), item.brand, item.model, item.product_name, item.spec]
      .map((value) => text(value).toLowerCase()).join(' ').includes(query))
    : catalog.items
  const safePageSize = Math.max(1, Math.min(500, Number(pageSize) || 200))
  const safePage = Math.max(1, Number(page) || 1)
  const start = (safePage - 1) * safePageSize
  return {
    items: filtered.slice(start, start + safePageSize),
    total: filtered.length,
    page: safePage,
    pageSize: safePageSize,
    invalidSpuRows: catalog.invalidRows.length,
    syncedAt: taskStore.getWmsSyncedAt()
  }
}

function catalogTaskDto(task = null) {
  if (!task) return null
  return {
    taskId: text(task.taskId || task.id),
    source: text(task.source),
    sourceLabel: text(task.sourceLabel),
    name: text(task.name),
    brand: text(task.brand),
    model: text(task.model),
    spuCode: canonicalSpu(task.spuCode || task.spu_code),
    lastStatus: text(task.lastStatus || task.status) || 'pending',
    lastPrice: task.lastPrice == null ? null : Number(task.lastPrice),
    lastRunAt: task.lastRunAt || null,
    lastReason: text(task.lastReason || task.reason),
    queueKind: text(task.queueKind),
    displayGroup: text(task.displayGroup),
    correctionWorkflowStatus: text(task.correctionWorkflowStatus),
    correctionReviewStatus: text(task.correctionReviewStatus),
    correctionVersion: text(task.correctionVersion),
    aiReviewStatus: text(task.aiReviewStatus),
    aiReviewReason: text(task.aiReviewReason),
    effectiveAlias: text(task.effectiveAlias),
    localizedDisplayName: text(task.localizedDisplayName),
    searchKeywords: Array.isArray(task.searchKeywords) ? task.searchKeywords.map((value) => text(value)).filter(Boolean).slice(0, 12) : [],
    spuSearchPolicy: task.spuSearchPolicy || null,
    effectiveSearchPolicy: task.effectiveSearchPolicy || null,
    apiSkuCode: text(task.apiSkuCode),
    apiSkuCount: Number(task.apiSkuCount) || 0,
    apiDataConflict: Boolean(task.apiDataConflict),
    apiSalePrice: task.apiSalePrice ?? null,
    apiSuggestPrice: task.apiSuggestPrice ?? null,
    apiListingPrice: task.apiListingPrice ?? null,
    apiListingUpdatedAt: task.apiListingUpdatedAt ?? null,
    apiListingVersion: task.apiListingVersion ?? null,
    referencePrice: task.referencePrice ?? null,
    priceComparison: task.lastPriceComparison || task.priceComparison || null,
    correctionAudit: Array.isArray(task.correctionAudit) ? task.correctionAudit.slice(-20) : [],
    writebackAudit: Array.isArray(task.writebackAudit) ? task.writebackAudit.slice(-20) : []
  }
}

/**
 * One bounded projection for the inventory workbench and market queue.  The
 * main process joins the API-SPU master row with its durable task projection;
 * renderers do not fetch the full task collection or create a second source
 * of truth.  `market` is a normal paged queue view with the five display
 * groups; internal reason codes remain on each row for audit/detail views.
 */
export function getWmsProjection({ q = '', page = 1, pageSize = 50, marketGroup = 'all', marketPage = 1, marketPageSize = 50 } = {}) {
  const catalog = getWmsCatalog({ q, page, pageSize })
  const tasks = taskStore.getUnifiedTasks({ includeDisabled: true })
  const taskBySpu = new Map(tasks.map((task) => [canonicalSpu(task.spuCode || task.spu_code), task]))
  const inventory = {
    ...catalog,
    items: catalog.items.map((item) => ({
      ...item,
      task: catalogTaskDto(taskBySpu.get(canonicalSpu(item.spu_code)) || null)
    }))
  }
  const market = taskStore.getTaskQueues({
    kind: marketGroup,
    page: marketPage,
    pageSize: marketPageSize,
    q
  })
  return {
    schemaVersion: 1,
    sync: getWmsState(),
    inventory,
    market
  }
}

/**
 * 仅允许按 API SKU 精确回写商品描述字段；价格不在此入口内。
 * 回写属于“已成功采集 → 人工复核 → API 更新”的闭环，所有门禁都在主进程
 * 重读当前任务后执行，不能由渲染层按钮状态替代。
 */
export async function updateWmsSku({ taskId, skuCode, patch = {}, timeoutMs = WMS_REQUEST_TIMEOUT_MS } = {}) {
  const code = text(skuCode)
  if (!taskId) throw new Error('API 回写缺少任务 ID')
  const task = taskStore.getActiveTask(taskId)
  if (!task) throw new Error('当前任务不存在，不能回写 API')
  assertWritebackTaskReady(task, code)
  const allowed = sanitizeWmsApiWritebackPatch(patch)
  const current = taskStore.getWmsSkus()
  const localRow = current.find((row) => row?.sku_code === code && text(row?.status).toUpperCase() === 'IN_STOCK')
  if (!localRow) {
    throw new Error('只能回写当前 API 缓存中已确认在库的 SKU')
  }
  // 用工作台**自己的**登录态回写（设备账号 MARKET_BOT）。
  // 以前这里要求另填一组管理员账号去换令牌：那把钥匙开的是仓管全量编辑接口
  // （能改货号、改 69 码），而我们只想改一个商品名，还得把管理员密码存在每台工位上。
  // 现在服务端有了只认 product_name/brand/model 的窄接口，端上不再保管第二套凭据。
  const { ensureCrawlerToken } = await import('./erp-sync.js')
  const { fetchInventorySku, inventoryVersion, updateSkuMarketInfo } = await import('./api.js')
  const selfToken = text(await ensureCrawlerToken())
  if (!selfToken) throw new Error('尚未登录 ERP：请先在登录页重新登录')
  const beforeResponse = await fetchInventorySku(code, { token: selfToken, timeoutMs })
  const before = beforeResponse?.item || {}
  if (text(before?.sku_code) !== code || text(before?.status).toUpperCase() !== 'IN_STOCK') {
    throw new Error('API 回写前 GET 未确认该 SKU 仍在库，已阻止 PATCH')
  }
  if (canonicalSpu(before?.spu_code || before?.spuCode) !== canonicalSpu(task.spuCode || task.spu_code)) {
    throw new Error('API 回写前 GET 返回的 SPU 与当前任务不一致，已阻止 PATCH')
  }
  const expectedVersion = inventoryVersion(before, beforeResponse?.headers || {})
  if (expectedVersion == null || !text(expectedVersion)) {
    const audit = buildWmsWritebackAudit({ task, skuCode: code, patch: allowed, before, operator: task.correctionOperator || 'manual', result: 'failed', reason: 'API 未提供 updated_at/version/ETag，无法安全执行并发门禁' })
    taskStore.applyTaskPatches([{ id: taskId, writebackAudit: [...(task.writebackAudit || []), audit].slice(-20) }])
    throw new Error('API 未提供 updated_at/version/ETag，不能安全回写')
  }
  const idempotencyKey = `${taskId}:${text(task.correctionVersion) || correctionVersionFor(allowed)}:${code}`
  let verifiedResponse
  let verified = {}
  try {
    await updateSkuMarketInfo(code, allowed, {
      token: selfToken,
      timeoutMs,
      expectedVersion,
      etag: beforeResponse?.headers?.etag || beforeResponse?.headers?.ETag || before?.etag || ''
    })
    // PATCH 成功不等于服务端已持久化。必须 GET 回读并逐字段比对，缓存只接受
    // 服务端确认后的对象，避免 UI 显示“已回写”但下次同步又恢复旧值。
    verifiedResponse = await fetchInventorySku(code, { token: selfToken, timeoutMs })
    verified = verifiedResponse?.item || {}
    assertVerifiedWmsWriteback({ task, skuCode: code, patch: allowed, before, after: verified, afterHeaders: verifiedResponse?.headers || {}, expectedVersion })
  } catch (error) {
    const audit = buildWmsWritebackAudit({ task, skuCode: code, patch: allowed, before, response: verified, operator: task.correctionOperator || 'manual', idempotencyKey, expectedVersion, result: 'failed', reason: safeWmsErrorReason(error, 'API 回写后 GET 校验失败') })
    taskStore.applyTaskPatches([{ id: taskId, writebackAudit: [...(task.writebackAudit || []), audit].slice(-20), correctionWorkflowStatus: 'writeback_failed', correctionWorkflowReason: audit.reason }])
    throw error
  }
  const normalizedVerified = normalizeInStockSkus([verified])[0]
  if (!normalizedVerified) throw new Error('API 回写后 GET 返回无效在库 SKU，未更新本地缓存')
  const next = current.map((row) => row?.sku_code === code ? { ...row, ...normalizedVerified } : row)
  // 回写不是一次完整同步，保留上次全量同步时间，避免把局部 PATCH 冒充成全量刷新。
  taskStore.replaceWmsCache(next, taskStore.getWmsSyncedAt())
  const audit = buildWmsWritebackAudit({ task, skuCode: code, patch: allowed, before, response: verified, operator: task.correctionOperator || 'manual', idempotencyKey, expectedVersion, verified: true })
  taskStore.applyTaskPatches([{ id: taskId, correctionWorkflowStatus: 'verified', correctionReviewStatus: 'verified', writebackAudit: [...(task.writebackAudit || []), audit].slice(-20) }])
  return { ok: true, skuCode: code, item: normalizedVerified, syncedAt: taskStore.getWmsSyncedAt(), verified: true, audit }
}

/** Apply a selected policy-v1 price through the dedicated listing contract. */
export async function applyWmsPrice({ taskId, skuCode = '', preview, timeoutMs = WMS_REQUEST_TIMEOUT_MS } = {}) {
  const task = taskStore.getMarketTask(taskId)
  if (!task) throw new Error('当前任务不存在，不能回写销售价')
  const code = text(skuCode || task.apiSkuCode || (Number(task.apiSkuCount) === 1 ? task.apiSkuCodes?.[0] : ''))
  if (!code) throw new Error('价格回写必须指定唯一 SKU；多 SKU SPU 需要逐 SKU 复核')
  const settings = wmsConnectionSettings()
  // 价格回写打的是「保存上架信息」接口（标题/描述/售价/图片一整套），
  // 那是另一个量级的权限，没有随名称回写一起开给设备账号——它现在是**明确未启用**，
  // 而不是"再去填个管理员密码就能用"。要启用得单独决定并单独授权。
  if (!settings.wmsRestUsername || !settings.wmsRestPassword) {
    const reason = '价格回写未启用（需要单独授权上架写权限），当前保持预览模式'
    taskStore.appendPriceApplyAudit({ taskId, audit: { action: 'price_apply', status: 'blocked', reason, putIssued: false, at: new Date().toISOString(), skuCode: code, spuCode: text(task.spuCode) } })
    return { ok: false, status: 'blocked', putIssued: false, reason }
  }
  const { adminLogin, fetchListingSku, updateListingSku } = await import('./api.js')
  let admin
  try {
    admin = await adminLogin(settings.wmsRestUsername, settings.wmsRestPassword, { timeoutMs })
  } catch (error) {
    const reason = safeWmsErrorReason(error, 'REST ADMIN 登录失败，价格回写保持阻断')
    taskStore.appendPriceApplyAudit({ taskId, audit: { action: 'price_apply', status: 'blocked', reason, putIssued: false, at: new Date().toISOString(), skuCode: code, spuCode: text(task.spuCode) } })
    return { ok: false, status: 'blocked', putIssued: false, reason }
  }
  if (!admin?.token) return { ok: false, status: 'blocked', putIssued: false, reason: 'REST ADMIN 登录未返回有效令牌' }
  const { applyPriceSelection } = await import('./price-apply.js')
  return applyPriceSelection({
    preview,
    skuCode: code,
    auth: { source: 'rest', token: admin.token, role: admin.staff?.role, staff: admin.staff },
    fetchCurrentListing: (sku) => fetchListingSku(sku, { token: admin.token, timeoutMs }),
    putListing: (sku, body, options) => updateListingSku(sku, body, { token: admin.token, timeoutMs, headers: options.headers, contract: options.contract, idempotencyKey: options.idempotencyKey }),
    hasAppliedIdempotency: (key) => taskStore.hasPriceApplyIdempotency(key),
    recordAudit: (audit) => taskStore.appendPriceApplyAudit({ taskId, audit }),
    updateCache: (after, { contract }) => taskStore.updateWmsListingPrice({
      skuCode: code,
      spuCode: after?.spu_code || after?.spuCode || task.spuCode,
      price: after?.price,
      updatedAt: after?.updated_at || after?.updatedAt || null,
      version: after?.version || after?.revision || (contract?.kind === 'version' ? contract.value : null),
      etag: after?.etag || null
    })
  })
}

/** 保存异常任务的搜索修正；这是本地 correction/review 意图，不是 API 回写。 */
export async function correctWmsSkuAndRecollect({ taskId, skuCode = '', patch = {}, confirm = false, operator = 'manual' } = {}) {
  const safePatch = assertExplicitWmsCorrection({ taskId, skuCode, confirm, patch })
  const task = taskStore.getActiveTask(taskId)
  if (!task) throw new Error('当前任务不存在，不能发起 WMS 修正')
  const correction = taskStore.applyManualTaskCorrection(taskId, {
    brand: safePatch.brand,
    model: safePatch.model,
    keyword: safePatch.keyword,
    search_terms: safePatch.search_terms,
    aliases: safePatch.aliases,
    operator
  })
  if (!correction?.ok) throw new Error(correction?.reason || '搜索修正保存失败')
  return { ok: true, correction, apiWritebackRequired: false, message: '已保存搜索修正并进入人工复核；复采成功且确认后才能回写 API' }
}
