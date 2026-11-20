import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildServer } = require('../../server/index.js')
const { loadConfig } = require('../../server/config.js')
const { createFakeProvider } = require('../../server/browser/fake-provider.js')
const { createJobStore } = require('../../server/jobs/job-store.js')
const { createWorker } = require('../../server/jobs/worker.js')

const config = loadConfig({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '3080', BROWSER_PROVIDER: 'fake', NODE_ENV: 'test' })
assert.throws(() => loadConfig({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '3080', BROWSER_PROVIDER: 'fake', NODE_ENV: 'production' }), /fake is disabled in production/)
assert.equal(loadConfig({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '3080', BROWSER_PROVIDER: 'fake', NODE_ENV: 'production', ALLOW_FAKE_PROVIDER: 'true' }).allowFakeProvider, true)
assert.equal(loadConfig({ SERVER_HOST: '127.0.0.1', SERVER_PORT: '3080', BROWSER_PROVIDER: 'fake', NODE_ENV: 'test', SERVER_WORKER_CONCURRENCY: '2' }).workerConcurrency, 2)
assert.throws(() => loadConfig({ BROWSER_PROVIDER: 'fake', NODE_ENV: 'test', SERVER_WORKER_CONCURRENCY: '0' }), /SERVER_WORKER_CONCURRENCY/)
const provider = createFakeProvider({ fixture: { title: 'Server fixture', items: [{ id: 'one', price: 321 }] } })
const jobStore = createJobStore()
const worker = createWorker({ jobStore, provider, workerId: 'test-worker' })
const app = buildServer({ config, provider, jobStore, logger: false })

try {
  const health = await app.inject({ method: 'GET', url: '/health' })
  assert.equal(health.statusCode, 200)
  const healthBody = health.json()
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.provider.name, 'fake')
  assert.equal(Object.hasOwn(healthBody, 'env'), false)

  assert.throws(() => buildServer({ config: { ...config, provider: 'adspower' } }), /browser_provider_not_configured/)
  assert.throws(() => jobStore.enqueue({ payload: { oversized: 'x'.repeat(256 * 1024) } }), /exceeds/)

  const created = await app.inject({
    method: 'POST',
    url: '/jobs',
    payload: { type: 'probe', operatorId: 'operator-1', payload: { profile: { id: 'profile-1' }, url: 'https://example.test', expression: 'fixture.results' } }
  })
  assert.equal(created.statusCode, 201)
  const createdJob = created.json().job
  assert.equal(createdJob.status, 'pending')

  const claimed = jobStore.claimNext('worker-a')
  assert.equal(claimed.id, createdJob.id)
  assert.throws(() => jobStore.complete(createdJob.id, 'wrong-token', {}), /job_lease_invalid/)
  jobStore.cancel(createdJob.id, 'operator-1')

  const second = jobStore.enqueue({ type: 'probe', payload: { profile: { id: 'profile-2' }, expression: 'fixture.results' } })
  const result = await worker.runOnce()
  assert.equal(result.status, 'succeeded')
  assert.equal(result.result.provider, 'fake')
  assert.deepEqual(result.result.result.items, [{ id: 'one', price: 321 }])
  assert.equal(jobStore.get(second.id).status, 'succeeded')

  const invalidProvider = () => createWorker({ jobStore: createJobStore(), provider: { name: 'bad' } })
  assert.throws(invalidProvider, /must be a function/)

  if (process.argv.includes('--health-only')) {
    process.stdout.write('server-foundation:health PASS\n')
  } else {
    process.stdout.write(`server-foundation: PASS (${jobStore.events().length} events)\n`)
  }
} finally {
  await app.close()
}
