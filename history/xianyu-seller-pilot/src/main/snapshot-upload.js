// 按需把某一轮采集的现场打包传回服务端。
//
// # 为什么是「按需」
//
// 快照是整页 DOM，一个型号一轮最多 12 份。全量传是 GB 级的量，而**绝大多数永远
// 不会有人看**——只有出了事那几轮才有人想看现场。所以默认不传，有人点了再取。
//
// # 为什么是「待办」而不是服务端推
//
// 要看现场的时候往往正是出事的时候，那台电脑很可能恰好不在线（关机、断网、
// 进程崩了）。做成待办之后，心跳每拍问一句「有没有要我传的」：在线就立刻传，
// 不在线就下次开机补传，一条路覆盖两种情况。手法搬自群控的日志取回。
//
// # 找不到也要回话
//
// 快照有保留期（snapshot-retention.js），而且是本机文件——过了期被清掉、或者这一轮是在**别的电脑**上跑的，
// 这边就找不到。找不到必须回一句 fail，否则这条待办永远 PENDING：端上每拍心跳
// 都收到它、每次都失败，而点过按钮的人一直在等一个不会来的东西。

import { existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import * as taskStore from './task-store.js'

// 一次最多打包多少份。一轮最多 12 份/型号 × 几十个型号，全打进去可能上百 MB，
// 传的人和存的人都不划算。取现场是为了看「出了什么事」，几十份足够看出来。
const MAX_FILES = 60
// 打包上限。超了就截断并在文件名里说明——传一个半包比传失败强，
// 半包里通常已经有想看的那几份。
const MAX_BYTES = 80 * 1024 * 1024

/** 这一轮在本机留下了哪些快照文件。取不到就空数组。 */
export function snapshotFilesOfRun(localRunId) {
  if (!localRunId) return []
  const seen = new Set()
  const files = []
  try {
    const { items } = taskStore.getRunResults({ page: 1, pageSize: 500 })
    for (const row of items) {
      if (row.runId !== localRunId) continue
      const paths = [
        row.snapshotPath,
        ...(Array.isArray(row.snapshotPaths) ? row.snapshotPaths : []),
        ...(Array.isArray(row.snapshotEntries) ? row.snapshotEntries.map((e) => e?.path) : [])
      ]
      for (const p of paths) {
        const path = String(p || '').trim()
        if (!path || seen.has(path)) continue
        seen.add(path)
        if (existsSync(path)) files.push(path)
        if (files.length >= MAX_FILES) return files
      }
    }
  } catch {
    return files
  }
  return files
}

/**
 * 打成一个 .tar.gz。
 *
 * 用系统的 tar：Node 里没有内置打包，为这件事引一个依赖不值得，而 macOS 与
 * Windows 10+ 都自带 tar。打不出来就返回 null，调方据此回一句 fail。
 */
async function packFiles(files, label) {
  if (!files.length) return null
  const { spawn } = await import('child_process')
  const out = join(tmpdir(), `crawl-snapshot-${label}-${Date.now()}.tar.gz`)
  const args = ['-czf', out, ...files.flatMap((f) => ['-C', dirnameOf(f), basename(f)])]
  const ok = await new Promise((resolve) => {
    const proc = spawn('tar', args, { windowsHide: true })
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
  })
  if (!ok || !existsSync(out)) return null
  if (statSync(out).size > MAX_BYTES) return { path: out, truncated: true }
  return { path: out, truncated: false }
}

function dirnameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : '.'
}

/**
 * 处理一条取回待办。
 *
 * 不抛：这是后台补传，失败了下一拍再来。唯一必须做到的是——**找不到就明确回话**，
 * 否则那条待办会永远挂着。
 */
export async function handleSnapshotRequest(req, { deviceId, uploadSnapshot, failSnapshot }) {
  const id = String(req?.id || '')
  if (!id) return { ok: false }
  const localRunId = String(req?.local_run_id || '')

  const files = snapshotFilesOfRun(localRunId)
  if (!files.length) {
    // 过了保留期被清掉、或者这一轮是在别的电脑上跑的。说清楚是哪一种，
    // 让看的人知道该去别处找还是根本没得找了。
    await failSnapshot(id, deviceId, localRunId
      ? '本机没有这一轮的快照（可能已过保留期被清掉，或这一轮不是在这台电脑上跑的）'
      : '这一轮没有记录端上的 run id，对不到本机的快照')
    return { ok: false, missing: true }
  }

  const packed = await packFiles(files, id.slice(0, 8))
  if (!packed) {
    await failSnapshot(id, deviceId, '打包失败（本机 tar 不可用）')
    return { ok: false }
  }
  try {
    const bytes = await uploadSnapshot(id, deviceId, packed.path)
    return { ok: true, files: files.length, bytes, truncated: packed.truncated }
  } catch {
    // 传失败**不回 fail**：文件还在，下一拍心跳再试。回 fail 会把一条本来能成的
    // 待办永久取消掉。
    return { ok: false, retry: true }
  }
}

export const __test__ = { MAX_FILES, MAX_BYTES, dirnameOf }
