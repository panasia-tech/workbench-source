"use strict"

const crypto = require('node:crypto')
const { runMarketJob } = require('./market-job.js')
const { runSellerJob } = require('./seller-job.js')
const { enqueueScheduledWorkbench } = require('./workbench-runner.js')
const { enqueueScheduledSeller } = require('./seller-runner.js')
const { BrowserProviderError, safeProviderError } = require('../browser/provider.js')

const SCHEDULE_JOB_TYPES = new Set(['workbench_schedule', 'seller_schedule'])

function profileForJob(db, row) {
  if (!row?.profile_id) return null
  const stored = db.getBrowserProfile(row.profile_id) || {}
  const vendorProfileId = stored.vendor_profile_id || row.profile_id
  return {
    id: vendorProfileId,
    profileId: vendorProfileId,
    serverProfileId: row.profile_id,
    vendorProfileId,
    userDataDir: stored.user_data_dir,
    provider: stored.provider
  }
}

function serverProfileKey(job) {
  const key = String(job?.profile_id || '').trim()
  return key || null
}

function createServerWorker({ db, provider, artifactStore = null, workerId = `worker-${crypto.randomUUID()}`, pollMs = 1000, leaseMs = 60_000, now = () => new Date().toISOString(), profileLocks = new Map() } = {}) {
  if (!db) throw new Error('worker database is required')
  if (!provider) throw new Error('worker provider is required')
  let timer = null
  let started = false
  let active = null

  function recordWorkbenchResult(job, result, terminalJob) {
    const taskId = job?.payload?.workbenchTaskId
    const runId = job?.payload?.workbenchRunId
    if (!taskId || !runId || !terminalJob || ['pending', 'running', 'cancelled'].includes(terminalJob.status)) return
    const resultStatus = String(result?.status || '')
    const status = ['succeeded', 'completed', 'empty', 'invalid_price', 'risk_control', 'failed'].includes(resultStatus)
      ? (resultStatus === 'completed' ? 'succeeded' : resultStatus)
      : (terminalJob.status === 'succeeded' ? 'succeeded' : (terminalJob.error_code || 'fail'))
    const reason = result?.error?.message || result?.reasonCode || terminalJob.error_message || ''
    db.recordWorkbenchResult({ taskId, runId, status, price: result?.price, reason, result })
  }

  function recordSellerResult(job, result, terminalJob) {
    const sourceId = job?.payload?.sellerSourceId
    const runId = job?.payload?.sellerRunId
    if (!sourceId || !runId || !terminalJob || ['pending', 'running', 'cancelled'].includes(terminalJob.status)) return
    db.recordSellerResult({ sourceId, runId, result: result || { status: terminalJob.status === 'succeeded' ? 'completed' : 'failed', error: { code: terminalJob.error_code, message: terminalJob.error_message } }, artifactId: result?.snapshotPath || null })
  }

  async function execute(job) {
    const token = job._leaseToken
    const profileLockOwner = job._profileLockOwner || ''
    let profileLockLost = false
    const heartbeatTimer = setInterval(() => {
      try {
        if (!db.heartbeat({ jobId: job.id, workerId, leaseToken: token, leaseMs })) profileLockLost = true
        if (job.profile_id && profileLockOwner && db.acquireBrowserProfileLock && !db.acquireBrowserProfileLock({ profileId: job.profile_id, ownerId: profileLockOwner, leaseMs })) profileLockLost = true
      } catch { profileLockLost = true }
    }, Math.max(250, Math.floor(leaseMs / 3)))
    const profile = profileForJob(db, job)
    try {
      if (db.getJob(job.id)?.control_requested === 'pause') {
        return db.releasePausedJob({ jobId: job.id, workerId, leaseToken: token }) || db.getJob(job.id)
      }
      // Recurring H5 jobs are server-side parent jobs.  They deliberately do
      // not bind to one browser profile: the runner fans child jobs across all
      // enabled profiles.  Ordinary browser jobs still fail closed when their
      // profile has disappeared or been disabled.
      if (!profile && !SCHEDULE_JOB_TYPES.has(job.type)) {
        const failed = db.failJob({ jobId: job.id, workerId, leaseToken: token, errorCode: 'profile_required', errorMessage: 'A browser profile is required' })
        recordWorkbenchResult(job, null, failed)
        recordSellerResult(job, null, failed)
        return failed || db.getJob(job.id)
      }
      const input = { provider, job, profile, artifactStore, now }
      let result
      if (job.type === 'workbench_schedule') result = enqueueScheduledWorkbench(db, job)
      else if (job.type === 'seller_schedule') result = enqueueScheduledSeller(db, job)
      else if (job.type === 'market_snapshot') result = await runMarketJob(input)
      else if (job.type === 'seller_snapshot') result = await runSellerJob(input)
      else if (job.type === 'browser_probe') {
        const session = await provider.openSession(profile)
        try {
          const page = await provider.getPage(session)
          await provider.navigate(page, String(job.payload?.url || 'about:blank'))
          result = { status: 'succeeded', kind: 'browser_probe', url: String(job.payload?.url || 'about:blank') }
        } finally { await provider.closeSession(session).catch(() => {}) }
      } else throw new BrowserProviderError(`unsupported job type: ${job.type}`, { code: 'job_type_not_allowed' })

      if (profileLockLost) throw new BrowserProviderError('browser profile lease was lost', { code: 'profile_lock_lost', retryable: true })
      if (!db.heartbeat({ jobId: job.id, workerId, leaseToken: token, leaseMs })) throw new BrowserProviderError('job lease was lost', { code: 'job_lease_lost', retryable: true })
      if (result.status === 'succeeded' || result.status === 'completed') {
        const completed = db.completeJob({ jobId: job.id, workerId, leaseToken: token, result }) || db.getJob(job.id)
        recordWorkbenchResult(job, result, completed)
        recordSellerResult(job, result, completed)
        return completed
      }
      const code = result.error?.code || (result.status === 'login_expired' ? 'login_expired' : result.status === 'risk_cooldown' ? 'risk_cooldown' : `${job.type}_${result.status}`)
      const message = result.error?.message || `Job ended with status ${result.status}`
      const maxAttempts = Math.min(5, Math.max(1, Number(job.payload?.maxAttempts) || 2))
      if (result.error?.retryable && job.attempt < maxAttempts) return db.retryJob({ jobId: job.id, workerId, leaseToken: token, errorCode: code, errorMessage: message, delayMs: Number(job.payload?.retryDelayMs) || 0 }) || db.getJob(job.id)
      const failed = db.failJob({ jobId: job.id, workerId, leaseToken: token, errorCode: code, errorMessage: message }) || db.getJob(job.id)
      recordWorkbenchResult(job, result, failed)
      recordSellerResult(job, result, failed)
      return failed
    } catch (error) {
      const safe = safeProviderError(error, 'worker_job_failed')
      const maxAttempts = Math.min(5, Math.max(1, Number(job.payload?.maxAttempts) || 2))
      if (safe.retryable && job.attempt < maxAttempts) return db.retryJob({ jobId: job.id, workerId, leaseToken: token, errorCode: safe.code, errorMessage: safe.message }) || db.getJob(job.id)
      const failed = db.failJob({ jobId: job.id, workerId, leaseToken: token, errorCode: safe.code, errorMessage: safe.message }) || db.getJob(job.id)
      recordWorkbenchResult(job, { status: 'failed', error: safe }, failed)
      recordSellerResult(job, { status: 'failed', error: safe }, failed)
      return failed
    } finally {
      clearInterval(heartbeatTimer)
    }
  }

  async function runOnce() {
    if (!started || active) return active
    const leaseToken = crypto.randomUUID()
    const profileLockOwner = `worker:${workerId}:${leaseToken}`
    const claimed = db.claimJob({ workerId, leaseToken, leaseMs, excludeProfileIds: [...profileLocks.keys()], profileLockOwner, profileLockLeaseMs: leaseMs })
    if (!claimed) return null
    Object.defineProperty(claimed, '_profileLockOwner', { value: profileLockOwner, enumerable: false, configurable: false })
    const profileKey = serverProfileKey(claimed)
    if (profileKey) profileLocks.set(profileKey, profileLockOwner)
    active = execute(claimed).finally(() => {
      if (profileKey) {
        db.releaseBrowserProfileLock?.({ profileId: profileKey, ownerId: profileLockOwner })
        if (profileLocks.get(profileKey) === profileLockOwner) profileLocks.delete(profileKey)
      }
      active = null
    })
    return active
  }

  return {
    workerId,
    async start() {
      if (started) return
      started = true
      timer = setInterval(() => { runOnce().catch(() => {}) }, Math.max(50, Number(pollMs) || 1000))
      await runOnce()
    },
    async stop() {
      started = false
      if (timer) clearInterval(timer)
      timer = null
      if (active) await active.catch(() => {})
    },
    runOnce,
    isRunning: () => started,
    getActive: () => active
  }
}

function createServerWorkerPool({ concurrency = 1, workerId = 'server-worker', ...options } = {}) {
  const count = Math.min(8, Math.max(1, Number(concurrency) || 1))
  const profileLocks = options.profileLocks || new Map()
  const workers = Array.from({ length: count }, (_, index) => createServerWorker({
    ...options,
    profileLocks,
    workerId: `${workerId}-${index + 1}`
  }))
  return {
    workers,
    async start() { await Promise.all(workers.map(worker => worker.start())) },
    async stop() { await Promise.all(workers.map(worker => worker.stop())) },
    async runOnce() { return Promise.all(workers.map(worker => worker.runOnce())) },
    isRunning: () => workers.some(worker => worker.isRunning()),
    getActive: () => workers.map(worker => worker.getActive()).filter(Boolean)
  }
}

module.exports = { createServerWorker, createServerWorkerPool }
