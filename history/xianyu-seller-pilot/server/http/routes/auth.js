"use strict"

const { BrowserProviderError } = require('../../browser/provider.js')
const { tokenFromRequest } = require('../events.js')

function handleError(reply, error) {
  const code = error instanceof BrowserProviderError ? error.code : 'request_failed'
  const status = code === 'unauthenticated' ? 401 : code === 'forbidden' ? 403 : code === 'invalid_credentials' ? 401 : 400
  return reply.code(status).send({ error: { code, message: error instanceof BrowserProviderError ? error.message : 'Request failed' } })
}

function registerAuthRoutes(fastify, { auth, db, config = {} }) {
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const body = request.body || {}
      const result = auth.authenticate(body.username, body.password)
      const secure = config.environment === 'production' ? '; Secure' : ''
      reply.header('set-cookie', `sid=${encodeURIComponent(result.token)}; HttpOnly; Path=/; SameSite=Strict${secure}`)
      return { user: result.user, expiresAt: result.expiresAt }
    } catch (error) { return handleError(reply, error) }
  })

  fastify.post('/auth/logout', async (request, reply) => {
    auth.revokeToken(tokenFromRequest(request))
    reply.header('set-cookie', 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict')
    return { ok: true }
  })

  fastify.get('/auth/me', async (request, reply) => {
    const user = auth.verifyToken(tokenFromRequest(request))
    if (!user) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    return { user }
  })

  fastify.post('/auth/users', async (request, reply) => {
    try {
      const actor = auth.verifyToken(tokenFromRequest(request))
      auth.requireRole(actor, ['admin'])
      const created = auth.createUser(request.body || {})
      db.audit({ actorId: actor.id, action: 'user.create', entityType: 'user', entityId: created.id, metadata: { role: created.role } })
      return reply.code(201).send({ user: created })
    } catch (error) { return handleError(reply, error) }
  })
}

module.exports = { registerAuthRoutes }
