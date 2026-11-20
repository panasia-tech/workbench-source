// 影子上报（S3-0）：本机把每一次决策报给服务端，作为 S3-1 搬家前的对照基准。
//
// 三条要害：
//   1. **上报失败绝不能影响采集** —— 它是观测不是业务，网络不好就丢这一轮记录；
//   2. **skip 也要记**，且记成 skip 而不是失败 —— 迁移后最容易出偏差的就是这半边；
//   3. **一轮一次**，不是一条一次 —— 几十上百条逐条发请求既吵又慢。
import assert from 'node:assert/strict'
import { beginRound } from '../../src/main/shadow-report.js'

// --- 状态翻译：scheduler 那套 → 服务端的 run/skip + ok --------------------
{
  const sent = []
  const r = beginRound({ clientId: 'd1', account: '演示业务负责人', trigger: 'daily',
                         post: async (body) => { sent.push(body); return { job_id: 'j1' } } })
  r.record({ spu: 'AOC 24G10', status: 'success', price: 780 })
  r.record({ spu: 'KTC 27GS820', status: 'skip', reason: '账号今日配额已满' })
  r.record({ spu: '飞利浦 27M2N', status: 'fail', reason: '搜索失败' })
  r.record({ spu: '戴尔 U2723', status: 'empty', reason: '无在售' })
  r.record({ spu: '小米 27', status: 'invalid_price', price: 9 })
  r.record({ spu: '华硕 VG27', status: 'risk_control', reason: '风控页面' })
  assert.equal(r.size(), 6)

  const out = await r.flush()
  assert.equal(out.ok, true)
  const body = sent[0]
  assert.equal(body.account, '演示业务负责人')
  assert.equal(body.trigger, 'daily')
  const by = Object.fromEntries(body.decisions.map((d) => [d.spu, d]))

  assert.equal(by['AOC 24G10'].action, 'run')
  assert.equal(by['AOC 24G10'].ok, true)
  assert.equal(by['AOC 24G10'].price, 780)

  assert.equal(by['KTC 27GS820'].action, 'skip', '跳过要记成 skip')
  assert.equal(by['KTC 27GS820'].ok, null, 'skip 既不是成功也不是失败')
  assert.equal(by['KTC 27GS820'].reason, '账号今日配额已满', '为什么没跑才是关键')

  // 失败要能指到步骤——服务端的排障口径靠它做聚合
  assert.equal(by['飞利浦 27M2N'].failed_step, 'crawl')
  assert.equal(by['戴尔 U2723'].failed_step, 'search_empty')
  assert.equal(by['小米 27'].failed_step, 'price_check')
  assert.equal(by['华硕 VG27'].failed_step, 'risk_control')

  // 等了多久：迁移前后要对比的关键项
  assert.ok(body.decisions.every((d) => typeof d.waited_ms === 'number'))
}

// --- 上报失败不抛，不影响采集 ----------------------------------------------
{
  const r = beginRound({ clientId: 'd1', account: 'X',
                         post: async () => { throw new Error('网络断了') } })
  r.record({ spu: 'A', status: 'success', price: 1 })
  const out = await r.flush()
  assert.equal(out.ok, false, '连不上时应返回 ok:false，而不是抛异常')
  assert.match(out.reason, /网络断了/, '要留下原因')
}

// --- 空轮次不发请求 ----------------------------------------------------------
{
  let called = false
  const r = beginRound({ clientId: 'd1', account: 'X', post: async () => { called = true } })
  const out = await r.flush()
  assert.deepEqual(out, { ok: true, skipped: true }, '一条都没有就别打扰服务端')
  assert.equal(called, false)
}

// --- 上限：再多也说明不了更多，只会撑爆请求体 --------------------------------
{
  const r = beginRound({ clientId: 'd1', account: 'X', post: async () => ({}) })
  for (let i = 0; i < 800; i++) r.record({ spu: `S${i}`, status: 'success', price: 1 })
  assert.equal(r.size(), 500)
}

// --- 节奏参数：本机报什么，服务端就存什么 -----------------------------------
{
  let body = null
  const r = beginRound({
    clientId: 'd1', account: 'X',
    rhythm: { throttleMinMs: 15000, throttleMaxMs: 30000, queryDelayMinMs: 8000,
              queryDelayMaxMs: 14000, dailyEnabled: true, dailyTime: '09:30' },
    post: async (b) => { body = b; return {} }
  })
  r.record({ spu: 'A', status: 'success', price: 1 })
  await r.flush()
  assert.deepEqual(body.rhythm, {
    throttle_min_ms: 15000, throttle_max_ms: 30000,
    query_delay_min_ms: 8000, query_delay_max_ms: 14000,
    daily_enabled: true, daily_time: '09:30'
  }, '要翻译成服务端的下划线命名')
}

// --- min > max 照报：反了本身就是要看见的现象，不该被观测通道纠正掉 ---------
{
  let body = null
  const r = beginRound({ clientId: 'd1', account: 'X',
    rhythm: { throttleMinMs: 30000, throttleMaxMs: 15000 },
    post: async (b) => { body = b; return {} } })
  r.record({ spu: 'A', status: 'success' })
  await r.flush()
  assert.equal(body.rhythm.throttle_min_ms, 30000)
  assert.equal(body.rhythm.throttle_max_ms, 15000)
}

// --- 脏值不能连累整轮决策 ----------------------------------------------------
// 服务端对这几个字段有范围校验；把越界值原样送上去会让请求 422，
// 那等于为了一个观测项，把几十条真正有价值的决策记录一起赔掉。
{
  let body = null
  const r = beginRound({ clientId: 'd1', account: 'X',
    rhythm: { throttleMinMs: 999999999, throttleMaxMs: 'abc', queryDelayMinMs: -5,
              queryDelayMaxMs: 14000, dailyEnabled: 'yes', dailyTime: 7 },
    post: async (b) => { body = b; return {} } })
  r.record({ spu: 'A', status: 'success' })
  await r.flush()
  assert.equal(body.decisions.length, 1, '决策一条都不能少')
  assert.deepEqual(body.rhythm, {
    throttle_min_ms: null, throttle_max_ms: null, query_delay_min_ms: null,
    query_delay_max_ms: 14000, daily_enabled: null, daily_time: null
  }, '越界和非数的丢掉，好的那个留下')
}

// --- 一个都取不到就不送，省得服务端存一行全空的 ------------------------------
{
  let body = null
  const r = beginRound({ clientId: 'd1', account: 'X', rhythm: { throttleMinMs: 'x' },
                         post: async (b) => { body = b; return {} } })
  r.record({ spu: 'A', status: 'success' })
  await r.flush()
  assert.equal(body.rhythm, null)
}

// --- 旧版本没有节奏字段，不能因此出错 ----------------------------------------
{
  let body = null
  const r = beginRound({ clientId: 'd1', account: 'X', post: async (b) => { body = b; return {} } })
  r.record({ spu: 'A', status: 'success' })
  await r.flush()
  assert.equal(body.rhythm, null)
}

console.log('shadow-report: PASS')
