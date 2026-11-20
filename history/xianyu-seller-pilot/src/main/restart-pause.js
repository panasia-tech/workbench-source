// 「暂停，准备重启电脑」与重启后接着干（2026-10-27）。
//
// 工位 Windows 电脑跑久了会卡死，要定期重启。直接重启有三个坑：
//   - 手上正在做的任务被掐断（发布做到一半、消息回到一半）；
//   - 浏览器没正常关，AdsPower 来不及把登录状态存好，重启后号可能掉线；
//   - 重启后执行端不回来：「停止」记的是人工停，开机自恢复尊重它、不拉起。
//
// 暂停：先把「这次停了谁」记进清单（中途断电也照清单恢复）→ 对调度中心报备，不再派新活
// → 等手上的任务做完（最多 6 分钟，同「更新」）→ 停执行端并关浏览器。巡航台自己在跑的
// 采集（行情 / 卖家主页）一起停，记进清单。
// 恢复（重启后打开巡航台自动跑；不重启了也可以点「继续」）：等 AdsPower 开好 → 照清单
// 拉起执行端 → 撤报备（窗口里被打断的任务由服务端重新排队）→ 接着采集 → 清单清空。
// 没拉起来的留在清单里，下次打开巡航台或再点一次时再试。
//
// 纯逻辑，依赖全部注入（同 executor-code.js），回归见 scripts/test/restart-pause-regression.mjs。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 等手上任务做完的上限，同「更新」：发布一单 2~4 分钟，6 分钟还没完就不等了
export const DRAIN_TIMEOUT_MS = 6 * 60_000
const DRAIN_POLL_MS = 10_000
// 报备有效期取服务端上限。执行端停了设备就离线，过期了调度器也派不过去
const MAINTENANCE_MINUTES = 60
// 采集收到停止后要把当前这条存完才退
const CRAWL_STOP_TIMEOUT_MS = 60_000
// 开机时 AdsPower 常比巡航台慢，人也可能过一会儿才打开它
export const ADS_WAIT_MS = 30 * 60_000
const ADS_POLL_MS = 10_000
// 一个个拉起，别同时开一排浏览器
const START_GAP_MS = 3_000

/** 清单存一个 JSON 文件：先写临时文件再改名，断电不会留下半个文件。 */
export function createPlanStore(file) {
  return {
    read() {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        return data && typeof data === 'object' && Array.isArray(data.envs) ? data : null
      } catch {
        return null
      }
    },
    write(plan) {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      writeFileSync(temp, JSON.stringify(plan, null, 1), 'utf8')
      renameSync(temp, file)
    },
    clear() {
      rmSync(file, { force: true })
    }
  }
}

const message = (error) => String(error?.message || error).slice(0, 300)

/**
 * 暂停。envs：现在在跑的执行端（环境 id）；crawls：[{ key, isRunning, stop, resume }]。
 * 返回 { nothing } 表示本来就没有在跑的；否则 { envs, stopped, unfinished, timedOut, notes }。
 * 一台设备都报备不上（没登录、断网）就不停：等不到手上的任务做完，停了就是掐断。
 */
export async function pauseForRestart({
  envs, deviceIdOf, begin, stop, crawls = [], plan,
  onProgress = () => {}, sleep = delay, now = () => Date.now(),
  drainTimeoutMs = DRAIN_TIMEOUT_MS, pollMs = DRAIN_POLL_MS, crawlStopTimeoutMs = CRAWL_STOP_TIMEOUT_MS
}) {
  const running = [...new Set((envs || []).map((uid) => String(uid || '').trim()).filter(Boolean))]
  const runningCrawls = crawls.filter((c) => c.isRunning())
  const previous = plan.read()
  if (!running.length && !runningCrawls.length) return { nothing: true, alreadyPaused: Boolean(previous) }

  // 先记清单再动手：后面任何一步断电，下次打开巡航台都照它恢复。
  // 上次暂停没恢复完又点了一次：两次停的都要回来
  const entries = new Map((previous?.envs || []).map((e) => [e.userId, e]))
  for (const uid of running) entries.set(uid, { userId: uid, deviceId: String(deviceIdOf(uid) || '') })
  const crawlKeys = [...new Set([...(previous?.crawls || []), ...runningCrawls.map((c) => c.key)])]
  const record = {
    state: 'pausing',
    pausedAt: new Date(now()).toISOString(),
    envs: [...entries.values()],
    crawls: crawlKeys
  }
  plan.write(record)

  const notes = []
  const reported = new Map()   // deviceId → 手上还在跑的任务数
  const devices = record.envs.filter((e) => running.includes(e.userId) && e.deviceId)
  const results = await Promise.allSettled(devices.map((e) =>
    begin(e.deviceId, { reason: 'pc_restart', minutes: MAINTENANCE_MINUTES })))
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') reported.set(devices[i].deviceId, r.value?.running?.length || 0)
    else notes.push(`${devices[i].userId} 没报备上：${message(r.reason)}`)
  })
  if (devices.length && !reported.size) {
    // 一台都没报上：退回原样，清单也撤掉（上次留下的照旧）
    if (previous) plan.write(previous)
    else plan.clear()
    throw new Error(`没报备上调度中心，这次没停（停了会掐断手上的任务）：${message(results[0].reason)}`)
  }

  for (const c of runningCrawls) {
    onProgress({ phase: 'crawls' })
    try {
      c.stop()
      const deadline = now() + crawlStopTimeoutMs
      while (c.isRunning() && now() < deadline) await sleep(1_000)
    } catch (error) {
      notes.push(`${c.key} 采集没停下：${message(error)}`)
    }
  }

  // 等手上的任务做完。每轮再报一次：窗口起点跟着挪到「真正停下那一刻」，
  // 收尾时只重排这之后失败的任务。全部报一遍都是空的才算完（防派出未起跑的漏网）
  const deadline = now() + drainTimeoutMs
  let busy = [...reported.values()].reduce((a, b) => a + b, 0)
  let timedOut = false
  while (busy > 0) {
    if (now() >= deadline) {
      timedOut = true
      break
    }
    onProgress({ phase: 'draining', running: busy, leftMs: Math.max(0, deadline - now()) })
    await sleep(pollMs)
    busy = 0
    for (const deviceId of reported.keys()) {
      try {
        const res = await begin(deviceId, { reason: 'pc_restart', minutes: MAINTENANCE_MINUTES })
        const n = res?.running?.length || 0
        reported.set(deviceId, n)
        busy += n
      } catch {
        busy += reported.get(deviceId) || 0   // 这一轮没问到，按上一轮算
      }
    }
  }

  const stopped = []
  for (const [i, uid] of running.entries()) {
    onProgress({ phase: 'stopping', done: i, total: running.length })
    try {
      await stop(uid)
      stopped.push(uid)
    } catch (error) {
      notes.push(`${uid} 没停下：${message(error)}`)
    }
  }
  plan.write({ ...record, state: 'paused', readyAt: new Date(now()).toISOString() })
  return { envs: running.length, stopped: stopped.length, unfinished: timedOut ? busy : 0, timedOut, crawls: crawlKeys, notes }
}

/** AdsPower 打开了没有。打开了给 true；等到 timeoutMs 还没开给 false。 */
export async function waitForAdsPower({ adsReady, onWait = () => {}, sleep = delay, now = () => Date.now(),
  timeoutMs = ADS_WAIT_MS, pollMs = ADS_POLL_MS }) {
  const deadline = now() + timeoutMs
  for (;;) {
    if (await adsReady().catch(() => false)) return true
    if (now() >= deadline) return false
    onWait()
    await sleep(pollMs)
  }
}

/**
 * 照清单恢复。返回 { nothing } 表示没有暂停过；否则
 * { started, failed: [{ userId, note }], requeued, waitingAds, crawls, notes }。
 * crawls 的 resume 只管拉起来、不等跑完（采集一跑几个小时，index.js 包了一层）。
 */
export async function resumeAfterPause({
  plan, adsReady, start, end, crawls = [],
  onProgress = () => {}, sleep = delay, now = () => Date.now(),
  adsWaitMs = ADS_WAIT_MS, adsPollMs = ADS_POLL_MS, startGapMs = START_GAP_MS
}) {
  const record = plan.read()
  if (!record) return { nothing: true }
  plan.write({ ...record, state: 'resuming' })

  const envs = record.envs || []
  if (envs.length) {
    const ready = await waitForAdsPower({ adsReady, sleep, now, timeoutMs: adsWaitMs, pollMs: adsPollMs,
      onWait: () => onProgress({ phase: 'waiting-ads' }) })
    if (!ready) {
      plan.write({ ...record, state: 'paused', resumeError: 'AdsPower 没打开' })
      return { started: 0, failed: envs.map((e) => ({ userId: e.userId, note: 'AdsPower 没打开' })), requeued: 0, waitingAds: true, crawls: [], notes: [] }
    }
  }

  const notes = []
  const failed = []
  let started = 0
  let requeued = 0
  for (const [i, e] of envs.entries()) {
    onProgress({ phase: 'starting', done: i, total: envs.length })
    if (i > 0) await sleep(startGapMs)
    try {
      await start(e.userId)
      started += 1
    } catch (error) {
      failed.push({ ...e, note: message(error) })
      continue
    }
    // 拉起来了才撤报备：撤了服务端就把窗口里被打断的任务放回队列
    if (!e.deviceId) continue
    try {
      requeued += (await end(e.deviceId))?.requeued?.length || 0
    } catch (error) {
      // 报备 60 分钟后自己失效，调度器照常派；只是窗口里被打断的任务没回队列
      notes.push(`${e.userId} 撤报备没成：${message(error)}`)
    }
  }

  const resumedCrawls = []
  for (const key of record.crawls || []) {
    const c = crawls.find((x) => x.key === key)
    if (!c) continue
    try {
      const res = await c.resume()
      if (res?.ok === false) notes.push(`${key} 采集没接上：${res.reason || '未知原因'}`)
      else resumedCrawls.push(key)
    } catch (error) {
      notes.push(`${key} 采集没接上：${message(error)}`)
    }
  }

  if (failed.length) {
    plan.write({
      ...record,
      state: 'paused',
      envs: failed.map(({ note, ...e }) => e),
      crawls: [],
      resumeError: failed.map((f) => `${f.userId}：${f.note}`).join('；').slice(0, 500)
    })
  } else {
    plan.clear()
  }
  return { started, failed, requeued, waitingAds: false, crawls: resumedCrawls, notes }
}
