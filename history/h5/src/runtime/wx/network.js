import { normalizeErr } from '../util.js'
import { resolveTempFile, registerTempFile } from './media.js'

// wx.request / uploadFile / downloadFile / connectSocket
// 回调语义照小程序：只要服务器有响应就走 success（4xx/5xx 也是），只有网络层失败才走 fail。

const UPLOAD_LIMIT = 50 * 1024 * 1024 // 服务端 nginx client_max_body_size 50m

function appendQuery(url, data) {
  if (data == null || typeof data !== 'object') return url
  const parts = []
  for (const key of Object.keys(data)) {
    const v = data[key]
    if (v === undefined || v === null) continue
    const text = typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : String(v)
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`)
  }
  if (!parts.length) return url
  return url + (url.includes('?') ? '&' : '?') + parts.join('&')
}

function headerValue(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

function finish(options, ok, res) {
  try {
    if (ok && options.success) options.success(res)
    if (!ok && options.fail) options.fail(res)
    if (options.complete) options.complete(res)
  } catch (e) {
    console.error(e)
  }
}

export function request(options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const headers = { ...(options.header || {}) }
  let url = String(options.url || '')
  let body
  const data = options.data
  if (method === 'GET' || method === 'HEAD') {
    if (typeof data === 'string' && data) url += (url.includes('?') ? '&' : '?') + data
    else url = appendQuery(url, data)
  } else if (data !== undefined && data !== null) {
    const ct = String(headerValue(headers, 'content-type') || 'application/json')
    if (typeof data === 'string' || data instanceof ArrayBuffer) body = data
    else if (/x-www-form-urlencoded/i.test(ct)) body = appendQuery('', data).replace(/^\?/, '')
    else body = JSON.stringify(data)
    if (!headerValue(headers, 'content-type')) headers['Content-Type'] = 'application/json'
  }
  const controller = new AbortController()
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 60000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)

  const run = async () => {
    try {
      const resp = await fetch(url, { method, headers, body, signal: controller.signal })
      let payload
      if (options.responseType === 'arraybuffer') payload = await resp.arrayBuffer()
      else {
        payload = await resp.text()
        if ((options.dataType || 'json') === 'json') {
          try { payload = JSON.parse(payload) } catch { /* 不是 JSON 就原样返回字符串 */ }
        }
      }
      const header = {}
      resp.headers.forEach((v, k) => { header[k] = v })
      const res = { data: payload, statusCode: resp.status, header, cookies: [], errMsg: 'request:ok' }
      finish(options, true, res)
      return res
    } catch (e) {
      const res = { errMsg: `request:fail ${timedOut ? 'timeout' : (e && e.name === 'AbortError' ? 'abort' : (e && e.message) || 'network error')}` }
      finish(options, false, res)
      throw res
    } finally {
      clearTimeout(timer)
    }
  }
  const p = run()
  const hasCb = options.success || options.fail || options.complete
  if (hasCb) p.catch(() => {})
  const task = {
    abort() { controller.abort() },
    onHeadersReceived() {},
    offHeadersReceived() {},
    onChunkReceived() {},
    offChunkReceived() {},
  }
  if (!hasCb) {
    // 无回调时返回 Promise，同时保留 abort
    return Object.assign(p, task)
  }
  return task
}

export function uploadFile(options = {}) {
  const xhr = new XMLHttpRequest()
  const progressCbs = []
  const task = {
    abort() { xhr.abort() },
    onProgressUpdate(cb) { progressCbs.push(cb) },
    offProgressUpdate(cb) { const i = progressCbs.indexOf(cb); if (i >= 0) progressCbs.splice(i, 1) },
    onHeadersReceived() {},
    offHeadersReceived() {},
  }
  const p = (async () => {
    const file = await resolveTempFile(options.filePath)
    if (!file) throw { errMsg: 'uploadFile:fail file not found' }
    if (file.size > UPLOAD_LIMIT) {
      // 照服务器的样子回一个 413，页面里 err.detail 能直接弹出来
      return {
        statusCode: 413,
        data: JSON.stringify({ detail: `文件 ${(file.size / 1048576).toFixed(0)}MB，超过 50MB 传不上去，请剪短或压缩后再传` }),
        errMsg: 'uploadFile:ok',
      }
    }
    const fd = new FormData()
    for (const [k, v] of Object.entries(options.formData || {})) fd.append(k, v == null ? '' : String(v))
    fd.append(options.name || 'file', file, file.name || 'file')
    return new Promise((resolve, reject) => {
      xhr.open('POST', options.url)
      for (const [k, v] of Object.entries(options.header || {})) {
        if (k.toLowerCase() !== 'content-type') xhr.setRequestHeader(k, v)
      }
      xhr.timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 120000
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const res = { progress: Math.round((e.loaded / e.total) * 100), totalBytesSent: e.loaded, totalBytesExpectedToSend: e.total }
        for (const cb of progressCbs) cb(res)
      }
      xhr.onload = () => resolve({ data: xhr.responseText, statusCode: xhr.status, errMsg: 'uploadFile:ok' })
      xhr.onerror = () => reject({ errMsg: 'uploadFile:fail network error' })
      xhr.ontimeout = () => reject({ errMsg: 'uploadFile:fail timeout' })
      xhr.onabort = () => reject({ errMsg: 'uploadFile:fail abort' })
      xhr.send(fd)
    })
  })()
  p.then((res) => finish(options, true, res), (err) => finish(options, false, normalizeErr('uploadFile', err)))
  p.catch(() => {})
  return task
}

export function downloadFile(options = {}) {
  const controller = new AbortController()
  const p = (async () => {
    const resp = await fetch(options.url, { headers: options.header || {}, signal: controller.signal })
    const blob = await resp.blob()
    return { tempFilePath: registerTempFile(new File([blob], 'download', { type: blob.type })), statusCode: resp.status, errMsg: 'downloadFile:ok' }
  })()
  p.then((res) => finish(options, true, res), (err) => finish(options, false, normalizeErr('downloadFile', err)))
  p.catch(() => {})
  return { abort() { controller.abort() }, onProgressUpdate() {}, offProgressUpdate() {} }
}

function wsUrl(url) {
  const u = new URL(url, location.href)
  if (u.protocol === 'http:') u.protocol = 'ws:'
  if (u.protocol === 'https:') u.protocol = 'wss:'
  return u.toString()
}

export function connectSocket(options = {}) {
  const handlers = { open: [], message: [], error: [], close: [] }
  const emit = (type, payload) => {
    for (const cb of handlers[type]) {
      try { cb(payload) } catch (e) { console.error(e) }
    }
  }
  let ws
  try {
    ws = new WebSocket(wsUrl(options.url), options.protocols)
  } catch (e) {
    setTimeout(() => {
      emit('error', { errMsg: `connectSocket:fail ${e.message}` })
      emit('close', { code: 1006, reason: e.message })
    }, 0)
    finish(options, false, { errMsg: `connectSocket:fail ${e.message}` })
  }
  if (ws) {
    ws.onopen = () => emit('open', { header: {}, profile: {} })
    ws.onmessage = (e) => emit('message', { data: e.data })
    ws.onerror = () => emit('error', { errMsg: 'websocket error' })
    ws.onclose = (e) => emit('close', { code: e.code, reason: e.reason })
    setTimeout(() => finish(options, true, { errMsg: 'connectSocket:ok' }), 0)
  }
  return {
    onOpen(cb) { handlers.open.push(cb) },
    onMessage(cb) { handlers.message.push(cb) },
    onError(cb) { handlers.error.push(cb) },
    onClose(cb) { handlers.close.push(cb) },
    send(o = {}) {
      try {
        ws.send(o.data)
        finish(o, true, { errMsg: 'sendSocketMessage:ok' })
      } catch (e) {
        finish(o, false, { errMsg: `sendSocketMessage:fail ${e.message}` })
      }
    },
    close(o = {}) {
      try {
        if (ws) ws.close(o.code || 1000, o.reason || '')
        finish(o, true, { errMsg: 'closeSocket:ok' })
      } catch (e) {
        finish(o, false, { errMsg: `closeSocket:fail ${e.message}` })
      }
    },
  }
}
