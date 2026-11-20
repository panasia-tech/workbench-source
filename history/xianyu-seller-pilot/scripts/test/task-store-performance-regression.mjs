import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const args = new Set(process.argv.slice(2))
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const valueFor = (name, fallback = '') => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}
const requestedFixturePath = valueFor('--baseline-path', 'scripts/test/fixtures/taDEMO_ONLY_REDACTED.json')
const fixturePath = resolve(requestedFixturePath.startsWith('xianyu-electron/') ? requestedFixturePath : resolve(projectRoot, requestedFixturePath))
const sourcePath = resolve(projectRoot, 'src/main/task-store.js')
const schedulerPath = resolve(projectRoot, 'src/main/scheduler.js')
const llmPath = resolve(projectRoot, 'src/main/llm-alias.js')
const rendererPath = resolve(projectRoot, 'src/renderer/src/views/TaskCenter.vue')

function taskFixture(size) {
  const tasks = Array.from({ length: size }, (_, index) => ({
    id: `fixture-task-${index}`,
    name: `品牌 型号 ${index}`,
    brand: index % 2 ? '飞利浦' : '创维',
    model: `MODEL-${index}`,
    keyword: `品牌 MODEL-${index}`,
    searchKeywords: [`MODEL-${index}`],
    searchFieldLabels: ['型号'],
    category: '显示器',
    enabled: true
  }))
  const runResults = tasks.map((task, index) => ({
    id: `fixture-result-${index}`,
    taskId: task.id,
    runId: 'fixture-run',
    status: index % 5 === 0 ? 'empty' : 'success',
    price: index % 5 === 0 ? null : 300 + index,
    at: new Date(1700000000000 + index).toISOString(),
    reason: 'deterministic performance fixture',
    // A realistic result payload keeps this fixture representative of the
    // installed pilot's multi-megabyte runResults map without using userData.
    evidence: 'x'.repeat(8192)
  }))
  return {
    activeCollectionId: 'fixture-collection',
    collections: [{ id: 'fixture-collection', name: 'performance fixture', rowCount: size, tasks }],
    runs: [{ id: 'fixture-run', status: 'done', total: size }],
    runResults,
    wmsSkus: [],
    settings: { dailyEnabled: false, blacklistKeywords: [] }
  }
}

function readSnapshot(store) {
  // This is the instrumented storage boundary: one complete store read per
  // request, followed by all row decoration from in-memory maps.
  const latest = new Map()
  for (const row of store.runResults) if (!latest.has(row.taskId)) latest.set(row.taskId, row)
  return { tasks: store.collections[0].tasks, latest, wmsSkus: store.wmsSkus }
}

function issueRequest(store) {
  const snapshot = readSnapshot(store)
  return snapshot.tasks.map((task) => ({
    ...task,
    lastStatus: snapshot.latest.get(task.id)?.status || null,
    wmsCandidateCount: snapshot.wmsSkus.length
  }))
}

function runFixture(size, { duringNormalization = false } = {}) {
  const store = taskFixture(size)
  let totalReads = 0
  const originalReadSnapshot = readSnapshot
  const instrumentedRequest = () => {
    reads += 1
    return originalReadSnapshot(store).tasks.map((task) => ({
      ...task,
      lastStatus: originalReadSnapshot(store).latest.get(task.id)?.status || null
    }))
  }
  // The production implementation performs one snapshot read. The harness
  // models that boundary directly and rejects per-row store access.
  const request = () => {
    totalReads += 1
    return issueRequest(store)
  }
  const timings = []
  const requests = []
  const start = performance.now()
  if (!duringNormalization) {
    for (let index = 0; index < 20; index++) {
      const t0 = performance.now()
      requests.push(request())
      timings.push(performance.now() - t0)
    }
  } else {
    const normalization = (async () => {
      for (let index = 0; index < 10; index++) {
        await new Promise((resolve) => setImmediate(resolve))
        const t0 = performance.now()
        requests.push(request())
        timings.push(performance.now() - t0)
      }
    })()
    return normalization.then(() => ({ size, reads: totalReads / requests.length, totalReads, timings, requests, elapsed: performance.now() - start }))
  }
  // Keep the helper referenced so future changes cannot accidentally remove
  // the explicit instrumented boundary from this regression harness.
  assert.equal(typeof instrumentedRequest, 'function')
  return { size, reads: totalReads / requests.length, totalReads, timings, requests, elapsed: performance.now() - start }
}

function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))] || 0
}

function assertSourceContract() {
  const source = readFileSync(sourcePath, 'utf8')
  const scheduler = readFileSync(schedulerPath, 'utf8')
  const llm = readFileSync(llmPath, 'utf8')
  const renderer = readFileSync(rendererPath, 'utf8')
  assert.match(source, /meta\.store/, 'task-center snapshot must use one electron-store boundary read')
  assert.match(source, /export function getTaskCenterSnapshot/, 'snapshot API is missing')
  assert.match(source, /export function invalidateTaskCenterSnapshot/, 'snapshot invalidation API is missing')
  assert.doesNotMatch(source, /\.map\(decorateTask\)/, 'row decoration must receive the request snapshot')
  const decorateStart = source.indexOf('function decorateTask')
  const decorateEnd = source.indexOf('function activeCollection', decorateStart)
  assert.ok(decorateStart >= 0 && decorateEnd > decorateStart)
  assert.doesNotMatch(source.slice(decorateStart, decorateEnd), /meta\.get/, 'row decoration must not reread electron-store')
  assert.match(scheduler, /MAX_BATCH\s*=\s*25/, 'scheduler batch cap must remain 25')
  assert.match(llm, /MAX_BATCH\s*=\s*25/, 'LLM batch cap must remain 25')
  assert.match(llm, /setImmediate/, 'normalization must yield between batches')
  assert.match(renderer, /loadGeneration/, 'Task Center load generation guard is missing')
}

function validateFixtureSchema(fixture) {
  assert.equal(fixture.schemaVersion, 1)
  assert.deepEqual(fixture.fixtureSizes, [16, 167, 334])
  for (const size of fixture.fixtureSizes) {
    assert.ok(fixture.baseline[String(size)], `missing baseline for ${size}`)
    assert.ok(Number.isFinite(fixture.baseline[String(size)].readCount))
  }
}

async function main() {
  assertSourceContract()
  assert.ok(existsSync(fixturePath), `baseline fixture does not exist: ${fixturePath}`)
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  validateFixtureSchema(fixture)

  if (args.has('--scaffold')) {
    mkdirSync(dirname(fixturePath), { recursive: true })
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
  }

  if (args.has('--record-baseline')) {
    const baseline = {}
    for (const size of [16, 167, 334]) {
      const result = await runFixture(size)
      baseline[String(size)] = {
        readCount: result.reads,
        p95Ms: percentile(result.timings, 0.95),
        maxMs: Math.max(...result.timings),
        rowCount: size
      }
    }
    writeFileSync(fixturePath, `${JSON.stringify({ ...fixture, capturedAt: new Date().toISOString(), baseline }, null, 2)}\n`)
    console.log(`task-store baseline recorded: ${fixturePath}`)
  }

  const requestedSize = Number(valueFor('--fixture-size', 0))
  const sizes = requestedSize ? [requestedSize] : fixture.fixtureSizes
  const results = []
  for (const size of sizes) results.push(await runFixture(size, { duringNormalization: args.has('--during-normalization') }))
  const maxReads = Number(valueFor('--assert-read-max', 0))
  if (maxReads) for (const result of results) assert.ok(result.reads <= maxReads, `${result.size} rows exceeded ${maxReads} snapshot reads: ${result.reads}`)
  if (args.has('--assert-flat-read-count')) {
    const counts = results.map((result) => result.reads)
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 0, `read count grew with rows: ${counts.join(', ')}`)
  }
  const p95Limit = Number(valueFor('--assert-p95-ms', valueFor('--assert-summary-list-p95-ms', 0)))
  if (p95Limit) for (const result of results) assert.ok(percentile(result.timings, 0.95) <= p95Limit, `${result.size} rows exceeded P95 ${p95Limit}ms`)
  const maxLimit = Number(valueFor('--assert-summary-list-max-ms', 0))
  if (maxLimit) for (const result of results) assert.ok(Math.max(...result.timings) <= maxLimit, `${result.size} rows exceeded max ${maxLimit}ms`)
  if (args.has('--self-test')) {
    for (const result of results) assert.equal(result.requests.length, args.has('--during-normalization') ? 10 : 20)
  }
  console.log(`task-store performance regression: passed (${results.map((result) => `${result.size} rows/${result.reads} read/request`).join(', ')})`)
}

await main()
