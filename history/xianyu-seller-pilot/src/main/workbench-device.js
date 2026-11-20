// 这台电脑的身份，以及它手上有没有爬虫租约。
//
// # 为什么需要一个设备 id
//
// 一个员工账号允许在多台电脑上同时登录（老板 2026-09-16 定）。于是「谁在操作」
// 不再等于「哪个账号」——同一个管理员可能在办公室和家里各开一个工作台。要把爬虫
// 指到某一台上，就得先让每台电脑有个稳定的名字。
//
// id 在**本机第一次运行时**生成一次并落盘，此后不变：不随登录账号变（换个人登录
// 还是这台机器）、不随 AdsPower 变（重装 AdsPower 不该让这台机器变成另一台）、
// 也不由服务端下发（服务端发 id 的话，每次重装客户端都会多出一台永远不再心跳的
// 僵尸设备）。
//
// # 租约在这里只被"读"
//
// 抢/还租约是人在界面上点出来的动作，走 IPC。这个模块只负责：定时心跳、把服务端
// 回的租约现状缓存下来、以及在持有租约时替持有方续期。
//
// 关键一条：**续期失败就是"你已经不是持有者了"**，必须立刻让本地那份爬虫停手。
// 不停的话两台机器一起跑，而这正是租约要解决的那个问题本身。

import { randomUUID } from 'crypto'
import { hostname, platform, release } from 'os'
import Store from 'electron-store'

import {
  acquireLease,
  claimCrawlRun,
  createCrawlRun,
  fetchEnvPurposes,
  finishCrawlRun,
  failSnapshot,
  leaseHeartbeat,
  releaseLease,
  renewLease,
  uploadSnapshot
} from './api.js'

const store = new Store({ name: 'xianyu-workbench-device' })

// 心跳间隔。服务端 TTL 默认 90 秒，这里取它的三分之一左右：丢一两拍还有救，
// 不至于因为一次网络抖动就把租约让出去。
const HEARTBEAT_MS = 25_000

const FEATURES = ['market', 'image']

let timer = null
// 一次只传一个包：一轮的现场可能几十兆，重入会把同一批文件打包两次
let snapshotInFlight = false
let state = {
  deviceId: null,
  online: false,
  ttlSec: 90,
  leases: [],
  lastError: '',
  lastBeatAt: null
}
const listeners = new Set()

/** 本机设备 id：第一次运行时生成并落盘，此后不变。 */
export function deviceId() {
  let id = store.get('deviceId')
  if (!id || typeof id !== 'string' || id.length < 8) {
    id = `pc-${randomUUID().replace(/-/g, '').slice(0, 24)}`
    store.set('deviceId', id)
  }
  return id
}

/** 电脑名：默认取主机名，人可以在界面上改（改完服务端跟着更新）。 */
export function deviceName() {
  return String(store.get('deviceName') || hostname() || '未命名电脑').slice(0, 64)
}

export function setDeviceName(name) {
  const clean = String(name || '').trim().slice(0, 64)
  if (clean) store.set('deviceName', clean)
  return deviceName()
}

export function getState() {
  return { ...state, deviceId: deviceId(), deviceName: deviceName() }
}

export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  const snapshot = getState()
  for (const fn of listeners) {
    try {
      fn(snapshot)
    } catch {
      /* 监听方自己的问题，不该把心跳循环带崩 */
    }
  }
}

/** 某个功能此刻是不是归本机。界面和调度都问这一个函数，不各自解释租约。 */
export function holdsLease(feature) {
  return state.leases.some((l) => l.feature === feature && l.held && l.mine)
}

/** 管理员请求本机让位的目标（没有则 null）。调度跑完当前这轮该主动交出去。 */
export function handoffRequested(feature) {
  const lease = state.leases.find((l) => l.feature === feature && l.held && l.mine)
  return lease?.handoff_to || null
}

/**
 * 本机挂着哪些 AdsPower 环境。
 *
 * 服务端那边 gc_device 一行是一个**执行单元**（一台手机，或一个环境），
 * 而工作台这张表一行是一台**电脑**——一台电脑上可以挂十几个环境。两边此前
 * 毫无关联，于是「这些环境跑在谁的机器上」没人答得上来。这条就是那个答案。
 *
 * 代理没起（人还没开 AdsPower）时返回空数组，服务端据此**不覆盖**已知的记录：
 * 「这一拍问不到」和「这台电脑上没有环境」是两件事。
 */
async function localEnvIds() {
  try {
    const { listEnvs } = await import('./adspower.js')
    const rows = await listEnvs()
    return (Array.isArray(rows) ? rows : []).map((e) => String(e?.id || '')).filter(Boolean)
  } catch {
    return []
  }
}

async function beat() {
  const id = deviceId()
  try {
    const data = await leaseHeartbeat({
      device_id: id,
      name: deviceName(),
      os: `${platform()} ${release()}`.slice(0, 32),
      app_version: process.env.npm_package_version || '',
      ads_env_ids: await localEnvIds()
    })
    state = {
      ...state,
      deviceId: id,
      online: true,
      ttlSec: Number(data?.ttl_sec) || 90,
      leases: Array.isArray(data?.leases) ? data.leases : [],
      pendingRunId: data?.pending_crawl_run_id || null,
      pendingSnapshot: data?.pending_snapshot_request || null,
      lastError: '',
      lastBeatAt: new Date().toISOString()
    }
  } catch (error) {
    // 心跳打不通不代表租约没了——可能只是网断了几秒。保留上一份租约快照，
    // 由续期那条路去判定"还是不是我的"：那条是服务端的明确答复，比猜可靠。
    state = { ...state, online: false, lastError: safeReason(error) }
  }
  emit()

  // 有人要取某一轮的现场就顺手传回去。放在心跳里是有意的：要看现场的时候往往
  // 正是出事的时候，那台电脑可能恰好不在线——挂在心跳上就等于「在线立刻传、
  // 不在线下次开机补传」，一条路覆盖两种情况。
  const snapshotReq = state.pendingSnapshot
  if (snapshotReq && !snapshotInFlight) {
    snapshotInFlight = true
    try {
      const { handleSnapshotRequest } = await import('./snapshot-upload.js')
      await handleSnapshotRequest(snapshotReq, { deviceId: id, uploadSnapshot, failSnapshot })
      state = { ...state, pendingSnapshot: null }
    } catch {
      /* 后台补传，失败下一拍再来 */
    } finally {
      snapshotInFlight = false
    }
  }

  // 持有中的功能顺手续期。续不上就地清掉本地持有态，调度下一拍就会停。
  for (const feature of FEATURES) {
    if (!holdsLease(feature)) continue
    try {
      const lease = await renewLease(feature, id)
      state = {
        ...state,
        leases: state.leases.map((l) => (l.feature === feature ? { ...l, ...lease, mine: true } : l))
      }
    } catch (error) {
      const gone = error?.response?.status === 409
      state = {
        ...state,
        leases: state.leases.map((l) => (l.feature === feature ? { ...l, held: !gone, mine: false } : l)),
        lastError: gone ? `${feature} 已经不归这台电脑，已停止` : state.lastError
      }
      emit()
    }
  }
}

function safeReason(error) {
  const detail = error?.response?.data?.detail
  return String(detail || error?.message || '心跳失败').slice(0, 200)
}

/**
 * 把服务端那份分组归属推进本机代理。
 *
 * AdsPower 自己已经按账号同步了环境本身（指纹、代理、cookie），所以要下发的只剩
 * 归属这一件事：哪个分组归谁驱动。它原来是每台机器一份 run/env_purposes.json，
 * 谁改谁的——两台机器对同一个分组判断不一致，就会有人去碰别人正开着的浏览器。
 *
 * 推进去而不是让代理自己去拉：代理是个纯本地进程，没有 ERP 登录态，为它加一套
 * 凭据只为读四行配置不划算。工作台本来就登着，顺手带过去。
 *
 * 代理没起（人还没开 AdsPower）不算错：下次登录或下次心跳还会再推一遍，
 * 本地那份文件在那之前照旧能用。
 */
export async function syncEnvPurposes() {
  let table
  try {
    table = await fetchEnvPurposes()
  } catch (error) {
    return { ok: false, reason: `读不到服务端的分组归属：${safeReason(error)}` }
  }
  const rows = Array.isArray(table?.purposes) ? table.purposes : []
  if (!rows.length) return { ok: true, pushed: 0, note: '服务端没有登记任何分组' }

  const { saveEnvPurpose } = await import('./adspower.js')
  let pushed = 0
  const failed = []
  for (const row of rows) {
    try {
      await saveEnvPurpose(row.name, row.owner)
      pushed += 1
    } catch (error) {
      failed.push(`${row.name}：${safeReason(error)}`)
    }
  }
  state = { ...state, purposesSyncedAt: new Date().toISOString(), purposeCount: rows.length }
  emit()
  return { ok: failed.length === 0, pushed, total: rows.length, failed }
}

export function start() {
  if (timer) return
  beat()
  // 归属跟着登录走：人一进来，这台电脑该管哪些环境就对齐了。失败不拦启动——
  // 本地那份文件还在，下一拍心跳会再推一次。
  void syncEnvPurposes().catch(() => {})
  timer = setInterval(beat, HEARTBEAT_MS)
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * 服务端有没有给这台电脑派一轮采集。调度每拍问它一次。
 */
export function pendingCrawlRunId() {
  return state.pendingRunId || null
}

/**
 * 向服务端登记一轮采集，返回 run id（登记不上返回 null）。
 *
 * `offlineStarted` 是给「服务端当时不可达、端上先跑了」用的：那种情况下这一轮
 * 已经在跑，补登记时不该再等人认领，服务端会直接把它记成运行中。
 *
 * 登记失败**不抛**：采集是本机能力，不该因为网抖就停。拿不到 run id 就照跑，
 * 只是这一轮在服务端没有记录——宁可少一条记录，不要少跑一轮。
 */
export async function openCrawlRun({ trigger = 'schedule', localRunId = null, offlineStarted = false } = {}) {
  try {
    const run = await createCrawlRun({
      device_id: deviceId(),
      trigger,
      local_run_id: localRunId,
      offline_started: offlineStarted
    })
    return run?.id || null
  } catch {
    return null
  }
}

/** 认领服务端派来的一轮。服务端会再查一次租约，认领不到就别跑。 */
export async function takeCrawlRun(runId, localRunId = null) {
  try {
    await claimCrawlRun(runId, deviceId(), localRunId)
    state = { ...state, pendingRunId: null }
    return true
  } catch {
    return false
  }
}

/** 上报一轮的结果。失败不抛——本轮已经跑完并落了本地历史，不该因为报不上去就算失败。 */
export async function closeCrawlRun(runId, result) {
  if (!runId) return
  try {
    await finishCrawlRun(runId, deviceId(), result)
  } catch {
    /* 服务端那条会一直停在 RUNNING，人看得见；比把本轮判失败强 */
  }
}

/** 开启：去服务端抢这个爬虫。抢不到时把服务端那句话原样带回界面。 */
export async function turnOn(feature) {
  const lease = await acquireLease(feature, deviceId())
  await beat()
  return lease
}

/** 关闭：还回租约。 */
export async function turnOff(feature) {
  const lease = await releaseLease(feature, deviceId())
  await beat()
  return lease
}

/** 供回归注入：不碰真 store、不起定时器。 */
export const __test__ = {
  setState(next) {
    state = { ...state, ...next }
  },
  reset() {
    state = { deviceId: null, online: false, ttlSec: 90, leases: [], lastError: '', lastBeatAt: null }
  },
  HEARTBEAT_MS,
  FEATURES
}
