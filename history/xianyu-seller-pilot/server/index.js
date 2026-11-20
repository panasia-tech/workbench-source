"use strict"

const Fastify = require('fastify')
const { loadConfig, publicConfig } = require('./config.js')
const { createFakeProvider } = require('./browser/fake-provider.js')
const { createJobStore } = require('./jobs/job-store.js')
const { createWorker } = require('./jobs/worker.js')

function buildServer({ config = loadConfig(), provider = null, jobStore = null, logger = false } = {}) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 })
  if (!provider && config.provider !== 'fake') {
    throw new Error(`browser_provider_not_configured:${config.provider}`)
  }
  const resolvedProvider = provider || createFakeProvider()
  const resolvedJobStore = jobStore || createJobStore()
  const worker = createWorker({ jobStore: resolvedJobStore, provider: resolvedProvider })

  app.get('/health', async () => {
    const providerHealth = await resolvedProvider.health()
    return {
      ok: true,
      service: 'xianyu-server',
      version: '0.1.0-server-foundation',
      checkedAt: new Date().toISOString(),
      provider: {
        name: resolvedProvider.name || config.provider,
        ok: Boolean(providerHealth?.ok),
        capabilities: resolvedProvider.capabilities || {}
      },
      config: publicConfig(config)
    }
  })

  app.post('/jobs', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', minLength: 1, maxLength: 80 },
          payload: { type: 'object', additionalProperties: true },
          operatorId: { type: 'string', minLength: 1, maxLength: 160 },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 10 }
        }
      }
    }
  }, async (request, reply) => {
    const job = resolvedJobStore.enqueue(request.body || {})
    reply.code(201)
    return { ok: true, job }
  })

  app.get('/jobs', async () => ({ ok: true, items: resolvedJobStore.list() }))
  app.get('/jobs/:jobId', async (request, reply) => {
    const job = resolvedJobStore.get(request.params.jobId)
    if (!job) return reply.code(404).send({ ok: false, code: 'job_not_found' })
    return { ok: true, job }
  })
  app.post('/jobs/:jobId/cancel', async (request, reply) => {
    try {
      return { ok: true, job: resolvedJobStore.cancel(request.params.jobId, request.body?.operatorId || 'system') }
    } catch (error) {
      return reply.code(error.message === 'job_not_found' ? 404 : 409).send({ ok: false, code: error.message || 'job_cancel_failed' })
    }
  })

  app.decorate('jobStore', resolvedJobStore)
  app.decorate('worker', worker)
  app.decorate('browserProvider', resolvedProvider)
  return app
}

async function startServer({ config = loadConfig(), ...options } = {}) {
  const app = buildServer({ config, ...options })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await app.close()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await app.listen({ host: config.host, port: config.port })
  return { app, close }
}

if (require.main === module) {
  try {
    const config = loadConfig()
    if (process.argv.includes('--check-config')) {
      process.stdout.write(`${JSON.stringify({ ok: true, config: publicConfig(config) })}\n`)
      process.exit(0)
    }
    startServer({ config }).then(({ app }) => {
      app.log.info({ host: config.host, port: config.port, provider: config.provider }, 'xianyu server listening')
    }).catch((error) => {
      process.stderr.write(`server_start_failed:${String(error.message || error).slice(0, 240)}\n`)
      process.exitCode = 1
    })
  } catch (error) {
    process.stderr.write(`server_config_failed:${String(error.message || error).slice(0, 240)}\n`)
    process.exitCode = 1
  }
}

module.exports = { buildServer, startServer }
