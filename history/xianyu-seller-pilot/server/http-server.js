"use strict"

const { loadConfig } = require('./config.js')
const { createDatabase } = require('./db/database.js')
const { createProviderFromConfig } = require('./browser/provider-registry.js')
const { buildHttpApp } = require('./http/app.js')
const { createServerWorkerPool } = require('./jobs/db-worker.js')
const { createServerScheduler } = require('./jobs/scheduler.js')
const { createServerWmsSyncService } = require('./jobs/wms-sync.js')
const { createManualSessionManager } = require('./browser/manual-session-manager.js')
const { syncAllRecurringSchedules } = require('./jobs/recurring-schedules.js')

async function start() {
  const config = loadConfig()
  const provider = createProviderFromConfig(config)
  const providerHealth = await provider.health().catch(error => ({ ok: false, provider: provider.name, error: String(error?.message || error).slice(0, 240) }))
  if (config.environment === 'production' && !providerHealth.ok) {
    throw Object.assign(new Error(`browser provider health check failed: ${providerHealth.error || providerHealth.provider || config.provider}`), { code: 'provider_health_failed' })
  }
  const db = createDatabase({ filename: require('node:path').join(config.dataDir, 'server.sqlite') })
  const manualSessions = createManualSessionManager({ db, provider })
  const wms = createServerWmsSyncService({ db, config })
  const app = buildHttpApp({ config, db, provider, wms, manualSessions, logger: config.environment === 'production' })
  const worker = createServerWorkerPool({ db, provider, artifactStore: app.artifacts, concurrency: config.workerConcurrency, workerId: 'server-worker', pollMs: Number(process.env.SERVER_WORKER_POLL_MS) || 1000 })
  const scheduler = createServerScheduler({ db, tickMs: Number(process.env.SERVER_SCHEDULER_TICK_MS) || 1000 })
  // Rehydrate the two H5 recurring schedules before the scheduler starts.
  // Existing next_run_at values are preserved so a restart cannot silently
  // postpone a due run; settings PATCHes explicitly recalculate them.
  syncAllRecurringSchedules(db)
  await scheduler.start()
  await worker.start()
  await wms.start()
  const close = async () => { await manualSessions.stopAll(); await wms.stop(); await scheduler.stop(); await worker.stop(); await app.fastify.close(); db.close() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  try {
    await app.fastify.listen({ host: config.host, port: config.port })
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
  return { app, db, provider, providerHealth, scheduler, worker, wms, manualSessions, close }
}

if (require.main === module) {
  start().catch(error => { console.error(`[server] ${error.message}`); process.exitCode = 1 })
}

module.exports = { start }
