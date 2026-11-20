// 调度：拉全量任务 → 本地按启用账号轮询切片 → 每账号一个串行队列并发跑 → 上报 + 记日志。
// 进度通过 onEvent 回调推给渲染层。每日定时也在这里。
import { fetchTasks, uploadPrice } from './api.js'
import { crawlOne } from './goofish.js'
import { getWebContents, recycleView } from './session-manager.js'
import { addResult, getAccounts, getSettings } from './store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 任务间隔：在 [min, max] 内取随机延迟（更像真人、降低风控）
function randomDelay(settings) {
  let min = Number(settings.throttleMinMs) || 1500
  let max = Number(settings.throttleMaxMs) || 3500
  if (max < min) [min, max] = [max, min]
  return Math.round(min + Math.random() * (max - min))
}

let running = false
let stopRequested = false
let emit = () => {} // 进度事件回调（main 注入）
let dailyTimer = null

export function setEmitter(fn) {
  emit = fn || (() => {})
}

export function isRunning() {
  return running
}

/** 把任务按启用账号轮询切片，返回 [{account, tasks:[...]}] */
export function planDistribution(tasks, accounts) {
  const enabled = accounts.filter((a) => a.enabled)
  if (!enabled.length) return []
  const buckets = enabled.map((a) => ({ account: a, tasks: [] }))
  tasks.forEach((t, i) => buckets[i % buckets.length].tasks.push(t))
  return buckets
}

/** 预览/账号页用：算每个账号会分到多少词（不实际爬） */
export async function previewPlan() {
  const tasks = await fetchTasks()
  const settings = getSettings()
  const limited = settings.maxTasks > 0 ? tasks.slice(0, settings.maxTasks) : tasks
  const buckets = planDistribution(limited, getAccounts())
  return {
    total: limited.length,
    buckets: buckets.map((b) => ({ accountId: b.account.id, accountName: b.account.name, count: b.tasks.length }))
  }
}

// 这些症状通常意味着渲染进程已崩/已销毁，重建视图后当条可救回来
const CRASH_PATTERN = /页面无响应|导航失败|destroyed|crashed|Render process gone/i

async function runBucket(bucket, settings, counters) {
  const recycleEvery = Number(settings.recycleEvery) || 0
  let done = 0
  for (const task of bucket.tasks) {
    if (stopRequested) break
    // 每爬 N 条主动销毁重建视图，释放渲染进程积累的内存（长任务列表防崩）
    if (recycleEvery > 0 && done > 0 && done % recycleEvery === 0) {
      recycleView(bucket.account.id)
    }
    done++
    emit('progress', { accountId: bucket.account.id, accountName: bucket.account.name, current: task.name })
    let res
    try {
      res = await crawlOne(getWebContents(bucket.account), task.keyword || task.name, { accountName: bucket.account.name })
    } catch (e) {
      res = { ok: false, reason: '爬取异常: ' + (e?.message || e) }
    }
    // 疑似渲染进程崩溃：重建视图重试一次
    if (!res.ok && !res.empty && CRASH_PATTERN.test(res.reason || '')) {
      recycleView(bucket.account.id)
      try {
        res = await crawlOne(getWebContents(bucket.account), task.keyword || task.name, { accountName: bucket.account.name })
      } catch (e) {
        res = { ok: false, reason: '爬取异常(重试后): ' + (e?.message || e) }
      }
    }

    const base = {
      name: task.name,
      keyword: task.keyword || task.name,
      account: bucket.account.name,
      at: new Date().toISOString()
    }

    if (res.ok) {
      try {
        await uploadPrice({ productId: task.id, price: res.price, raw: res.raw })
        counters.success++
        addResult({ ...base, price: res.price, source: res.source, status: 'success' })
      } catch (e) {
        counters.fail++
        const detail = e?.response?.data?.detail || e?.message || '上报失败'
        addResult({ ...base, price: res.price, source: res.source, status: 'fail', reason: '上报失败: ' + JSON.stringify(detail) })
      }
    } else if (res.empty) {
      // 闲鱼无此商品在售：不算失败，也不上报脏价
      counters.empty++
      addResult({ ...base, status: 'empty', reason: res.reason })
    } else {
      counters.fail++
      addResult({ ...base, status: 'fail', reason: res.reason })
    }

    emit('counters', { ...counters })
    if (!stopRequested) await sleep(randomDelay(settings))
  }
}

/** 开始一轮爬取（所有启用账号并发，各自串行其分片） */
export async function start() {
  if (running) return { ok: false, reason: '已在运行中' }
  running = true
  stopRequested = false
  const counters = { success: 0, fail: 0, empty: 0, total: 0 }
  try {
    const settings = getSettings()
    const tasks = await fetchTasks()
    const limited = settings.maxTasks > 0 ? tasks.slice(0, settings.maxTasks) : tasks
    const buckets = planDistribution(limited, getAccounts())
    if (!buckets.length) {
      running = false
      return { ok: false, reason: '没有启用的账号' }
    }
    counters.total = limited.length
    emit('start', { total: counters.total, buckets: buckets.map((b) => ({ accountName: b.account.name, count: b.tasks.length })) })
    await Promise.all(buckets.map((b) => runBucket(b, settings, counters)))
    emit('done', { ...counters, stopped: stopRequested })
    return { ok: true, ...counters, stopped: stopRequested }
  } catch (e) {
    emit('error', { message: e?.response?.data?.detail || e?.message || String(e) })
    return { ok: false, reason: e?.message || String(e) }
  } finally {
    running = false
  }
}

export function stop() {
  stopRequested = true
  return { ok: true }
}

// ---------- 每日定时 ----------
export function rearmDaily() {
  if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
  // 每分钟检查一次是否到点（简单稳健，避免长 setTimeout 漂移）
  dailyTimer = setInterval(() => {
    const s = getSettings()
    if (!s.dailyEnabled || running) return
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    if (hhmm === (s.dailyTime || '09:00')) {
      emit('daily-trigger', { time: hhmm })
      start()
    }
  }, 60 * 1000)
}
