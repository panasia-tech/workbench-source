"use strict"

function tokenFromRequest(request) {
  const authorization = String(request.headers.authorization || '')
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim()
  const cookie = String(request.headers.cookie || '')
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const PRIVATE_EVENT_KEYS = new Set([
  'workerid', 'leasetoken', 'leaseexpiresat', 'password', 'passwordhash',
  'apikey', 'cookie', 'authorization', 'userdata_dir', 'userdatadir'
])

function sanitizeEventPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeEventPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_EVENT_KEYS.has(key.toLowerCase()))
    .map(([key, nested]) => [key, sanitizeEventPayload(nested)]))
}

function registerEventRoute(fastify, { db, auth }) {
  fastify.get('/events', async (request, reply) => {
    const user = auth.verifyToken(tokenFromRequest(request))
    if (!user) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    const afterHeader = request.headers['last-event-id']
    const after = Number(request.query?.after ?? afterHeader ?? 0)
    const limit = Math.min(200, Math.max(1, Number(request.query?.limit) || 100))
    const events = db.listEvents({ after: Number.isFinite(after) ? after : 0, limit })
    const body = events.map(event => `id: ${event.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify({ cursor: event.cursor, jobId: event.jobId, jobType: event.jobType, status: event.status, payload: sanitizeEventPayload(event.payload), createdAt: event.createdAt })}\n\n`).join('') || ': heartbeat\n\n'
    reply.header('content-type', 'text/event-stream; charset=utf-8')
    reply.header('cache-control', 'no-cache, no-store')
    reply.header('x-events-next-cursor', String(events.at(-1)?.cursor || after || 0))
    return reply.send(body)
  })
}

module.exports = { registerEventRoute, tokenFromRequest, sanitizeEventPayload }
