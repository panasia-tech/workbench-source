import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AdsPowerApi, AdsPowerWebContents } from '../../src/main/adspower.js'

const targets = new Map([
  ['existing-target', { id: 'existing-target', type: 'page', url: 'https://local.adspower.net/', webSocketDebuggerUrl: 'ws://target/existing-target', name: '' }]
])
let nextTarget = 0
let lastBounds = null

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  constructor(url) {
    super()
    this.url = url
    this.readyState = FakeWebSocket.OPEN
    queueMicrotask(() => this.emit('open'))
  }
  send(raw) {
    const message = JSON.parse(raw)
    let result = {}
    if (message.method === 'Target.createTarget') {
      const id = `seller-target-${++nextTarget}`
      targets.set(id, { id, type: 'page', url: message.params.url, webSocketDebuggerUrl: `ws://target/${id}`, name: '' })
      result = { targetId: id }
    } else if (message.method === 'Target.closeTarget') {
      targets.delete(String(message.params.targetId))
      result = { success: true }
    } else if (message.method === 'Runtime.evaluate') {
      const target = [...targets.values()].find((entry) => entry.webSocketDebuggerUrl === this.url)
      const expression = String(message.params?.expression || '')
      const assigned = expression.match(/window\.name\s*=\s*("(?:[^"\\]|\\.)*")/)
      if (assigned && target) target.name = JSON.parse(assigned[1])
      result = { result: { value: target?.name || '' } }
    } else if (message.method === 'Browser.getWindowForTarget') {
      result = { windowId: 7 }
    } else if (message.method === 'Browser.getWindowBounds') {
      result = { bounds: { left: 0, top: 0, width: 1280, height: 720 } }
    } else if (message.method === 'Browser.setWindowBounds') {
      lastBounds = message.params
      result = {}
    } else {
      result = {}
    }
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result })))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

const fetchImpl = async (url) => {
  if (url.includes('/api/v1/browser/local-active')) return new Response(JSON.stringify({ code: 0, data: { list: [{ user_id: 'profile-1', debug_port: 9001, ws: { puppeteer: 'ws://browser' } }] } }), { status: 200 })
  if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://browser' }), { status: 200 })
  if (url.endsWith('/json/list')) return new Response(JSON.stringify([...targets.values()]), { status: 200 })
  throw new Error(`unexpected fetch ${url}`)
}

// AdsPower has no display endpoint; the adapter asks the host (Electron) for
// the screen layout instead, so the fake stands in for that, not for fetch.
const displaysImpl = async () => ([
  { bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 30, width: 1280, height: 690 } },
  { bounds: { x: 1280, y: 0, width: 1280, height: 720 }, workArea: { x: 1280, y: 30, width: 1280, height: 690 } }
])
const api = new AdsPowerApi({ baseUrl: 'http://fake', fetchImpl, minIntervalMs: 0, displaysImpl })
const contents = new AdsPowerWebContents({ api, profileId: 'profile-1', purpose: 'seller', fetchImpl, WebSocketImpl: FakeWebSocket, pageTimeoutMs: 50 })
await contents.ensureConnected()
assert.deepEqual(lastBounds, {
  windowId: 7,
  bounds: { left: 1280, top: 30, width: 1280, height: 690, windowState: 'normal' }
})
await contents.close()
console.log('adspower-display-regression: PASS (secondary display placement)')
