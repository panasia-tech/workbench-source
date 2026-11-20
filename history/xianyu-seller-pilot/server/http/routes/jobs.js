"use strict"

const { BrowserProviderError } = require('../../browser/provider.js')
const { tokenFromRequest } = require('../events.js')

const MAX_BODY_BYTES = 256 * 1024

function authUser(request, auth) {
  const user = auth.verifyToken(tokenFromRequest(request))
  if (!user) throw new BrowserProviderError('Authentication required', { code: 'unauthenticated' })
  return user
}

function handleError(reply, error) {
  const code = error?.code || 'request_failed'
  const status = code === 'unauthenticated' ? 401 : code === 'forbidden' ? 403 : code === 'job_not_found' ? 404 : code === 'payload_too_large' ? 413 : 400
  return reply.code(status).send({ error: { code, message: String(error?.message || 'Request failed').slice(0, 240) } })
}

function registerJobRoutes(fastify, { db, auth }) {
  fastify.post('/jobs', async (request, reply) => {
    try {
      const actor = authUser(request, auth)
      auth.requireRole(actor, ['admin', 'operator'])
      const body = request.body || {}
      const type = String(body.type || '').trim()
      if (!['browser_probe', 'market_snapshot', 'seller_snapshot'].includes(type)) throw new BrowserProviderError('unsupported job type', { code: 'job_type_not_allowed' })
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {}
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_BODY_BYTES) throw Object.assign(new Error('job payload too large'), { code: 'payload_too_large' })
      if (body.profileId && !db.getBrowserProfile(body.profileId)) throw new BrowserProviderError('browser profile not found', { code: 'profile_not_found' })
      const job = db.createJob({ type, payload, profileId: body.profileId, operatorId: actor.id })
      db.audit({ actorId: actor.id, action: 'job.create', entityType: 'job', entityId: job.id, metadata: { type, profileId: job.profile_id } })
      return reply.code(201).send({ job })
    } catch (error) { return handleError(reply, error) }
  })

  fastify.get('/jobs', async (request, reply) => {
    try {
      authUser(request, auth)
      return { jobs: db.listJobs({ limit: request.query?.limit, status: request.query?.status }) }
    } catch (error) { return handleError(reply, error) }
  })

  fastify.get('/jobs/active-summary', async (request, reply) => {
    try {
      authUser(request, auth)
      return db.getActiveJobSummary()
    } catch (error) { return handleError(reply, error) }
  })

  fastify.get('/jobs/:id', async (request, reply) => {
    try {
      authUser(request, auth)
      const job = db.getJob(request.params.id)
      if (!job) throw Object.assign(new Error('job not found'), { code: 'job_not_found' })
      return { job }
    } catch (error) { return handleError(reply, error) }
  })

  fastify.post('/jobs/:id/cancel', async (request, reply) => {
    try {
      const actor = authUser(request, auth)
      auth.requireRole(actor, ['admin', 'operator'])
      const existing = db.getJob(request.params.id)
      if (!existing) throw Object.assign(new Error('job not found'), { code: 'job_not_found' })
      const job = db.cancelJob({ jobId: request.params.id, actorId: actor.id })
      return { job }
    } catch (error) { return handleError(reply, error) }
  })
}

module.exports = { registerJobRoutes }
