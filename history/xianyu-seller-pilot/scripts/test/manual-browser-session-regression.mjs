import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDatabase } = require('../../server/db/database.js')
const { createAuthService } = require('../../server/auth/auth-service.js')
const { buildHttpApp } = require('../../server/http/app.js')
const { createManualSessionManager } = require('../../server/browser/manual-session-manager.js')

function createManualProvider(calls) {
  const sessions = new Map()
  return {
    name: 'camoufox',
    capabilities: { manualControl: true, screenshot: true, accessibilitySnapshot: true, remoteView: false },
    async health() { return { ok: true, provider: 'camoufox' } },
    async openSession(profile) { calls.push(['open', profile]); const session = { sessionId: `provider-${sessions.size + 1}`, profileId: profile.id }; sessions.set(session.sessionId, session); return session },
    async getPage(session) { return { sessionId: session.sessionId, url: 'about:blank' } },
    async navigate(page, url) { calls.push(['navigate', url]); page.url = url; return { ok: true, url } },
    async evaluate() { return {} },
    async snapshot(page) { calls.push(['snapshot', page.url]); return '- textbox "账号" [ref=e1]\n- button "登录" [ref=e2]' },
    async screenshot() { calls.push(['screenshot']); return { mimeType: 'image/png', base64: 'aGVsbG8=' } },
    async manualAction(_page, action) { calls.push(['action', action]); return { ok: true, action: action.type } },
    async closeSession(session) { calls.push(['close', session.sessionId]); sessions.delete(session.sessionId); return { ok: true } }
  }
}

async function main() {
  const root = '/Volumes/Data/Codex-External/xianyu-manual-browser-regression'
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const db = createDatabase({ filename: path.join(root, 'server.sqlite') })
  const auth = createAuthService({ db })
  const admin = auth.createUser({ username: 'manual-admin', password: 'DEMO_ONLY_REDACTED', role: 'admin' })
  const readOnly = auth.createUser({ username: 'manual-reader', password: 'DEMO_ONLY_REDACTED', role: 'read_only' })
  db.upsertBrowserProfile({ id: 'manual-p1', provider: 'camoufox', vendorProfileId: 'vendor-p1', label: '人工登录 1', createdBy: admin.id })
  db.upsertBrowserProfile({ id: 'manual-p2', provider: 'camoufox', vendorProfileId: 'vendor-p2', label: '人工登录 2', createdBy: admin.id })
  const calls = []
  const provider = createManualProvider(calls)
  const manualSessions = createManualSessionManager({ provider, db, ttlMs: 120_000 })
  const app = buildHttpApp({ db, auth, provider, manualSessions, config: { provider: 'camoufox', dataDir: root } })
  await app.fastify.ready()
  const login = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'manual-admin', password: 'DEMO_ONLY_REDACTED' } })
  assert.equal(login.statusCode, 200)
  const cookie = String(login.headers['set-cookie']).split(';')[0]
  const readerLogin = await app.fastify.inject({ method: 'POST', url: '/auth/login', payload: { username: 'manual-reader', password: 'DEMO_ONLY_REDACTED' } })
  const readerCookie = String(readerLogin.headers['set-cookie']).split(';')[0]

  const opened = await app.fastify.inject({ method: 'POST', url: '/profiles/manual-p1/manual-session', headers: { cookie }, payload: { url: 'https://login.goofish.com/' } })
  assert.equal(opened.statusCode, 201)
  assert.equal(opened.json().session.profileId, 'manual-p1')
  assert.equal(opened.json().screenshot.base64, 'aGVsbG8=')
  assert.match(opened.json().snapshot, /ref=e1/)
  const sessionId = opened.json().session.sessionId
  assert.equal(calls.some(([type, url]) => type === 'navigate' && url === 'https://login.goofish.com/'), true)

  const fetched = await app.fastify.inject({ method: 'GET', url: '/profiles/manual-p1/manual-session', headers: { cookie } })
  assert.equal(fetched.statusCode, 200)
  assert.equal(fetched.json().session.sessionId, sessionId)
  const action = await app.fastify.inject({ method: 'POST', url: '/profiles/manual-p1/manual-session/action', headers: { cookie }, payload: { sessionId, type: 'click', ref: '@e2' } })
  assert.equal(action.statusCode, 200)
  assert.equal(calls.some(([type, value]) => type === 'action' && value.type === 'click' && value.ref === '@e2'), true)
  const invalid = await app.fastify.inject({ method: 'POST', url: '/profiles/manual-p1/manual-session/action', headers: { cookie }, payload: { sessionId, type: 'click', ref: 'e1' } })
  assert.equal(invalid.statusCode, 400)
  const denied = await app.fastify.inject({ method: 'POST', url: '/profiles/manual-p1/manual-session/action', headers: { cookie: readerCookie }, payload: { sessionId, type: 'click', ref: '@e2' } })
  assert.equal(denied.statusCode, 403)

  db.createJob({ id: 'busy-job', type: 'market_snapshot', profileId: 'manual-p2', payload: {} })
  const busy = await app.fastify.inject({ method: 'POST', url: '/profiles/manual-p2/manual-session', headers: { cookie }, payload: {} })
  assert.equal(busy.statusCode, 409)
  assert.equal(busy.json().error.code, 'profile_busy')
  db.cancelJob({ jobId: 'busy-job', actorId: admin.id })
  const overlap = db.createJob({ id: 'manual-worker-overlap', type: 'market_snapshot', profileId: 'manual-p1', payload: {} })
  const overlapToken = 'DEMO_ONLY_REDACTED'
  const blockedClaim = db.claimJob({ workerId: 'manual-worker', leaseToken: overlapToken, profileLockOwner: 'worker:manual-worker:1' })
  assert.equal(blockedClaim, null)
  const closed = await app.fastify.inject({ method: 'DELETE', url: '/profiles/manual-p1/manual-session', headers: { cookie }, payload: { sessionId } })
  assert.equal(closed.statusCode, 200)
  const claimAfterClose = db.claimJob({ workerId: 'manual-worker', leaseToken: overlapToken, profileLockOwner: 'worker:manual-worker:1' })
  assert.equal(claimAfterClose.id, overlap.id)
  db.failJob({ jobId: overlap.id, workerId: 'manual-worker', leaseToken: overlapToken, errorCode: 'fixture_cleanup', errorMessage: 'fixture cleanup' })
  db.releaseBrowserProfileLock({ profileId: 'manual-p1', ownerId: 'worker:manual-worker:1' })
  assert.equal((await app.fastify.inject({ method: 'GET', url: '/manual-sessions', headers: { cookie } })).json().sessions.length, 0)
  const audits = db.raw.prepare("SELECT action FROM audit_log WHERE action LIKE 'manual.session.%' ORDER BY created_at").all().map(row => row.action)
  assert.deepEqual(audits, ['manual.session.open', 'manual.session.action', 'manual.session.close'])
  await app.fastify.close(); db.close(); fs.rmSync(root, { recursive: true, force: true })
  console.log('manual-browser-session-regression: PASS (H5 screenshot + snapshot + controlled actions + profile lock)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
