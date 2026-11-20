"use strict"

const { randomUUID } = require('node:crypto')

const STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'cancelled'])
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function assertJobId(jobId) {
  const value = String(jobId || '').trim()
  if (!value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('job id is invalid')
  return value
}

function createJobStore({ now = () => Date.now(), leaseMs = 120_000 } = {}) {
  const jobs = new Map()
  const events = []

  function event(type, job) {
    const entry = { cursor: events.length + 1, type, jobId: job.id, at: new Date(now()).toISOString(), status: job.status }
    events.push(entry)
    return entry
  }

  function enqueue({ type = 'probe', payload = {}, operatorId = 'system', maxAttempts = 1 } = {}) {
    const serializedPayload = JSON.stringify(payload || {})
    if (serializedPayload.length > 256 * 1024) throw new TypeError('job payload exceeds 256 KiB')
    const job = {
      id: randomUUID(),
      type: String(type),
      payload: clone(payload) || {},
      operatorId: String(operatorId || 'system').slice(0, 160),
      status: 'pending',
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || 1)),
      leaseToken: null,
      workerId: null,
      leaseExpiresAt: null,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null
    }
    jobs.set(job.id, job)
    event('job.created', job)
    return clone(job)
  }

  function get(jobId) {
    return clone(jobs.get(assertJobId(jobId)) || null)
  }

  function list() {
    return [...jobs.values()].map(clone)
  }

  function claimNext(workerId = 'worker') {
    const id = String(workerId || '').trim()
    if (!id) throw new TypeError('worker id is required')
    const timestamp = now()
    const candidate = [...jobs.values()].find((job) => {
      if (job.status === 'pending') return true
      return job.status === 'running' && Number(job.leaseExpiresAt || 0) <= timestamp
    })
    if (!candidate) return null
    candidate.status = 'running'
    candidate.attempts += 1
    candidate.workerId = id.slice(0, 160)
    candidate.leaseToken = randomUUID()
    candidate.leaseExpiresAt = timestamp + leaseMs
    candidate.startedAt = candidate.startedAt || new Date(timestamp).toISOString()
    candidate.updatedAt = new Date(timestamp).toISOString()
    candidate.error = null
    event('job.claimed', candidate)
    return clone(candidate)
  }

  function requireLease(jobId, leaseToken) {
    const job = jobs.get(assertJobId(jobId))
    if (!job) throw new Error('job_not_found')
    if (job.status !== 'running' || !leaseToken || job.leaseToken !== String(leaseToken)) throw new Error('job_lease_invalid')
    if (Number(job.leaseExpiresAt || 0) <= now()) throw new Error('job_lease_expired')
    return job
  }

  function heartbeat(jobId, leaseToken) {
    const job = requireLease(jobId, leaseToken)
    job.leaseExpiresAt = now() + leaseMs
    job.updatedAt = new Date(now()).toISOString()
    event('job.heartbeat', job)
    return clone(job)
  }

  function complete(jobId, leaseToken, result = null) {
    const job = requireLease(jobId, leaseToken)
    job.status = 'succeeded'
    job.result = clone(result)
    job.finishedAt = new Date(now()).toISOString()
    job.updatedAt = job.finishedAt
    job.leaseToken = null
    job.leaseExpiresAt = null
    event('job.succeeded', job)
    return clone(job)
  }

  function fail(jobId, leaseToken, error = {}) {
    const job = requireLease(jobId, leaseToken)
    const safeError = {
      code: String(error.code || 'job_failed').slice(0, 80),
      message: String(error.message || 'Job failed').slice(0, 240),
      retryable: Boolean(error.retryable)
    }
    job.status = 'failed'
    job.error = safeError
    job.finishedAt = new Date(now()).toISOString()
    job.updatedAt = job.finishedAt
    job.leaseToken = null
    job.leaseExpiresAt = null
    event('job.failed', job)
    return clone(job)
  }

  function cancel(jobId, operatorId = 'system') {
    const job = jobs.get(assertJobId(jobId))
    if (!job) throw new Error('job_not_found')
    if (TERMINAL.has(job.status)) return clone(job)
    job.status = 'cancelled'
    job.operatorId = String(operatorId || 'system').slice(0, 160)
    job.leaseToken = null
    job.leaseExpiresAt = null
    job.finishedAt = new Date(now()).toISOString()
    job.updatedAt = job.finishedAt
    event('job.cancelled', job)
    return clone(job)
  }

  return Object.freeze({ enqueue, get, list, claimNext, heartbeat, complete, fail, cancel, events: () => clone(events), statuses: STATUSES })
}

module.exports = { STATUSES, createJobStore }
