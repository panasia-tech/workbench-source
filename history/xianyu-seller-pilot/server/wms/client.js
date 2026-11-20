"use strict"

// Server-only WMS transport.  It deliberately contains no Electron imports,
// employee-local storage or renderer concerns.  The inventory/SPU rules stay
// in src/main/wms-match.js and are loaded by the sync service below.

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PAGE_SIZE = 100
const MAX_ROWS = 1_000_000

function text(value) { return String(value ?? '').trim() }

function safeError(error, fallback = 'WMS 请求失败') {
  const message = text(error?.safeReason || error?.message || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;)}]+/gi, '$1=[REDACTED]')
  return Object.assign(new Error(message.slice(0, 240) || fallback), { safeReason: message.slice(0, 240) || fallback })
}

function boundedSignal(timeoutMs, parentSignal = null) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  const abort = () => controller.abort()
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout)
      parentSignal?.removeEventListener?.('abort', abort)
    }
  }
}

function joinUrl(base, pathname, query = null) {
  const root = new URL(`${String(base || '').replace(/\/$/, '')}/`)
  const path = String(pathname || '').replace(/^\/+/, '')
  const url = new URL(path, root)
  if (query) for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  return url
}

function assertConfig(config = {}) {
  const apiBaseUrl = text(config.apiBaseUrl)
  if (!apiBaseUrl) throw new Error('WMS_API_BASE_URL 未配置')
  const parsed = new URL(apiBaseUrl)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('WMS_API_BASE_URL 必须是无凭据的 HTTPS URL')
  return { ...config, apiBaseUrl: parsed.toString().replace(/\/$/, '') }
}

function validateMcpUrl(value) {
  const raw = text(value)
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('WMS_MCP_URL 必须是有效 HTTPS URL') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('WMS_MCP_URL 必须是无凭据的 HTTPS URL')
  return parsed.toString().replace(/\/$/, '')
}

function parseMcpRows(value) {
  const raw = text(value)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.items)) return parsed.items
    if (Array.isArray(parsed?.rows)) return parsed.rows
  } catch {}
  const lines = raw.split(/\r?\n/).map(line => line.trim())
  if (!lines[0]?.startsWith('列:')) return []
  const columns = lines[0].slice(2).split(',').map(column => column.trim()).filter(Boolean)
  return lines.slice(2).filter(Boolean).map(line => {
    const parts = line.split('\t')
    return Object.fromEntries(columns.map((column, index) => [column, parts[index] ?? '']))
  })
}

function createWmsClient(config = {}, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const settings = assertConfig(config)
  if (typeof fetchImpl !== 'function') throw new Error('服务器运行时缺少 fetch')

  async function request(pathname, { method = 'GET', query = null, token = '', body = undefined, signal = null, headers = {} } = {}) {
    const bounded = boundedSignal(timeoutMs, signal)
    const requestHeaders = { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache', ...headers }
    if (token) requestHeaders.Authorization = `Bearer ${token}`
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'
    try {
      const response = await fetchImpl(joinUrl(settings.apiBaseUrl, pathname, query), { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: bounded.signal })
      const raw = await response.text()
      let data = {}
      try { data = raw ? JSON.parse(raw) : {} } catch { data = { raw: raw.slice(0, 240) } }
      if (!response.ok) {
        const error = new Error(`WMS 返回 HTTP ${response.status}`)
        error.status = response.status
        error.response = { status: response.status, data }
        throw error
      }
      return { data, headers: response.headers || {}, status: response.status }
    } catch (error) {
      if (error?.status) throw error
      const timedOut = error?.name === 'AbortError' || /timeout|aborted/i.test(text(error?.message))
      throw safeError(error, timedOut ? `WMS 请求超时（${timeoutMs}ms）` : 'WMS 请求失败，请检查服务器配置')
    } finally {
      bounded.cleanup()
    }
  }

  async function adminLogin({ signal = null } = {}) {
    if (!settings.restUsername || !settings.restPassword) throw Object.assign(new Error('未配置 WMS REST 管理账号'), { code: 'wms_credentials_missing' })
    const response = await request('/auth/admin-login', { method: 'POST', body: { username: settings.restUsername, password: settings.restPassword }, signal })
    const token = text(response.data?.token)
    if (!token) throw Object.assign(new Error('WMS 管理登录未返回有效令牌'), { code: 'wms_token_missing' })
    return { token, staff: response.data?.staff || null }
  }

  async function fetchInventoryPage({ status = 'IN_STOCK', page = 1, size = DEFAULT_PAGE_SIZE, token = '', signal = null } = {}) {
    if (String(status).toUpperCase() !== 'IN_STOCK') throw new Error('服务器库存同步只允许读取 IN_STOCK')
    const safePage = Number(page); const safeSize = Number(size)
    if (!Number.isInteger(safePage) || safePage < 1) throw new Error('WMS 分页 page 无效')
    if (!Number.isInteger(safeSize) || safeSize < 1 || safeSize > 100) throw new Error('WMS 分页 size 无效')
    return request('/inventory/skus', { query: { status: 'IN_STOCK', page: safePage, size: safeSize }, token, signal })
  }

  async function fetchAllInventory({ token = '', signal = null, pageSize = DEFAULT_PAGE_SIZE, maxRows = MAX_ROWS } = {}) {
    const safePageSize = Number(pageSize)
    if (!Number.isInteger(safePageSize) || safePageSize < 1 || safePageSize > 100) throw new Error('WMS 分页 size 无效')
    const safeMaxRows = Number(maxRows)
    if (!Number.isInteger(safeMaxRows) || safeMaxRows < safePageSize) throw new Error('WMS 分页 maxRows 无效')
    const items = []; const signatures = new Set(); let page = 1; let total = null; let previousHasMore = null
    while (true) {
      const response = await fetchInventoryPage({ page, size: safePageSize, token, signal })
      const data = response?.data || {}
      if (!Array.isArray(data.items)) throw new Error(`WMS 第 ${page} 页响应缺少 items`)
      const batch = data.items
      const reportedPage = Number(data.page)
      if (Number.isFinite(reportedPage) && reportedPage !== page) throw new Error(`WMS 分页响应不一致（请求第 ${page} 页，返回第 ${reportedPage} 页）`)
      const reportedTotal = data.total == null || data.total === '' ? null : Number(data.total)
      if (reportedTotal != null && (!Number.isInteger(reportedTotal) || reportedTotal < 0)) throw new Error(`WMS 第 ${page} 页 total 无效`)
      if (total != null && reportedTotal != null && total !== reportedTotal) throw new Error('WMS 分页 total 在不同页面不一致')
      if (reportedTotal != null) total = reportedTotal
      const hasMore = data.has_more ?? data.hasMore
      if (previousHasMore === false) throw new Error('WMS 分页在 has_more=false 后仍返回后续页面')
      const signature = JSON.stringify(batch.map(row => [row?.sku_code, row?.spu_code, row?.model, row?.status]))
      if (signatures.has(signature)) throw new Error(`WMS 分页重复（第 ${page} 页）`)
      signatures.add(signature)
      if (batch.some(row => String(row?.status || '').trim().toUpperCase() !== 'IN_STOCK')) throw new Error(`WMS 第 ${page} 页包含非 IN_STOCK 商品`)
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
      if (batch.length < safePageSize && hasMore !== true) {
        if (total != null && items.length !== total) throw new Error('WMS 短页未收齐 total')
        break
      }
      previousHasMore = hasMore == null ? null : Boolean(hasMore)
      page += 1
    }
    return { items, total: total ?? items.length, pageCount: page }
  }

  async function fetchInventorySku(skuCode, { token = '', signal = null } = {}) {
    const code = text(skuCode); if (!code) throw new Error('WMS 查询缺少 SKU')
    return request(`/inventory/skus/${encodeURIComponent(code)}`, { token, signal })
  }

  async function updateInventorySku(skuCode, patch, { token = '', expectedVersion = null, etag = '', signal = null } = {}) {
    const code = text(skuCode); if (!code) throw new Error('WMS 回写缺少 SKU')
    const headers = {}
    if (etag) headers['If-Match'] = String(etag)
    if (expectedVersion != null) headers['X-Expected-Version'] = String(expectedVersion)
    return request(`/inventory/skus/${encodeURIComponent(code)}`, { method: 'PATCH', token, body: patch, headers, signal })
  }

  async function fetchMcpInventory({ signal = null, limit = 10_000 } = {}) {
    const url = validateMcpUrl(settings.mcpUrl)
    const key = text(config.mcpKey)
    if (!key) throw Object.assign(new Error('未配置 WMS MCP 密钥'), { code: 'wms_credentials_missing' })
    const bounded = boundedSignal(timeoutMs, signal)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_database', arguments: { sql: `SELECT sku_code, spu_code, brand, model, product_name, spec, suggest_price, sale_price, location_code, product_type, status FROM sku WHERE status='IN_STOCK' ORDER BY created_at DESC LIMIT ${Math.min(10_000, Math.max(1, Number(limit) || 10_000))}`, limit: Math.min(10_000, Math.max(1, Number(limit) || 10_000)) } } }),
        redirect: 'error',
        signal: bounded.signal
      })
      const raw = await response.text()
      if (!response.ok) throw Object.assign(new Error(`WMS MCP 返回 HTTP ${response.status}`), { status: response.status })
      let payload = null
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim().startsWith('data:')) continue
        try { payload = JSON.parse(line.trim().slice(5).trim()); break } catch {}
      }
      const content = Array.isArray(payload?.result?.content) ? payload.result.content : []
      const textContent = content.filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n')
      const items = parseMcpRows(textContent)
      if (!items.length) throw new Error('WMS MCP 没有返回有效的 IN_STOCK 型号')
      return { items, total: items.length }
    } catch (error) {
      if (error?.status) throw error
      throw safeError(error, 'WMS MCP 请求失败，请检查服务器配置')
    } finally {
      bounded.cleanup()
    }
  }

  return { settings: { ...settings, restPassword: undefined, mcpKey: undefined }, request, adminLogin, fetchInventoryPage, fetchAllInventory, fetchInventorySku, updateInventorySku, fetchMcpInventory }
}

module.exports = { DEFAULT_PAGE_SIZE, DEFAULT_TIMEOUT_MS, MAX_ROWS, createWmsClient, safeError }
