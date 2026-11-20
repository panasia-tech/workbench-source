import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createFakeProvider } = require('../../server/browser/fake-provider.js')
const { runMarketJob } = require('../../server/jobs/market-job.js')
const { runSellerJob, applySellerControl } = require('../../server/jobs/seller-job.js')
const { createArtifactStore, safeArtifactName } = require('../../server/storage/artifacts.js')
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { buildHttpApp } = require('../../server/http/app.js')

function fixtureProvider({ market, seller }) {
  const sessions = new Set()
  return {
    name: 'fixture',
    capabilities: { cdp: false, playwright: false, persistentProfile: true, remoteView: false },
    async health() { return { ok: true, provider: 'fixture' } },
    async openSession() { const session = { sessionId: `fixture-${sessions.size + 1}`, closed: false }; sessions.add(session.sessionId); return session },
    async getPage(session) { if (!sessions.has(session.sessionId)) throw new Error('closed'); return { sessionId: session.sessionId, url: '' } },
    async navigate(page, url) { page.url = url; return { ok: true, url } },
    async evaluate(page, expression) { return expression === 'window.__sellerFixture' ? seller : market },
    async closeSession(session) { sessions.delete(session.sessionId); return { ok: true } }
  }
}

// Exercises the production seller crawler through the server's real-provider
// branch without requiring a live account. The transport intentionally
// returns the smallest DOM observations needed to prove that the worker chose
// crawlSellerPage (rather than window.__sellerFixture).
function realSellerProvider() {
  const sessions = new Set()
  let section = 'combined'
  const activeItem = { itemId: 'real-active', itemUrl: 'https://www.goofish.com/item?id=real-active', title: 'Real active listing', price: 120, status: 'active' }
  const soldItem = { itemId: 'real-sold', itemUrl: 'https://www.goofish.com/item?id=real-sold', title: 'Real sold listing', price: 80, status: 'sold' }
  const tabs = [{ text: '在售 1', count: 1, active: section === 'active' }, { text: '已售 1', count: 1, active: section === 'sold' }]
  return {
    name: 'camoufox',
    capabilities: { cdp: false, playwright: true, persistentProfile: true, remoteView: false, cli: true },
    async health() { return { ok: true, provider: 'camoufox' } },
    async openSession() { const session = { sessionId: `camoufox-${sessions.size + 1}` }; sessions.add(session.sessionId); return session },
    async getPage(session) { if (!sessions.has(session.sessionId)) throw new Error('closed'); return { sessionId: session.sessionId, url: '' } },
    async navigate(page, url) { page.url = url; return { ok: true, url } },
    async evaluate(_page, expression) {
      if (expression.includes('document.documentElement.cloneNode')) return { html: '<!doctype html><html><body>真实卖家</body></html>', width: 1280, height: 720, url: 'https://www.goofish.com/personal?userId=real-seller' }
      if (expression.includes('const signals =')) return { candidate: false, url: 'https://www.goofish.com/personal?userId=real-seller', route: 'www.goofish.com/personal', normalContent: true }
      if (expression.includes('const deadline =')) return { remaining: 0 }
      if (expression.includes('const wanted =') && expression.includes('target.click')) { section = expression.includes('"sold"') ? 'sold' : 'active'; return { clicked: true, alreadyActive: false, section } }
      if (expression.includes('const body =') && expression.includes('const cardOf')) {
        const items = section === 'active' ? [activeItem] : section === 'sold' ? [soldItem] : [activeItem, soldItem]
        return { loggedOut: false, http429: false, items, imagePlaceholderCount: 0, tabs, sellerName: '真实卖家', loading: false, loadingKind: 'none', loadingBottom: false, endHints: false, bodySample: '在售 1 已售 1' }
      }
      return { clicked: true, remaining: 0 }
    },
    async closeSession(session) { sessions.delete(session.sessionId); return { ok: true } }
  }
}

function realMarketProvider() {
  const sessions = new Set()
  return {
    name: 'camoufox',
    capabilities: { cdp: false, playwright: true, persistentProfile: true, remoteView: false, cli: true },
    async health() { return { ok: true, provider: 'camoufox' } },
    async openSession() { const session = { sessionId: `camoufox-market-${sessions.size + 1}` }; sessions.add(session.sessionId); return session },
    async getPage(session) { if (!sessions.has(session.sessionId)) throw new Error('closed'); return { sessionId: session.sessionId, url: '' } },
    async navigate(page, url) { page.url = url; return { ok: true, url } },
    async evaluate(_page, expression) {
      if (expression.includes('const signals =')) return { candidate: false, url: 'https://www.goofish.com/search?q=显示器', route: 'www.goofish.com/search', normalContent: true }
      if (expression.includes('const blacklist =')) return { noResult: false, loggedOut: false, cardCount: 1, pricedCount: 1, blockedCount: 0, nonTargetCount: 0, candidates: [{ itemId: 'market-real', itemUrl: 'https://www.goofish.com/item?id=market-real', title: '显示器', price: 180 }], prices: [180], lowest: 180 }
      return { html: '<!doctype html><html><body>显示器</body></html>', width: 1280, height: 720, url: 'https://www.goofish.com/search?q=显示器' }
    },
    async closeSession(session) { sessions.delete(session.sessionId); return { ok: true } }
  }
}

async function main() {
  const market = await runMarketJob({
    provider: createFakeProvider({ fixture: { items: [
      { id: '1', title: 'Monitor 27 inch', price: 300 },
      { id: '2', title: 'Monitor 27 inch broken', price: 39 },
      { id: '3', title: 'Monitor 27 inch wholesale', price: 420 },
      { id: '4', title: 'Monitor 27 inch bait', price: 99999999 }
    ] } }),
    job: { id: 'market-1', payload: { keyword: '27 monitor', blacklistKeywords: ['broken'], priceFence: { minListingPrice: 100, maxListingPrice: 1000 } } },
    profile: { id: 'fixture-profile' }
  })
  assert.equal(market.status, 'succeeded')
  assert.equal(market.price, 360)
  assert.equal(market.evidence.blockedCount, 1)
  assert.equal(market.itemCount, 2)

  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-crawl-snapshots-'))
  const snapshotStore = createArtifactStore({ root: snapshotDir, maxBytes: 1024 * 1024 })
  const realMarket = await runMarketJob({
    provider: realMarketProvider(),
    job: { id: 'market-real-1', payload: { keywords: ['显示器'], blacklistKeywords: [] } },
    profile: { id: 'camoufox-profile' },
    artifactStore: snapshotStore
  })
  assert.equal(realMarket.status, 'succeeded')
  assert.equal(realMarket.price, 180)
  assert.equal(realMarket.raw.provider, 'camoufox')
  assert.ok(realMarket.snapshotPath)
  assert.equal((await snapshotStore.read(realMarket.snapshotPath)).content.toString().includes('显示器'), true)

  const sellerFixture = {
    evidence: {
      firstPageExpected: { active: 2, sold: 1 },
      expectedTrusted: { active: true, sold: true },
      itemIds: { active: ['a', 'b'], sold: ['c'] }
    },
    items: [{ itemId: 'a', status: 'active' }, { itemId: 'b', status: 'active' }, { itemId: 'c', status: 'sold' }]
  }
  const seller = await runSellerJob({
    provider: fixtureProvider({ market: {}, seller: sellerFixture }),
    job: { id: 'seller-1', payload: { sellerUrl: 'https://www.goofish.com/shop/fixture' } },
    profile: { id: 'fixture-profile' }
  })
  assert.equal(seller.status, 'completed')
  assert.equal(seller.reasonCode, 'COMPLETE_EVIDENCE')

  const realSeller = await runSellerJob({
    provider: realSellerProvider(),
    job: { id: 'seller-real-1', payload: { sellerUrl: 'https://www.goofish.com/personal?userId=real-seller', sellerName: '掩码卖家' } },
    profile: { id: 'camoufox-profile' },
    artifactStore: snapshotStore
  })
  assert.equal(realSeller.status, 'completed')
  assert.equal(realSeller.sellerName, '真实卖家')
  assert.deepEqual(realSeller.counts, { active: 1, sold: 1 })
  assert.equal(realSeller.items.length, 2)
  assert.ok(realSeller.snapshotPath)
  assert.equal(applySellerControl({ status: 'running' }, 'pause').status, 'paused')
  assert.equal(applySellerControl({ status: 'paused' }, 'resume').status, 'running')
  assert.equal(applySellerControl({ status: 'running' }, 'stop').status, 'cancelled')

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-artifacts-'))
  const artifacts = createArtifactStore({ root: tempDir, maxBytes: 1024 })
  assert.equal(safeArtifactName('../../secrets.txt'), 'secrets.txt')
  const metadata = await artifacts.put({ name: '../../snapshot.json', content: Buffer.from('{"ok":true}'), mimeType: 'application/json', jobId: 'market-1' })
  const read = await artifacts.read(metadata.id)
  assert.equal(read.content.toString(), '{"ok":true}')
  await assert.rejects(() => artifacts.put({ name: 'too-large.bin', content: Buffer.alloc(1025) }), error => error.code === 'artifact_too_large')
  await assert.rejects(() => artifacts.get('../secrets'), error => error.code === 'artifact_not_found')
  const apiDb = createDatabase()
  const apiAuth = createAuthService({ db: apiDb })
  apiAuth.createUser({ username: 'uploader', password: 'DEMO_ONLY_REDACTED', role: 'operator' })
  const api = buildHttpApp({ db: apiDb, auth: apiAuth, config: { provider: 'fake', dataDir: tempDir } })
  await api.fastify.ready()
  const login = await api.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'uploader', password: 'DEMO_ONLY_REDACTED' } })
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const boundary = '----xianyu-boundary'
  const multipartBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="h5.txt"\r\nContent-Type: text/plain\r\n\r\nH5 upload\r\n--${boundary}--\r\n`
  const uploaded = await api.fastify.inject({ method: 'POST', url: '/artifacts', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartBody })
  assert.equal(uploaded.statusCode, 201)
  const downloaded = await api.fastify.inject({ method: 'GET', url: `/artifacts/${uploaded.json().artifact.id}`, headers: { cookie } })
  assert.equal(downloaded.statusCode, 200)
  assert.equal(downloaded.body, 'H5 upload')
  const listed = await api.fastify.inject({ method: 'GET', url: '/artifacts', headers: { cookie } })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().artifacts.some(item => item.id === uploaded.json().artifact.id), true)
  await api.fastify.close()
  apiDb.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(snapshotDir, { recursive: true, force: true })
  console.log('server-business-regression: PASS (market/seller/artifacts)')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
