// 「暂停，准备重启电脑」与重启后恢复（src/main/restart-pause.js）。
//
// 钉死几条：
//   1. 先记清单再动手；报备 → 等手上的任务做完 → 停执行端（连浏览器）→ 清单标「已暂停」；
//   2. 等太久不再等，照样停，告诉人有几个没等完；
//   3. 一台都报备不上就不停（停了就是掐断手上的任务），清单退回原样；
//   4. 恢复先等 AdsPower 开好，照清单一个个拉起，拉起来的才撤报备；没起来的留在清单里；
//   5. 采集在跑的一起停、一起接着跑。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlanStore, pauseForRestart, resumeAfterPause, waitForAdsPower } from '../../src/main/restart-pause.js'
import { executorAlive } from '../../src/main/executor-local.js'

const dir = mkdtempSync(join(tmpdir(), 'restart-pause-'))
let n = 0
const newPlan = () => createPlanStore(join(dir, `plan-${++n}.json`))
const clock = () => {
  let t = 1_000_000
  return { now: () => t, sleep: async (ms) => { t += ms } }
}
const crawl = (key, running) => {
  const c = { key, running, stops: 0, resumes: 0 }
  c.isRunning = () => c.running
  c.stop = () => { c.stops += 1; c.running = false }
  c.resume = async () => { c.resumes += 1; return { ok: true } }
  return c
}

// --- 1. 正常暂停：先记清单、报备、等任务做完、停（连浏览器）---------------------------
{
  const log = []
  const plan = newPlan()
  const t = clock()
  let busyRounds = 2
  const market = crawl('market', true)
  const res = await pauseForRestart({
    envs: ['k1a', 'k1b', 'k1a'],
    deviceIdOf: (uid) => ({ k1a: 'dev-a', k1b: 'dev-b' })[uid],
    begin: async (id, opts) => {
      assert.ok(plan.read(), '报备之前清单就该落盘了')
      assert.equal(opts.reason, 'pc_restart')
      log.push(`begin:${id}`)
      return { running: id === 'dev-a' && busyRounds-- > 0 ? [{ id: 't1' }] : [] }
    },
    stop: async (uid) => { log.push(`stop:${uid}`) },
    crawls: [market, crawl('seller', false)],
    plan,
    ...t
  })
  assert.equal(res.envs, 2, '同一个环境只算一次')
  assert.equal(res.stopped, 2)
  assert.equal(res.timedOut, false)
  assert.deepEqual(res.crawls, ['market'], '只记在跑的采集')
  assert.equal(market.stops, 1)
  assert.ok(log.indexOf('stop:k1a') > log.lastIndexOf('begin:dev-a'), '任务做完才停')
  const saved = plan.read()
  assert.equal(saved.state, 'paused')
  assert.deepEqual(saved.envs, [{ userId: 'k1a', deviceId: 'dev-a' }, { userId: 'k1b', deviceId: 'dev-b' }])
  assert.deepEqual(saved.crawls, ['market'])
}

// --- 2. 等太久：不再等，照样停，报出没等完的个数 ------------------------------------------
{
  const plan = newPlan()
  const stopped = []
  const res = await pauseForRestart({
    envs: ['k1a'],
    deviceIdOf: () => 'dev-a',
    begin: async () => ({ running: [{ id: 'stuck' }] }),
    stop: async (uid) => { stopped.push(uid) },
    plan,
    drainTimeoutMs: 60_000,
    ...clock()
  })
  assert.equal(res.timedOut, true)
  assert.equal(res.unfinished, 1)
  assert.deepEqual(stopped, ['k1a'], '超时也要停：人要重启电脑')
  assert.equal(plan.read().state, 'paused')
}

// --- 3. 一台都报备不上：不停，清单退回原样 ------------------------------------------------
{
  const plan = newPlan()
  const stopped = []
  await assert.rejects(pauseForRestart({
    envs: ['k1a', 'k1b'],
    deviceIdOf: () => 'dev',
    begin: async () => { throw new Error('401 未登录') },
    stop: async (uid) => { stopped.push(uid) },
    plan,
    ...clock()
  }), /没报备上调度中心/)
  assert.deepEqual(stopped, [], '没报备上不能停')
  assert.equal(plan.read(), null, '清单要撤掉，不然开机会去「恢复」没停过的')

  // 有一台报上了：照常暂停，没报上的那台记一笔
  const plan2 = newPlan()
  const res = await pauseForRestart({
    envs: ['k1a', 'k1b'],
    deviceIdOf: (uid) => `dev-${uid}`,
    begin: async (id) => { if (id === 'dev-k1b') throw new Error('超时'); return { running: [] } },
    stop: async () => {},
    plan: plan2,
    ...clock()
  })
  assert.equal(res.stopped, 2)
  assert.match(res.notes.join(), /k1b 没报备上/)

  // 没注册过的执行端（没有设备 id）不用报备，直接停
  const plan3 = newPlan()
  const res3 = await pauseForRestart({
    envs: ['k1new'],
    deviceIdOf: () => '',
    begin: async () => { throw new Error('不该报备') },
    stop: async () => {},
    plan: plan3,
    ...clock()
  })
  assert.equal(res3.stopped, 1)
}

// --- 4. 本来就没在跑；暂停没恢复完又点一次 ------------------------------------------------
{
  const plan = newPlan()
  const res = await pauseForRestart({ envs: [], deviceIdOf: () => '', begin: async () => ({}), stop: async () => {}, plan, ...clock() })
  assert.equal(res.nothing, true)
  assert.equal(plan.read(), null, '没停任何东西就别留清单')

  plan.write({ state: 'paused', envs: [{ userId: 'k1old', deviceId: 'dev-old' }], crawls: ['seller'] })
  await pauseForRestart({
    envs: ['k1new'],
    deviceIdOf: () => 'dev-new',
    begin: async () => ({ running: [] }),
    stop: async () => {},
    plan,
    ...clock()
  })
  assert.deepEqual(plan.read().envs.map((e) => e.userId), ['k1old', 'k1new'], '两次停的都要回来')
  assert.deepEqual(plan.read().crawls, ['seller'])
}

// --- 5. 恢复：等 AdsPower、一个个拉起、拉起来的才撤报备、采集接着跑、清单清空 ------------
{
  const plan = newPlan()
  plan.write({ state: 'paused', envs: [{ userId: 'k1a', deviceId: 'dev-a' }, { userId: 'k1b', deviceId: '' }], crawls: ['market'] })
  const log = []
  let adsChecks = 0
  const market = crawl('market', false)
  const phases = []
  const res = await resumeAfterPause({
    plan,
    adsReady: async () => ++adsChecks >= 3,
    start: async (uid) => { log.push(`start:${uid}`) },
    end: async (id) => { log.push(`end:${id}`); return { requeued: ['t9'] } },
    crawls: [market],
    onProgress: (p) => phases.push(p.phase),
    ...clock()
  })
  assert.equal(adsChecks, 3, 'AdsPower 没开就等，不急着拉')
  assert.deepEqual(log, ['start:k1a', 'end:dev-a', 'start:k1b'], '没有设备 id 的不撤报备')
  assert.equal(res.started, 2)
  assert.equal(res.requeued, 1)
  assert.deepEqual(res.crawls, ['market'])
  assert.equal(market.resumes, 1)
  assert.ok(phases.includes('waiting-ads') && phases.includes('starting'))
  assert.equal(plan.read(), null, '全恢复了清单要清掉')
}

// --- 6. 恢复一部分：没起来的留在清单里、不撤它的报备 ----------------------------------------
{
  const plan = newPlan()
  plan.write({ state: 'paused', envs: [{ userId: 'k1a', deviceId: 'dev-a' }, { userId: 'k1b', deviceId: 'dev-b' }], crawls: [] })
  const ended = []
  const res = await resumeAfterPause({
    plan,
    adsReady: async () => true,
    start: async (uid) => { if (uid === 'k1b') throw new Error('套餐并发上限') },
    end: async (id) => { ended.push(id); return {} },
    ...clock()
  })
  assert.equal(res.started, 1)
  assert.deepEqual(res.failed.map((f) => f.userId), ['k1b'])
  assert.deepEqual(ended, ['dev-a'])
  const left = plan.read()
  assert.equal(left.state, 'paused')
  assert.deepEqual(left.envs, [{ userId: 'k1b', deviceId: 'dev-b' }])
  assert.match(left.resumeError, /套餐并发上限/)

  // 撤报备失败不算没恢复：执行端起来了，报备 60 分钟后自己失效
  const plan2 = newPlan()
  plan2.write({ state: 'paused', envs: [{ userId: 'k1a', deviceId: 'dev-a' }], crawls: [] })
  const res2 = await resumeAfterPause({
    plan: plan2,
    adsReady: async () => true,
    start: async () => {},
    end: async () => { throw new Error('网络抖了') },
    ...clock()
  })
  assert.equal(res2.failed.length, 0)
  assert.match(res2.notes.join(), /撤报备没成/)
  assert.equal(plan2.read(), null)
}

// --- 7. AdsPower 一直没开：一个都不拉，清单留着等下次 ----------------------------------------
{
  const plan = newPlan()
  plan.write({ state: 'paused', envs: [{ userId: 'k1a', deviceId: 'dev-a' }], crawls: ['market'] })
  let started = 0
  const res = await resumeAfterPause({
    plan,
    adsReady: async () => false,
    start: async () => { started += 1 },
    end: async () => ({}),
    adsWaitMs: 60_000,
    ...clock()
  })
  assert.equal(res.waitingAds, true)
  assert.equal(started, 0)
  assert.equal(plan.read().state, 'paused')
  assert.deepEqual(plan.read().crawls, ['market'], '采集也留着，等下次一起接')
  assert.equal((await resumeAfterPause({ plan: newPlan(), adsReady: async () => true, start: async () => {}, end: async () => {} })).nothing, true)
  assert.equal(await waitForAdsPower({ adsReady: async () => { throw new Error('ECONNREFUSED') }, timeoutMs: 0, ...clock() }), false,
    '探活报错按没开算')
}

// --- 8. 重启前的 pid：台账记的启动时间早于这次开机，就不是它了 --------------------------------
{
  const boot = new Date(2026, 9, 27, 9, 0, 0).getTime()
  const opts = { platform: 'win32', bootTime: boot }
  assert.equal(await executorAlive(process.pid, 'k1a', { ...opts, startedAt: '2026-10-26 22:00:00' }), false,
    '开机前起的进程不可能还活着（Windows 重启后 pid 被复用）')
  assert.equal(await executorAlive(process.pid, 'k1a', { ...opts, startedAt: '2026-10-27 09:05:00' }), true)
  assert.equal(await executorAlive(process.pid, 'k1a', { ...opts, startedAt: '2026-10-27 08:59:00' }), true,
    '开机前后 2 分钟内的按活着算（时钟会被校准）')
  assert.equal(await executorAlive(process.pid, 'k1a', { ...opts, startedAt: '' }), true, '没记时间的按老办法')
}

rmSync(dir, { recursive: true, force: true })
console.log('restart-pause regression: PASS')
