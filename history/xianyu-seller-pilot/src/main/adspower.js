// AdsPower local API + a small Chrome DevTools Protocol adapter.
//
// The desktop app does not create a second Chromium profile for accounts that
// are explicitly bound to AdsPower.  AdsPower owns the persistent fingerprint,
// cookies and browser process; this module only talks to its documented
// localhost API and the returned CDP websocket.
//
// Replaces the former BitBrowser adapter.  Only the vendor API class changed:
// everything below it is plain CDP and is shared with the old implementation.
import { EventEmitter } from 'events'
import { writeFile } from 'fs/promises'
import { WebSocket } from 'ws'

// 默认走本机代理（adspower-executor 的 manage.py broker）：全机唯一一条通往
// AdsPower Local API 的路，它做全局节流 + 环境归属强制。代理没起时自动降级直连
// AdsPower 本体——功能照常，只是失去跨进程节流与归属保护。
const BROKER_API_URL = 'http://127.0.0.1:50326'
// AdsPower 本体的 Local API。50325 是它的默认端口，但**各机可能不同**：
// AdsPower 自己允许改，装了多个版本时也会错开。所以这条是可配的（设置项
// adsPowerDirectUrl，界面在「浏览器环境 → AdsPower 连接」），不是写死的常量。
// 代理那条（50326）是我们自己的组件，全机唯一入口，保持固定。
const DEFAULT_DIRECT_API_URL = 'http://127.0.0.1:50325'
let directApiUrl = DEFAULT_DIRECT_API_URL
const DEFAULT_API_URL = BROKER_API_URL

/** 当前的 AdsPower 本体地址（降级直连用的那个）。 */
export function getDirectApiUrl() {
  return directApiUrl
}

/**
 * 改 AdsPower 本体地址。传空 = 回默认 50325。
 *
 * 改完要把已经降级过的连接状态清掉，否则它还钉在旧地址上——用户在界面上改了端口
 * 却要重启应用才生效，那跟不能改没区别。
 */
export function setDirectApiUrl(value) {
  const next = String(value || '').trim().replace(/\/+$/, '') || DEFAULT_DIRECT_API_URL
  new URL(next)  // 格式不对就抛，调方负责把话说给界面
  directApiUrl = next
  api.resetTransport()
  return directApiUrl
}
// 本端在用途登记表里的身份，代理据此判断「你有没有资格驱动这个环境」。
const OWNER = 'desktop'
// AdsPower documents a one-request-per-second ceiling on the Local API.
const MIN_REQUEST_INTERVAL_MS = 1_100

function isPaidOnlyError(error) {
  return /paid subscription/i.test(String(error?.message || ''))
}

// BitBrowser exposed the screen layout over its own /alldisplays endpoint;
// AdsPower's Local API has no equivalent.  Electron already knows the real
// display geometry and reports it in the same {bounds, workArea} shape, so ask
// it directly.  Plain-Node regression runs resolve `electron` to a path string
// rather than the module, which yields no screen API — placement is a
// convenience and is simply skipped there.
async function electronDisplays() {
  try {
    const { screen } = await import('electron')
    if (typeof screen?.getAllDisplays !== 'function') return []
    return screen.getAllDisplays()
  } catch {
    return []
  }
}
const GOofishHome = 'https://www.goofish.com/'
const TARGET_URL_MARKER_PREFIX = 'xianyu-seller-pilot-target-v1-'

function targetUrlMarker(purpose) {
  return `${TARGET_URL_MARKER_PREFIX}${normalizePurpose(purpose)}`
}

function targetUrlFor(value, purpose) {
  const raw = String(value || '').trim()
  if (normalizePurpose(purpose) === 'worker' || !raw) return raw
  try {
    const url = new URL(raw)
    url.hash = targetUrlMarker(purpose)
    return url.href
  } catch {
    return raw
  }
}

function stripTargetUrlMarker(value) {
  const raw = String(value || '')
  try {
    const url = new URL(raw)
    if (url.hash.startsWith(`#${TARGET_URL_MARKER_PREFIX}`)) url.hash = ''
    return url.href
  } catch {
    return raw
  }
}

function hasTargetUrlMarker(value, purpose) {
  try {
    return new URL(String(value || '')).hash === `#${targetUrlMarker(purpose)}`
  } catch {
    return false
  }
}

function isLegacySellerPage(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && /^(?:[^/]+\.)?goofish\.com$/i.test(url.hostname) && /^\/personal(?:\/|$)/i.test(url.pathname)
  } catch {
    return false
  }
}
const PROFILE_PAGE_TIMEOUT_MS = 30_000
const PURPOSES = new Set(['worker', 'seller', 'preview', 'auth-check'])

function normalizePurpose(value) {
  const purpose = String(value || 'worker').trim().toLowerCase()
  return PURPOSES.has(purpose) ? purpose : 'worker'
}

function comparableUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    return url.href
  } catch {
    return String(value || '').trim()
  }
}

function cleanBaseUrl(value) {
  return String(value || DEFAULT_API_URL).trim().replace(/\/+$/, '')
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.data)) return value.data
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

function profileId(profile) {
  return String(profile?.id || profile?.browserId || profile?.browser_id || '').trim()
}

function profilePort(profile) {
  const raw = profile?.http || profile?.httpPort || profile?.http_port || profile?.port || profile?.debugPort || profile?.debug_port
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function portEntries(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([id, port]) => ({ id, port }))
  }
  return asArray(value)
}

// AdsPower opens its own start page and extension pages inside every
// environment.  They are never a reusable Goofish tab.
function isVendorInternalPage(value) {
  const raw = String(value || '')
  return raw.startsWith('chrome-extension://')
    || raw.startsWith('chrome://')
    || /^https?:\/\/local\.adspower\.net\//i.test(raw)
}

/**
 * 连不上时别把「fetch failed」原样端出去。
 *
 * undici 的连接失败只有这三个词，显示在界面上等于什么也没说——看的人分不清是
 * 本机没开 AdsPower、是代理没起，还是服务器那边的事。2026-09-19 现场就卡在这
 * 一句上，红条里只有 fetch failed，最后是去翻服务器日志才排除掉服务端。
 *
 * 所以这句话里必须有两样东西：试过哪个口、下一步做什么。照着它就能自己弄好，
 * 不用来问。
 */
function connectFailed(error, tried) {
  const reason = String(error?.cause?.code || error?.code || error?.message || '')
  // 不是连接问题就原样抛：AdsPower 自己的报错（付费版限制、参数不对）比这里的兜底准。
  if (!/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|fetch failed|ETIMEDOUT/i.test(reason)) return error
  if (tried === 'both') {
    return new Error(`连不上本机 AdsPower：归属代理（${BROKER_API_URL}）和 AdsPower 本体（${directApiUrl}）都没有应答。`
      + '先打开 AdsPower、确认它的 Local API 是开着的，再起 adspower-executor 的 manage.py broker。'
      + `端口不是 ${directApiUrl.replace(/^.*:/, '')} 的话，在「AdsPower 连接」里改。`)
  }
  if (tried === directApiUrl) {
    return new Error(`连不上 AdsPower 本体（${directApiUrl}）：AdsPower 没打开、Local API 没开，`
      + '或者端口不是这个。前两样在 AdsPower 里开，端口在「AdsPower 连接」里改。')
  }
  return new Error(`连不上 AdsPower（${tried}）：那个地址没有应答，检查一下地址和它那头的服务。`)
}

/** 代理不在。带 code 好让调方分辨：执行端控制见到它就改走本机直控，别的照实报给人。 */
function brokerUnavailable(cause) {
  const error = new Error(`本机代理没在跑（${BROKER_API_URL}）`)
  error.code = 'BROKER_DOWN'
  if (cause) error.cause = cause
  return error
}

export function isBrokerDown(error) {
  return error?.code === 'BROKER_DOWN'
}

function errorMessage(value, fallback) {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object') return String(value.msg || value.message || fallback)
  return String(value || fallback)
}

// AdsPower target ids are assigned by the running Chromium process and are
// therefore not a durable handle.  Keep a purpose-scoped marker in the
// browsing context instead.  `window.name` belongs to one tab (unlike
// localStorage, which is shared by every Goofish tab in a profile) and survives
// top-level navigation and an Electron process restart while AdsPower keeps
// the profile open.  Every reuse path verifies this value over CDP; arbitrary
// user tabs never match it.
function targetMarker(profile, purpose) {
  return `xianyu-seller-pilot:target:v1:${encodeURIComponent(String(profile || ''))}:${normalizePurpose(purpose)}`
}

async function connectBrowserSession(port, WebSocketImpl, fetchImpl) {
  const versionResponse = await fetchImpl(`http://127.0.0.1:${port}/json/version`)
  if (!versionResponse.ok) throw new Error(`AdsPower CDP browser lookup failed (${versionResponse.status})`)
  const version = await versionResponse.json()
  if (!version?.webSocketDebuggerUrl) throw new Error('AdsPower CDP browser websocket is unavailable')
  const session = new AdsCDPSession(version.webSocketDebuggerUrl, WebSocketImpl)
  await session.connect()
  return session
}

export class AdsPowerApi {
  constructor({
    baseUrl = process.env.ADSPOWER_API_URL,
    token = process.env.ADSPOWER_API_TOKEN,
    fetchImpl = globalThis.fetch,
    minIntervalMs = MIN_REQUEST_INTERVAL_MS,
    displaysImpl = electronDisplays
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable; Node 18+ is required')
    this.baseUrl = cleanBaseUrl(baseUrl)
    // The token is intentionally read only from the private process
    // environment.  It is never persisted in electron-store or emitted in
    // an error/log message.
    this.token = String(token || '').trim()
    this.fetchImpl = fetchImpl
    // AdsPower's Local API rejects bursts: requests must be spaced at least a
    // second apart or it answers "Too many request".  Serialise every call
    // through one chain so concurrent callers queue instead of tripping it.
    this.minIntervalMs = Number(minIntervalMs) || 0
    this.lastRequestAt = 0
    this.queue = Promise.resolve()
    this.displaysImpl = typeof displaysImpl === 'function' ? displaysImpl : null
    this.brokerDown = false
  }

  /** 改了本体地址之后调：把降级状态清掉，下一次请求重新从代理试起。 */
  resetTransport() {
    this.brokerDown = false
    this.baseUrl = cleanBaseUrl(process.env.ADSPOWER_API_URL)
  }

  // 只有「连不上代理」才降级：代理返回的 403 归属拒绝是**正确判决**，
  // 绕过去直连就等于把归属保护作废了，那正是这套机制要防的事。
  fallbackToDirect(error) {
    if (this.brokerDown) return false
    if (cleanBaseUrl(this.baseUrl) !== BROKER_API_URL) return false
    const reason = String(error?.cause?.code || error?.code || error?.message || '')
    if (!/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|fetch failed|ETIMEDOUT/i.test(reason)) return false
    this.brokerDown = true
    this.baseUrl = directApiUrl
    console.warn(`[adspower] 本机代理 ${BROKER_API_URL} 连不上（${reason}），本次起直连 ${directApiUrl}。`
      + '失去跨进程节流与环境归属保护，请尽快起 adspower-executor 的 manage.py broker。')
    return true
  }

  // Local API is GET + query string and answers {code, msg, data}; code !== 0
  // is an application-level failure even when HTTP status is 200.
  async get(path, params = {}) {
    return this.request('GET', path, { params })
  }

  // 环境的增删改（user/create、user/regroup、user/delete、group/create）都是 POST。
  // 走同一条 request：队列、1 次/秒节流、代理降级、X-Ads-Owner 身份头一个不少——
  // 另起一条 fetch 就会绕过全局节流，而撞限时 AdsPower 返回 200 + code=-1 不抛异常。
  async post(path, body = {}) {
    return this.request('POST', path, { body })
  }

  async request(method, path, { params = {}, body = null } = {}) {
    // /broker/* 是代理独有的路径，AdsPower 本体没有。代理不在时不能把它们降级发给
    // 本体——那只会拿回一个 404「Not Found」，界面上就剩这三个词。直接说「代理不在」，
    // 由调方决定走哪条备用路（执行端控制改走 executor-local.js）。
    const brokerOnly = path.startsWith('/broker/')
    const run = async () => {
      if (brokerOnly && cleanBaseUrl(this.baseUrl) !== BROKER_API_URL) throw brokerUnavailable()
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const url = new URL(`${this.baseUrl}${path}`)
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
      if (this.token) url.searchParams.set('serial_number', this.token)
      const init = method === 'POST'
        ? {
            method: 'POST',
            headers: { 'X-Ads-Owner': OWNER, 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
          }
        : { headers: { 'X-Ads-Owner': OWNER } }
      try {
        let response
        try {
          response = await this.fetchImpl(url.href, init)
        } catch (error) {
          // 代理没起（连接被拒）→ 本次及之后直连 AdsPower 本体。
          // 引入代理不能引入新的单点故障：它宕了只该失去全局节流与归属保护，
          // 不该让桌面端整个不能用。
          if (!this.fallbackToDirect(error)) throw connectFailed(error, cleanBaseUrl(this.baseUrl))
          // 代理连不上：上面已经切了直连，之后的请求照常走本体；只有这一条要的东西本体没有
          if (brokerOnly) throw brokerUnavailable(error)
          const direct = new URL(url.href)
          direct.protocol = new URL(this.baseUrl).protocol
          direct.host = new URL(this.baseUrl).host
          try {
            response = await this.fetchImpl(direct.href, init)
          } catch (retryError) {
            // 代理连不上才走到这里，本体又连不上——两个口都试过了，一次说完，
            // 免得人先去起 broker、起完发现还是不行再回来。
            throw connectFailed(retryError, 'both')
          }
        }
        const text = await response.text()
        let payload = null
        try { payload = text ? JSON.parse(text) : null } catch { payload = { code: -1, msg: text.slice(0, 200) } }
        if (!response.ok) throw new Error(errorMessage(payload, `AdsPower API ${response.status}`))
        if (payload?.code !== 0) throw new Error(errorMessage(payload, 'AdsPower API request failed'))
        return payload?.data ?? payload
      } finally {
        this.lastRequestAt = Date.now()
      }
    }
    const next = this.queue.then(run, run)
    // Keep the chain alive after a rejection so one failure does not poison
    // every queued call behind it.
    this.queue = next.then(() => {}, () => {})
    return next
  }

  health() { return this.get('/status') }

  // Not a Local API call: the screen layout comes from Electron, not AdsPower.
  async allDisplays() {
    if (!this.displaysImpl) return []
    return (await this.displaysImpl()) || []
  }

  // user/list is a paid-subscription endpoint.  Callers fall back to the
  // running-environment list, so surface the refusal instead of throwing.
  async listProfiles(page = 1, pageSize = 100) {
    try {
      return await this.get('/api/v1/user/list', { page, page_size: pageSize })
    } catch (error) {
      if (isPaidOnlyError(error)) return { list: [], paidOnly: true }
      throw error
    }
  }

  profileDetail(id) { return this.get('/api/v1/browser/active', { user_id: String(id) }) }

  // Normalised to the {id, port} entries the CDP layer expects.
  async ports() {
    const data = await this.get('/api/v1/browser/local-active')
    return asArray(data).map((entry) => ({
      id: String(entry?.user_id || '').trim(),
      port: Number(entry?.debug_port) || null,
      ws: entry?.ws?.puppeteer || null
    })).filter((entry) => entry.id)
  }

  // 分组即用途：环境从出生起就带归属，不会出现「建完忘了分组、谁也不认领」的空档。
  listGroups() { return this.get('/api/v1/group/list', { page: 1, page_size: 200 }) }
  createGroup(name) { return this.post('/api/v1/group/create', { group_name: String(name || '').trim() }) }
  createUser(body) { return this.post('/api/v1/user/create', body) }
  // ⚠️ 换分组必须用 user/regroup。user/update 带 {user_id, group_id} 会返回
  // code=0 "Success" 而环境的 group_id 原封不动——静默失败（2026-09-13 实测栽过）。
  regroup(userIds, groupId) {
    return this.post('/api/v1/user/regroup', { user_ids: userIds.map(String), group_id: String(groupId) })
  }
  deleteUsers(userIds) { return this.post('/api/v1/user/delete', { user_ids: userIds.map(String) }) }
  // 写环境的平台账号（密码库填进 AdsPower 用）。只送 username / password / fakey / domain_name 这几项，
  // 别的字段一个不带——带了 group_id 也不会生效（见上面 regroup 的注释），写完一定读回来比。
  updateAccount(body) { return this.post('/api/v1/user/update', body) }
  // 按环境 id 读一条完整记录（含账号密码，只在主进程里用来核对，绝不过 IPC）
  async profileRecord(userId) {
    const id = String(userId)
    const hit = (data) => asArray(data).find((p) => String(p?.user_id || '') === id) || null
    const direct = hit(await this.get('/api/v1/user/list', { user_id: id, page: 1, page_size: 100 }))
    if (direct) return direct
    // 有的 AdsPower 版本不认 user_id 过滤、照样从头列：那就翻页找，别把真写成功的报成找不到
    for (let page = 1; page <= 50; page += 1) {
      const data = await this.get('/api/v1/user/list', { page, page_size: 100 })
      const found = hit(data)
      if (found || asArray(data).length < 100) return found
    }
    return null
  }
  listProfilesInGroup(groupId, page = 1, pageSize = 100) {
    return this.get('/api/v1/user/list', { page, page_size: pageSize, group_id: String(groupId) })
  }
  // 本机代理独有的接口（AdsPower 本体没有这个路径）。拿用途登记表用，
  // 失败即说明没经代理——调方据此提示「归属保护当前不生效」。
  brokerHealth() { return this.get('/broker/health') }
  // 用途登记表的增删改查（同样只有本机代理有这几条路径）
  listPurposes() { return this.get('/broker/purposes') }
  // 执行端进程的控制面（也只有本机代理有）。真正在驱动浏览器的是它。
  listExecutors() { return this.get('/broker/executor') }
  startExecutor(userId) { return this.post('/broker/executor/start', { user_id: String(userId) }) }
  stopExecutor(userId, stopBrowser) {
    return this.post('/broker/executor/stop', { user_id: String(userId), stop_browser: Boolean(stopBrowser) })
  }
  upsertPurpose(name, owner) { return this.post('/broker/purposes', { name, owner }) }
  deletePurpose(name) { return this.post('/broker/purposes/delete', { name }) }

  // open_tabs=1 keeps the environment's own startup tabs out of the way so a
  // reused profile does not resurrect unrelated pages on every launch.
  open(id) { return this.get('/api/v1/browser/start', { user_id: String(id), open_tabs: 1 }) }
  close(id) { return this.get('/api/v1/browser/stop', { user_id: String(id) }) }
}

class AdsCDPSession extends EventEmitter {
  constructor(webSocketUrl, WebSocketImpl = WebSocket) {
    super()
    this.webSocketUrl = webSocketUrl
    this.WebSocketImpl = WebSocketImpl
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
    this.connectPromise = null
  }

  async connect() {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.webSocketUrl)
      this.socket = socket
      const fail = (error) => {
        this.connectPromise = null
        this.socket = null
        reject(error instanceof Error ? error : new Error(String(error || 'CDP websocket failed')))
      }
      socket.once('open', () => {
        this.connectPromise = null
        resolve()
      })
      socket.on('message', (data) => {
        let message
        try { message = JSON.parse(String(data)) } catch { return }
        if (message.id != null) {
          const entry = this.pending.get(message.id)
          if (!entry) return
          this.pending.delete(message.id)
          if (message.error) entry.reject(new Error(String(message.error.message || 'CDP command failed')))
          else entry.resolve(message.result)
          return
        }
        if (message.method) this.emit('message', null, message.method, message.params || {})
      })
      socket.on('error', fail)
      socket.on('close', () => {
        const error = new Error('AdsPower CDP websocket closed')
        for (const entry of this.pending.values()) entry.reject(error)
        this.pending.clear()
        this.socket = null
        this.emit('close')
      })
      // ws can emit error after the initial rejection; keep it observable but
      // do not turn it into an unhandled EventEmitter error.
      socket.on('error', () => {})
    })
    return this.connectPromise
  }

  async sendCommand(method, params = {}) {
    await this.connect()
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) throw new Error('AdsPower CDP is not connected')
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  close() {
    try { this.socket?.close() } catch { /* already closed */ }
    this.socket = null
  }
}

export class AdsPowerWebContents extends EventEmitter {
  constructor({ api = new AdsPowerApi(), profileId: id, purpose = 'worker', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, pageTimeoutMs = PROFILE_PAGE_TIMEOUT_MS } = {}) {
    super()
    this.api = api
    this.profileId = String(id || '').trim()
    if (!this.profileId) throw new TypeError('AdsPower profile id is required')
    this.fetchImpl = fetchImpl
    this.WebSocketImpl = WebSocketImpl
    this.pageTimeoutMs = Math.max(1, Number(pageTimeoutMs) || PROFILE_PAGE_TIMEOUT_MS)
    this.purpose = normalizePurpose(purpose)
    this.session = null
    this.debugger = new AdsPowerDebugger(this)
    this.currentUrl = ''
    this.targetId = ''
    this.connected = false
    this.destroyed = false
    this.navigationWaiters = new Set()
    this.navigationGeneration = 0
    this.navigationState = { status: 'idle', generation: 0, expectedUrl: '', currentUrl: '' }
    this.boundOnMessage = null
    this.boundOnClose = null
    this.ensurePromise = null
    this.ownedTarget = false
    this.targetPurpose = this.purpose
    this.targetMarker = targetMarker(this.profileId, this.purpose)
    this.browserPort = null
    this.browserSession = null
    this.closePromise = null
    // A registry replacement may be requested while the prior target is
    // still closing.  The registry supplies this promise so creation waits
    // for Target.closeTarget instead of racing it.
    this.lifecycleReady = Promise.resolve()
  }

  isDestroyed() { return this.destroyed }
  assertAlive() {
    if (this.destroyed) throw new Error('AdsPower web contents is destroyed')
  }
  getURL() { return this.currentUrl }
  getNavigationState() { return { ...this.navigationState, currentUrl: this.currentUrl } }
  setUserAgent() { /* AdsPower owns its fingerprint and UA. */ }
  setWindowOpenHandler() { /* external AdsPower windows are not embedded */ }

  setLifecycleReady(value) {
    this.lifecycleReady = Promise.resolve(value).catch(() => {})
    return this
  }

  async findMarkedTarget(port, pages) {
    this.assertAlive()
    if (this.purpose === 'worker') return null
    // window.name is the primary marker, but Goofish occasionally overwrites
    // it with its own storage key. Keep a purpose marker in the URL hash as
    // a second durable signal so an app restart still reuses the same tab.
    const urlMarked = pages.find((page) => hasTargetUrlMarker(page?.url, this.purpose))
    if (urlMarked) return urlMarked
    for (const page of pages) {
      this.assertAlive()
      const socketUrl = String(page?.webSocketDebuggerUrl || '')
      if (!socketUrl) continue
      const probe = new AdsCDPSession(socketUrl, this.WebSocketImpl)
      try {
        await probe.connect()
        this.assertAlive()
        const response = await probe.sendCommand('Runtime.evaluate', {
          expression: 'window.name',
          awaitPromise: false,
          returnByValue: true
        })
        this.assertAlive()
        if (response?.result?.value === this.targetMarker) return page
      } catch {
        // A user tab can disappear between /json/list and the websocket probe;
        // it is not ours and must simply be skipped.
      } finally {
        probe.close()
      }
    }
    return null
  }

  async closeLegacySellerTargets(port, pages, keepTargetId = '') {
    if (this.purpose !== 'seller') return
    const legacy = pages.filter((page) => {
      const targetId = String(page?.id || '')
      if (!targetId || targetId === String(keepTargetId || '')) return false
      if (!isLegacySellerPage(page?.url)) return false
      // Preserve any target already claimed by this or another app purpose;
      // only unmarked legacy seller tabs are reclaimed.
      return ![...PURPOSES].some((purpose) => hasTargetUrlMarker(page?.url, purpose))
    })
    if (!legacy.length) return
    const browserSession = await connectBrowserSession(port, this.WebSocketImpl, this.fetchImpl)
    try {
      for (const page of legacy) {
        try { await browserSession.sendCommand('Target.closeTarget', { targetId: String(page.id) }) } catch { /* tab may have disappeared */ }
      }
    } finally {
      browserSession.close()
    }
  }

  async markTarget() {
    this.assertAlive()
    if (!this.ownedTarget || !this.session) return
    const marker = JSON.stringify(this.targetMarker)
    // Re-assert the marker on every future document.  window.name itself
    // survives normal seller-page navigation; this script also protects the
    // handle if the site or an intermediate redirect clears it.
    await this.session.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.name = ${marker}`
    })
    this.assertAlive()
    const response = await this.session.sendCommand('Runtime.evaluate', {
      expression: `window.name = ${marker}; window.name`,
      awaitPromise: false,
      returnByValue: true
    })
    this.assertAlive()
    if (response?.result?.value !== this.targetMarker) {
      throw new Error('AdsPower target marker could not be verified')
    }
  }

  // AdsPower's launch default is the primary display (0,0). Keep the
  // browser window on the user's secondary display after every open/reconnect
  // without moving Electron itself or changing the page viewport more than
  // the available work area requires.
  async alignToSecondaryDisplay() {
    if (!this.browserPort || !this.targetId || typeof this.api.allDisplays !== 'function') return false
    let temporaryBrowserSession = null
    try {
      const displays = await this.api.allDisplays()
      const list = Array.isArray(displays) ? displays.filter((display) => display?.bounds) : []
      const display = list[1] || list.find((candidate) => Number(candidate?.bounds?.x) !== 0)
      if (!display) return false
      const workArea = display.workArea || display.bounds
      if (!workArea) return false
      const browserSession = this.browserSession || (temporaryBrowserSession = await connectBrowserSession(this.browserPort, this.WebSocketImpl, this.fetchImpl))
      const window = await browserSession.sendCommand('Browser.getWindowForTarget', { targetId: this.targetId })
      const current = await browserSession.sendCommand('Browser.getWindowBounds', { windowId: window.windowId })
      await browserSession.sendCommand('Browser.setWindowBounds', {
        windowId: window.windowId,
        bounds: {
          left: Math.trunc(Number(workArea.x) || 0),
          top: Math.trunc(Number(workArea.y) || 0),
          width: Math.min(Math.max(500, Math.trunc(Number(current?.bounds?.width) || 1280)), Math.trunc(Number(workArea.width) || 1280)),
          height: Math.min(Math.max(200, Math.trunc(Number(current?.bounds?.height) || 720)), Math.trunc(Number(workArea.height) || 720)),
          windowState: 'normal'
        }
      })
      return true
    } catch {
      // Display placement is a convenience. A host without a usable screen
      // API must never stop seller collection.
      return false
    } finally {
      temporaryBrowserSession?.close()
    }
  }

  async resolveTarget() {
    this.assertAlive()
    let port = null
    const ports = portEntries(await this.api.ports())
    this.assertAlive()
    const ownPort = ports.find((entry) => profileId(entry) === this.profileId || String(entry?.id || '') === this.profileId)
    port = profilePort(ownPort) || profilePort({ port: ownPort?.port })
    if (!port) {
      const opened = await this.api.open(this.profileId)
      this.assertAlive()
      port = profilePort(opened)
      if (!port) {
        const afterOpen = portEntries(await this.api.ports())
        this.assertAlive()
        port = profilePort(afterOpen.find((entry) => profileId(entry) === this.profileId))
          || profilePort({ port: afterOpen.find((entry) => String(entry?.id || '') === this.profileId)?.port })
      }
    }
    if (!port) throw new Error('AdsPower profile has no CDP port; open it in AdsPower first')
    const listResponse = await this.fetchImpl(`http://127.0.0.1:${port}/json/list`)
    this.assertAlive()
    if (!listResponse.ok) throw new Error(`AdsPower CDP target lookup failed (${listResponse.status})`)
    const targets = await listResponse.json()
    this.assertAlive()
    const pages = (Array.isArray(targets) ? targets : []).filter((target) => target?.type === 'page' && target.webSocketDebuggerUrl)
    if (!pages.length) throw new Error('AdsPower profile has no page target')
    // Keep a purpose-owned target across reconnects. A preview/seller/auth
    // check target must never be selected from an arbitrary page left open by
    // another purpose, and a destroyed target must be replaced rather than
    // reused.
    const owned = this.targetId && pages.find((page) => String(page.id || '') === this.targetId)
    if (owned && this.targetPurpose === this.purpose) return { port, target: owned, created: false }
    // A newly constructed adapter has no in-memory targetId.  Verify the
    // purpose marker in each existing page before creating anything; this is
    // the process-restart/memory-loss recovery path.  Do not select an
    // arbitrary user page merely because it is the only page in the profile.
    const marked = await this.findMarkedTarget(port, pages)
    this.assertAlive()
    if (marked) {
      const markedTargetId = String(marked.id || '')
      await this.closeLegacySellerTargets(port, pages, markedTargetId)
      this.assertAlive()
      this.targetId = markedTargetId
      this.browserPort = port
      this.targetPurpose = this.purpose
      this.ownedTarget = this.purpose !== 'worker'
      // Reused purpose-owned targets must remain closable by this adapter.
      // Hold a browser-level CDP session for the eventual Target.closeTarget.
      const browserSession = await connectBrowserSession(port, this.WebSocketImpl, this.fetchImpl)
      if (this.destroyed) {
        // close() may have run while connectBrowserSession() was awaiting its
        // websocket handshake, before this browser-level session was visible
        // on the adapter.  It cannot close the target in that narrow window,
        // so finish that ownership cleanup with the local session here.
        try {
          if (markedTargetId) {
            await browserSession.sendCommand('Target.closeTarget', { targetId: markedTargetId })
          }
        } catch {
          // The target may already be gone; the adapter must still remain
          // destroyed and must not continue connecting it.
        } finally {
          browserSession.close()
        }
        this.assertAlive()
      }
      this.browserSession = browserSession
      this.assertAlive()
      return { port, target: marked, created: false }
    }
    const usable = pages.find((page) => !isVendorInternalPage(page.url))
    if (this.purpose !== 'worker') {
      // Start purpose-owned targets on a neutral document. Creating them on
      // the Goofish home page races the first explicit navigation: the
      // initial home-page frame event can be mistaken for the seller URL and
      // fail the navigation before the requested page has loaded. Auth
      // checks still navigate to GOofishHome explicitly below.
      const target = await this.createTarget(port, 'about:blank')
      this.assertAlive()
      if (target) {
        await this.closeLegacySellerTargets(port, pages, target.id)
        return { port, target, created: true }
      }
      // Never fall back to an arbitrary user page for a purpose-owned
      // adapter. It would both steal manual browsing and make close() capable
      // of destroying a page this process did not create.
      throw new Error(`AdsPower ${this.purpose} target could not be created`)
    }
    if (!usable) {
      const target = await this.createTarget(port, 'about:blank')
      this.assertAlive()
      if (target) {
        await this.closeLegacySellerTargets(port, pages, target.id)
        return { port, target, created: true }
      }
    }
    return { port, target: usable || pages[0] }
  }

  async createTarget(port, url) {
    this.assertAlive()
    const versionResponse = await this.fetchImpl(`http://127.0.0.1:${port}/json/version`)
    this.assertAlive()
    if (!versionResponse.ok) return null
    const version = await versionResponse.json()
    if (!version?.webSocketDebuggerUrl) return null
    const browserSession = new AdsCDPSession(version.webSocketDebuggerUrl, this.WebSocketImpl)
    let targetId = ''
    let retained = false
    try {
      await browserSession.connect()
      this.assertAlive()
      const created = await browserSession.sendCommand('Target.createTarget', { url: targetUrlFor(url, this.purpose) })
      // Record the target before checking liveness. close() can be called by
      // the CDP response callback itself; retaining the id lets finally close
      // the browser-owned page even though close() observed no adapter state.
      targetId = String(created?.targetId || '')
      this.assertAlive()
      if (!targetId) return null
      const listResponse = await this.fetchImpl(`http://127.0.0.1:${port}/json/list`)
      this.assertAlive()
      if (!listResponse.ok) throw new Error(`AdsPower CDP target lookup failed (${listResponse.status})`)
      const targets = await listResponse.json()
      this.assertAlive()
      const target = (Array.isArray(targets) ? targets : []).find((entry) => String(entry.id || '') === targetId && entry.webSocketDebuggerUrl)
      if (!target) throw new Error('AdsPower created target is not available')
      this.browserSession = browserSession
      this.targetId = targetId
      this.browserPort = port
      this.targetPurpose = this.purpose
      // A target returned by Target.createTarget is ours regardless of
      // purpose.  Worker usually reuses a user-visible page (handled below),
      // but the no-page fallback also needs a safe close path.
      this.ownedTarget = true
      retained = true
      this.assertAlive()
      return target
    } finally {
      if (!retained) {
        // Target.createTarget is not transactional.  If the follow-up list
        // request, target lookup, or marker setup fails, close the just-made
        // page before releasing the browser-level websocket.
        if (targetId) {
          try { await browserSession.sendCommand('Target.closeTarget', { targetId }) } catch { /* best effort orphan cleanup */ }
        }
        browserSession.close()
      }
    }
  }

  ensureConnected() {
    if (this.destroyed) return Promise.reject(new Error('AdsPower web contents is destroyed'))
    if (this.connected && this.session) return Promise.resolve(this)
    if (this.ensurePromise) return this.ensurePromise
    this.ensurePromise = this._ensureConnected().finally(() => { this.ensurePromise = null })
    return this.ensurePromise
  }

  async _ensureConnected() {
    this.assertAlive()
    if (this.connected && this.session) return this
    await this.lifecycleReady
    this.assertAlive()
    const { target, created } = await this.resolveTarget()
    if (this.destroyed) {
      // A target created during this ensure must not outlive a close racing
      // the async target lookup.  createTarget() already cleans up failures
      // before retention; this covers the final close-after-return window.
      if (created && this.targetId) await this.close()
      this.assertAlive()
    }
    try {
      const session = new AdsCDPSession(target.webSocketDebuggerUrl, this.WebSocketImpl)
      this.session = session
      this.boundOnMessage = (_event, method, params) => {
        if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
          this.currentUrl = stripTargetUrlMarker(params.frame.url || '')
          this.emit('did-navigate', null, this.currentUrl)
          const waiter = [...this.navigationWaiters].find((entry) => entry.generation === this.navigationGeneration)
          if (waiter && comparableUrl(this.currentUrl) !== comparableUrl(waiter.expectedUrl)) {
            waiter.reject(new Error(`AdsPower navigation URL mismatch: expected ${waiter.expectedUrl}, got ${this.currentUrl}`))
            this.navigationWaiters.delete(waiter)
          } else if (waiter) {
            waiter.frameNavigated = true
          }
        }
        if (method === 'Page.loadEventFired') {
          // The page itself may replace window.name after navigation. Reapply
          // the marker once the document has settled; this is harmless for a
          // target that is already marked and keeps reconnect discovery stable.
          if (this.ownedTarget) this.markTarget().catch(() => {})
          for (const waiter of [...this.navigationWaiters]) {
            if (waiter.generation !== this.navigationGeneration || !waiter.frameNavigated) continue
            if (waiter.expectedUrl && comparableUrl(this.currentUrl) !== comparableUrl(waiter.expectedUrl)) {
              waiter.reject(new Error(`AdsPower navigation URL mismatch: expected ${waiter.expectedUrl}, got ${this.currentUrl}`))
            } else {
              this.navigationState = { status: 'ready', generation: waiter.generation, expectedUrl: waiter.expectedUrl, currentUrl: this.currentUrl }
              waiter.resolve(this.currentUrl)
            }
            this.navigationWaiters.delete(waiter)
          }
        }
      }
      this.boundOnClose = () => {
        this.connected = false
        this.emit('render-process-gone', null, { reason: 'clean-exit', exitCode: 0 })
      }
      // Register before connect: CDP can emit Page events as soon as the
      // websocket opens, and losing the first event leaves a stale DOM that
      // must never be scanned as seller evidence.
      session.on('message', this.boundOnMessage)
      session.on('close', this.boundOnClose)
      await session.connect()
      this.assertAlive()
      this.connected = true
      this.currentUrl = stripTargetUrlMarker(target.url || this.currentUrl || '')
      await session.sendCommand('Page.enable')
      this.assertAlive()
      await session.sendCommand('Runtime.enable')
      this.assertAlive()
      await this.markTarget()
      this.assertAlive()
      await this.alignToSecondaryDisplay()
      this.assertAlive()
      return this
    } catch (error) {
      this.session?.removeListener('message', this.boundOnMessage)
      this.session?.removeListener('close', this.boundOnClose)
      this.session?.close()
      this.session = null
      this.connected = false
      // Target.createTarget succeeded before this method runs.  Any failure
      // connecting/enabling/marking that owned page must close it, otherwise a
      // retry creates an invisible orphan tab.
      if (this.ownedTarget && this.targetId) await this.close()
      if (/listener registration failed/i.test(String(error?.message || ''))) throw error
      throw error
    }
  }

  async loadURL(url) {
    await this.ensureConnected()
    const value = String(url || '').trim()
    if (!/^https?:\/\//i.test(value)) throw new TypeError('AdsPower navigation requires an absolute URL')
    const navigationUrl = targetUrlFor(value, this.purpose)
    const generation = ++this.navigationGeneration
    const expectedUrl = comparableUrl(value)
    this.navigationState = { status: 'navigating', generation, expectedUrl: value, currentUrl: this.currentUrl }
    const wait = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.navigationWaiters.delete(entry)
        this.navigationState = { status: 'failed', generation, expectedUrl: value, currentUrl: this.currentUrl, reason: 'timeout' }
        this.navigationGeneration += 1
        reject(new Error('AdsPower navigation timed out'))
      }, this.pageTimeoutMs)
      const entry = {
        generation,
        expectedUrl,
        frameNavigated: false,
        resolve: (result) => { clearTimeout(timeout); resolve(result) },
        reject: (error) => { clearTimeout(timeout); reject(error) }
      }
      this.navigationWaiters.add(entry)
    })
    const command = this.session.sendCommand('Page.navigate', { url: navigationUrl })
    command.catch(() => {})
    const commandOutcome = await Promise.race([
      command.then((response) => ({ kind: 'command', response }), (error) => ({ kind: 'command-error', error })),
      wait.then((result) => ({ kind: 'loaded', result }), (error) => ({ kind: 'wait-error', error }))
    ])
    if (commandOutcome.kind === 'wait-error') {
      this.navigationWaiters.delete([...this.navigationWaiters].find((entry) => entry.generation === generation))
      throw commandOutcome.error
    }
    if (commandOutcome.kind === 'command-error') {
      this.navigationWaiters.delete([...this.navigationWaiters].find((entry) => entry.generation === generation))
      this.navigationState = { status: 'failed', generation, expectedUrl: value, currentUrl: this.currentUrl, reason: 'command' }
      throw commandOutcome.error
    }
    if (commandOutcome.response?.errorText) {
      this.navigationWaiters.delete([...this.navigationWaiters].find((entry) => entry.generation === generation))
      this.navigationState = { status: 'failed', generation, expectedUrl: value, currentUrl: this.currentUrl, reason: commandOutcome.response.errorText }
      throw new Error(commandOutcome.response.errorText)
    }
    if (commandOutcome.kind === 'command') await wait
    return this.currentUrl || value
  }

  async executeJavaScript(script, userGesture = false) {
    await this.ensureConnected()
    const response = await this.session.sendCommand('Runtime.evaluate', {
      expression: String(script || ''),
      awaitPromise: true,
      returnByValue: true,
      userGesture: Boolean(userGesture)
    })
    if (response?.exceptionDetails) {
      throw new Error(String(response.exceptionDetails.text || response.exceptionDetails.exception?.description || 'AdsPower script failed'))
    }
    return response?.result?.value
  }

  async reload() {
    await this.ensureConnected()
    const wait = this.waitForLoad()
    await this.session.sendCommand('Page.reload', { ignoreCache: false })
    return wait
  }

  waitForLoad() {
    const generation = ++this.navigationGeneration
    const expectedUrl = comparableUrl(this.currentUrl)
    this.navigationState = { status: 'navigating', generation, expectedUrl: this.currentUrl, currentUrl: this.currentUrl }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.navigationWaiters.delete(entry)
        this.navigationState = { status: 'failed', generation, expectedUrl: this.currentUrl, currentUrl: this.currentUrl, reason: 'timeout' }
        this.navigationGeneration += 1
        reject(new Error('AdsPower page load timed out'))
      }, this.pageTimeoutMs)
      const entry = {
        generation,
        expectedUrl,
        frameNavigated: true,
        resolve: (result) => { clearTimeout(timeout); resolve(result) },
        reject: (error) => { clearTimeout(timeout); reject(error) }
      }
      this.navigationWaiters.add(entry)
    })
  }

  async stop() {
    await this.ensureConnected()
    return this.session.sendCommand('Page.stopLoading')
  }

  async sendInputEvent(event = {}) {
    await this.ensureConnected()
    const type = String(event.type || '')
    if (type === 'mouseWheel') {
      return this.session.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Number(event.x) || 0,
        y: Number(event.y) || 0,
        deltaX: Number(event.deltaX) || 0,
        deltaY: Number(event.deltaY) || 0
      })
    }
    const mapped = type === 'mouseDown' || type === 'mouseUp' ? type : 'mouseMoved'
    return this.session.sendCommand('Input.dispatchMouseEvent', {
      type: mapped,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      button: event.button || 'none',
      clickCount: Number(event.clickCount) || 1
    })
  }

  async savePage(path) {
    const html = await this.executeJavaScript('document.documentElement?.outerHTML || document.documentElement?.innerHTML || ""')
    await writeFile(path, `<!doctype html>\n${String(html || '')}`, 'utf8')
    return path
  }

  close() {
    if (this.closePromise) return this.closePromise
    // Set destroyed synchronously so callers cannot issue new commands while
    // the asynchronous Target.closeTarget handshake is still in flight.
    this.destroyed = true
    this.closePromise = (async () => {
      for (const waiter of this.navigationWaiters) waiter.reject(new Error('AdsPower web contents closed'))
      this.navigationWaiters.clear()
      this.session?.removeListener('message', this.boundOnMessage)
      this.session?.removeListener('close', this.boundOnClose)
      this.session?.close()
      const browserSession = this.browserSession
      const targetId = this.targetId
      try {
        if (browserSession && targetId && this.ownedTarget) {
          // Await the command before releasing the browser-level websocket.
          // Recycle/create callers use this promise as their serialization
          // barrier, preventing an old tab from overlapping its replacement.
          await browserSession.sendCommand('Target.closeTarget', { targetId })
        }
      } catch {
        // Closing is best effort against a target that AdsPower already
        // destroyed.  The promise still settles only after the command has
        // completed or failed, preserving ordering for the next create.
      } finally {
        browserSession?.close()
        this.browserSession = null
        this.targetId = ''
        this.browserPort = null
        this.ownedTarget = false
        this.connected = false
        this.emit('destroyed')
      }
    })()
    return this.closePromise
  }
}

class AdsPowerDebugger {
  constructor(contents) {
    this.contents = contents
    this.attached = false
    this.pendingListeners = new Map()
  }

  isAttached() { return this.attached }
  attach() {
    this.attached = true
    return this.contents.ensureConnected()
  }
  detach() { this.attached = false }
  sendCommand(method, params = {}) {
    this.attached = true
    return this.contents.ensureConnected().then(() => this.contents.session.sendCommand(method, params))
  }
  on(event, listener) {
    if (this.contents.connected && this.contents.session) {
      this.contents.session.on(event, listener)
      return this
    }
    const listeners = this.pendingListeners.get(event) || []
    if (!listeners.includes(listener)) listeners.push(listener)
    this.pendingListeners.set(event, listeners)
    this.contents.ensureConnected().then(() => {
      const queued = this.pendingListeners.get(event) || []
      if (!this.contents.session) throw new Error('AdsPower debugger session is unavailable')
      for (const callback of queued) this.contents.session.on(event, callback)
      this.pendingListeners.delete(event)
    }).catch(() => {})
    return this
  }
  removeListener(event, listener) {
    const listeners = this.pendingListeners.get(event) || []
    const index = listeners.indexOf(listener)
    if (index >= 0) listeners.splice(index, 1)
    if (listeners.length) this.pendingListeners.set(event, listeners)
    else this.pendingListeners.delete(event)
    this.contents.session?.removeListener(event, listener)
    return this
  }
}

const api = new AdsPowerApi()
const contentsByAccount = new Map()
const lifecycleLocks = new Map()

function trackClose(key, contents) {
  let closePromise
  try { closePromise = contents.close() } catch (error) { closePromise = Promise.reject(error) }
  const tracked = Promise.resolve(closePromise).catch(() => {})
  lifecycleLocks.set(key, tracked)
  tracked.finally(() => {
    if (lifecycleLocks.get(key) === tracked) lifecycleLocks.delete(key)
  }).catch(() => {})
  return tracked
}

export function isAdsPowerAccount(account) {
  const provider = String(account?.browserProvider || '').toLowerCase()
  // 'bitbrowser' is the pre-migration provider value; accounts stored before
  // the AdsPower swap still carry it until the store migration rewrites them.
  return provider === 'adspower' || provider === 'bitbrowser' || Boolean(getAdsPowerProfileId(account))
}

export function getAdsPowerProfileId(account) {
  return String(account?.adsPowerId || account?.bitBrowserId || account?.browserProfileId || '').trim()
}

export function getAdsPowerWebContents(account, purpose = 'worker') {
  if (!isAdsPowerAccount(account)) return null
  const id = String(account?.id || '').trim()
  const profile = getAdsPowerProfileId(account)
  if (!id || !profile) throw new Error('AdsPower account requires adsPowerId')
  const normalizedPurpose = normalizePurpose(purpose)
  const key = `${id}:${normalizedPurpose}`
  const current = contentsByAccount.get(key)
  if (current && current.profileId === profile && !current.isDestroyed()) return current
  const priorClose = current ? trackClose(key, current) : lifecycleLocks.get(key)
  const next = new AdsPowerWebContents({ api, profileId: profile, purpose: normalizedPurpose })
  if (priorClose) next.setLifecycleReady(priorClose)
  contentsByAccount.set(key, next)
  return next
}

export function closeAdsPowerWebContents(accountId, purpose = null) {
  const id = String(accountId || '').trim()
  const prefix = `${id}:`
  const normalizedPurpose = purpose == null ? null : normalizePurpose(purpose)
  const closes = []
  for (const [key, current] of contentsByAccount.entries()) {
    if (!key.startsWith(prefix)) continue
    if (normalizedPurpose && key !== `${prefix}${normalizedPurpose}`) continue
    contentsByAccount.delete(key)
    closes.push(trackClose(key, current))
  }
  return Promise.all(closes)
}

export function closeAllAdsPowerWebContents() {
  const closes = []
  for (const [key, current] of contentsByAccount.entries()) {
    contentsByAccount.delete(key)
    closes.push(trackClose(key, current))
  }
  return Promise.all(closes)
}

export async function openAdsPowerProfile(account, { url = GOofishHome } = {}) {
  if (!isAdsPowerAccount(account)) {
    throw new Error('当前账号未绑定 AdsPower，请先在账号设置中绑定 AdsPower 环境')
  }
  const profile = getAdsPowerProfileId(account)
  if (!profile) {
    throw new Error('当前账号未配置 AdsPower 环境 ID，请先在账号设置中绑定 AdsPower 环境')
  }

  // The documented browser/open endpoint is also the foreground/focus path
  // for an already-open profile.  Calling it here is intentional: merely
  // reusing a CDP websocket can navigate the right tab while leaving the
  // AdsPower window behind the Electron shell, which is exactly the unsafe
  // preview behaviour this entry point replaces.
  let openError = null
  try {
    await api.open(profile)
  } catch (error) {
    openError = error
  }

  // AdsPower versions differ in whether browser/open returns an error for
  // an already-running profile.  If the profile still has a live CDP port,
  // continue with that explicitly opened profile; otherwise preserve the
  // official API error so the caller gets an actionable failure.
  if (openError) {
    const ports = portEntries(await api.ports().catch(() => null))
    const isOpen = ports.some((entry) => {
      const id = profileId(entry) || String(entry?.id || '').trim()
      return id === profile && Boolean(profilePort(entry) || profilePort({ port: entry?.port }))
    })
    if (!isOpen) throw openError
  }

  const contents = getAdsPowerWebContents(account, 'preview')
  await contents.ensureConnected()
  if (url) await contents.loadURL(url)
  return contents
}

export function adsPowerHealth() { return api.health() }
// AdsPower gates full profile enumeration (/api/v1/user/list) behind a paid
// subscription.  With one, every environment is listed; on the free tier the
// only thing the Local API will name is the set currently running, so fall
// back to that rather than leaving the account binding UI with nothing to pick
// from.  Operators can type an environment id by hand in either case.
//
// SECURITY: /api/v1/user/list answers with the environment's full record,
// including `user_proxy_config` with a plaintext proxy username and password.
// This function is what the renderer receives over IPC, so it is an explicit
// allowlist — never spread the raw profile into the result.
// 纯函数，便于离线回归直接覆盖真实映射（而不是在测试里重抄一遍）。
//
// SECURITY: `data` 里的原始条目带 user_proxy_config（明文 proxy_user /
// proxy_password）、环境账号密码和真实出口 IP。这里是**白名单**——永远不要
// 改成展开 ...profile。
export function mapProfileListing(data, running = [], group = '') {
  const wanted = String(group || '').trim()
  const runningIds = new Set(running.map((entry) => entry.id))

  const profiles = asArray(data).map((profile) => {
    const id = String(profile?.user_id || profileId(profile) || '').trim()
    return {
      id,
      name: String(profile?.name || profile?.remark || profile?.group_name || '').trim(),
      remark: String(profile?.remark || '').trim(),
      seq: profile?.serial_number ?? profile?.seq ?? null,
      status: runningIds.has(id) ? 'Active' : String(profile?.status || '').trim(),
      running: runningIds.has(id),
      group: String(profile?.group_name || '').trim()
    }
  }).filter((profile) => profile.id)

  // 归属过滤：设了分组就只列这个分组的环境，没有分组的环境谁也不碰
  // （opt-in——新建环境漏了分组只是不出现在这里，而不是被错误的一方接管）。
  if (profiles.length) return wanted ? profiles.filter((p) => p.group === wanted) : profiles

  // 免费版兜底：只有运行中的环境能被列出，且 local-active 不带分组信息，
  // 所以这条路径不做归属过滤——此时必须靠 config 侧人工确认归属。
  return running.map((entry) => ({
    id: entry.id,
    name: `运行中环境 ${entry.id}`,
    remark: data?.paidOnly ? 'AdsPower 免费版仅能列出运行中的环境，其余请手工填写环境 ID' : '',
    seq: null,
    status: 'Active',
    running: true,
    group: ''
  }))
}

export async function listAdsPowerProfiles({ group = '' } = {}) {
  const data = await api.listProfiles(1, 100)
  const running = await api.ports().catch(() => [])
  return mapProfileListing(data, running, group)
}

export async function hasAuthenticatedAdsPowerSession(account, { apiClient = api, WebSocketImpl = WebSocket } = {}) {
  // This is a read-only probe. Never call getAdsPowerWebContents/loadURL
  // here: those paths create/focus a tab and can show a login page for an
  // account that is merely not open. The scheduler may inspect an already
  // open Goofish tab, but it must not manufacture one during preflight.
  try {
    const profile = getAdsPowerProfileId(account)
    if (!profile) return false
    const ports = portEntries(await apiClient.ports().catch(() => null))
    const entry = ports.find((candidate) => profileId(candidate) === profile || String(candidate?.id || '') === profile)
    const port = profilePort(entry) || profilePort({ port: entry?.port })
    if (!port) return false
    const response = await apiClient.fetchImpl(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return false
    const pages = (await response.json())
      .filter((target) => target?.type === 'page' && target.webSocketDebuggerUrl)
      .filter((target) => /^https:\/\/(?:[^/]+\.)?goofish\.com\//i.test(`${target.url || ''}/`))
    if (!pages.length) return false
    for (const page of pages) {
      const probe = new AdsCDPSession(page.webSocketDebuggerUrl, WebSocketImpl)
      try {
        await probe.connect()
        const result = await probe.sendCommand('Runtime.evaluate', {
          expression: 'document.body?.innerText || ""',
          awaitPromise: false,
          returnByValue: true
        })
        const text = String(result?.result?.value || '')
        if (text && !/(扫码登录|请先登录|登录后查看更多|立即登录)/.test(text)) return true
      } catch {
        // A target can disappear while AdsPower is closing it; inspect the
        // next existing Goofish page instead of opening a replacement.
      } finally {
        probe.close()
      }
    }
    return false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 环境管理（新建 / 改用途 / 删除 / 登录态回读）
//
// 这一段是给「浏览器环境」这个界面用的：让人自己建环境、自己定用途、自己登录账号，
// 而不是拿这些当配置问题去问人。规矩全部照搬 adspower-executor 的 manage.py——
// 那边是拿线上事故换来的：
//   1. 分组即用途，建环境**必须**带 group_id，不给「建完忘了分组」留空档；
//   2. 用途不在登记表里直接拒绝，防打错字建出谁也不认领的孤儿环境；
//   3. 改分组只能用 user/regroup，且**改完读回校验**——user/update 会返回
//      code=0 "Success" 而 group_id 原封不动，是静默失败；
//   4. Local API 没有 group/delete，所以建分组一律先查后建，别留同名垃圾分组。
// ---------------------------------------------------------------------------

// 用途登记表的事实来源是本机代理（adspower-executor 的 manage.py broker）。
// 代理没起时用这份兜底，并如实告诉界面「归属保护当前不生效」——两处各抄一份
// 迟早会对不上，所以这份只是降级用，不参与判断谁对谁错。
//
// 它真对不上过一次：09-15 销售号从安卓 App 搬到浏览器、「销售」改归执行端，这里还
// 写着 desktop。代理一不在，「登录闲鱼」就只开浏览器不起执行端——号登上了，店铺却
// 永远长不出来。抄的是 adspower-executor/gc_ads/config.py 的 env_purposes，改要一起改。
const FALLBACK_PURPOSES = {
  行情: 'executor',
  采购: 'executor',
  销售: 'executor',
  未分配: 'none'
}

// 登录态锚点与执行端同源：页头昵称元素，且排掉未登录时的「登录」入口文案。
// 反向匹配（找"扫码登录"字样）会漏——未登录时 /im 页头就只写两个字「登录」。
const LOGIN_NICK_JS = `(() => {
  const ENTRY = ['登录','登录/注册','注册/登录','请登录','立即登录','登录注册','sign in','signin','login'];
  const el = [...document.querySelectorAll('[class*="nick--"]')].find(e => {
    const t = (e.textContent || '').trim();
    if (!t || ENTRY.includes(t.toLowerCase())) return false;
    return e.getBoundingClientRect().top < window.innerHeight * 0.15;
  });
  return el ? el.textContent.trim().slice(0, 40) : '';
})()`

/** 用途登记表：{ table, source }。source=broker 才代表归属保护真的在生效。 */
export async function fetchEnvPurposes({ apiClient = api } = {}) {
  try {
    const data = await apiClient.brokerHealth()
    const table = data?.purposes
    if (table && typeof table === 'object' && Object.keys(table).length) {
      return { table: { ...table }, source: 'broker' }
    }
  } catch {
    // 代理没起／直连 AdsPower 本体（本体没有 /broker/health）。不是错误，降级即可。
  }
  return { table: { ...FALLBACK_PURPOSES }, source: 'fallback' }
}

/**
 * 环境清单（纯函数，便于离线回归直接覆盖真实映射）。
 *
 * SECURITY: 原始条目里带 user_proxy_config —— 明文 proxy_user / proxy_password
 * 和真实出口 IP。这里是**白名单**，proxy 只折成一个布尔 hasProxy（「配没配」是
 * 运维要看的，凭据不是）。永远不要改成展开 ...profile。
 */
export function mapEnvListing(data, running = [], purposes = {}) {
  const runningIds = new Set(portEntries(running).map((entry) => profileId(entry) || String(entry?.id || '')))
  return asArray(data).map((profile) => {
    const id = String(profile?.user_id || profileId(profile) || '').trim()
    const group = String(profile?.group_name || '').trim()
    // 代理配没配：**优先信 has_proxy 这个显式布尔**。
    // AdsPower 的 user/list 不返回 user_proxy_config 明细（就是个空对象），
    // 只在 user/detail 里才有——光看明细会把配好代理的环境显示成「未配」，
    // 而「未配代理」在这套体系里是一句很重的话（等于说这个号跑不了活）。
    const proxySoft = String(profile?.user_proxy_config?.proxy_soft || '').trim().toLowerCase()
    const explicitProxy = typeof profile?.has_proxy === 'boolean' ? profile.has_proxy : null
    return {
      id,
      name: String(profile?.name || profile?.remark || '').trim(),
      seq: profile?.serial_number ?? null,
      group,
      // 没登记 = 人工新建、尚未纳管的环境。代理对它不做主（放行），
      // 界面如实显示「未登记」，而不是假装它归谁。
      owner: purposes[group] || '',
      hasProxy: explicitProxy !== null ? explicitProxy : (Boolean(proxySoft) && proxySoft !== 'no_proxy'),
      running: runningIds.has(id)
    }
  }).filter((env) => env.id)
}

/**
 * 用途登记表的增删改。
 *
 * 它就是「谁驱动哪批环境」的答案，以前写死在执行端源码里，改一次要找开发——
 * 而这是件随人随时间变的事。事实来源仍是本机代理（它按这张表强制归属），
 * 这里只是把读写接上界面。代理没起时**不允许改**：改了也没人执行，
 * 还会让人以为已经生效。
 */
export async function listEnvPurposes({ apiClient = api } = {}) {
  const data = await apiClient.listPurposes()
  return {
    purposes: data?.purposes || {},
    source: data?.source || 'config',
    validOwners: data?.valid_owners || ['executor', 'desktop', 'none']
  }
}

export async function saveEnvPurpose(name, owner, { apiClient = api } = {}) {
  const label = String(name || '').trim()
  if (!label) throw new Error('用途名不能为空')
  return apiClient.upsertPurpose(label, String(owner || '').trim())
}

export async function removeEnvPurpose(name, { apiClient = api } = {}) {
  const label = String(name || '').trim()
  if (!label) throw new Error('缺少用途名')
  return apiClient.deletePurpose(label)
}

/**
 * 执行端进程状态（按环境）。
 *
 * 为什么界面必须看得见它：归执行端驱动的环境，浏览器是**它**在管——人在界面上点
 * 「关闭浏览器」，一来会被归属规则 403（桌面端没资格驱动执行端的环境），二来就算关掉，
 * 执行端的自愈也会在几秒内把它重开。看不见这个进程，现场就只剩「关不掉」四个字。
 */
export async function listExecutors({ apiClient = api, local = null } = {}) {
  let data
  try {
    data = await apiClient.listExecutors()
  } catch (error) {
    if (!isBrokerDown(error) || !local) throw error
    return local.status()
  }
  const rows = Array.isArray(data?.executors) ? data.executors : []
  const map = {}
  for (const row of rows) {
    const id = String(row?.user_id || '').trim()
    if (!id) continue
    map[id] = { executor: String(row.executor || ''), browser: String(row.browser || '') }
  }
  return map
}

/**
 * 执行端控制：代理在就经代理；代理不在就交给本机直控（local，见 executor-local.js），
 * 它照着同一本台账做同一件事。只有「代理不在」才换路——代理在、但它说不行，
 * 那句话原样给人看。
 */
async function viaBrokerOrLocal(local, viaBroker, viaLocal) {
  try {
    return await viaBroker()
  } catch (error) {
    if (!isBrokerDown(error) || !local) throw error
    return viaLocal(local)
  }
}

export async function startExecutorFor(userId, { apiClient = api, local = null } = {}) {
  return viaBrokerOrLocal(local, () => apiClient.startExecutor(userId), (l) => l.start(userId))
}

/** 停执行端（可连浏览器一起关）。关浏览器必须走这条，不能只调 browser/stop。 */
export async function stopExecutorFor(userId, { stopBrowser = false, apiClient = api, local = null } = {}) {
  return viaBrokerOrLocal(local, () => apiClient.stopExecutor(userId, stopBrowser),
    (l) => l.stop(userId, stopBrowser))
}

export async function listEnvs({ apiClient = api, local = null } = {}) {
  const { table, source } = await fetchEnvPurposes({ apiClient })
  const data = await apiClient.listProfiles(1, 100)
  const running = await apiClient.ports().catch(() => null)
  let executors = {}
  try {
    executors = await listExecutors({ apiClient, local })
  } catch {
    // 读不到执行端状态（代理不在、本机也没找到执行端）时，环境清单照常给——少一列信息好过整页打不开
  }
  return {
    envs: mapEnvListing(data, running, table).map((e) => ({ ...e, ...(executors[e.id] || {}) })),
    purposes: table,
    purposeSource: source,
    paidOnly: Boolean(data?.paidOnly)
  }
}

function assertPurposeRegistered(purpose, table) {
  const name = String(purpose || '').trim()
  if (!name) throw new Error('必须选择环境用途：用途就是归属，没有用途的环境谁也不会驱动它')
  if (!table[name]) {
    throw new Error(`用途「${name}」不在登记表里（现有：${Object.keys(table).join(' / ')}）。`
      + '打错一个字就会建出谁也不认领的孤儿环境，所以这里直接拒绝。')
  }
  return name
}

/** 按名字取分组 id，没有就建一个。Local API 没有 group/delete，所以先查后建。 */
export async function ensureEnvGroup(name, { apiClient = api } = {}) {
  const wanted = String(name || '').trim()
  const groups = asArray(await apiClient.listGroups())
  const hit = groups.find((g) => String(g?.group_name || '').trim() === wanted)
  if (hit) return String(hit.group_id)
  const created = await apiClient.createGroup(wanted)
  const id = String(created?.group_id || created?.id || '').trim()
  if (!id) throw new Error(`AdsPower 建分组「${wanted}」没有返回 group_id`)
  return id
}

async function groupMemberIds(groupId, apiClient) {
  const data = await apiClient.listProfilesInGroup(groupId, 1, 100)
  return new Set(asArray(data).map((u) => String(u?.user_id || '').trim()).filter(Boolean))
}

/** 新建环境。proxy 留空 = 不走代理；凭据只透传给 AdsPower，不落库不回显。 */
export async function createEnv({ name, purpose, proxy = null } = {}, { apiClient = api } = {}) {
  const label = String(name || '').trim()
  if (!label) throw new Error('环境名不能为空：盘点时全靠它认人')
  const { table } = await fetchEnvPurposes({ apiClient })
  const group = assertPurposeRegistered(purpose, table)
  const groupId = await ensureEnvGroup(group, { apiClient })
  const created = await apiClient.createUser({
    group_id: groupId,
    name: label,
    user_proxy_config: proxy || { proxy_soft: 'no_proxy' }
  })
  const id = String(created?.id || created?.user_id || '').trim()
  if (!id) throw new Error('AdsPower 建环境没有返回 user_id')
  // 读回校验：不信返回码（regroup 那次就是接口报成功、东西没动）
  const landed = await groupMemberIds(groupId, apiClient)
  if (!landed.has(id)) {
    throw new Error(`AdsPower 报成功，但环境 ${id} 没落到分组「${group}」——请在 AdsPower 客户端里核对`)
  }
  return { id, name: label, group, owner: table[group] || '', hasProxy: Boolean(proxy) }
}

/** 改用途 = 换分组。改完必须读回校验。 */
export async function setEnvPurpose(userId, purpose, { apiClient = api } = {}) {
  const id = String(userId || '').trim()
  if (!id) throw new Error('缺少环境 ID')
  const { table } = await fetchEnvPurposes({ apiClient })
  const group = assertPurposeRegistered(purpose, table)
  const groupId = await ensureEnvGroup(group, { apiClient })
  await apiClient.regroup([id], groupId)
  const landed = await groupMemberIds(groupId, apiClient)
  if (!landed.has(id)) {
    throw new Error(`AdsPower 报成功，但环境 ${id} 仍不在分组「${group}」里`
      + '（user/regroup 的已知静默失败，所以这里读回校验）')
  }
  return { id, group, owner: table[group] || '' }
}

/** 删除环境。不可逆：指纹与 cookie 一并消失，登录态要重扫码。 */
export async function deleteEnvs(userIds = [], { apiClient = api } = {}) {
  const ids = asArray(userIds).map((u) => String(u || '').trim()).filter(Boolean)
  if (!ids.length) throw new Error('没有要删除的环境')
  await apiClient.deleteUsers(ids)
  const still = new Set(asArray(await apiClient.listProfiles(1, 100))
    .map((u) => String(u?.user_id || '').trim()))
  const left = ids.filter((id) => still.has(id))
  if (left.length) throw new Error(`AdsPower 报成功但环境仍在：${left.join(', ')}`)
  return { deleted: ids }
}

/**
 * 登录态回读：在环境已开的浏览器里找一张闲鱼页，读页头昵称。
 *
 * 纯只读，而且**完全绕开 Local API**——直连调试端口的 /json/list，所以不受归属
 * 守卫影响：归执行端驱动的环境，人也能在这里确认「到底登没登」。登录态 AdsPower
 * 的接口是看不到的，只能这样读。
 */
export async function probeEnvLogin(userId, { apiClient = api, WebSocketImpl = WebSocket, openTab = false } = {}) {
  const id = String(userId || '').trim()
  if (!id) throw new Error('缺少环境 ID')
  const ports = portEntries(await apiClient.ports().catch(() => null))
  const entry = ports.find((candidate) => (profileId(candidate) || String(candidate?.id || '')) === id)
  const port = profilePort(entry)
  if (!port) return { running: false, loggedIn: false, nick: '' }

  const listPages = async () => {
    const response = await apiClient.fetchImpl(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return []
    return (await response.json()).filter((t) => t?.type === 'page' && t.webSocketDebuggerUrl)
  }
  const isGoofish = (t) => /^https:\/\/(?:[^/]+\.)?goofish\.com\//i.test(`${t?.url || ''}/`)

  let pages = (await listPages()).filter(isGoofish)
  if (!pages.length && openTab) {
    // 人点了「打开闲鱼准备登录」才会走到这里：这时新建标签页正是他要的。
    // 其余路径一律不制造标签页（会把一个只是没开页的环境显示成未登录）。
    const session = await connectBrowserSession(port, WebSocketImpl, apiClient.fetchImpl)
    try {
      await session.sendCommand('Target.createTarget', { url: GOofishHome })
    } finally {
      session.close()
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    pages = (await listPages()).filter(isGoofish)
  }
  if (!pages.length) return { running: true, loggedIn: false, nick: '', reason: '环境里没有打开的闲鱼页' }

  for (const page of pages) {
    const probe = new AdsCDPSession(page.webSocketDebuggerUrl, WebSocketImpl)
    try {
      await probe.connect()
      const result = await probe.sendCommand('Runtime.evaluate', {
        expression: LOGIN_NICK_JS, awaitPromise: false, returnByValue: true
      })
      const nick = String(result?.result?.value || '').trim()
      if (nick) return { running: true, loggedIn: true, nick }
    } catch {
      // 标签页可能正在被关掉，换下一张，不去制造新的。
    } finally {
      probe.close()
    }
  }
  return { running: true, loggedIn: false, nick: '' }
}

// 闲鱼网页版按 PC 宽度排版。窗口窄了，发布页右半边被裁掉、出横向滚动条，执行端照
// DOM 坐标点下去落在看不见的地方——2026-10-06 现场：视口 824 宽（Windows 150% 缩放），
// 上架点「发布」点不动，用户看着像「移动端的样式」。AdsPower 开多大的窗由环境指纹和
// 客户端决定，这里不去改环境：开完浏览器看一眼窗口，不够宽就最大化。
// 执行端（gc_ads/driver.py）每次导航前也做同一件事，可已经装在工位上的执行端是 09-10
// 的老包、不能热更新，所以开窗这一步在行情台这边先做掉。
export const MIN_ENV_WINDOW_WIDTH = 1200

export async function widenEnvWindow(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 10,
  timeoutMs = 8000
} = {}) {
  if (!port) return { widened: false, reason: '浏览器没有调试端口' }
  const session = await connectBrowserSession(port, WebSocketImpl, fetchImpl)
  // CDP 命令本身不设超时：浏览器卡住时到点断开，挂着的命令随之报错退出
  const timer = setTimeout(() => session.close(), timeoutMs)
  try {
    // 刚 start 完，页面 target 可能还没建出来
    let page = null
    for (let i = 0; i < attempts && !page; i++) {
      const { targetInfos = [] } = await session.sendCommand('Target.getTargets')
      page = targetInfos.find((t) => t.type === 'page')
      if (!page) await sleep(300)
    }
    if (!page) return { widened: false, reason: '浏览器里还没有页面' }
    const { windowId, bounds = {} } = await session.sendCommand('Browser.getWindowForTarget', { targetId: page.targetId })
    // 已最大化/全屏就是这块屏能给的最大；最小化是人收起来的，不替人弹出来
    if (bounds.windowState && bounds.windowState !== 'normal') return { widened: false, state: bounds.windowState }
    if (Number(bounds.width) >= MIN_ENV_WINDOW_WIDTH) return { widened: false, width: bounds.width }
    await session.sendCommand('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } })
    return { widened: true, from: bounds.width }
  } finally {
    clearTimeout(timer)
    session.close()
  }
}

export async function startEnv(userId, { apiClient = api, WebSocketImpl = WebSocket } = {}) {
  const opened = await apiClient.open(String(userId || '').trim())
  // 放大窗口是顺手的事，做不到也不能耽误「浏览器开了」
  try {
    const widened = await widenEnvWindow(profilePort(opened), { fetchImpl: apiClient.fetchImpl, WebSocketImpl })
    if (widened.widened) console.info(`[adspower] 环境 ${userId} 窗口宽 ${widened.from}，已最大化`)
  } catch (error) {
    console.warn(`[adspower] 环境 ${userId} 放大窗口失败：${error?.message || error}`)
  }
  return opened
}

export async function stopEnv(userId, { apiClient = api } = {}) {
  return apiClient.close(String(userId || '').trim())
}

export { GOofishHome }


// ---------- 密码库填进 AdsPower（vault-ads.js 用；结果只在主进程里，不过 IPC） ----------

/** 本机 AdsPower 里全部环境 id。免费版列不出来，返回 null。 */
export async function adsAllProfileIds() {
  const ids = []
  for (let page = 1; page <= 50; page += 1) {
    const data = await api.listProfiles(page, 100)
    if (data?.paidOnly) return null
    const rows = asArray(data)
    for (const p of rows) if (p?.user_id) ids.push(String(p.user_id))
    if (rows.length < 100) break
  }
  return ids
}

export function adsWriteAccount(body) { return api.updateAccount(body) }
export function adsReadAccount(userId) { return api.profileRecord(userId) }
