"use strict"

const { assertProvider, safeProviderError } = require('../browser/provider.js')

function createWorker({ jobStore, provider, workerId = 'server-worker' } = {}) {
  if (!jobStore || typeof jobStore.claimNext !== 'function') throw new TypeError('jobStore is required')
  assertProvider(provider)

  async function runOnce() {
    const job = jobStore.claimNext(workerId)
    if (!job) return null
    let session = null
    try {
      const profile = job.payload?.profile || { id: 'fixture-profile' }
      session = await provider.openSession(profile)
      const page = await provider.getPage(session)
      if (job.payload?.url) await provider.navigate(page, job.payload.url)
      const result = await provider.evaluate(page, job.payload?.expression || 'fixture.results')
      return jobStore.complete(job.id, job.leaseToken, {
        provider: provider.name || 'unknown',
        sessionId: session.sessionId || null,
        url: job.payload?.url || null,
        result
      })
    } catch (error) {
      return jobStore.fail(job.id, job.leaseToken, safeProviderError(error, 'worker_execution_failed'))
    } finally {
      if (session) {
        try { await provider.closeSession(session) } catch { /* cleanup must not mask job result */ }
      }
    }
  }

  async function drain({ maxJobs = 100 } = {}) {
    const limit = Math.max(1, Math.min(1000, Number(maxJobs) || 100))
    const results = []
    for (let index = 0; index < limit; index += 1) {
      const result = await runOnce()
      if (!result) break
      results.push(result)
    }
    return results
  }

  return Object.freeze({ runOnce, drain, workerId })
}

module.exports = { createWorker }
