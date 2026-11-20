// 执行端代码热更新：行情台这一侧的「看版本」与「更新」。
//
// 执行端自己会下新代码（gc_ads/hot_code.py），但**跑着的进程只下载、不换自己**，要重启
// 才生效。没人重启，工位就一直跑旧代码——2026-10-14 现场：新代码 10-10 就下到了工位上，
// 两个执行端到 10-14 还在跑 0.2.1，登录自救用不上，掉登录只能等人。
//
// 所以「更新」= 先把新代码下到位，再把执行端进程重启一遍。**浏览器不关**：停执行端时不带
// stopBrowser，新进程起来经 CDP 接回同一个浏览器（AdsPower 开浏览器是幂等的）。
//
// 下载格式与 hot_code.download 一字不差（code.next → code，旧的留 code.prev），
// 两边谁下的对方都认。⚠️ 那边改了这里要跟着改。
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

export const EXECUTOR_CODE_BASE_URL = 'http://127.0.0.1:8000'
const MANIFEST_NAME = 'gc-ads-code-version.json'
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 200

/** 同 hot_code.safe_rel_path：清单来自网上，路径必须落在 code/ 里。不安全返回 null。 */
export function safeRelPath(name) {
  const rel = String(name || '').trim().replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || rel.includes(':')) return null
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null
  if (!/\.(py|json|yaml|txt)$/.test(parts[parts.length - 1])) return null
  return parts.join('/')
}

async function fetchBuffer(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 线上最新的执行端代码清单。 */
export async function fetchExecutorCodeManifest({ fetchImpl = fetch, baseUrl = EXECUTOR_CODE_BASE_URL } = {}) {
  const data = JSON.parse((await fetchBuffer(`${baseUrl}/${MANIFEST_NAME}`, fetchImpl, 15_000)).toString('utf8'))
  if (!(Number(data?.codeVersion) > 0) || !data.files || typeof data.files !== 'object') {
    throw new Error('执行端代码清单不完整')
  }
  return data
}

// 与 hot_code._take_lock 同一把锁：同一目录同时只有一个进程在下载
const LOCK_STALE_MS = 10 * 60_000

function takeDownloadLock(root) {
  const lock = join(root, 'code.lock')
  try {
    if (Date.now() - statSync(lock).mtimeMs >= LOCK_STALE_MS) rmSync(lock, { force: true })
  } catch { /* 没有锁 */ }
  try {
    closeSync(openSync(lock, 'wx'))
  } catch {
    throw new Error('有执行端正在下载新代码，等一分钟再点更新')
  }
  return lock
}

/**
 * 本机的 code/ 是否完整（同 hot_code.verify_dir）。没有 code/ 不算坏。
 * 清单说已是最新、文件却不全时，执行端启动校验不过只能退回内置版本，光比版本号永远修不好
 * （2026-11-01 现场：多个执行端同时下载弄坏了 code/，点多少次更新都还是 0.2.1）。
 */
export function executorCodeIntact(root) {
  const dir = join(root, 'code')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
  } catch {
    return !existsSync(dir)
  }
  const entries = Object.entries(manifest?.files || {})
  if (!entries.length) return false
  try {
    return entries.every(([rel, want]) => {
      const safe = safeRelPath(rel)
      return safe && createHash('md5').update(readFileSync(join(dir, ...safe.split('/')))).digest('hex') === want
    })
  } catch {
    return false
  }
}

/** 把清单里的代码下到执行端的 code/：全部校验通过才换上，坏一个就整体不动。 */
export async function downloadExecutorCode(root, manifest, { fetchImpl = fetch, baseUrl = EXECUTOR_CODE_BASE_URL } = {}) {
  const entries = Object.entries(manifest.files)
  if (!entries.length) throw new Error('清单里没有文件')
  if (entries.length > MAX_FILES) throw new Error(`清单里有 ${entries.length} 个文件，超过上限 ${MAX_FILES}`)
  const staging = join(root, `code.next.${process.pid}`)
  const current = join(root, 'code')
  const backup = join(root, 'code.prev')
  const lock = takeDownloadLock(root)
  rmSync(staging, { recursive: true, force: true })
  try {
    for (const [rel, want] of entries) {
      const safe = safeRelPath(rel)
      if (!safe) throw new Error(`清单里有不安全的路径: ${rel}`)
      const blob = await fetchBuffer(`${baseUrl}/${safe}`, fetchImpl, 60_000)
      if (blob.length > MAX_FILE_BYTES) throw new Error(`${safe} 超过单文件上限`)
      if (createHash('md5').update(blob).digest('hex') !== want) throw new Error(`${safe} 校验不符`)
      const target = join(staging, ...safe.split('/'))
      if (!target.startsWith(staging + sep)) throw new Error(`${safe} 越出暂存目录`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, blob)
    }
    writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
    rmSync(backup, { recursive: true, force: true })
    if (existsSync(current)) renameSync(current, backup)
    try {
      renameSync(staging, current)
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, current)
      throw error
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(lock, { force: true })
  }
  return { codeVersion: Number(manifest.codeVersion), versionName: String(manifest.versionName || '') }
}

/** 本机代码比线上旧或者不完整，就下一份。返回是否下了。 */
export async function syncExecutorCode(root, disk, { fetchManifest = fetchExecutorCodeManifest, download = downloadExecutorCode, intact = executorCodeIntact } = {}) {
  const manifest = await fetchManifest()
  if (Number(disk?.codeVersion || 0) >= Number(manifest.codeVersion) && intact(root)) return false
  await download(root, manifest)
  return true
}

/**
 * 哪些执行端要重启才能用上 latest：在跑的版本比它旧，或者是认不出版本的老进程。
 * running 形如 runningCodeVersions 的返回。
 */
export function executorsBehind(running, latestCodeVersion) {
  return Object.entries(running || {})
    .filter(([, v]) => v.stale || Number(v.codeVersion) < Number(latestCodeVersion))
    .map(([uid]) => uid)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 等手上任务跑完的上限：发布一单 2~4 分钟，等 6 分钟还没完就这次先不重启它，下次再点
const DRAIN_TIMEOUT_MS = 6 * 60_000
const DRAIN_POLL_MS = 10_000

/**
 * 重启一个执行端，并对调度中心报备（2026-10-14：直接重启掐断了两单正在发布的任务）。
 *
 *   1. 报备：调度器不再给它派新活，服务端回它手上还在跑的任务；
 *   2. 有在跑的就等它跑完（每 10 秒再报一次，窗口起点跟着挪到「真正重启那一刻」），
 *      等太久就撤报备、这次不重启它；
 *   3. 重启（只停进程、不关浏览器）；
 *   4. 收尾：撤报备，服务端把窗口里因重启失败的任务放回队列重新派。
 *
 * 不是浏览器执行端（没有 deviceId）或报备接口不通，就退回原来的直接重启——
 * 报备是锦上添花，不能让「服务器一时连不上」把更新整个卡死。
 */
export async function restartWithMaintenance(uid, { deviceId, stop, start, begin, end, sleep = delay,
  drainTimeoutMs = DRAIN_TIMEOUT_MS, pollMs = DRAIN_POLL_MS, now = () => Date.now() }) {
  let reported = false
  if (deviceId && begin) {
    try {
      let res = await begin(deviceId)
      reported = true
      const deadline = now() + drainTimeoutMs
      while (res?.running?.length) {
        if (now() >= deadline) {
          await end(deviceId).catch(() => {})
          return { user_id: uid, ok: false, skipped: true, note: `手上的任务 ${drainTimeoutMs / 60_000} 分钟还没跑完，这次先不重启它` }
        }
        await sleep(pollMs)
        res = await begin(deviceId)
      }
    } catch (error) {
      if (reported) await end(deviceId).catch(() => {})
      reported = false
      console.warn(`[executor] ${uid} 维护报备没成，直接重启：${error?.message || error}`)
    }
  }
  let failure = null
  try {
    await stop(uid)
    await start(uid)
  } catch (error) {
    failure = error
  }
  let requeued = []
  if (reported) {
    try {
      requeued = (await end(deviceId))?.requeued || []
    } catch (error) {
      // 收尾没报上：报备 10 分钟后自己失效，调度器照常派，只是窗口里失败的任务要人重发
      console.warn(`[executor] ${uid} 维护收尾没报上：${error?.message || error}`)
    }
  }
  if (failure) return { user_id: uid, ok: false, requeued, note: String(failure?.message || failure).slice(0, 300) }
  return { user_id: uid, ok: true, requeued }
}

/**
 * 更新执行端：新代码下到位（磁盘上已是最新就不下），再把落后的执行端一个个重启。
 *
 * 一个个来、不并发：同时重启会让所有号一起停一下，也一起踩新代码的坑。单个重启失败
 * 不影响其他的，结果逐个报回去。重启只停进程不关浏览器（stop 不带 stopBrowser），
 * 并且前后都对调度中心报备（restartWithMaintenance）。
 * deviceIdOf(uid)：环境 → 群控设备 id，读不到给空，退回直接重启。
 */
export async function updateExecutors({ root, disk, running, manifest, stop, start, download = downloadExecutorCode,
  deviceIdOf = () => '', begin = null, end = null, sleep = delay, intact = executorCodeIntact, runningNow = null }) {
  const latest = Number(manifest.codeVersion)
  let downloaded = false
  if (Number(disk?.codeVersion || 0) < latest || !intact(root)) {
    await download(root, manifest)
    downloaded = true
  }
  const results = []
  for (const uid of executorsBehind(running, latest)) {
    results.push(await restartWithMaintenance(uid, { deviceId: deviceIdOf(uid), stop, start, begin, end, sleep }))
  }
  // 重启成功不等于用上了新版：再看一眼实际在跑的，没换上的如实报
  if (runningNow) {
    const behind = executorsBehind(await runningNow(), latest)
    for (const result of results) {
      if (result.ok && behind.includes(result.user_id)) {
        result.ok = false
        result.note = '重启了，但还在跑旧版，把执行端日志发给管理员看看'
      }
    }
  }
  return { codeVersion: latest, versionName: String(manifest.versionName || ''), downloaded, results }
}
