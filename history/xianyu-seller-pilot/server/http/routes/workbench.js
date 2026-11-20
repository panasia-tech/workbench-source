"use strict"

const crypto = require('node:crypto')
const XLSX = require('xlsx')
const { tokenFromRequest } = require('../events.js')
const { enqueueWorkbenchTasks, retryableTasks, resumableTasks } = require('../../jobs/workbench-runner.js')
const { syncWorkbenchSchedule } = require('../../jobs/recurring-schedules.js')
const { appendAudit, executeWmsIdentityWriteback, normalizeVerifiedInventory, blockedWmsWritebackAudit } = require('../../wms/writeback.js')

const MAX_ROWS = 10_000
const HEADER_ALIASES = {
  brand: ['品牌', 'brand'],
  model: ['名称（兼容型号）', '名称/型号', '型号名称', '型号', 'model', 'name'],
  alias: ['别称（可能由SPU读取内容生成）', '别称', 'alias'],
  spuCode: ['SPU编号', 'SPU', 'SPU编码', 'spu_code', 'spuCode'],
  referencePrice: ['采购价', '采购价格', '采购成本', 'purchase_price', 'referencePrice'],
  category: ['分类', '品类', 'category']
}

function actorFor(request, auth) {
  return auth.verifyToken(tokenFromRequest(request))
}

function appendAiEvent(previous = {}, event = {}) {
  const row = { at: new Date().toISOString(), ...event }
  return [...(Array.isArray(previous.aiEvents) ? previous.aiEvents : []), row].slice(-100)
}

function aiResultStatus(result = {}) {
  return result.ok && Array.isArray(result.results) && result.results.length ? 'needs_review' : 'search_failed'
}

function requireActor(request, reply, auth, roles = []) {
  const actor = actorFor(request, auth)
  if (!actor) { reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } }); return null }
  if (roles.length && !roles.includes(actor.role)) { reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } }); return null }
  return actor
}

function safeNumber(value) {
  if (value == null || String(value).trim() === '') return null
  const normalized = String(value).replace(/[¥￥，,\s]/g, '')
  const number = Number(normalized)
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null
}

function pickHeader(headers, aliases) {
  const index = headers.findIndex(header => aliases.some(alias => String(header || '').trim().toLowerCase() === String(alias).trim().toLowerCase()))
  return index < 0 ? -1 : index
}

function parseWorkbook(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw Object.assign(new Error('Excel 中没有工作表'), { code: 'sheet_required' })
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false })
  const headers = (rows.shift() || []).map(value => String(value || '').trim())
  if (!headers.length) throw Object.assign(new Error('Excel 首行必须是表头'), { code: 'header_required' })
  const indexes = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, pickHeader(headers, aliases)]))
  if (indexes.brand < 0 || indexes.model < 0) throw Object.assign(new Error('Excel 至少需要“品牌”和“名称（兼容型号）”列'), { code: 'required_columns' })
  if (rows.length > MAX_ROWS) throw Object.assign(new Error(`Excel 最多支持 ${MAX_ROWS} 行`), { code: 'row_limit_exceeded' })
  const tasks = rows.map((values, index) => {
    const value = key => indexes[key] >= 0 ? values[indexes[key]] : ''
    const brand = String(value('brand') || '').trim()
    const model = String(value('model') || '').trim()
    if (!brand && !model) return null
    if (!brand || !model) throw Object.assign(new Error(`第 ${index + 2} 行的品牌和型号必须同时填写`), { code: 'row_invalid' })
    const alias = String(value('alias') || '').trim()
    const spuCode = String(value('spuCode') || '').trim()
    const referencePrice = safeNumber(value('referencePrice'))
    const category = String(value('category') || '').trim()
    const id = crypto.createHash('sha256').update(`${brand}\0${model}\0${spuCode}\0${index}`).digest('hex').slice(0, 32)
    return { id, brand, model, name: model, alias, spuCode, referencePrice, category, searchKeywords: [model, `${brand} ${model}`.trim(), alias].filter(Boolean) }
  }).filter(Boolean)
  if (!tasks.length) throw Object.assign(new Error('Excel 没有可执行任务行'), { code: 'empty_sheet' })
  return { sourceFile: String(filename || '任务清单.xlsx').slice(0, 240), sheetName: String(sheetName).slice(0, 120), tasks }
}

function workbookResponse(reply, workbook, filename) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const safeName = String(filename || 'download.xlsx').replace(/[\r\n"\\]/g, '')
  reply.header('content-disposition', `attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
  return reply.send(buffer)
}

async function buildWmsProjection(db, query = {}, wms = null) {
  const { priceFence } = await historyRules()
  const page = db.listWorkbenchTasks({ page: query.page, pageSize: query.pageSize, q: query.q, includeDisabled: true })
  const marketPage = db.listWorkbenchTasks({ page: query.marketPage, pageSize: query.marketPageSize, q: query.q, includeDisabled: true })
  const results = db.listWorkbenchResults({ page: 1, pageSize: 2000, q: query.q }).items
  const latest = new Map()
  for (const result of results) if (!latest.has(result.task_id)) latest.set(result.task_id, result)
  let apiCatalog = null
  const marketItems = marketPage.items.map(task => {
    const result = latest.get(task.id)
    const rawStatus = result?.status || task.lastStatus || 'pending'
    const status = rawStatus === 'succeeded' || rawStatus === 'completed' ? 'success' : rawStatus === 'failed' ? 'fail' : rawStatus
    const normalizedQueueKind = status === 'success' ? 'success' : ['fail', 'failed', 'invalid_price', 'risk_control'].includes(status) ? (status === 'failed' ? 'fail' : status) : status === 'empty' ? 'empty' : 'pending'
    const observedPrice = result?.price ?? task.lastPrice ?? null
    const priceComparison = priceFence.classifyPriceAgainstPurchase({ marketPrice: observedPrice, purchasePrice: task.referencePrice })
    const displayGroup = ['empty', 'fail', 'failed', 'invalid_price', 'risk_control'].includes(normalizedQueueKind) ? 'failed' : normalizedQueueKind === 'success' ? 'success' : 'pending'
    return { ...task, taskId: task.id, spu_code: task.spuCode, queueKind: normalizedQueueKind, displayGroup, lastStatus: status, lastPrice: observedPrice, lastReason: result?.reason || task.lastReason || '', price: observedPrice, referencePrice: task.referencePrice, priceComparison, lastPriceComparison: priceComparison, priceBand: priceComparison.key, result: result?.result || task.result || null }
  })
  const groupCounts = { all: marketItems.length, pending: marketItems.filter(item => item.displayGroup === 'pending').length, success: marketItems.filter(item => item.displayGroup === 'success').length, failed: marketItems.filter(item => item.displayGroup === 'failed').length, review: marketItems.filter(item => item.displayGroup === 'review').length }
  const priceBandCounts = Object.fromEntries(['purchase_100_119', 'purchase_120_plus', 'purchase_150_plus', 'purchase_200_plus'].map(key => [key, 0]))
  for (const item of marketItems) if (item.displayGroup === 'success' && Object.hasOwn(priceBandCounts, item.priceBand)) priceBandCounts[item.priceBand] += 1
  const wmsState = db.getWmsSyncState?.() || { status: 'unconfigured', source: '', available: false, skuTotal: 0, spuTotal: 0, invalidSpuRows: 0, syncedAt: null }
  let inventory = null
  if (wmsState.status === 'synced' && typeof db.listAllWmsInventory === 'function' && db.listAllWmsInventory().length) {
    const rules = await import('../../../src/main/wms-match.js')
    const rows = db.listAllWmsInventory()
    const catalog = rules.buildSpuCatalog(rows)
    apiCatalog = catalog
    const taskBySpu = new Map(page.items.map(task => [String(task.spuCode || '').trim().toUpperCase(), task]))
    inventory = catalog.items.map(item => {
      const task = taskBySpu.get(String(item.spu_code || '').trim().toUpperCase()) || null
      return {
        ...item,
        task: task ? { ...task, spu_code: task.spuCode } : null,
        spu_code: item.spu_code,
        sku_count: Array.isArray(item.sku_items) ? item.sku_items.length : 0
      }
    })
  }
  const projectedMarketItems = marketItems.map((item) => {
    if (!apiCatalog) return item
    const association = apiCatalog.bySpu.get(String(item.spuCode || '').trim().toUpperCase()) || null
    if (!association) {
      return {
        ...item,
        apiSpuAssociationStatus: item.spuCode ? 'spu_not_found' : 'missing_spu',
        apiSpuAssociationPercent: null,
        apiSpuAssociated: false,
        apiSpuAssociationReason: item.spuCode ? `API 中不存在 SPU：${item.spuCode}` : '任务缺少 SPU，未执行其他字段匹配',
        apiSkuCodes: [], apiSkuCount: 0, apiSkuCode: null,
        apiSpuCode: null, apiDataConflict: false
      }
    }
    return {
      ...item,
      apiSpuAssociationStatus: 'exact',
      apiSpuAssociationPercent: 100,
      apiSpuAssociated: true,
      apiSpuAssociationReason: association.api_data_conflict ? 'SPU 已精确关联，但 API 同一 SPU 的字段存在冲突' : '',
      apiSpuDataQualityStatus: association.data_quality_status || 'clean',
      apiSkuCodes: association.sku_codes || [],
      apiSkuCount: Number(association.sku_count) || 0,
      apiSkuCode: Number(association.sku_count) === 1 ? association.sku_codes?.[0] || null : null,
      apiSpuCode: association.spu_code || null,
      apiBrand: association.brand || null,
      apiModel: association.model || null,
      apiProductName: association.product_name || null,
      apiSpec: association.spec || null,
      apiSalePrice: association.sale_price || null,
      apiSalePriceValues: association.sale_price_values || [],
      apiSuggestPrice: association.suggest_price || null,
      apiSuggestPriceValues: association.suggest_price_values || [],
      apiDataConflict: Boolean(association.api_data_conflict),
      apiListingUpdatedAt: association.listing_updated_at || null
    }
  })
  return {
    inventory: inventory ? { items: inventory, total: inventory.length, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 50 } : { items: page.items.map(task => ({ task: { ...task, spu_code: task.spuCode }, spu_code: task.spuCode, sku_count: task.spuCode ? 1 : 0, sku_items: task.spuCode ? [{ sku_code: task.spuCode, product_name: task.name, brand: task.brand, model: task.model, purchase_price: task.referencePrice, purchase_price_status: task.referencePrice == null ? 'missing_price' : 'available', status: 'active' }] : [] })), total: page.total, page: page.page, pageSize: page.pageSize },
    market: { items: projectedMarketItems.slice(0, Math.min(500, Number(query.marketPageSize) || 50)), total: projectedMarketItems.length, groupCounts, priceBandCounts, page: Number(query.marketPage) || 1, pageSize: Number(query.marketPageSize) || 50 },
    sync: inventory ? wmsState : { status: 'projection', source: 'server_task_catalog', syncedAt: null, lastSuccessAt: null, stale: false, available: page.total > 0, safeError: '', skuTotal: page.items.filter(task => task.spuCode).length, spuTotal: page.total, invalidSpuRows: 0 }
  }
}

let historyRulesPromise = null
function historyRules() {
  if (!historyRulesPromise) historyRulesPromise = Promise.all([
    import('../../../src/main/price-fence.js'),
    import('../../../src/main/task-queue.js')
  ]).then(([priceFence, taskQueue]) => ({ priceFence, taskQueue }))
  return historyRulesPromise
}

async function buildMarketHistory(db, query = {}, wms = null) {
  const { priceFence, taskQueue } = await historyRules()
  // The database API deliberately caps one page at 500 rows. History group
  // counts must still cover the complete server-owned ledger, so hydrate all
  // pages before applying the H5 filters instead of silently counting only
  // the newest page.
  const firstPage = db.listWorkbenchResults({ page: 1, pageSize: 500, q: '', status: null })
  const raw = [...firstPage.items]
  for (let page = 2; page <= Math.ceil(Number(firstPage.total || 0) / 500); page += 1) {
    raw.push(...db.listWorkbenchResults({ page, pageSize: 500, q: '', status: null }).items)
  }
  const rows = raw.map((item) => {
    const task = db.getWorkbenchTask(item.task_id) || {}
    const result = item.result && typeof item.result === 'object' ? item.result : {}
    const rawStatus = String(item.status || 'failed')
    const status = rawStatus === 'succeeded' || rawStatus === 'completed' ? 'success' : rawStatus === 'failed' ? 'fail' : rawStatus
    const queueKind = taskQueue.queueKeyForStatus(status)
    const referencePrice = task.referencePrice == null ? null : Number(task.referencePrice)
    const priceComparison = priceFence.classifyPriceAgainstPurchase({ marketPrice: item.price, purchasePrice: referencePrice })
    const searchKeywords = Array.isArray(task.searchKeywords) && task.searchKeywords.length
      ? [...task.searchKeywords]
      : String(result.keyword || '').split('|').map((value) => value.trim()).filter(Boolean)
    const displayGroup = status === 'success' ? 'success' : status === 'pending' ? 'pending' : 'failed'
    return {
      id: item.id,
      taskId: item.task_id,
      runId: item.run_id,
      at: item.created_at,
      status,
      rawStatus,
      queueKind,
      displayGroup,
      brand: task.brand || item.brand || '',
      name: task.name || item.name || '',
      model: task.model || item.model || '',
      category: task.category || item.category || '',
      spuCode: task.spuCode || item.spuCode || '',
      referencePrice,
      keyword: result.keyword || searchKeywords.join(' | '),
      searchKeywords,
      price: item.price,
      reason: item.reason || result.error?.message || '',
      result: result.result || result,
      snapshotPath: result.snapshotPath || '',
      priceComparison,
      priceBand: priceComparison.key,
      priceReason: priceComparison.reason,
      attempts: 1
    }
  })

  const q = String(query.q || '').trim().toLowerCase()
  const matchesQuery = (row) => !q || [row.name, row.brand, row.model, row.category, row.keyword, row.spuCode].some((value) => String(value || '').toLowerCase().includes(q))
  const scoped = rows.filter(matchesQuery).filter((row) => !query.priceBand || row.priceBand === String(query.priceBand))
  const groupCounts = { all: scoped.length, failed: 0, pending: 0, success: 0, review: 0 }
  for (const row of scoped) groupCounts[row.displayGroup] = (groupCounts[row.displayGroup] || 0) + 1
  const group = String(query.group || 'all')
  const filtered = group === 'all' ? scoped : scoped.filter((row) => group === 'attention' ? ['failed', 'review'].includes(row.displayGroup) : row.displayGroup === group)
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 50))
  const priceBandCounts = Object.fromEntries(['purchase_100_119', 'purchase_120_plus', 'purchase_150_plus', 'purchase_200_plus'].map((key) => [key, 0]))
  for (const row of scoped) if (row.displayGroup === 'success' && Object.hasOwn(priceBandCounts, row.priceBand)) priceBandCounts[row.priceBand] += 1
  const sync = wms?.getState?.() || db.getWmsSyncState?.() || { status: 'unconfigured', source: '', syncedAt: null, safeError: '' }
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, page, pageSize, group, groupCounts, priceBandCounts, sync }
}

function buildWorkbenchPlan(db) {
  const tasks = db.listWorkbenchTasks({ page: 1, pageSize: 2000, includeDisabled: false }).items.filter((task) => ['pending', 'failed', 'empty', 'invalid_price', 'risk_control'].includes(task.lastStatus))
  const profiles = db.listBrowserProfiles({ limit: 100 })
  const buckets = profiles.map((profile, index) => ({ accountId: profile.id, accountName: profile.label, count: tasks.filter((_task, taskIndex) => taskIndex % Math.max(1, profiles.length) === index).length }))
  return { total: tasks.length, buckets, tasks: tasks.map((task) => task.id) }
}

function buildPriceIntentPreview(task) {
  if (!task) return null
  const market = task.lastPrice == null ? null : Number(task.lastPrice)
  const cost = task.referencePrice == null ? null : Number(task.referencePrice)
  const candidates = [
    { key: 'market', label: '行情观察价', price: market, enabled: Number.isFinite(market) && market > 0, reason: market == null ? '尚未取得行情价' : '' },
    { key: 'reference', label: '采购价', price: cost, enabled: Number.isFinite(cost) && cost > 0, reason: cost == null ? '未提供采购价' : '' }
  ]
  return {
    previewId: `${task.id}-${task.updatedAt || ''}`,
    policyVersion: 'server-workbench-v1',
    status: candidates.some(item => item.enabled) ? 'ready' : 'blocked',
    facts: { costPrice: cost, apiCurrentSalePrice: null, apiSuggestPrice: null },
    market: { median: market },
    candidates
  }
}

async function decorateTaskForWmsWriteback(db, task) {
  const rules = await import('../../../src/main/wms-match.js')
  const association = rules.matchTaskToSku(task, db.listAllWmsInventory?.() || [])
  return {
    ...task,
    lastStatus: ['succeeded', 'completed'].includes(task.lastStatus) ? 'success' : task.lastStatus === 'failed' ? 'fail' : task.lastStatus,
    apiSpuAssociationStatus: association.associationStatus,
    apiSpuAssociationPercent: association.associationPercent,
    apiSpuAssociated: association.associated,
    apiSpuCode: association.spu_code || null,
    apiSkuCodes: association.apiSkuCodes || association.sku_codes || [],
    apiSkuCount: Number(association.sku_count) || 0,
    apiSkuCode: Number(association.sku_count) === 1 ? association.sku_codes?.[0] || null : null,
    apiDataConflict: Boolean(association.api_data_conflict)
  }
}

function registerWorkbenchRoutes(fastify, { db, auth, config = {}, wms = null, llm = null }) {
  const aiSearchInFlight = new Map()
  fastify.get('/workbench/summary', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchSummary() })
  fastify.get('/workbench/sample', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchSample() })
  fastify.get('/workbench/tasks', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listWorkbenchTasks({ page: request.query?.page, pageSize: request.query?.pageSize, q: request.query?.q, category: request.query?.category, includeDisabled: request.query?.includeDisabled !== 'false' }) })
  fastify.get('/workbench/collections', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return { items: db.listWorkbenchCollections({ limit: request.query?.limit }) } })
  fastify.get('/workbench/runs', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listWorkbenchRuns({ page: request.query?.page, pageSize: request.query?.pageSize }) })
  fastify.get('/workbench/rankings', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchRankings({ limit: request.query?.limit }) })
  fastify.get('/workbench/results', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listWorkbenchResults({ page: request.query?.page, pageSize: request.query?.pageSize, q: request.query?.q, runId: request.query?.runId, status: request.query?.status }) })
  fastify.get('/workbench/history', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return buildMarketHistory(db, request.query || {}, wms) })
  fastify.get('/workbench/plan', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return buildWorkbenchPlan(db) })
  fastify.get('/workbench/resume', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchSummary().resume })
  fastify.get('/workbench/queues', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const projection = await buildWmsProjection(db, { ...request.query, marketPage: request.query?.page, marketPageSize: request.query?.pageSize }, wms); return { ...projection.market, items: projection.market.items, counts: projection.market.groupCounts } })
  fastify.get('/workbench/settings', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchSettings() })
  const saveWorkbenchSettings = (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return null
    try {
      const settings = db.setWorkbenchSettings(request.body || {}, actor.id)
      const schedule = syncWorkbenchSchedule(db, settings, { actorId: actor.id, forceNext: true })
      return { ...settings, nextSchedule: schedule.enabled ? schedule.next_run_at : null }
    } catch (error) {
      reply.code(400).send({ error: { code: error?.code || 'settings_update_failed', message: String(error?.message || 'Settings update failed').slice(0, 240) } })
      return null
    }
  }
  fastify.patch('/workbench/settings', async (request, reply) => saveWorkbenchSettings(request, reply))
  fastify.get('/settings', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getWorkbenchSettings() })
  fastify.patch('/settings', async (request, reply) => saveWorkbenchSettings(request, reply))

  fastify.post('/workbench/import', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    try {
      const file = await request.file()
      if (!file) return reply.code(400).send({ error: { code: 'file_required', message: 'Excel 文件不能为空' } })
      const chunks = []
      for await (const chunk of file.file) chunks.push(chunk)
      const parsed = parseWorkbook(Buffer.concat(chunks), file.filename)
      const collection = db.createWorkbenchCollection({ sourceFile: parsed.sourceFile, sheetName: parsed.sheetName, tasks: parsed.tasks, createdBy: actor.id })
      db.audit({ actorId: actor.id, action: 'workbench.import', entityType: 'task_collection', entityId: collection.id, metadata: { rowCount: parsed.tasks.length } })
      return reply.code(201).send({ ok: true, collection, rowCount: parsed.tasks.length, aiNormalization: { configured: false, updated: 0 } })
    } catch (error) {
      return reply.code(400).send({ error: { code: error?.code || 'import_failed', message: String(error?.message || 'Excel 导入失败').slice(0, 240) } })
    }
  })

  fastify.post('/workbench/start', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    try {
      const profileId = String(request.body?.profileId || '').trim() || null
      if (profileId && !db.getBrowserProfile(profileId)) throw Object.assign(new Error('浏览器 Profile 不存在'), { code: 'profile_not_found' })
      const resume = request.body?.resume === true
      const tasks = resumableTasks(db, { resume })
      const result = enqueueWorkbenchTasks(db, tasks, { actorId: actor.id, profileId, trigger: resume ? 'resume' : 'manual', resume })
      return { ok: true, runId: result.run?.id || null, total: result.jobs.length, skipped: result.skipped, resumedFrom: resume && result.run ? result.run.id : null }
    } catch (error) { return reply.code(400).send({ error: { code: error?.code || 'start_failed', message: String(error?.message || '任务启动失败').slice(0, 240) } }) }
  })

  fastify.post('/workbench/retry', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    try {
      const profileId = String(request.body?.profileId || '').trim() || null
      if (profileId && !db.getBrowserProfile(profileId)) throw Object.assign(new Error('浏览器 Profile 不存在'), { code: 'profile_not_found' })
      const taskId = String(request.body?.taskId || '').trim()
      const tasks = retryableTasks(db, { taskId })
      const result = enqueueWorkbenchTasks(db, tasks, { actorId: actor.id, profileId, trigger: 'retry', resume: true, taskId })
      return { ok: true, runId: result.run?.id || null, total: result.jobs.length, skipped: result.skipped }
    } catch (error) { return reply.code(400).send({ error: { code: error?.code || 'retry_failed', message: String(error?.message || '复采启动失败').slice(0, 240) } }) }
  })

  fastify.patch('/workbench/tasks/:id', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    const task = db.setWorkbenchTaskEnabled(request.params.id, Boolean(request.body?.enabled), actor.id)
    if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: 'Task not found' } })
    return task
  })
  fastify.patch('/workbench/tasks/:id/identity', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    try {
      const result = db.updateWorkbenchTaskIdentity(request.params.id, request.body || {}, actor.id)
      return { ok: true, taskId: result.task.id, updated: result.updated, localOnly: result.localOnly, localOnlyReason: result.localOnlyReason, task: result.task }
    } catch (error) {
      const code = error?.code || 'identity_update_failed'
      return reply.code(code === 'task_not_found' ? 404 : 400).send({ error: { code, message: String(error?.message || '商品资料保存失败').slice(0, 240) } })
    }
  })
  fastify.get('/workbench/ai/status', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    if (!llm || typeof llm.status !== 'function') return reply.code(503).send({ error: { code: 'ai_service_unavailable', message: '服务器 AI 服务不可用' } })
    return llm.status()
  })
  fastify.get('/workbench/tasks/:id/ai-events', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const task = db.getWorkbenchTask(request.params.id)
    if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: '当前行情任务不存在' } })
    const limit = Math.min(100, Math.max(1, Number(request.query?.limit) || 20))
    return { taskId: task.id, items: (Array.isArray(task.aiEvents) ? task.aiEvents : []).slice(-limit).reverse(), aiReviewStatus: task.aiReviewStatus || 'none', aiReviewReason: task.aiReviewReason || '' }
  })
  fastify.post('/workbench/tasks/:id/aliases/suggest', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    if (!llm || typeof llm.suggestAliases !== 'function') return reply.code(503).send({ error: { code: 'ai_service_unavailable', message: '服务器 AI 服务不可用' } })
    const task = db.getWorkbenchTask(request.params.id)
    if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: '当前行情任务不存在' } })
    try {
      const result = await llm.suggestAliases(task)
      if (!result.ok) {
        const status = result.configured === false ? 503 : 502
        return reply.code(status).send({ ok: false, configured: result.configured, aliases: [], error: { code: result.configured === false ? 'ai_credentials_missing' : 'ai_alias_failed', message: result.reason || '别名生成失败' } })
      }
      const previous = db.getWorkbenchTaskOverride(task.id)
      const aliases = [...new Set((result.aliases || []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 12)
      const searchKeywords = [...new Set([task.model, `${task.brand} ${task.model}`.trim(), ...aliases].filter(Boolean))].slice(0, 12)
      const event = { type: 'ai-alias-suggest', taskId: task.id, source: result.source || 'llm', model: result.model || '', aliases, ok: true }
      const next = { ...previous, aliases, searchKeywords, aliasSource: result.source || 'llm', aliasUpdatedAt: new Date().toISOString(), aiEvents: appendAiEvent(previous, event) }
      db.setWorkbenchTaskOverride(task.id, next, actor.id)
      db.audit({ actorId: actor.id, action: 'workbench.task.ai_alias_suggest', entityType: 'workbench_task', entityId: task.id, metadata: { source: result.source || 'llm', aliasCount: aliases.length } })
      return { ...result, taskId: task.id, aliases, task: db.getWorkbenchTask(task.id), event }
    } catch (error) {
      return reply.code(502).send({ ok: false, error: { code: error?.code || 'ai_alias_failed', message: String(error?.message || '别名生成失败').slice(0, 240) } })
    }
  })
  fastify.post('/workbench/tasks/:id/ai-search', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    if (!llm || typeof llm.searchTaskEvidence !== 'function') return reply.code(503).send({ error: { code: 'ai_service_unavailable', message: '服务器 AI 服务不可用' } })
    const task = db.getWorkbenchTask(request.params.id)
    if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: '当前行情任务不存在' } })
    if (!['candidate', 'search_failed'].includes(String(task.aiReviewStatus || ''))) return reply.code(409).send({ error: { code: 'ai_review_state_invalid', message: '当前任务没有可打回的 AI 候选，避免重复产生联网费用' } })
    if (aiSearchInFlight.has(task.id)) return reply.code(409).send({ error: { code: 'ai_search_in_progress', message: '这条任务的联网核查正在进行，请稍候' } })
    const reason = String(request.body?.reason || '').trim().slice(0, 240)
    const work = (async () => {
      const result = await llm.searchTaskEvidence(task, { reason })
      const previous = db.getWorkbenchTaskOverride(task.id)
      const status = aiResultStatus(result)
      const results = (Array.isArray(result.results) ? result.results : []).slice(0, 20)
      const reviewReason = status === 'needs_review' ? '已完成联网核查，等待人工审阅' : String(result.reason || '联网核查未完成，等待人工处理').slice(0, 240)
      const event = { type: 'ai-web-search', taskId: task.id, query: result.query || '', source: result.source || 'web-search', estimatedCostCny: Number(result.estimatedCostCny) || 0, configured: Boolean(result.configured), ok: status === 'needs_review', resultCount: results.length, reason: reviewReason }
      const next = { ...previous, aiReviewStatus: status, aiReviewReason: reviewReason, aiReviewUpdatedAt: new Date().toISOString(), aiWebSearchStatus: status === 'needs_review' ? 'done' : 'failed', aiWebSearchQuery: String(result.query || '').slice(0, 70), aiWebSearchResults: results, aiWebSearchSource: String(result.source || 'web-search').slice(0, 120), aiEvents: appendAiEvent(previous, event) }
      db.setWorkbenchTaskOverride(task.id, next, actor.id)
      db.audit({ actorId: actor.id, action: 'workbench.task.ai_web_search', entityType: 'workbench_task', entityId: task.id, metadata: { source: event.source, resultCount: results.length, configured: event.configured, estimatedCostCny: event.estimatedCostCny, ok: event.ok } })
      return { ...result, taskId: task.id, status, task: db.getWorkbenchTask(task.id), event }
    })()
    aiSearchInFlight.set(task.id, work)
    try {
      const result = await work
      if (!result.ok) {
        const status = result.configured === false ? 503 : 502
        return reply.code(status).send({ ...result, ok: false, error: { code: result.configured === false ? 'ai_credentials_missing' : 'ai_search_failed', message: result.reason || '联网核查失败' } })
      }
      return result
    } catch (error) {
      return reply.code(502).send({ ok: false, error: { code: error?.code || 'ai_search_failed', message: String(error?.message || '联网核查失败').slice(0, 240) } })
    } finally { aiSearchInFlight.delete(task.id) }
  })
  fastify.post('/workbench/tasks/:id/ai-review/approve', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    const task = db.getWorkbenchTask(request.params.id)
    if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: '当前行情任务不存在' } })
    if (!['needs_review', 'candidate', 'search_failed'].includes(String(task.aiReviewStatus || '')) && !String(task.correctionVersion || '')) return reply.code(409).send({ error: { code: 'ai_review_state_invalid', message: '当前任务没有待复核的搜索修正' } })
    const previous = db.getWorkbenchTaskOverride(task.id)
    const timestamp = new Date().toISOString()
    const event = { type: 'ai-review-approve', taskId: task.id, ok: true, operatorId: actor.id }
    const next = { ...previous, aiReviewStatus: 'approved', aiReviewReason: task.correctionVersion ? '人工确认搜索修正，可显式复采；成功后再确认 API 回写' : '人工确认 AI 型号候选', aiReviewUpdatedAt: timestamp, aiEvents: appendAiEvent(previous, event) }
    if (task.correctionVersion) {
      next.correctionReviewStatus = 'approved'
      next.correctionWorkflowStatus = task.lastStatus === 'success' ? 'approved' : (task.correctionWorkflowStatus || 'recollect_pending')
      next.correctionWorkflowReason = task.lastStatus === 'success' ? '修正复采成功，已人工确认 API 回写门禁' : '搜索修正已人工确认，等待显式复采'
    }
    db.setWorkbenchTaskOverride(task.id, next, actor.id)
    db.audit({ actorId: actor.id, action: 'workbench.task.ai_review_approve', entityType: 'workbench_task', entityId: task.id, metadata: { hasCorrectionVersion: Boolean(task.correctionVersion) } })
    return { ok: true, taskId: task.id, task: db.getWorkbenchTask(task.id), event }
  })
  fastify.post('/wms/identity-writeback', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    const body = request.body || {}
    const taskId = String(body.taskId || '').trim()
    const skuCode = String(body.skuCode || body.sku_code || '').trim()
    const task = db.getWorkbenchTask(taskId)
    if (!task) return reply.code(404).send({ ok: false, error: { code: 'task_not_found', message: '当前行情任务不存在' } })
    const configured = config?.wms || {}
    if (configured.source === 'mcp' || !configured.apiBaseUrl || !configured.restUsername || !configured.restPassword) {
      const reason = '服务器未配置 WMS REST 管理账号，已阻止回写'
      const previous = db.getWorkbenchTaskOverride(taskId)
      const audit = await blockedWmsWritebackAudit({ task, skuCode, patch: body.patch || {}, operator: actor.id, reason, errorCode: 'wms_credentials_missing' })
      db.setWorkbenchTaskOverride(taskId, {
        ...previous,
        writebackAudit: appendAudit(previous.writebackAudit, audit),
        correctionWorkflowStatus: 'writeback_blocked',
        correctionWorkflowReason: reason,
        correctionWorkflowUpdatedAt: new Date().toISOString(),
        correctionOperator: actor.id
      }, actor.id)
      return reply.code(503).send({ ok: false, error: { code: 'wms_credentials_missing', message: reason }, status: 'blocked', putIssued: false, audit })
    }
    try {
      const decoratedTask = await decorateTaskForWmsWriteback(db, task)
      const client = wms?.getClient?.()
      const result = await executeWmsIdentityWriteback({ client, task: decoratedTask, skuCode, patch: body.patch || {}, operator: actor.id })
      const previous = db.getWorkbenchTaskOverride(taskId)
      const audit = result.audit
      const next = {
        ...previous,
        writebackAudit: appendAudit(previous.writebackAudit, audit)
      }
      if (result.ok) {
        if (result.patch?.product_name !== undefined) next.name = String(result.patch.product_name).trim()
        if (result.patch?.brand !== undefined) next.brand = String(result.patch.brand).trim()
        if (result.patch?.model !== undefined) next.model = String(result.patch.model).trim()
        next.correctionReviewStatus = 'verified'
        next.correctionWorkflowStatus = 'verified'
        next.correctionWorkflowReason = 'WMS GET→PATCH→GET 已验证'
        next.correctionWorkflowUpdatedAt = new Date().toISOString()
        next.correctionOperator = actor.id
        const snapshot = db.listAllWmsInventory?.().find(row => String(row.sku_code || '') === result.skuCode)
        if (snapshot && typeof db.updateWmsInventoryRow === 'function') db.updateWmsInventoryRow(result.skuCode, normalizeVerifiedInventory(result.item, snapshot), actor.id)
      } else {
        next.correctionWorkflowStatus = result.status === 'blocked' ? 'writeback_blocked' : 'writeback_failed'
        next.correctionWorkflowReason = result.reason
        next.correctionWorkflowUpdatedAt = new Date().toISOString()
        next.correctionOperator = actor.id
      }
      db.setWorkbenchTaskOverride(taskId, next, actor.id)
      if (result.ok) {
        return { ok: true, status: 'verified', putIssued: true, skuCode: result.skuCode, verified: true, task: db.getWorkbenchTask(taskId), item: { sku_code: result.item?.sku_code || result.item?.skuCode || result.skuCode, spu_code: result.item?.spu_code || result.item?.spuCode || '', status: result.item?.status || 'IN_STOCK', product_name: result.item?.product_name || '', brand: result.item?.brand || '', model: result.item?.model || '' }, audit }
      }
      const statusCode = result.status === 'blocked'
        ? (['wms_credentials_missing', 'wms_writeback_unavailable', 'wms_token_missing'].includes(result.errorCode) ? 503 : result.errorCode === 'wms_writeback_patch_invalid' ? 400 : 409)
        : 502
      return reply.code(statusCode).send({ ok: false, status: result.status, putIssued: result.putIssued, skuCode: result.skuCode, error: { code: result.errorCode, message: result.reason }, audit })
    } catch (error) {
      return reply.code(502).send({ ok: false, status: 'failed', putIssued: false, error: { code: error?.code || 'wms_writeback_failed', message: String(error?.message || 'WMS 回写失败').slice(0, 240) } })
    }
  })
  fastify.post('/workbench/tasks/:id/price-intent', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator'])
    if (!actor) return
    try {
      const task = db.getWorkbenchTask(request.params.id)
      if (!task) return reply.code(404).send({ error: { code: 'task_not_found', message: '当前行情任务不存在' } })
      const body = request.body || {}
      const preview = buildPriceIntentPreview(task)
      if (!preview || preview.previewId !== String(body.previewId || '') || preview.policyVersion !== String(body.policyVersion || '')) {
        return reply.code(409).send({ error: { code: 'price_preview_expired', message: '价格预览已过期，请重新生成预览' } })
      }
      if (body.confirmed !== true) return reply.code(400).send({ error: { code: 'price_confirmation_required', message: '必须明确确认价格意图' } })
      const choice = String(body.choice || '').trim()
      if (!['market', 'reference', 'custom'].includes(choice)) return reply.code(400).send({ error: { code: 'price_choice_invalid', message: '价格候选无效' } })
      const selectedPrice = choice === 'custom' ? Number(body.customPrice) : Number(preview.candidates.find(item => item.key === choice)?.price)
      if (!Number.isFinite(selectedPrice) || selectedPrice <= 0) return reply.code(400).send({ error: { code: 'price_value_invalid', message: '价格必须是大于 0 的数字' } })
      if (choice !== 'custom' && !preview.candidates.some(item => item.key === choice && item.enabled)) return reply.code(400).send({ error: { code: 'price_candidate_unavailable', message: '当前候选价格不可用' } })
      if (preview.facts.costPrice != null && selectedPrice < Number(preview.facts.costPrice)) return reply.code(400).send({ error: { code: 'price_below_cost', message: '价格不得低于采购成本' } })
      const timestamp = new Date().toISOString()
      const intent = {
        previewId: preview.previewId,
        policyVersion: preview.policyVersion,
        choice,
        selectedPrice: Math.round(selectedPrice * 100) / 100,
        confirmed: true,
        operatorId: actor.id,
        note: String(body.note || '').trim().slice(0, 240),
        recordedAt: timestamp,
        status: 'recorded',
        apiMutation: 'not_issued'
      }
      const currentOverride = db.getWorkbenchTaskOverride(request.params.id)
      const nextOverride = { ...currentOverride, priceIntent: intent }
      db.setWorkbenchTaskOverride(request.params.id, nextOverride, actor.id)
      db.audit({ actorId: actor.id, action: 'workbench.price_intent.record', entityType: 'workbench_task', entityId: request.params.id, metadata: { choice, selectedPrice: intent.selectedPrice, apiMutation: 'not_issued' } })
      return { ok: true, status: 'recorded', intent, selectedPrice: intent.selectedPrice, writeback: { ok: false, status: 'blocked', putIssued: false, reason: '服务器当前只记录价格意图，未修改 WMS/API 价格' } }
    } catch (error) {
      const code = error?.code || 'price_intent_failed'
      return reply.code(400).send({ error: { code, message: String(error?.message || '价格意图保存失败').slice(0, 240) } })
    }
  })

  fastify.get('/workbench/policies', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return { items: db.listSpuPolicies() } })
  fastify.get('/workbench/policies/:spuCode', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getSpuPolicy(request.params.spuCode) || {} })
  fastify.put('/workbench/policies/:spuCode', async (request, reply) => { const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return; return { ok: true, policy: db.setSpuPolicy(request.params.spuCode, request.body || {}, actor.id) } })
  fastify.get('/workbench/policies/:spuCode/preview', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const policy = db.getSpuPolicy(request.params.spuCode) || {}; return { spuCode: request.params.spuCode, effective: policy } })

  fastify.get('/workbench/template', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价', '分类']]), '行情任务')
    return workbookResponse(reply, workbook, '巡航台任务清单_sample.xlsx')
  })

  fastify.get('/workbench/export-invalid', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const results = db.listWorkbenchResults({ page: 1, pageSize: 500, runId: request.query?.runId, status: 'invalid_price' }).items
    const rows = [['品牌', '名称', '型号', 'SPU编号', '状态', '价格', '原因'], ...results.map(row => [row.brand, row.name, row.model, row.spuCode, row.status, row.price ?? '', row.reason || ''])]
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '错误价格')
    return workbookResponse(reply, workbook, '错误价格.xlsx')
  })

  fastify.get('/workbench/export-wms', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const tasks = db.listWorkbenchTasks({ page: 1, pageSize: 2000, includeDisabled: true }).items
    const rows = [['品牌', '名称', '型号', 'SPU编号', '采购价'], ...tasks.map(row => [row.brand, row.name, row.model, row.spuCode, row.referencePrice ?? ''])]
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'API-SPU')
    return workbookResponse(reply, workbook, 'API-SPU-映射.xlsx')
  })

  // The H5 WMS view reads the server-owned task/SPU projection. A real WMS
  // connector can replace this source later without moving credentials or
  // employee-local files back into the browser.
  fastify.get('/wms/projection', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return buildWmsProjection(db, request.query || {}, wms) })
  fastify.get('/wms/catalog', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const projection = await buildWmsProjection(db, request.query || {}, wms); return projection.inventory })
  fastify.get('/wms/state', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const state = wms?.getState?.() || db.getWmsSyncState?.(); return state || (await buildWmsProjection(db, {}, wms)).sync })
  fastify.get('/wms/config', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const value = config.wms || {}; return { source: value.source || 'auto', apiConfigured: Boolean(value.restUsername && value.restPassword), mcpConfigured: Boolean(value.mcpUrl && value.mcpKey), apiBaseConfigured: Boolean(value.apiBaseUrl) } })
  fastify.post('/wms/sync', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return
    if (!wms) return reply.code(503).send({ ok: false, error: { code: 'wms_service_unavailable', message: 'WMS 同步服务不可用' } })
    try {
      const state = await wms.refresh({ reason: 'manual', actorId: actor.id })
      return { ok: state.status === 'synced', source: state.source, spuTotal: state.spuTotal, skuTotal: state.skuTotal, counts: { spuTotal: state.spuTotal }, status: state.status, reason: state.safeError || '' }
    } catch (error) {
      const state = wms.getState?.() || db.getWmsSyncState?.()
      return reply.code(502).send({ ok: false, status: state?.status || 'failed', reason: state?.safeError || String(error?.message || 'WMS 同步失败').slice(0, 240) })
    }
  })
}

module.exports = { registerWorkbenchRoutes, parseWorkbook }
