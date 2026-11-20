// 开环境时窗口不够宽就最大化（2026-10-06 现场：视口 824 宽，闲鱼发布页排不开，
// 执行端点「发布」点不动，用户看着像「移动端的样式」）。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MIN_ENV_WINDOW_WIDTH, startEnv, widenEnvWindow } from '../../src/main/adspower.js'

function fakeBrowser({ width = 840, windowState = 'normal', pagesAfter = 0, hang = false } = {}) {
  const sent = []
  let polls = 0
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
      sent.push(message.method)
      if (hang && message.method === 'Browser.getWindowForTarget') return // 浏览器卡住：永不回包
      let result = {}
      if (message.method === 'Target.getTargets') {
        polls += 1
        result = { targetInfos: polls > pagesAfter ? [{ targetId: 'T1', type: 'page', url: 'https://www.goofish.com/' }] : [] }
      } else if (message.method === 'Browser.getWindowForTarget') {
        result = { windowId: 7, bounds: { left: 0, top: 0, width, height: 900, windowState } }
      }
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result })))
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      this.emit('close')
    }
  }
  const fetchImpl = async (url) => {
    if (url.endsWith('/json/version')) return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://browser' }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }
  return { sent, FakeWebSocket, fetchImpl }
}

const noSleep = async () => {}

// 1. 窄窗（现场 824 视口 ≈ 840 窗宽）：最大化
{
  const b = fakeBrowser({ width: 840 })
  const r = await widenEnvWindow(9001, { fetchImpl: b.fetchImpl, WebSocketImpl: b.FakeWebSocket, sleep: noSleep })
  assert.deepEqual(r, { widened: true, from: 840 })
  assert.deepEqual(b.sent, ['Target.getTargets', 'Browser.getWindowForTarget', 'Browser.setWindowBounds'])
}

// 2. 够宽：不动（人调成别的大小，排得开就不抢）
{
  const b = fakeBrowser({ width: MIN_ENV_WINDOW_WIDTH + 200 })
  const r = await widenEnvWindow(9001, { fetchImpl: b.fetchImpl, WebSocketImpl: b.FakeWebSocket, sleep: noSleep })
  assert.equal(r.widened, false)
  assert.ok(!b.sent.includes('Browser.setWindowBounds'))
}

// 3. 已最大化 / 被人最小化：都不碰
for (const windowState of ['maximized', 'minimized']) {
  const b = fakeBrowser({ width: 600, windowState })
  const r = await widenEnvWindow(9001, { fetchImpl: b.fetchImpl, WebSocketImpl: b.FakeWebSocket, sleep: noSleep })
  assert.deepEqual(r, { widened: false, state: windowState })
  assert.ok(!b.sent.includes('Browser.setWindowBounds'), windowState)
}

// 4. 刚开浏览器、页面还没建出来：等它几轮
{
  const b = fakeBrowser({ width: 700, pagesAfter: 2 })
  const r = await widenEnvWindow(9001, { fetchImpl: b.fetchImpl, WebSocketImpl: b.FakeWebSocket, sleep: noSleep })
  assert.equal(r.widened, true)
  assert.equal(b.sent.filter((m) => m === 'Target.getTargets').length, 3)
}

// 5. 浏览器卡住不回包：到点放弃，不把「启动执行端」挂死
{
  const b = fakeBrowser({ hang: true })
  const started = Date.now()
  await assert.rejects(widenEnvWindow(9001, { fetchImpl: b.fetchImpl, WebSocketImpl: b.FakeWebSocket, sleep: noSleep, timeoutMs: 100 }))
  assert.ok(Date.now() - started < 2000)
}

// 6. startEnv：开完就放大；放大失败也照样返回「开了」
{
  const b = fakeBrowser({ width: 840 })
  const apiClient = { fetchImpl: b.fetchImpl, open: async (id) => ({ ws: { puppeteer: 'ws://browser' }, debug_port: '9001', user: id }) }
  const opened = await startEnv('k1env', { apiClient, WebSocketImpl: b.FakeWebSocket })
  assert.equal(opened.user, 'k1env')
  assert.ok(b.sent.includes('Browser.setWindowBounds'))

  const broken = { fetchImpl: async () => { throw new Error('connect ECONNREFUSED') }, open: async () => ({ debug_port: '9001' }) }
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.deepEqual(await startEnv('k1env', { apiClient: broken, WebSocketImpl: b.FakeWebSocket }), { debug_port: '9001' })
  } finally {
    console.warn = warn
  }
}

console.log('adspower-env-window-regression: PASS')
