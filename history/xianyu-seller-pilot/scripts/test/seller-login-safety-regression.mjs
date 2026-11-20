import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const events = []
let eligibilityCalls = 0
let prepareRunCalls = 0

const sellerStore = {
  reconcileCanonicalSellerManifest() { return { changed: false } },
  getAllSourceRows() {
    return [{ id: 'source-1', sellerId: 'seller-1', url: 'https://www.goofish.com/personal?userId=seller-1', status: 'pending' }]
  },
  getAccountSafetyState(accountId) {
    assert.equal(accountId, 'account-3')
    return { accountId, status: 'login_required', reasonCode: 'LOGIN_REQUIRED' }
  },
  prepareRun() {
    prepareRunCalls += 1
    throw new Error('login-required account must not prepare a run')
  }
}

globalThis.__sellerLoginSafetyRegression = {
  crawlSellerPage: async () => { throw new Error('login-required account must not crawl') },
  sellerStore,
  getAccounts: () => [{ id: 'account-3', name: '账号3', enabled: true, partition: 'persist:account-3' }],
  getSellerWebContents: async () => { throw new Error('login-required account must not open a page') },
  recycleSellerWorker() {},
  evaluateSellerEvidence() { throw new Error('login-required account must not evaluate evidence') },
  validateAccountIdentities: (accounts) => accounts,
  evaluateSchedule: () => ({ outcome: 'idle' }),
  SELLER_TIMEZONE: 'Asia/Shanghai'
}

const sourceText = readFileSync(new URL('../../src/main/seller-scheduler.js', import.meta.url), 'utf8')
const source = sourceText
  .replace("import { crawlSellerPage, resolveAuthoritativeSellerName } from './seller-goofish.js'", 'const { crawlSellerPage } = globalThis.__sellerLoginSafetyRegression; const resolveAuthoritativeSellerName = ({ sourceSellerName = "", pageSellerName = "" } = {}) => String(pageSellerName || sourceSellerName || "")')
  .replace("import * as sellerStore from './seller-store.js'", 'const { sellerStore } = globalThis.__sellerLoginSafetyRegression')
  .replace("import { getAccounts } from './store.js'", 'const { getAccounts } = globalThis.__sellerLoginSafetyRegression')
  .replace("import { getSellerWebContents, recycleSellerWorker } from './seller-worker.js'", 'const { getSellerWebContents, recycleSellerWorker } = globalThis.__sellerLoginSafetyRegression')
  .replace("import { evaluateSellerEvidence, validateAccountIdentities } from './seller-state-machine.js'", 'const { evaluateSellerEvidence, validateAccountIdentities } = globalThis.__sellerLoginSafetyRegression')
  .replace("import { evaluateSchedule, SELLER_TIMEZONE } from './seller-schedule.js'", 'const { evaluateSchedule, SELLER_TIMEZONE } = globalThis.__sellerLoginSafetyRegression')
  .replace('const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))', 'const sleep = async () => {}')

const scheduler = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`)
scheduler.setEmitter((type, payload) => events.push({ type, payload }))
scheduler.setAccountEligibilityChecker(async () => {
  eligibilityCalls += 1
  return true
})

const result = await scheduler.start({ maxSellers: 1, trigger: 'login-safety-regression' })
assert.equal(result.ok, false)
assert.match(result.reason, /所有账号均在等待登录修复/)
assert.equal(eligibilityCalls, 0, 'login_required account must not be sent to the auth checker')
assert.equal(prepareRunCalls, 0, 'login_required account must not create a run')
assert.deepEqual(events, [{
  type: 'seller-account-safety',
  payload: { accountId: 'account-3', status: 'login_required', reasonCode: 'LOGIN_REQUIRED', accountName: '账号3' }
}])

delete globalThis.__sellerLoginSafetyRegression
console.log('seller-login-safety-regression: PASS')
