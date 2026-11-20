// 本地日志：按天落盘、保留 30 天，并能按服务端的要求打包回传。
//
// 从前桌面端只有 console —— 操作员那边一出问题，除了让他截图别无他法，而窗口一关
// 什么都没了。这里做三件事：
//   1. console.log/warn/error 同时写进按天切分的文件；
//   2. 只留最近 30 天，更久的自动删（没人会看三个月前的日志，只会占盘）；
//   3. 能把最近 N 天打成一个 .log.gz 交回服务端 —— 服务端下待办，端上启动时与每 10 分钟各问一次。
//
// 一条纪律：日志是要离开这台机器的，所以打包前统一打码。桌面端手上有 ERP 令牌、
// AdsPower 代理凭据，宁可日志难看，也不能把登录态送出去。
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import path from 'path'
import { gzipSync } from 'zlib'

const KEEP_DAYS = 30
const MAX_FILE_BYTES = 8 * 1024 * 1024      // 单个文件进包时的上限，超了只取尾部

// 会出现在日志里的凭据。这份名单宁可宽一点。
const SECRET_PATTERN = /((?:token|secret|password|passwd|pwd|sid|authorization|bearer|api[_-]?key)["'=:\s]+)([A-Za-z0-9_\-%.+/]{6,})/gi

export function redact(text) {
  if (!text) return text
  return String(text).replace(SECRET_PATTERN, (_m, k, v) => `${k}<redacted:${v.length}>`)
}

// electron 只在真的跑在主进程里时才 require —— 纯 Node 回归要能直接 import 这个文件。
// 用 GC_DESKTOP_LOG_DIR 覆盖目录（与执行端那侧 GC_ADS_PURPOSES_FILE 同一个路子）。
function userDataDir() {
  const override = process.env.GC_DESKTOP_LOG_DIR
  if (override) return override
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron')
  return path.join(app.getPath('userData'), 'logs')
}

export function logDir() {
  const dir = userDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function appVersion() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron').app.getVersion()
  } catch {
    return ''
  }
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let stream = null
let streamDay = ''

function writeLine(level, args) {
  try {
    const day = today()
    if (!stream || streamDay !== day) {
      stream?.end()
      streamDay = day
      stream = createWriteStream(path.join(logDir(), `desktop-${day}.log`), { flags: 'a' })
    }
    const text = args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    }).join(' ')
    stream.write(`${new Date().toISOString()} ${level} ${text}\n`)
  } catch {
    // 写日志本身绝不能把应用带崩
  }
}

/** 接管 console 并落盘。重复调用无副作用。 */
export function installFileLogging() {
  if (globalThis.__gcFileLogging) return
  globalThis.__gcFileLogging = true
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      original(...args)
      writeLine(level.toUpperCase(), args)
    }
  }
  process.on('uncaughtException', (err) => writeLine('FATAL', ['uncaughtException', err]))
  process.on('unhandledRejection', (err) => writeLine('FATAL', ['unhandledRejection', err]))
  pruneOldLogs()
  console.log(`[logs] 本地日志目录 ${logDir()}（按天切分，保留 ${KEEP_DAYS} 天）`)
}

/** 删掉超过保留期的日志。返回删掉的文件名。 */
export function pruneOldLogs(keepDays = KEEP_DAYS) {
  const cutoff = Date.now() - keepDays * 86400_000
  const removed = []
  for (const name of safeList()) {
    const full = path.join(logDir(), name)
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
        removed.push(name)
      }
    } catch { /* 正被写/被占用：下轮再说 */ }
  }
  return removed
}

function safeList() {
  try {
    return readdirSync(logDir()).filter((n) => n.endsWith('.log'))
  } catch {
    return []
  }
}

/**
 * 把最近 days 天的日志打成一个 .log.gz（内存里）。逐文件打码后再压。
 *
 * 为什么不打 zip：Node 没有内置的 zip 写入，而**桌面端不能引新依赖**——热更新只替换
 * out/，装了新 npm 包的机器上根本没有那个包，一上线就是 MODULE_NOT_FOUND。
 * zlib 是内置的，gz 里放一份带分隔符的纯文本，任何机器都打得开，也够排障用。
 */
export function collectLogs(days = 7) {
  const cutoff = Date.now() - Math.max(1, days) * 86400_000
  const parts = [
    `# 卖家工作台 本地日志`,
    `# collected_at=${new Date().toISOString()} days=${days} keep_days=${KEEP_DAYS} version=${appVersion()}`,
    ''
  ]
  for (const name of safeList()) {
    const full = path.join(logDir(), name)
    try {
      if (statSync(full).mtimeMs < cutoff) continue
      let text = readFileSync(full, 'utf8')
      if (text.length > MAX_FILE_BYTES) {
        // 排障要的是最近发生了什么，不是开头
        text = `...(truncated, tail only)...\n${text.slice(-MAX_FILE_BYTES)}`
      }
      parts.push(`===== ${name} =====`, redact(text), '')
    } catch { /* 跳过读不了的 */ }
  }
  return gzipSync(Buffer.from(parts.join('\n'), 'utf8'))
}

export function logSummary() {
  const names = safeList()
  if (!names.length) return { files: 0, bytes: 0, oldest: null, keepDays: KEEP_DAYS }
  let bytes = 0
  let oldest = Infinity
  for (const n of names) {
    try {
      const st = statSync(path.join(logDir(), n))
      bytes += st.size
      oldest = Math.min(oldest, st.mtimeMs)
    } catch { /* ignore */ }
  }
  return {
    files: names.length,
    bytes,
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString().slice(0, 10) : null,
    keepDays: KEEP_DAYS
  }
}

// ---------------------------------------------------------------------------
// 回传：服务端下待办，端上问一句就传。
//
// 桌面端没有心跳，所以自己问：**启动时一次 + 之后每 10 分钟一次**。这正好覆盖
// 「在线时」与「不在线就下次启动」两种情况——和执行端挂在心跳上是同一个道理。
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10 * 60_000
const done = new Set()      // 本进程已处理过的待办 id：上传要几十秒，不记会重复传

/**
 * 本机 id：一台机器一个，落在 electron-store 里。
 * 不用 MAC/主机名——换网卡、改名字都会让它变，而这是日志归属的唯一线索。
 */
export function clientId(store) {
  const existing = store.getSettings?.()?.clientId
  if (existing) return existing
  const id = `desktop-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  try { store.setSettings({ clientId: id }) } catch { /* 存不下就每次新生成，不影响功能 */ }
  return id
}

export async function checkAndUploadLogs({ gcGet, gcUpload, store, days = null } = {}) {
  const id = clientId(store)
  let req
  try {
    const data = await gcGet('/logs/pending', { owner_kind: 'desktop', owner_id: id })
    req = data?.log_request
  } catch {
    return { ok: false, reason: '问不到待办（服务端不可达）' }
  }
  if (!req || done.has(req.id)) return { ok: true, idle: true }
  done.add(req.id)
  try {
    const blob = collectLogs(days || req.days || 7)
    await gcUpload(req.id, blob, `${id}.log.gz`)
    console.log(`[logs] 已回传日志 ${req.id}（最近 ${req.days} 天，${(blob.length / 1048576).toFixed(1)}MB）`)
    return { ok: true, uploaded: req.id, bytes: blob.length }
  } catch (error) {
    done.delete(req.id)      // 传失败就留着，下一轮再来
    console.warn('[logs] 日志回传失败：', error?.message || error)
    return { ok: false, reason: String(error?.message || error) }
  }
}

export function startLogAgent(deps) {
  const tick = () => { void checkAndUploadLogs(deps) }
  setTimeout(tick, 15_000)            // 启动后等一会儿：先让登录态就绪
  const timer = setInterval(tick, POLL_INTERVAL_MS)
  const prune = setInterval(() => pruneOldLogs(), 6 * 3600_000)
  return () => { clearInterval(timer); clearInterval(prune) }
}
