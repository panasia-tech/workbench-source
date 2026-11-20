/**
 * 每轮检查/推送摘要上传到服务端，便于远程排查「为什么不推送」。
 * 控制量：只传计数和最多 5 条推送样本；同一任务连续结果相同的轮次合并成一行（repeat 计数）；
 * 默认每 60 秒传一次、每次最多 150 行，积压超过 300 行丢最旧的并告知服务端；频率与开关以服务端回包为准。
 */
import { app } from 'electron'
import { sxjkBackendPost } from './sxjk-backend-client.js'
import { getDeviceId } from './device-binding.js'

const MAX_ROWS_PER_FLUSH = 150
const MAX_PENDING = 300
const DEFAULT_INTERVAL_SEC = 60
const DISABLED_RETRY_MS = 30 * 60 * 1000

/** @type {Array<Record<string, unknown>>} */
let pending = []
/** 每个任务最后一行（用于合并相同结果） */
const lastByTask = new Map()
let dropped = 0
let intervalSec = DEFAULT_INTERVAL_SEC
let disabledUntil = 0
let timer = null
let flushing = false

function s(v, max) {
  return String(v ?? '').trim().slice(0, max)
}

/** 合并用的签名：去掉每轮都会变的搜索总量、页码 */
function signatureOf(row) {
  const summary = String(row.filterSummary || '')
    .replace(/总量\d+；?/g, '')
    .replace(/第\d+页；?/g, '')
    .replace(/可随机1~\d+页；?/g, '')
  return [row.kind, row.success ? 1 : 0, row.error, row.itemCount, row.dingtalkSkipped ? 1 : 0, summary].join('|')
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), intervalSec * 1000)
  timer.unref?.()
}

async function flush() {
  if (flushing) return
  if (!pending.length) return schedule()
  flushing = true
  const batch = pending.slice(0, MAX_ROWS_PER_FLUSH)
  try {
    const res = await sxjkBackendPost('/app/xy-sxjk/clientRoundLogs/report', {
      deviceCode: s(getDeviceId(app.getPath('userData')), 64),
      appVersion: app.getVersion(),
      dropped,
      rows: batch.map(({ sig, ...r }) => r)
    }, { timeoutMs: 20000 })
    const policy = res?.data && typeof res.data === 'object' && 'intervalSec' in res.data ? res.data : res
    pending = pending.slice(batch.length)
    dropped = 0
    for (const [k, v] of lastByTask) if (!pending.includes(v)) lastByTask.delete(k)
    const sec = Math.floor(Number(policy?.intervalSec))
    if (Number.isFinite(sec)) intervalSec = Math.min(600, Math.max(30, sec))
    if (policy?.enabled === false) {
      disabledUntil = Date.now() + DISABLED_RETRY_MS
      pending = []
      lastByTask.clear()
    }
  } catch {
    // 窗口未就绪或网络失败：留着下次再传，积压上限由 report 端控制
  } finally {
    flushing = false
    schedule()
  }
}

/**
 * @param {'check' | 'push' | 'shopPush'} kind
 * @param {Record<string, unknown>} entry 已写入本地日志的记录
 */
export function reportRoundLog(kind, entry) {
  try {
    if (Date.now() < disabledUntil) return
    const taskId = s(entry?.taskId, 64)
    if (!taskId) return
    const itemCount = Math.max(0, Math.floor(Number(entry?.itemCount)) || 0)
    // 推送日志每轮都写，只有真推了或出错才传；每轮概况走 check
    if (kind !== 'check' && !itemCount && !entry?.error && entry?.success !== false) return
    const items = Array.isArray(entry?.pushItems) ? entry.pushItems.slice(0, 5).map(x => ({
      itemId: s(x?.itemId, 32),
      title: s(x?.title, 60),
      price: s(x?.price, 24)
    })) : []
    const at = s(entry?.at, 40) || new Date().toISOString()
    const row = {
      kind,
      taskId,
      keyword: s(entry?.keyword, 120),
      at,
      lastAt: at,
      repeat: 1,
      success: entry?.success !== false,
      error: s(entry?.error, 300),
      filterSummary: s(entry?.filterSummary, 600),
      itemCount,
      dingtalkSkipped: entry?.dingtalkSkipped === true,
      pollAccountId: s(entry?.pollAccountId, 64),
      ...(items.length ? { items } : {})
    }
    row.sig = signatureOf(row)
    const key = `${kind}|${taskId}`
    const last = lastByTask.get(key)
    if (last && last.sig === row.sig && pending.includes(last)) {
      last.repeat += 1
      last.lastAt = at
      return
    }
    pending.push(row)
    lastByTask.set(key, row)
    if (pending.length > MAX_PENDING) {
      dropped += pending.length - MAX_PENDING
      pending = pending.slice(-MAX_PENDING)
    }
    if (!timer) schedule()
  } catch {}
}
