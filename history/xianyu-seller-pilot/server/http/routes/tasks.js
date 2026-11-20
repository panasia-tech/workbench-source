"use strict"

const { BrowserProviderError } = require('../../browser/provider.js')
const { tokenFromRequest } = require('../events.js')

function registerTaskRoutes(fastify, { db, auth }) {
  fastify.post('/tasks', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const body = request.body || {}
    const kind = String(body.kind || body.type || '').trim()
    if (!['market_snapshot', 'seller_snapshot'].includes(kind)) throw new BrowserProviderError('unsupported task type', { code: 'task_type_not_allowed' })
    const job = db.createJob({ type: kind, payload: body.payload || {}, profileId: body.profileId, operatorId: actor.id })
    db.audit({ actorId: actor.id, action: 'task.create', entityType: 'job', entityId: job.id, metadata: { kind } })
    return reply.code(201).send({ task: job })
  })

  fastify.post('/tasks/:id/control', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const command = String(request.body?.command || '').trim().toLowerCase()
    if (!['pause', 'resume', 'stop'].includes(command)) return reply.code(400).send({ error: { code: 'invalid_control', message: 'command must be pause, resume or stop' } })
    const job = db.getJob(request.params.id)
    if (!job) return reply.code(404).send({ error: { code: 'job_not_found', message: 'Job not found' } })
    const updated = command === 'stop'
      ? db.cancelJob({ jobId: job.id, actorId: actor.id })
      : db.requestJobControl({ jobId: job.id, command, actorId: actor.id })
    return { task: updated, control: command }
  })
}

module.exports = { registerTaskRoutes }
