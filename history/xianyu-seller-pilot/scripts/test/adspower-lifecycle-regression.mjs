import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AdsPowerApi, AdsPowerWebContents } from '../../src/main/adspower.js'

const sockets = []
const targets = new Map([
  ['worker-target', { id: 'worker-target', type: 'page', url: 'https://www.goofish.com/', webSocketDebuggerUrl: 'ws://target/worker', name: '' }]
])
let created = 0
const closedTargets = []
let hideCreatedTarget = false
let closeDuringCreateResponse = null
let closeDuringBrowserConnect = null

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  constructor(url) {
    super()
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    sockets.push(this)
    closeDuringBrowserConnect?.(url)
    queueMicrotask(() => this.emit('open'))
  }
  send(raw, callback) {
    const message = JSON.parse(raw)
    const result = (value) => queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result: value })))
    if (message.method === 'Target.createTarget') {
      const id = `owned-target-${++created}`
      targets.set(id, { id, type: 'page', url: message.params.url, webSocketDebuggerUrl: `ws://target/${id}`, name: '' })
      closeDuringCreateResponse?.()
      result({ targetId: id })
    } else if (message.method === 'Target.closeTarget') {
      closedTargets.push(String(message.params.targetId))
      targets.delete(String(message.params.targetId))
      result({ success: true })
    } else if (message.method === 'Page.navigate') {
      const target = [...targets.values()].find((entry) => entry.webSocketDebuggerUrl === this.url)
      if (target) {
        target.url = String(message.params.url)
        const observedUrl = target.url.includes('seller-2') ? 'https://www.goofish.com/' : target.url
        queueMicrotask(() => this.emit('message', JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: observedUrl } } })))
        queueMicrotask(() => this.emit('message', JSON.stringify({ method: 'Page.loadEventFired', params: {} })))
      }
      result({})
    } else if (message.method === 'Runtime.evaluate') {
      const target = [...targets.values()].find((entry) => entry.webSocketDebuggerUrl === this.url)
      const expression = String(message.params?.expression || '')
      let value = target?.name || ''
      const assigned = expression.match(/window\.name\s*=\s*("(?:[^"\\]|\\.)*")/)
      if (assigned && target) {
        try { target.name = JSON.parse(assigned[1]) } catch { /* invalid fixture expression */ }
        value = target.name
      }
      result({ result: { value } })
    } else {
      result({ result: { value: true } })
    }
    callback?.()
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

const fetchImpl = async (url) => {
  if (url.includes('/api/v1/browser/local-active')) return new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 })
  if (url.includes('/api/v1/browser/start')) return new Response(JSON.stringify({ code: 0, data: { debug_port: '9001', ws: { puppeteer: 'ws://browser/version' } } }), { status: 200 })
  if (url.endsWith('/json/list')) {
    const visible = hideCreatedTarget
      ? [...targets.values()].filter((entry) => entry.id === 'worker-target' || entry.id === 'owned-target-2')
      : [...targets.values()]
    return new Response(JSON.stringify(visible), { status: 200 })
  }
  if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://browser/version' }), { status: 200 })
  throw new Error(`unexpected fetch ${url}`)
}

const api = new AdsPowerApi({ baseUrl: 'http://fake', fetchImpl, minIntervalMs: 0 })
const account = { id: 'account-1', browserProvider: 'adspower', adsPowerId: 'profile-1' }
const seller = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
const preview = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'preview', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })

let queuedDebuggerMessage = null
seller.debugger.on('message', (_event, method) => { queuedDebuggerMessage = method })
await Promise.all([seller.ensureConnected(), preview.ensureConnected()])
assert.notEqual(seller.targetId, preview.targetId, 'seller and preview must own separate targets')
assert.equal(seller.ownedTarget, true)
assert.equal(preview.ownedTarget, true)
assert.match(targets.get(seller.targetId)?.url || '', /^about:blank#xianyu-seller-pilot-target-v1-seller$/, 'seller target starts neutral and carries a durable purpose marker')
assert.match(targets.get(preview.targetId)?.url || '', /^about:blank#xianyu-seller-pilot-target-v1-preview$/, 'preview target starts neutral and carries a durable purpose marker')
await new Promise((resolve) => setTimeout(resolve, 10))
const sellerSocket = seller.session.socket
sellerSocket.emit('message', JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }))
await new Promise((resolve) => setImmediate(resolve))
assert.equal(queuedDebuggerMessage, 'Runtime.consoleAPICalled', 'listener registered before connect must be delivered')

await seller.loadURL('https://www.goofish.com/personal?userId=seller-1')
assert.equal(seller.getNavigationState().status, 'ready')
assert.equal(seller.getURL(), 'https://www.goofish.com/personal?userId=seller-1')
await assert.rejects(seller.loadURL('https://www.goofish.com/personal?userId=seller-2'), /URL mismatch/)

// Simulate the Electron process losing its in-memory adapter while the
// AdsPower profile and its tab remain alive. Goofish may overwrite
// window.name with its own storage key; the URL marker must still find the
// same target without another Target.createTarget call.
const createdBeforeRestart = created
targets.get(seller.targetId).name = 'nameStorage:?wm_referrer=https%3A%2F%2Fwww.goofish.com%2F'
targets.set('legacy-seller-tab', {
  id: 'legacy-seller-tab',
  type: 'page',
  url: 'https://www.goofish.com/personal?userId=legacy-seller',
  webSocketDebuggerUrl: 'ws://target/legacy-seller-tab',
  name: ''
})
const restartedSeller = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
await restartedSeller.ensureConnected()
assert.equal(restartedSeller.targetId, seller.targetId, 'seller target is reused by durable purpose marker after adapter restart')
assert.equal(created, createdBeforeRestart, 'reconnecting a seller adapter does not create another target')
assert.equal(targets.has('legacy-seller-tab'), false, 'reconnect reclaims unmarked legacy seller tabs instead of leaving a tab per seller')

const timeout = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: class extends FakeWebSocket {
  send(raw, callback) {
    const message = JSON.parse(raw)
    if (message.method === 'Page.navigate') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: message.params.url } } })))
      callback?.()
      return
    }
    super.send(raw, callback)
  }
}, pageTimeoutMs: 10 })
await timeout.ensureConnected()
await assert.rejects(timeout.loadURL('https://www.goofish.com/personal?userId=late'), /timed out/)
assert.equal(timeout.getNavigationState().status, 'failed')
assert.equal(timeout.getNavigationState().reason, 'timeout')

const previewTarget = preview.targetId
await restartedSeller.close()
assert.ok(targets.has(previewTarget), 'recycling seller must leave preview target alive')
await preview.close()
await timeout.close()
assert.ok(closedTargets.length > 0, 'owned target close is awaited before adapter close resolves')

// If the post-create /json/list lookup fails, the just-created target must be
// closed instead of becoming an orphan page.
hideCreatedTarget = true
const orphanAttempt = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
const createdBeforeOrphan = created
await assert.rejects(orphanAttempt.ensureConnected(), /created target is not available|target lookup failed/)
assert.ok(closedTargets.includes(`owned-target-${createdBeforeOrphan}`), 'failed target lookup closes the orphan target')
assert.equal(targets.has(`owned-target-${createdBeforeOrphan}`), false, 'orphan target is removed from AdsPower target list')

// close() can be triggered by the CDP create response before createTarget()
// has copied targetId onto the adapter.  That early close still has to leave
// enough local state for createTarget's finally block to close the page.
const preAssignmentBaseline = created
const preAssignment = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
closeDuringCreateResponse = () => { void preAssignment.close() }
await assert.rejects(preAssignment.ensureConnected(), /destroyed/)
closeDuringCreateResponse = null
assert.equal(preAssignment.connected, false, 'an adapter closed from the create response never becomes connected')
assert.ok(closedTargets.includes(`owned-target-${preAssignmentBaseline + 1}`), 'close during create response closes the newly created target')
assert.equal(targets.has(`owned-target-${preAssignmentBaseline + 1}`), false, 'close during create response leaves no orphan target')

// The same ordering hole exists when recovering an already marker-owned
// target: close can run while the browser-level CDP connection is opening,
// before the local adapter stores browserSession. That target must still be
// closed using the session that finishes connecting.
hideCreatedTarget = false
const durableTargetId = 'durable-race-target'
targets.set(durableTargetId, {
  id: durableTargetId,
  type: 'page',
  url: 'about:blank',
  webSocketDebuggerUrl: 'ws://target/durable-race-target',
  name: 'xianyu-seller-pilot:target:v1:profile-1:seller'
})
const durableRace = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
closeDuringBrowserConnect = (url) => {
  if (url !== 'ws://browser/version') return
  closeDuringBrowserConnect = null
  void durableRace.close()
}
await assert.rejects(durableRace.ensureConnected(), /destroyed/)
assert.equal(durableRace.connected, false, 'a reused target closed during browser connect never becomes connected')
assert.ok(closedTargets.includes(durableTargetId), 'a reused target closed during browser connect is explicitly released')
assert.equal(targets.has(durableTargetId), false, 'a reused target closed during browser connect is not left behind')

// Closing an adapter while its post-create target lookup is in flight must
// reject ensureConnected, never publish connected=true, and close the target
// that was created before the close became observable.
const raceBaseline = created
let releaseRaceList
const raceListGate = new Promise((resolve) => { releaseRaceList = resolve })
let raceListBlocked = false
const raceFetch = async (url) => {
  if (url.endsWith('/json/list') && created > raceBaseline && !raceListBlocked) {
    raceListBlocked = true
    await raceListGate
  }
  return fetchImpl(url)
}
const race = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'SELLER', fetchImpl: raceFetch, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
const raceEnsure = race.ensureConnected()
while (!raceListBlocked) await new Promise((resolve) => setImmediate(resolve))
await race.close()
releaseRaceList()
await assert.rejects(raceEnsure, /destroyed/)
assert.equal(race.connected, false, 'an adapter closed during ensure never becomes connected')
assert.ok(closedTargets.includes(`owned-target-${raceBaseline + 1}`), 'a target created during a racing ensure is closed')
assert.equal(targets.has(`owned-target-${raceBaseline + 1}`), false, 'the racing target is not left as an orphan page')

console.log(JSON.stringify({ ok: true, checks: 22, purposeIsolation: true, purposeNormalization: true, listenerBuffer: true, timeoutFailClosed: true, durableReuse: true, orphanCleanup: true, closeDuringCreateResponse: true, closeDuringReuseConnect: true, closeDuringEnsure: true }))
