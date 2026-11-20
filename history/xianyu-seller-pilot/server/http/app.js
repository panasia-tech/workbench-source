"use strict"

const Fastify = require('fastify')
const multipart = require('@fastify/multipart')
const { loadConfig } = require('../config.js')
const { createDatabase } = require('../db/database.js')
const { createAuthService } = require('../auth/auth-service.js')
const { registerAuthRoutes } = require('./routes/auth.js')
const { registerJobRoutes } = require('./routes/jobs.js')
const { registerEventRoute } = require('./events.js')
const { registerTaskRoutes } = require('./routes/tasks.js')
const { registerArtifactRoutes } = require('./routes/artifacts.js')
const { createArtifactStore } = require('../storage/artifacts.js')
const { registerHealthRoutes } = require('./routes/health.js')
const { registerWebRoutes } = require('./routes/web.js')
const { registerScheduleRoutes } = require('./routes/schedules.js')
const { registerProfileRoutes } = require('./routes/profiles.js')
const { registerWorkbenchRoutes } = require('./routes/workbench.js')
const { registerSellerWorkbenchRoutes } = require('./routes/seller-workbench.js')
const { registerManualBrowserRoutes } = require('./routes/manual-browser.js')
const { createLlmService } = require('../ai/llm-service.js')

function buildHttpApp({ config = loadConfig(), db = null, auth = null, provider = null, wms = null, llm = null, manualSessions = null, logger = false } = {}) {
  const database = db || createDatabase({ filename: require('node:path').join(config.dataDir, 'server.sqlite') })
  const authService = auth || createAuthService({ db: database })
  const fastify = Fastify({ logger, bodyLimit: 256 * 1024 })
  const artifacts = createArtifactStore({ root: require('node:path').join(config.dataDir, 'artifacts') })
  fastify.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
  fastify.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return
    const origin = String(request.headers.origin || '').trim()
    if (!origin) return
    const proto = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    const host = String(request.headers.host || '').trim()
    if (host && origin !== `${proto}://${host}`) return reply.code(403).send({ error: { code: 'csrf_origin_rejected', message: 'Cross-origin mutation rejected' } })
  })
  fastify.decorate('serverDatabase', database)
  registerHealthRoutes(fastify, { config, db: database, provider })
  registerWebRoutes(fastify)
  registerAuthRoutes(fastify, { auth: authService, db: database, config })
  registerJobRoutes(fastify, { auth: authService, db: database })
  registerEventRoute(fastify, { auth: authService, db: database })
  registerTaskRoutes(fastify, { auth: authService, db: database })
  registerScheduleRoutes(fastify, { auth: authService, db: database })
  registerProfileRoutes(fastify, { auth: authService, db: database, config })
  registerWorkbenchRoutes(fastify, { auth: authService, db: database, config, wms, llm: llm || createLlmService() })
  registerSellerWorkbenchRoutes(fastify, { auth: authService, db: database })
  registerManualBrowserRoutes(fastify, { auth: authService, db: database, manualSessions })
  registerArtifactRoutes(fastify, { auth: authService, db: database, artifacts })
  fastify.addHook('onClose', async () => { if (!db) database.close() })
  return { fastify, db: database, auth: authService, artifacts }
}

module.exports = { buildHttpApp }
