import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const row = {
  id: 'drain-source',
  sellerId: 'drain-seller',
  url: 'https://www.goofish.com/personal?userId=drain-seller',
  status: 'pending',
  itemIds: { active: [], sold: [] }
}
const account = { id: 'drain-account', name: 'Drain 账号', enabled: true, partition: 'persist:drain-account' }
const state = { crawlStarted: null, releaseCrawl: null, getWebContentsCalls: 0, retries: 0, finished: 0 }
const crawlStarted = new Promise((resolve) => { state.crawlStarted = resolve })
const crawlRelease = new Promise((resolve) => { state.releaseCrawl = resolve })

const sellerStore = {
  reconcileCanonicalSellerManifest() { return { changed: false } },
  getAllSourceRows() { return [{ ...row, itemIds: { ...row.itemIds } }] },
  getAccountSafetyState() { return null },
  getSettings() { return { throttleMinMs: 15000, throttleMaxMs: 30000, recycleEvery: 0 } },
  prepareRun({ cycleKey }) { return { runId: 'drain-run', cycleKey: cycleKey || 'drain-cycle' } },
  addEvent() {},
  finishRun() { state.finished += 1 },
  mergeSellerItemIds(previous = {}, incoming = {}) {
    return {
      active: [...new Set([...(previous.active || []), ...(incoming.active || [])])],
      sold: [...new Set([...(previous.sold || []), ...(incoming.sold || [])])]
    }
  },
  claimNext() {
    if (row.status !== 'pending') return null
    row.status = 'running'
    row.currentAttempt = { accountId: account.id, cycleKey: 'drain-cycle', attemptKey: 'drain-attempt' }
    return { ...row, itemIds: { ...row.itemIds } }
  },
  markSource() {},
  appendItems() {},
  saveSellerSnapshot() { return { snapshotId: 'drain-snapshot', snapshotHash: 'fixture', path: '/fixture/drain.html' } },
  finalizeFormalAttempt(_id, result) {
    row.status = result.status
    row.currentAttempt = null
  }
}

async function crawlSellerPage() {
  state.crawlStarted()
  await crawlRelease
  return { ok: false, reasonCode: 'NAV_TIMEOUT', reason: 'fixture timeout' }
}

globalThis.__sellerSchedulerDrainRegression = {
  crawlSellerPage,
  sellerStore,
  getAccounts: () => [account],
  getSellerWebContents: async () => {
    state.getWebContentsCalls += 1
    return {}
  },
  recycleSellerWorker() { state.retries += 1 },
  evaluateSellerEvidence(evidence) {
    return evidence.failed || evidence.error
      ? { status: 'failed', reasonCode: 'CRAWL_FAILED', counts: { active: 0, sold: 0 }, expected: {} }
      : { status: 'completed', reasonCode: 'COMPLETE_EVIDENCE', counts: { active: 0, sold: 0 }, expected: {} }
  },
  validateAccountIdentities: (accounts) => accounts,
  evaluateSchedule: () => ({ outcome: 'idle' }),
  SELLER_TIMEZONE: 'Asia/Shanghai'
}

const sourceText = readFileSync(new URL('../../src/main/seller-scheduler.js', import.meta.url), 'utf8')
assert.match(sourceText, /export async function drain\(\)/, 'scheduler exposes a shutdown drain barrier')
assert.match(sourceText, /if \(!stopRequested && !result\.ok && transientReason\)/, 'shutdown does not launch an immediate retry after stop')
const source = sourceText
  .replace("import { crawlSellerPage, resolveAuthoritativeSellerName } from './seller-goofish.js'", 'const { crawlSellerPage } = globalThis.__sellerSchedulerDrainRegression; const resolveAuthoritativeSellerName = ({ sourceSellerName = "", pageSellerName = "" } = {}) => String(pageSellerName || sourceSellerName || "")')
  .replace("import * as sellerStore from './seller-store.js'", 'const { sellerStore } = globalThis.__sellerSchedulerDrainRegression')
  .replace("import { getAccounts } from './store.js'", 'const { getAccounts } = globalThis.__sellerSchedulerDrainRegression')
  .replace("import { getSellerWebContents, recycleSellerWorker } from './seller-worker.js'", 'const { getSellerWebContents, recycleSellerWorker } = globalThis.__sellerSchedulerDrainRegression')
  .replace("import { evaluateSellerEvidence, validateAccountIdentities } from './seller-state-machine.js'", 'const { evaluateSellerEvidence, validateAccountIdentities } = globalThis.__sellerSchedulerDrainRegression')
  .replace("import { evaluateSchedule, SELLER_TIMEZONE } from './seller-schedule.js'", 'const { evaluateSchedule, SELLER_TIMEZONE } = globalThis.__sellerSchedulerDrainRegression')
  .replace('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))', 'const sleep = async () => {}')
const scheduler = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#drain-${Date.now()}`)

const startPromise = scheduler.start({ trigger: 'manual', cycleKey: 'drain-cycle' })
await crawlStarted
const drainPromise = scheduler.drain()
let drainSettled = false
drainPromise.then(() => { drainSettled = true })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(drainSettled, false, 'drain waits for the in-flight crawl/runWorker')
state.releaseCrawl()
await drainPromise
const result = await startPromise
assert.equal(result.ok, true, `the stopped run settles its durable result before shutdown: ${result.reason || 'no reason'}`)
assert.equal(state.getWebContentsCalls, 1, 'shutdown does not create a replacement worker for an immediate retry')
assert.equal(state.retries, 0, 'shutdown skips worker recycle/retry')
assert.equal(state.finished, 1, 'shutdown settles the run exactly once')
assert.equal(row.status, 'incomplete', 'the interrupted attempt remains resumable rather than being falsely completed')

delete globalThis.__sellerSchedulerDrainRegression
console.log('seller scheduler drain regression: passed (waits for active run and suppresses retry after stop)')
