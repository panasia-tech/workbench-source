// 执行端版本显示与「更新」按钮（src/main/executor-code.js + executor-local.js 的版本读取）。
//
// 钉死几条：
//   1. 「在跑的版本」只认属于当前进程的标记；没有标记的在跑进程 = 老进程，算落后
//      （2026-10-14：新代码早下到了工位，进程没重启，界面却看不出来）；
//   2. 下载和 hot_code.download 同格式，坏一个文件就整体不动、旧的 code/ 原样留着；
//   3. 更新只重启落后的执行端，停的时候不关浏览器；一个失败不拖累别的。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadExecutorCode, executorCodeIntact, executorsBehind, restartWithMaintenance, safeRelPath, syncExecutorCode, updateExecutors } from '../../src/main/executor-code.js'
import { diskCodeVersion, executorDeviceId, runningCodeVersions } from '../../src/main/executor-local.js'

const made = []
function home() {
  const root = mkdtempSync(join(tmpdir(), 'gc-ads-code-'))
  made.push(root)
  mkdirSync(join(root, 'run'))
  return { root, kind: 'packaged' }
}
const md5 = (text) => createHash('md5').update(text).digest('hex')
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data))
const noSleep = async () => {}

// --- 1. 路径安全线（同 hot_code.safe_rel_path）---------------------------------
for (const bad of ['../x.py', '/etc/passwd', 'C:/x.py', 'a/../../b.py', '..\\w.py', 'x.exe', '']) {
  assert.equal(safeRelPath(bad), null, `不安全路径被放行了: ${bad}`)
}
assert.equal(safeRelPath('gc_ads/logs.py'), 'gc_ads/logs.py')

// --- 2. 磁盘版本：热更新和内置取大的 ------------------------------------------
{
  const h = home()
  assert.deepEqual(diskCodeVersion(h), { codeVersion: 0, versionName: '' })
  mkdirSync(join(h.root, '_internal'))
  writeJson(join(h.root, '_internal', 'builtin-code-version.json'), { codeVersion: 2, versionName: '0.2.0' })
  assert.equal(diskCodeVersion(h).codeVersion, 2)
  mkdirSync(join(h.root, 'code'))
  writeJson(join(h.root, 'code', 'gc-ads-code-version.json'), { codeVersion: 6, versionName: '0.2.5' })
  assert.deepEqual(diskCodeVersion(h), { codeVersion: 6, versionName: '0.2.5' })
}

// --- 3. 在跑的版本只认当前进程的标记 -------------------------------------------
{
  const h = home()
  writeJson(join(h.root, 'run', 'supervisor.json'), {
    k1new: { pid: 100, started_at: '2026-10-14 12:00:00', stopped: false },
    k1old: { pid: 200, started_at: '2026-10-08 09:00:00', stopped: false },
    k1prev: { pid: 300, started_at: '2026-10-14 12:00:00', stopped: false },
    k1off: { pid: 400, started_at: '', stopped: true },
    '::broker': { pid: 500, stopped: false }
  })
  writeJson(join(h.root, 'run', 'executor_k1new.version.json'), { pid: 100, codeVersion: 7, versionName: '0.2.6' })
  // 上一个进程留下的标记：pid 不对、文件也比这次启动早 → 不认
  const prev = join(h.root, 'run', 'executor_k1prev.version.json')
  writeJson(prev, { pid: 299, codeVersion: 7, versionName: '0.2.6' })
  const old = new Date(2026, 9, 13, 8, 0, 0)
  utimesSync(prev, old, old)
  const running = await runningCodeVersions(h, { alive: async () => true, sleep: noSleep })
  assert.deepEqual(running.k1new, { codeVersion: 7, versionName: '0.2.6' })
  assert.equal(running.k1old.stale, true, '没有标记的在跑进程是老进程，必须算落后')
  assert.equal(running.k1prev.stale, true, '上一个进程的标记不能顶替这个进程')
  assert.equal('k1off' in running, false, '人工停了的不算在跑')
  assert.equal('::broker' in running, false, '代理不是执行端')

  // pid 对不上但文件是这次启动后写的（打包形态 pid 偶尔不一致）→ 认
  writeJson(prev, { pid: 299, codeVersion: 7, versionName: '0.2.6' })
  const fresh = new Date(2026, 9, 14, 12, 0, 3)
  utimesSync(prev, fresh, fresh)
  const again = await runningCodeVersions(h, { alive: async () => true, sleep: noSleep })
  assert.equal(again.k1prev.codeVersion, 7)

  assert.deepEqual(executorsBehind(running, 7).sort(), ['k1old', 'k1prev'])
}

// --- 4. 下载：全对才换，坏一个整体不动 ----------------------------------------
{
  const h = home()
  mkdirSync(join(h.root, 'code'))
  writeFileSync(join(h.root, 'code', 'main.py'), 'OLD = 1\n')
  const served = { 'main.py': 'NEW = 1\n', 'gc_ads/__init__.py': '__version__ = "0.2.6"\n' }
  const manifest = { codeVersion: 7, versionName: '0.2.6', files: Object.fromEntries(Object.entries(served).map(([k, v]) => [k, md5(v)])) }
  const fetchFrom = (files) => async (url) => {
    const rel = url.replace(/^.*?gc-ads-code\//, '')
    if (!(rel in files)) return { ok: false, status: 404 }
    return { ok: true, arrayBuffer: async () => Buffer.from(files[rel]) }
  }

  await assert.rejects(downloadExecutorCode(h.root, manifest, { fetchImpl: fetchFrom({ ...served, 'main.py': 'TAMPERED\n' }) }), /校验不符/)
  assert.equal(readFileSync(join(h.root, 'code', 'main.py'), 'utf8'), 'OLD = 1\n', '下坏了旧代码要原样留着')
  assert.equal(existsSync(join(h.root, 'code.next')), false, '暂存目录要清掉')

  const evil = { ...manifest, files: { ...manifest.files, '../escape.py': md5('x') } }
  await assert.rejects(downloadExecutorCode(h.root, evil, { fetchImpl: fetchFrom(served) }), /不安全/)

  await downloadExecutorCode(h.root, manifest, { fetchImpl: fetchFrom(served) })
  assert.equal(readFileSync(join(h.root, 'code', 'main.py'), 'utf8'), 'NEW = 1\n')
  assert.equal(readFileSync(join(h.root, 'code.prev', 'main.py'), 'utf8'), 'OLD = 1\n', '上一版要留在 code.prev')
  // 清单要落进 code/：执行端的 hot_code.verify_dir / activate 靠它认版本
  assert.equal(diskCodeVersion(h).codeVersion, 7)
}

// --- 5. 更新：只重启落后的，不关浏览器，一个失败不拖累别的 --------------------
{
  const calls = []
  let downloads = 0
  const res = await updateExecutors({
    root: '/x',
    disk: { codeVersion: 6 },
    running: { a: { codeVersion: 7 }, b: { codeVersion: 6 }, c: { stale: true, codeVersion: 0 } },
    manifest: { codeVersion: 7, versionName: '0.2.6', files: {} },
    download: async () => { downloads++ },
    stop: async (uid) => { calls.push(`stop:${uid}`) },
    start: async (uid) => {
      calls.push(`start:${uid}`)
      if (uid === 'b') throw new Error('AdsPower 没开')
    }
  })
  assert.equal(downloads, 1, '磁盘上比线上旧要先下')
  assert.deepEqual(calls, ['stop:b', 'start:b', 'stop:c', 'start:c'], '已是最新的 a 不能碰')
  assert.deepEqual(res.results.map((r) => [r.user_id, r.ok]), [['b', false], ['c', true]])

  // 磁盘上已是最新：不再下载，只重启
  let again = 0
  await updateExecutors({
    root: '/x', disk: { codeVersion: 7 }, running: {}, manifest: { codeVersion: 7, files: {} },
    download: async () => { again++ }, stop: async () => {}, start: async () => {}
  })
  assert.equal(again, 0)
}

// --- 6. 报备：重启前报、手上有活等它跑完、重启后收尾 --------------------------
{
  const log = []
  let clock = 0
  let busyRounds = 2
  const deps = {
    deviceId: 'dev-1',
    stop: async (uid) => { log.push(`stop:${uid}`) },
    start: async (uid) => { log.push(`start:${uid}`) },
    begin: async (id) => {
      log.push(`begin:${id}`)
      return { running: busyRounds-- > 0 ? [{ id: 't-pub' }] : [] }
    },
    end: async (id) => { log.push(`end:${id}`); return { requeued: ['t-cut'] } },
    sleep: async (ms) => { clock += ms },
    now: () => clock
  }
  const res = await restartWithMaintenance('k1a', deps)
  assert.deepEqual(log, ['begin:dev-1', 'begin:dev-1', 'begin:dev-1', 'stop:k1a', 'start:k1a', 'end:dev-1'],
    '手上有活要等它跑完再重启，重启完收尾')
  assert.deepEqual(res, { user_id: 'k1a', ok: true, requeued: ['t-cut'] })

  // 一直忙：等到上限就撤报备、这次不重启
  log.length = 0
  clock = 0
  busyRounds = 1e9
  const busy = await restartWithMaintenance('k1a', { ...deps, drainTimeoutMs: 30_000, pollMs: 10_000 })
  assert.equal(busy.skipped, true)
  assert.equal(log.includes('stop:k1a'), false, '手上任务没跑完绝不能重启')
  assert.equal(log[log.length - 1], 'end:dev-1', '放弃时要撤报备，否则号要被挂 10 分钟')

  // 报备接口不通：退回直接重启，不把更新卡死
  log.length = 0
  const down = await restartWithMaintenance('k1a', {
    ...deps, begin: async () => { throw new Error('ECONNREFUSED') }
  })
  assert.equal(down.ok, true)
  assert.deepEqual(log, ['stop:k1a', 'start:k1a'], '没报上就别去收尾')

  // 没有设备 id（还没注册过）：直接重启
  log.length = 0
  await restartWithMaintenance('k1a', { ...deps, deviceId: '' })
  assert.deepEqual(log, ['stop:k1a', 'start:k1a'])

  // 重启失败也要收尾，失败照实报
  log.length = 0
  busyRounds = 0
  const broke = await restartWithMaintenance('k1a', { ...deps, start: async () => { throw new Error('AdsPower 没开') } })
  assert.equal(broke.ok, false)
  assert.match(broke.note, /AdsPower 没开/)
  assert.equal(log[log.length - 1], 'end:dev-1')
}

// --- 7. 环境 → 设备 id：只读 device_id，hw_id 对不上不认 -------------------------
{
  const h = home()
  writeJson(join(h.root, 'device_identity_k1a.json'), { hw_id: 'k1a', device_id: 'dev-a', token: 'secret' })
  writeJson(join(h.root, 'device_identity_k1b.json'), { hw_id: 'other', device_id: 'dev-b', token: 'secret' })
  assert.equal(executorDeviceId(h, 'k1a'), 'dev-a')
  assert.equal(executorDeviceId(h, 'k1b'), '')
  assert.equal(executorDeviceId(h, 'k1none'), '')
}

{
  // 11-01 现场：清单是最新版、文件不全。要重下，也不能把没换上新版的报成成功
  const h = home()
  const dir = join(h.root, 'code')
  mkdirSync(dir, { recursive: true })
  const body = 'x = 1\n'
  writeFileSync(join(dir, 'main.py'), body)
  const files = { 'main.py': createHash('md5').update(body).digest('hex'), 'gc_ads/__init__.py': 'abc' }
  writeFileSync(join(dir, 'gc-ads-code-version.json'), JSON.stringify({ codeVersion: 10, files }))
  assert.equal(executorCodeIntact(h.root), false)
  let downloads = 0
  const res = await updateExecutors({
    root: h.root,
    disk: { codeVersion: 10 },
    running: { k1: { codeVersion: 2 } },
    manifest: { codeVersion: 10, versionName: '0.2.9' },
    download: async () => { downloads++ },
    stop: async () => {},
    start: async () => {},
    runningNow: async () => ({ k1: { codeVersion: 2 } })
  })
  assert.equal(downloads, 1)
  assert.equal(res.results[0].ok, false)
  assert.match(res.results[0].note, /还在跑旧版/)
  writeFileSync(join(dir, 'gc-ads-code-version.json'), JSON.stringify({ codeVersion: 10, files: { 'main.py': files['main.py'] } }))
  assert.equal(executorCodeIntact(h.root), true)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(executorCodeIntact(h.root), true, '没有 code/ 不算坏')
  // 别的进程正在下：不抢，也不留半份
  writeFileSync(join(h.root, 'code.lock'), '')
  await assert.rejects(downloadExecutorCode(h.root, { files: { 'main.py': 'x' } }, { fetchImpl: async () => { throw new Error('不该下载') } }), /正在下载/)
}

{
  // 启动前同步：已是最新且完整不下；旧了或坏了才下
  let n = 0
  const deps = (intact) => ({ fetchManifest: async () => ({ codeVersion: 11 }), download: async () => { n++ }, intact: () => intact })
  assert.equal(await syncExecutorCode('x', { codeVersion: 11 }, deps(true)), false)
  assert.equal(await syncExecutorCode('x', { codeVersion: 11 }, deps(false)), true)
  assert.equal(await syncExecutorCode('x', { codeVersion: 10 }, deps(true)), true)
  assert.equal(n, 2)
}

for (const dir of made) rmSync(dir, { recursive: true, force: true })
console.log('executor-code-regression: PASS')
