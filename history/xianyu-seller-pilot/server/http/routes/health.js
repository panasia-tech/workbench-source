"use strict"

function registerHealthRoutes(fastify, { config, db, provider = null }) {
  fastify.get('/health', async () => ({
    ok: true,
    service: 'xianyu-seller-server',
    provider: config.provider,
    database: db.schemaVersion() > 0 ? 'ready' : 'unavailable'
  }))

  fastify.get('/ready', async (request, reply) => {
    const checks = { database: db.schemaVersion() > 0, provider: true }
    if (provider && typeof provider.health === 'function') {
      try { checks.provider = Boolean((await provider.health()).ok) } catch { checks.provider = false }
    }
    const ready = checks.database && checks.provider
    if (!ready) return reply.code(503).send({ ok: false, ready: false, checks })
    return { ok: true, ready: true, checks }
  })
}

module.exports = { registerHealthRoutes }
