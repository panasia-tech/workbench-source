import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AdsPowerApi, hasAuthenticatedAdsPowerSession } from '../../src/main/adspower.js'

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
    if (message.method !== 'Runtime.evaluate') return
    const body = this.url.includes('logged-in') ? '订单\n宝贝\n关注' : '请先登录'
    queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result: { result: { value: body } } })))
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
}

const fetchImpl = async (url, options = {}) => {
  if (url.includes('/api/v1/browser/local-active')) {
    return new Response(JSON.stringify({ code: 0, data: { list: [
      { user_id: 'profile-logged-in', debug_port: '59001', ws: { puppeteer: 'ws://logged-in' } },
      { user_id: 'profile-console-only', debug_port: '59002', ws: { puppeteer: 'ws://console' } }
    ] } }), { status: 200 })
  }
  if (url.endsWith('/json/list')) {
    if (url.includes(':59001')) return new Response(JSON.stringify([{
      type: 'page',
      url: 'https://www.goofish.com/personal?userId=ready',
      webSocketDebuggerUrl: 'ws://logged-in'
    }]), { status: 200 })
    if (url.includes(':59002')) return new Response(JSON.stringify([{
      type: 'page',
      url: 'https://local.adspower.net/?id=profile-console-only',
      webSocketDebuggerUrl: 'ws://console'
    }]), { status: 200 })
  }
  throw new Error(`unexpected fetch ${url} ${options.method || 'GET'}`)
}

const api = new AdsPowerApi({ baseUrl: 'http://fake', fetchImpl, minIntervalMs: 0 })
assert.equal(await hasAuthenticatedAdsPowerSession(
  { browserProvider: 'adspower', adsPowerId: 'profile-logged-in' },
  { apiClient: api, WebSocketImpl: FakeWebSocket }
), true)
assert.equal(await hasAuthenticatedAdsPowerSession(
  { browserProvider: 'adspower', adsPowerId: 'profile-console-only' },
  { apiClient: api, WebSocketImpl: FakeWebSocket }
), false, 'a profile with only the AdsPower console must not open a Goofish/login tab')
assert.equal(await hasAuthenticatedAdsPowerSession(
  { browserProvider: 'adspower', adsPowerId: 'profile-not-open' },
  { apiClient: api, WebSocketImpl: FakeWebSocket }
), false)

console.log('adspower-auth-probe-regression: PASS')
