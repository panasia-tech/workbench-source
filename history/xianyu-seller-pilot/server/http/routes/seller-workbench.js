"use strict"

const crypto = require('node:crypto')
const XLSX = require('xlsx')
const { tokenFromRequest } = require('../events.js')
const { enqueueSellerRun, pendingSellerSources } = require('../../jobs/seller-runner.js')
const { syncSellerSchedule } = require('../../jobs/recurring-schedules.js')

const URL_ALIASES = ['卖家主页', '卖家链接', '主页', 'url', 'seller_url', 'sellerUrl']
const ID_ALIASES = ['卖家ID', '卖家编号', 'seller_id', 'sellerId']
const NAME_ALIASES = ['卖家名称', '卖家名', '名称', 'seller_name', 'sellerName']
const MAX_ROWS = 10_000

function actorFor(request, auth) { return auth.verifyToken(tokenFromRequest(request)) }
function requireActor(request, reply, auth, roles = []) {
  const actor = actorFor(request, auth)
  if (!actor) { reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } }); return null }
  if (roles.length && !roles.includes(actor.role)) { reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } }); return null }
  return actor
}
function headerIndex(headers, aliases) { return headers.findIndex(value => aliases.some(alias => String(value || '').trim().toLowerCase() === alias.toLowerCase())) }
function safeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try { const parsed = new URL(raw); if (!['http:', 'https:'].includes(parsed.protocol)) return ''; return parsed.toString().slice(0, 2000) } catch { return '' }
}
function parseWorkbook(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw Object.assign(new Error('Excel 中没有工作表'), { code: 'sheet_required' })
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false })
  const headers = (rows.shift() || []).map(value => String(value || '').trim())
  const urlIndex = headerIndex(headers, URL_ALIASES); if (urlIndex < 0) throw Object.assign(new Error('Excel 至少需要“卖家主页”列'), { code: 'seller_url_column_required' })
  const idIndex = headerIndex(headers, ID_ALIASES); const nameIndex = headerIndex(headers, NAME_ALIASES)
  const indexOf = (aliases) => headerIndex(headers, aliases)
  const fields = { mainContent: indexOf(['主营内容', 'mainContent']), mainType: indexOf(['主营类型', 'mainType']), category: indexOf(['分类', 'category']), board: indexOf(['榜单', 'board']), boardName: indexOf(['榜单名称', 'boardName']), sourceBoardRanks: indexOf(['来源榜单排名', 'sourceBoardRanks']), sourceRank: indexOf(['榜单排名', 'sourceRank', 'rank']), sourceOrdinal: indexOf(['来源序号', 'sourceOrdinal']), sourceSlotCount: indexOf(['榜单槽位数', 'sourceSlotCount']), cities: indexOf(['城市', 'cities']) }
  if (rows.length > MAX_ROWS) throw Object.assign(new Error(`Excel 最多支持 ${MAX_ROWS} 行`), { code: 'row_limit_exceeded' })
  const result = []; const seen = new Set()
  rows.forEach((values, index) => {
    const url = safeUrl(values[urlIndex]); if (!url) return
    const key = url.replace(/#.*$/, '').replace(/\/$/, '')
    if (seen.has(key)) return; seen.add(key)
    const value = (idx) => idx >= 0 ? String(values[idx] || '').trim() : ''
    const id = value(idIndex) || crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)
    result.push({ id, sellerId: id, url, sellerName: value(nameIndex), mainContent: value(fields.mainContent), mainType: value(fields.mainType), category: value(fields.category), board: value(fields.board), boardName: value(fields.boardName), sourceBoardRanks: value(fields.sourceBoardRanks), sourceRank: Number.isFinite(Number(value(fields.sourceRank))) ? Number(value(fields.sourceRank)) : null, sourceOrdinal: Number.isFinite(Number(value(fields.sourceOrdinal))) ? Number(value(fields.sourceOrdinal)) : null, sourceSlotCount: Number.isFinite(Number(value(fields.sourceSlotCount))) ? Number(value(fields.sourceSlotCount)) : null, cities: value(fields.cities), excelRow: index + 2 })
  })
  if (!result.length) throw Object.assign(new Error('Excel 没有可执行的卖家主页链接'), { code: 'empty_sheet' })
  return { sourceFile: String(filename || '卖家主页.xlsx').slice(0, 240), sheetName: String(sheetName).slice(0, 120), rows: result }
}
function workbookResponse(reply, workbook, filename) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  reply.header('content-disposition', `attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent(String(filename || '卖家队列.xlsx').replace(/[\r\n"\\]/g, ''))}`)
  return reply.send(buffer)
}

function sellerJobs(db) {
  return typeof db.listActiveJobs === 'function'
    ? db.listActiveJobs({ type: 'seller_snapshot' })
    : db.listJobs({ limit: 100 }).filter(job => job.type === 'seller_snapshot' && ['pending', 'running'].includes(job.status))
}

function registerSellerWorkbenchRoutes(fastify, { db, auth }) {
  fastify.get('/seller-workbench/summary', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getSellerSummary() })
  fastify.get('/seller-workbench/queues', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listSellerSources({ page: request.query?.page, pageSize: request.query?.pageSize, q: request.query?.q, status: request.query?.status, group: request.query?.group }) })
  fastify.get('/seller-workbench/sources', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listSellerSources({ page: request.query?.page, pageSize: request.query?.pageSize, q: request.query?.q, status: request.query?.status }) })
  fastify.get('/seller-workbench/items', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listSellerItems({ sourceId: request.query?.sourceId, runId: request.query?.runId, page: request.query?.page, pageSize: request.query?.pageSize }) })
  fastify.get('/seller-workbench/queues/:id', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const seller = db.getSellerSource(request.params.id); if (!seller) return reply.code(404).send({ error: { code: 'seller_not_found', message: 'Seller not found' } })
    return { ok: true, seller, items: db.listSellerItems({ sourceId: seller.id, runId: request.query?.runId, page: 1, pageSize: 1000 }).items, attempts: [] }
  })
  fastify.get('/seller-workbench/runs', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.listSellerRuns({ page: request.query?.page, pageSize: request.query?.pageSize }) })
  fastify.get('/seller-workbench/runs/:id', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const run = db.getSellerRun(request.params.id); if (!run) return reply.code(404).send({ error: { code: 'run_not_found', message: 'Run not found' } }); return { ...run, sellers: db.listSellerSources({ page: 1, pageSize: 1000 }).items.filter(item => item.lastRunId === run.id) } })
  fastify.get('/seller-workbench/settings', async (request, reply) => { if (!requireActor(request, reply, auth)) return; return db.getSellerSettings() })
  fastify.patch('/seller-workbench/settings', async (request, reply) => { const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return; return db.setSellerSettings(request.body || {}, actor.id) })
  fastify.get('/seller-workbench/schedule', async (request, reply) => {
    if (!requireActor(request, reply, auth)) return
    const settings = db.getSellerSettings()
    const systemSchedule = db.getSchedule?.('system-seller-weekly')
    return { weeklyEnabled: Boolean(settings.weeklyEnabled), weeklyDay: settings.weeklyDay, weeklyTime: settings.weeklyTime, timezone: settings.timezone, nextRunAt: systemSchedule?.enabled ? systemSchedule.next_run_at : null, lastRunAt: systemSchedule?.last_run_at || null }
  })
  fastify.patch('/seller-workbench/schedule', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return
    try {
      const settings = db.setSellerSettings({ weeklyEnabled: request.body?.weeklyEnabled, weeklyDay: request.body?.weeklyDay, weeklyTime: request.body?.weeklyTime, timezone: request.body?.timezone }, actor.id)
      const schedule = syncSellerSchedule(db, settings, { actorId: actor.id, forceNext: true })
      return { ...settings, nextRunAt: schedule.enabled ? schedule.next_run_at : null, lastRunAt: schedule.last_run_at || null }
    } catch (error) {
      return reply.code(400).send({ error: { code: error?.code || 'schedule_update_failed', message: String(error?.message || 'Schedule update failed').slice(0, 240) } })
    }
  })

  fastify.post('/seller-workbench/import', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return
    try { const file = await request.file(); if (!file) return reply.code(400).send({ error: { code: 'file_required', message: 'Excel 文件不能为空' } }); const chunks = []; for await (const chunk of file.file) chunks.push(chunk); const parsed = parseWorkbook(Buffer.concat(chunks), file.filename); const sources = db.upsertSellerSources(parsed.rows, actor.id); return reply.code(201).send({ ok: true, added: sources.length, total: sources.length, sourceFile: parsed.sourceFile, sheetName: parsed.sheetName }) } catch (error) { return reply.code(400).send({ error: { code: error?.code || 'import_failed', message: String(error?.message || '卖家 Excel 导入失败').slice(0, 240) } }) }
  })
  fastify.post('/seller-workbench/start', async (request, reply) => {
    const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return
    try {
      const profileId = String(request.body?.profileId || '').trim() || null
      if (profileId && !db.getBrowserProfile(profileId)) throw Object.assign(new Error('浏览器 Profile 不存在'), { code: 'profile_not_found' })
      const sample = String(request.body?.sample || 'all')
      const result = enqueueSellerRun(db, pendingSellerSources(db, sample), { actorId: actor.id, profileId, trigger: request.body?.trigger || 'manual', sample })
      return { ok: true, runId: result.run?.id || null, total: result.jobs.length, skipped: result.skipped }
    } catch (error) { return reply.code(400).send({ error: { code: error?.code || 'start_failed', message: String(error?.message || '卖家任务启动失败').slice(0, 240) } }) }
  })
  fastify.post('/seller-workbench/pause', async (request, reply) => { const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return; const jobs = sellerJobs(db); jobs.forEach(job => db.requestJobControl({ jobId: job.id, command: 'pause', actorId: actor.id })); return { ok: true, paused: jobs.length } })
  fastify.post('/seller-workbench/resume', async (request, reply) => { const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return; const jobs = sellerJobs(db); jobs.forEach(job => db.requestJobControl({ jobId: job.id, command: 'resume', actorId: actor.id })); return { ok: true, resumed: jobs.length } })
  fastify.post('/seller-workbench/stop', async (request, reply) => { const actor = requireActor(request, reply, auth, ['admin', 'operator']); if (!actor) return; const jobs = sellerJobs(db); jobs.forEach(job => db.cancelJob({ jobId: job.id, actorId: actor.id })); return { ok: true, stopped: jobs.length } })
  fastify.get('/seller-workbench/export', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const result = db.listSellerSources({ page: 1, pageSize: 1000, q: request.query?.q, status: request.query?.status, group: request.query?.group }); const rows = [['卖家ID', '卖家主页', '卖家名称', '分类', '榜单', '当前状态', '原因', '在售已采', '已售已采', '最近更新时间'], ...result.items.map(row => [row.sellerId, row.url, row.sellerName, row.category, row.boardName || row.board, row.status, row.reason, row.activeCount ?? '', row.soldCount ?? '', row.updatedAt])]; const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '卖家队列'); return workbookResponse(reply, workbook, '卖家队列.xlsx') })
  fastify.get('/seller-workbench/export-detail', async (request, reply) => { if (!requireActor(request, reply, auth)) return; const sources = db.listSellerSources({ page: 1, pageSize: 1000, q: request.query?.q, status: request.query?.status, group: request.query?.group }).items; const rows = [['卖家ID', '卖家主页', '商品ID', '商品标题', '分支', '价格', '商品状态', '采集时间'], ...sources.flatMap(source => db.listSellerItems({ sourceId: source.id, page: 1, pageSize: 1000 }).items.map(item => [source.sellerId, source.url, item.itemId, item.title, item.branch, item.price ?? '', item.status, item.capturedAt]))]; const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '商品明细'); return workbookResponse(reply, workbook, '卖家商品明细.xlsx') })
}

module.exports = { registerSellerWorkbenchRoutes, parseWorkbook }
