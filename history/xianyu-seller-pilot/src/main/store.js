// 持久化：服务器地址 / 加密 token / 登录信息 / 账号配置 / 设置 / 爬取结果日志
import { randomUUID } from 'crypto'
import electron from 'electron'
import Store from 'electron-store'
import { isPrimaryInstance } from './instance.js'
import { makeResilientStore } from './safe-store.js'

// Electron exposes this module as CommonJS in plain Node regression runs and
// as an ESM-compatible default in the packaged main process. Using the
// default keeps the protected-secret adapter loadable by both environments.
const { safeStorage } = electron

// 服务器地址是配置项，这里只是出厂默认值：换一套 ERP 部署（测试环境、自建）时
// 在登录页或库存连接设置里改，不需要重新打包。
export const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8000'

const store = new Store({
  name: 'xianyu-electron',
  defaults: {
    serverBaseUrl: DEFAULT_SERVER_BASE_URL,
    tokenEnc: null, // safeStorage 加密后的 base64
    // WMS credentials are kept separate from the task-center JSON.  There is
    // deliberately no plaintext fallback: without OS encryption the WMS
    // connection remains unavailable instead of creating another secret copy.
    wmsSecretsEnc: null,
    staff: null, // { id, username, role }
    localMode: false, // 本机 Excel 任务模式，不依赖大模型或服务端任务接口
    accounts: [], // [{ id, name, partition, enabled }]
    settings: {
      throttleMinMs: 12000, // 任务间隔下限（保守节奏）
      throttleMaxMs: 20000, // 任务间隔上限（运行时在 [min,max] 内取随机延迟）
      queryDelayMinMs: 8000, // 同一任务多个关键词搜索之间的间隔
      queryDelayMaxMs: 14000,
      rateSafetyVersion: 2,
      dailyEnabled: false,
      dailyTime: '09:00',
      closeToTray: true,
      maxTasks: 0, // 0=不限；>0 用于联调时只跑前 N 个
      recycleEvery: 50, // 每爬 N 条销毁重建浏览器视图释放内存，0=不重建
      // 只认领这个 AdsPower 分组里的环境（环境归属边界）。同机上 adspower-executor
      // 也在驱动 AdsPower，两边必须各管各的环境，否则会抢同一个浏览器的标签页。
      // 桌面端拿「销售」，执行端拿「行情」；留空 = 不过滤（列出全部环境）。
      adsPowerGroup: '销售',
      // AdsPower 本体 Local API 的地址。50325 是官方默认端口，但各机可能不同
      // （AdsPower 自己能改，装多个版本也会错开），所以摆出来让人改，别让他
      // 对着一个写死的端口干瞪眼。代理那条（50326）是我们自己的组件，不开放。
      adsPowerDirectUrl: 'http://127.0.0.1:50325'
    },
    results: [] // 爬取结果日志（最新在前），上限见 RESULT_CAP
  }
})

// 所有写盘都经过重试和友好错误；读不会碰锁，不包。
makeResilientStore(store, '保存登录配置')
// 当前进程是否已经按“退出登录”处理过。写盘失败时磁盘里可能还是旧 token，
// 但本次运行必须立刻回到未登录，否则退出登录/重新登录会卡死。
let authMemoryCleared = false

const RESULT_CAP = 5000

const storedSettings = store.get('settings') || {}
if (Number(storedSettings.rateSafetyVersion) < 2 || Number(storedSettings.throttleMinMs) < 8000 || Number(storedSettings.throttleMaxMs) < 8000 || Number(storedSettings.queryDelayMinMs) < 5000) {
  // 第二个实例不写；主实例写失败也只记日志，启动阶段不能因为配置被锁整个起不来。
  if (isPrimaryInstance) {
    try {
      store.set('settings', {
        ...storedSettings,
        throttleMinMs: 12000,
        throttleMaxMs: 20000,
        queryDelayMinMs: 8000,
        queryDelayMaxMs: 14000,
        rateSafetyVersion: 2
      })
    } catch (error) {
      console.error('[store] 初始化设置写盘失败：', error?.message || error)
    }
  }
}

// ---------- token（safeStorage 加密） ----------
export function setToken(token) {
  if (!token) {
    store.set('tokenEnc', null)
    authMemoryCleared = true
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('tokenEnc', safeStorage.encryptString(token).toString('base64'))
  } else {
    // 兜底：明文（极少数无 keychain 环境）
    store.set('tokenEnc', 'plain:' + token)
  }
  authMemoryCleared = false
}

export function getToken() {
  if (authMemoryCleared) return null
  const enc = store.get('tokenEnc')
  if (!enc) return null
  if (enc.startsWith('plain:')) return enc.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function clearAuth() {
  const errors = []
  for (const [key, value] of [['tokenEnc', null], ['staff', null], ['localMode', false]]) {
    try {
      store.set(key, value)
    } catch (error) {
      errors.push(error)
    }
  }
  // 不管写盘成没成，当前进程先按未登录走；否则旧 token 会一直挡住重新登录。
  authMemoryCleared = true
  if (errors.length) return { ok: false, reason: errors[0].message }
  return { ok: true }
}

function encryptionAvailable() {
  try {
    return Boolean(safeStorage.isEncryptionAvailable())
  } catch {
    return false
  }
}

// ---------- 记住的账号密码（本机，safeStorage 加密） ----------
// 密码只在系统钥匙串能加密时才记；加密不了就只记账号——明文密码落盘，等于把员工
// 账号交给任何能翻这台电脑文件的人。退出登录不清它：记住就是为了下次登录页直接填好。
export function getRememberedLogin() {
  const saved = store.get('rememberedLogin')
  if (saved?.off) return { off: true }   // 上次特意没勾「记住」，登录页别再替人勾上
  if (!saved?.username) return null
  let password = ''
  if (saved.passwordEnc && encryptionAvailable()) {
    try {
      password = safeStorage.decryptString(Buffer.from(saved.passwordEnc, 'base64'))
    } catch {
      password = ''   // 换了系统账号/钥匙串，旧密文解不开：只填账号，让人重输密码
    }
  }
  return { username: String(saved.username), password }
}

export function setRememberedLogin(username, password) {
  const passwordEnc = password && encryptionAvailable()
    ? safeStorage.encryptString(String(password)).toString('base64')
    : null
  store.set('rememberedLogin', { username: String(username || ''), passwordEnc })
  return { passwordSaved: Boolean(passwordEnc) }
}

/** 不记了：连同「不想记」这个选择一起存下，下次登录页的勾选框保持不勾。 */
export function clearRememberedLogin() {
  store.set('rememberedLogin', { off: true })
}

function normalizeWmsSecrets(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    mcpKey: String(source.mcpKey ?? source.wmsMcpKey ?? '').trim(),
    restUsername: String(source.restUsername ?? source.wmsRestUsername ?? '').trim(),
    restPassword: String(source.restPassword ?? source.wmsRestPassword ?? '')
  }
}

export function setWmsSecrets(value = {}, { merge = true } = {}) {
  if (!encryptionAvailable()) return { ok: false, reason: 'safe_storage_unavailable', configured: false }
  const current = merge ? getWmsSecrets() : {}
  const next = normalizeWmsSecrets({ ...current, ...value })
  const hasAny = Object.values(next).some(Boolean)
  try {
    const payload = Buffer.from(JSON.stringify(next), 'utf8')
    store.set('wmsSecretsEnc', hasAny ? safeStorage.encryptString(payload.toString('base64')).toString('base64') : null)
    return { ok: true, configured: hasAny, status: getWmsSecretStatus() }
  } catch {
    return { ok: false, reason: 'safe_storage_write_failed', configured: false }
  }
}

export function getWmsSecrets() {
  const encoded = store.get('wmsSecretsEnc')
  if (!encoded || !encryptionAvailable()) return { mcpKey: '', restUsername: '', restPassword: '' }
  try {
    const json = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    return normalizeWmsSecrets(JSON.parse(Buffer.from(json, 'base64').toString('utf8')))
  } catch {
    return { mcpKey: '', restUsername: '', restPassword: '' }
  }
}

export function getWmsSecretStatus() {
  const value = getWmsSecrets()
  return {
    safeStorageAvailable: encryptionAvailable(),
    wmsMcpKeyConfigured: Boolean(value.mcpKey),
    wmsRestUsernameConfigured: Boolean(value.restUsername),
    wmsRestPasswordConfigured: Boolean(value.restPassword),
    configured: Boolean(value.mcpKey || (value.restUsername && value.restPassword))
  }
}

/**
 * 清空回写管理账号，保留 MCP 密钥。
 *
 * 保存那边「留空 = 保持不变」（避免手滑清掉密钥），代价是写错一次就再也删不掉，
 * 而一组过期凭据会一直挡在回写路径上。所以清除必须是一个显式动作。
 */
/**
 * 升级即清除：把盘上存的那组「回写管理账号」凭据抹掉。
 *
 * 它是回写只放行 ADMIN/仓管时代的产物——为了改一个商品名，每台工位上存着一份能读
 * 全部成本/财务、还能改货号和 69 码的管理员密码。窄接口（MARKET_BOT）上线后回写
 * 用的是设备账号自己的令牌，这组凭据既没用处又是风险，不该等人想起来手动删。
 *
 * 静默执行：安全存储不可用时直接跳过，不打断启动。
 */
export function purgeLegacyWmsAdminCredentials() {
  try {
    if (!encryptionAvailable()) return { ok: false, reason: 'safe_storage_unavailable' }
    const current = getWmsSecrets()
    if (!current.restUsername && !current.restPassword) return { ok: true, changed: false }
    const result = setWmsSecrets({ ...current, restUsername: '', restPassword: '' }, { merge: false })
    return { ...result, changed: Boolean(result.ok) }
  } catch {
    return { ok: false, reason: 'purge_failed' }
  }
}

export function clearWmsRestCredentials() {
  if (!encryptionAvailable()) return { ok: false, reason: 'safe_storage_unavailable' }
  const current = getWmsSecrets()
  return setWmsSecrets({ ...current, restUsername: '', restPassword: '' }, { merge: false })
}

/** Migrate legacy task-center settings only after protected write succeeds. */
export function migrateLegacyWmsSecrets(legacy = {}) {
  const value = normalizeWmsSecrets(legacy)
  const hasAny = Object.values(value).some(Boolean)
  if (!hasAny) return { ok: true, changed: false, configured: getWmsSecretStatus().configured }
  const result = setWmsSecrets(value, { merge: false })
  if (!result.ok) return { ...result, changed: false }
  return { ...result, changed: true }
}

export const getLocalMode = () => (authMemoryCleared ? false : !!store.get('localMode'))
export const setLocalMode = (enabled) => {
  store.set('localMode', !!enabled)
  if (enabled) authMemoryCleared = false
}

// ---------- 通用 getter/setter ----------
/**
 * 规范化并校验用户填的服务器地址。
 *
 * 以前这里只 trim 加去尾斜杠，写错或留空都会照存不误，之后每个请求都拿一个
 * 坏 baseURL 去发，报出来的错完全指不到病根。地址是配置项就得在入口校一次。
 */
export function normalizeServerBaseUrl(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '')
  if (!raw) throw new Error('服务器地址不能为空')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`服务器地址格式无效，例如 ${DEFAULT_SERVER_BASE_URL}`)
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('服务器地址只支持 http/https')
  if (parsed.username || parsed.password) throw new Error('服务器地址里不能带账号密码')
  if (parsed.search || parsed.hash) throw new Error('服务器地址不能带查询参数或锚点')
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
  if (parsed.protocol === 'http:' && !isLoopback) throw new Error('只有本机调试地址可以用 http，线上必须 https')
  // 各处调用统一拼 '/api'，地址末尾再写一次 /api 是最常见的手误，会拼成 /api/api。
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '')
  return `${parsed.origin}${path}`
}

export const getServerBaseUrl = () => store.get('serverBaseUrl') || DEFAULT_SERVER_BASE_URL
export function setServerBaseUrl(v) {
  const next = normalizeServerBaseUrl(v)
  store.set('serverBaseUrl', next)
  return next
}
export const getStaff = () => (authMemoryCleared ? null : store.get('staff'))
export const setStaff = (v) => {
  store.set('staff', v)
  if (v) authMemoryCleared = false
}
export function getSettings() {
  const s = { ...store.get('settings') }
  if (Number(s.rateSafetyVersion) < 2 || Number(s.throttleMinMs) < 8000 || Number(s.throttleMaxMs) < 8000 || Number(s.queryDelayMinMs) < 5000) {
    s.throttleMinMs = 12000
    s.throttleMaxMs = 20000
    s.queryDelayMinMs = 8000
    s.queryDelayMaxMs = 14000
    s.rateSafetyVersion = 2
    store.set('settings', s)
  }
  // 兼容老配置：单值 throttleMs → min/max
  if (s.throttleMinMs == null || s.throttleMaxMs == null) {
    const base = s.throttleMs || 2200
    s.throttleMinMs = s.throttleMinMs ?? Math.max(500, Math.round(base * 0.7))
    s.throttleMaxMs = s.throttleMaxMs ?? Math.round(base * 1.6)
    delete s.throttleMs
    store.set('settings', s)
  }
  // 兼容老配置：无 recycleEvery 时补默认值
  if (s.recycleEvery == null) {
    s.recycleEvery = 50
    store.set('settings', s)
  }
  // 兼容老配置：环境归属分区是后加的。存量安装没有这个字段，若留空会继续
  // 认领全部环境——包括归 adspower-executor 的那批，两边就会抢标签页。
  // 所以补默认值时要显式写成「销售」，而不是留空。
  if (s.adsPowerGroup == null) {
    s.adsPowerGroup = '销售'
    store.set('settings', s)
  }
  return s
}
export function setSettings(patch = {}) {
  const next = { ...store.get('settings'), ...patch }
  next.throttleMinMs = Math.max(8000, Number(next.throttleMinMs) || 12000)
  next.throttleMaxMs = Math.max(next.throttleMinMs, Number(next.throttleMaxMs) || 20000)
  next.queryDelayMinMs = Math.max(5000, Number(next.queryDelayMinMs) || 8000)
  next.queryDelayMaxMs = Math.max(next.queryDelayMinMs, Number(next.queryDelayMaxMs) || 14000)
  next.rateSafetyVersion = 2
  store.set('settings', next)
  return next
}

// ---------- 账号 ----------
// Accounts written before the BitBrowser → AdsPower swap carry `bitBrowserId`
// and `browserProvider: 'bitbrowser'`.  The stored id is an environment handle
// belonging to the old vendor, so it cannot be reused as-is — it is surfaced
// under `legacyBitBrowserId` for the UI to warn about and is deliberately NOT
// promoted to `adsPowerId`.  Rebinding to an AdsPower environment is a manual
// step; silently inheriting the id would point the adapter at an environment
// that does not exist in AdsPower.
export function normalizeAccount(account = {}) {
  const legacyProfile = String(account?.bitBrowserId || '').trim()
  const adsPowerId = String(account?.adsPowerId || account?.browserProfileId || '').trim()
  const declared = String(account?.browserProvider || '').trim().toLowerCase()
  const provider = adsPowerId ? 'adspower' : (declared === 'bitbrowser' ? 'electron' : (declared || 'electron'))
  const normalized = {
    ...account,
    adsPowerId,
    browserProvider: provider
  }
  delete normalized.bitBrowserId
  if (legacyProfile && !adsPowerId) normalized.legacyBitBrowserId = legacyProfile
  return normalized
}

export const getAccounts = () => store.get('accounts').map(normalizeAccount)

function assertUniqueAdsPowerProfiles(accounts) {
  const profiles = new Set()
  for (const account of accounts) {
    const provider = String(account?.browserProvider || '').trim().toLowerCase()
    const profileId = String(account?.adsPowerId || account?.browserProfileId || '').trim()
    if (provider !== 'adspower' && !profileId) continue
    if (!profileId) throw new TypeError(`account ${String(account?.id || '')} requires an AdsPower profile`)
    if (profiles.has(profileId)) throw new TypeError(`duplicate AdsPower profile: ${profileId}`)
    profiles.add(profileId)
  }
}

export function addAccount(name) {
  const id = randomUUID()
  const acc = {
    id,
    name: (name || '').trim() || '账号',
    partition: `persist:xianyu-${id}`,
    enabled: true,
    browserProvider: 'electron',
    adsPowerId: ''
  }
  store.set('accounts', [...store.get('accounts'), acc])
  return acc
}

export function updateAccount(id, patch) {
  const list = store.get('accounts').map((a) => (a.id === id ? { ...a, ...patch } : a))
  assertUniqueAdsPowerProfiles(list)
  store.set('accounts', list)
  return list.find((a) => a.id === id) || null
}

export function removeAccount(id) {
  store.set('accounts', store.get('accounts').filter((a) => a.id !== id))
}

// ---------- 爬取结果日志 ----------
export function addResult(row) {
  const list = store.get('results')
  list.unshift({ id: randomUUID(), ...row })
  if (list.length > RESULT_CAP) list.length = RESULT_CAP
  store.set('results', list)
}

export function queryResults({ q = '', status = null, page = 1, pageSize = 50 } = {}) {
  let list = store.get('results')
  const kw = (q || '').trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (r) =>
        (r.name || '').toLowerCase().includes(kw) ||
        (r.keyword || '').toLowerCase().includes(kw) ||
        (r.account || '').toLowerCase().includes(kw)
    )
  }
  if (status) list = list.filter((r) => r.status === status)
  const total = list.length
  const start = (page - 1) * pageSize
  return { items: list.slice(start, start + pageSize), total }
}

export function clearResults() {
  store.set('results', [])
}
