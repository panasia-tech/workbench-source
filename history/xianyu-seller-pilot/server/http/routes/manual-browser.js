"use strict"

const { tokenFromRequest } = require('../events.js')
const { safeProviderError } = require('../../browser/provider.js')

function actorFor(request, auth) { return auth.verifyToken(tokenFromRequest(request)) }
function sendError(reply, error) {
  const safe = safeProviderError(error, error?.code || 'manual_browser_failed')
  const status = safe.code === 'unauthenticated' ? 401 : safe.code === 'forbidden' ? 403 : safe.code === 'manual_session_not_found' || safe.code === 'profile_not_found' ? 404 : ['manual_session_exists', 'profile_busy'].includes(safe.code) ? 409 : safe.code === 'manual_control_unavailable' ? 503 : 400
  return reply.code(status).send({ error: safe })
}

function registerManualBrowserRoutes(fastify, { db, auth, manualSessions }) {
  if (!manualSessions) return
  fastify.get('/manual-sessions', async (request, reply) => {
    if (!actorFor(request, auth)) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    return { sessions: manualSessions.list() }
  })
  fastify.post('/profiles/:id/manual-session', async (request, reply) => {
    const actor = actorFor(request, auth)
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const profile = db.getBrowserProfile(request.params.id)
    if (!profile) return reply.code(404).send({ error: { code: 'profile_not_found', message: 'Profile not found' } })
    try { return reply.code(201).send(await manualSessions.open({ profile, actorId: actor.id, url: request.body?.url })) } catch (error) { return sendError(reply, error) }
  })
  fastify.get('/profiles/:id/manual-session', async (request, reply) => {
    if (!actorFor(request, auth)) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    try { return await manualSessions.inspect({ profileId: request.params.id, sessionId: request.query?.sessionId, withScreenshot: request.query?.screenshot !== '0', withSnapshot: request.query?.snapshot !== '0' }) } catch (error) { return sendError(reply, error) }
  })
  fastify.post('/profiles/:id/manual-session/action', async (request, reply) => {
    const actor = actorFor(request, auth)
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const body = request.body || {}
    try { return await manualSessions.action({ profileId: request.params.id, sessionId: body.sessionId, actorId: actor.id, action: body }) } catch (error) { return sendError(reply, error) }
  })
  fastify.delete('/profiles/:id/manual-session', async (request, reply) => {
    const actor = actorFor(request, auth)
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    try { return await manualSessions.close({ profileId: request.params.id, sessionId: request.body?.sessionId || request.query?.sessionId, actorId: actor.id }) } catch (error) { return sendError(reply, error) }
  })
}

module.exports = { registerManualBrowserRoutes }
