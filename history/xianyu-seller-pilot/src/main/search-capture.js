// 通过 Chromium DevTools Protocol 读取闲鱼搜索接口响应。
// GitHub 上的实现监听 mtop/pc.search 请求；这里不依赖页面脚本注入，兼容 Electron 31。
const SEARCH_API_MARKERS = ['mtop.taobao.idlemtopsearch', 'idlemtopsearch', 'pc.search']
const searchCaptureStates = new WeakMap()

function parseSearchPayload(text) {
  if (!text || typeof text !== 'string') return null
  try { return JSON.parse(text) } catch {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}

function isSearchApiUrl(url) {
  const value = String(url || '')
  return SEARCH_API_MARKERS.some((marker) => value.includes(marker))
}

function recordSearchPayload(state, url, body) {
  const requestUrl = String(url || '')
  if (!isSearchApiUrl(requestUrl)) return
  const text = body?.base64Encoded
    ? Buffer.from(String(body.body || ''), 'base64').toString('utf8')
    : String(body?.body || body || '')
  const payload = parseSearchPayload(text)
  if (!payload) return
  state.payloads.push({ url: requestUrl, payload, at: Date.now() })
  if (state.payloads.length > 12) state.payloads.splice(0, state.payloads.length - 12)
}

export function installSearchCapture(webContents) {
  if (!webContents?.debugger || searchCaptureStates.has(webContents)) return
  const protocol = webContents.debugger
  const state = { payloads: [], requests: new Map(), attachedHere: false }
  const onMessage = async (_event, method, params = {}) => {
    if (method === 'Network.requestWillBeSent' && isSearchApiUrl(params.request?.url)) {
      state.requests.set(params.requestId, params.request.url)
      return
    }
    if (method === 'Network.responseReceived' && isSearchApiUrl(params.response?.url)) {
      state.requests.set(params.requestId, params.response.url)
      return
    }
    if (method !== 'Network.loadingFinished' || !state.requests.has(params.requestId)) return
    const requestUrl = state.requests.get(params.requestId)
    state.requests.delete(params.requestId)
    try {
      const body = await protocol.sendCommand('Network.getResponseBody', { requestId: params.requestId })
      recordSearchPayload(state, requestUrl, body)
    } catch {
      // 某些缓存/跨进程响应无法通过 CDP 取 body，DOM 兜底逻辑仍会继续工作。
    }
  }
  protocol.on('message', onMessage)
  try {
    if (!protocol.isAttached()) {
      protocol.attach('1.3')
      state.attachedHere = true
    }
    protocol.sendCommand('Network.enable').catch(() => {})
  } catch {
    protocol.removeListener('message', onMessage)
  }
  searchCaptureStates.set(webContents, state)
  webContents.once('destroyed', () => {
    protocol.removeListener('message', onMessage)
    if (state.attachedHere && protocol.isAttached()) {
      try { protocol.detach() } catch {}
    }
    searchCaptureStates.delete(webContents)
  })
}

export function readCapturedSearchPayloads(webContents) {
  const state = searchCaptureStates.get(webContents)
  if (!state) return []
  return state.payloads.slice()
}

export function clearCapturedSearchPayloads(webContents) {
  const state = searchCaptureStates.get(webContents)
  if (!state) return
  state.payloads.length = 0
  state.requests.clear()
}
