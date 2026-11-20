"use strict"

const { BrowserProviderError } = require('../../browser/provider.js')
const { tokenFromRequest } = require('../events.js')

function registerScheduleRoutes(fastify, { db, auth }) {
  const managedIds = new Set(['system-workbench-daily', 'system-seller-weekly'])
  fastify.get('/schedules', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    return { schedules: db.listSchedules({ limit: request.query?.limit, enabled: request.query?.enabled == null ? null : request.query.enabled !== 'false' }) }
  })

  fastify.post('/schedules', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    try {
      const body = request.body || {}
      const jobType = String(body.jobType || body.type || '').trim()
      if (!['market_snapshot', 'seller_snapshot', 'browser_probe'].includes(jobType)) throw new BrowserProviderError('unsupported schedule task type', { code: 'task_type_not_allowed' })
      if (body.profileId && !db.getBrowserProfile(body.profileId)) throw new BrowserProviderError('browser profile not found', { code: 'profile_not_found' })
      const schedule = db.createSchedule({ name: body.name, jobType, payload: body.payload || {}, profileId: body.profileId, intervalMs: body.intervalMs, nextRunAt: body.nextRunAt, createdBy: actor.id })
      db.audit({ actorId: actor.id, action: 'schedule.create', entityType: 'schedule', entityId: schedule.id, metadata: { jobType, intervalMs: schedule.interval_ms } })
      return reply.code(201).send({ schedule })
    } catch (error) {
      const code = error?.code || 'schedule_create_failed'
      return reply.code(code === 'forbidden' ? 403 : code === 'profile_not_found' ? 404 : 400).send({ error: { code, message: String(error?.message || 'Schedule create failed').slice(0, 240) } })
    }
  })

  fastify.post('/schedules/:id/toggle', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    if (managedIds.has(String(request.params.id || ''))) return reply.code(409).send({ error: { code: 'schedule_system_managed', message: '工作台计划必须通过对应 H5 工作台设置修改' } })
    const schedule = db.setScheduleEnabled(request.params.id, Boolean(request.body?.enabled), actor.id)
    if (!schedule) return reply.code(404).send({ error: { code: 'schedule_not_found', message: 'Schedule not found' } })
    return { schedule }
  })
}

module.exports = { registerScheduleRoutes }
