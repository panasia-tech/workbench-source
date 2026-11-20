// 影子模式上报（S3-0）：本机照常自己决定，但把每一次决策报给服务端。
//
// 它存在的唯一理由是给 S3-1 留一个**对照基准**。决策权搬到服务端之后，
// 要能回答「新调度是不是比原来跑得少了／慢了／跳得多了」——没有搬家前的同口径数据，
// 那个问题只能靠感觉回答。
//
// 三条设计取舍：
//   1. **一轮一次上报**，不是一条一次。行情一轮几十上百条，逐条发请求既吵又慢；
//      而对照要看的是"这一轮整体如何"。
//   2. **上报失败绝不影响采集**。它是观测，不是业务——网络不好就丢掉这一轮的记录，
//      也不能让爬虫因此停下。
//   3. **skip 也要记**。「为什么没跑」和「跑了什么」一样是决策，而且迁移后最容易
//      出偏差的恰恰是这半边。
import { gcGet, gcPostJson } from './api.js'

const MAX_DECISIONS = 500      // 一轮上报的上限：再多也说明不了更多，只会撑爆请求体
const MAX_MS = 3600000         // 与服务端 schema 的上界一致

/**
 * 把本机的节奏参数整成服务端认得的形状。
 *
 * **越界或不是数的一律丢掉，而不是原样送上去**：服务端对这几个字段有范围校验，
 * 送一个脏值上去会让整个请求 422——那等于因为一个观测项，把这一轮几十条真正
 * 有价值的决策记录一起赔掉。观测不能拖累业务，这里也一样。
 *
 * 注意不在这里纠正 min > max：那种反了的情况**本身就是要看见的现象**。
 */
function normalizeRhythm(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ms = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n <= MAX_MS ? Math.round(n) : null
  }
  const rhythm = {
    throttle_min_ms: ms(raw.throttleMinMs),
    throttle_max_ms: ms(raw.throttleMaxMs),
    query_delay_min_ms: ms(raw.queryDelayMinMs),
    query_delay_max_ms: ms(raw.queryDelayMaxMs),
    daily_enabled: typeof raw.dailyEnabled === 'boolean' ? raw.dailyEnabled : null,
    daily_time: typeof raw.dailyTime === 'string' ? raw.dailyTime.slice(0, 8) : null
  }
  // 一个都没取到就别送了，省得服务端存一行全空的
  return Object.values(rhythm).some((v) => v !== null) ? rhythm : null
}

/** 一轮的收集器。scheduler 每个账号分片开一个。 */
export function beginRound({ clientId, account, trigger = 'manual', rhythm = null, post = null } = {}) {
  // post 可注入：回归里换成假的，否则测试会**真的往生产写影子数据**
  // （接口上线前是 404，上线后就是真记录——这种测试比没有测试更糟）。
  const send = post || ((body) => gcPostJson('/market/rounds', body))
  const rhythmOut = normalizeRhythm(rhythm)
  const decisions = []
  const startedAt = new Date()
  let lastAt = Date.now()

  return {
    /**
     * 记一条处置。status 用 scheduler 自己那套（success / fail / empty /
     * invalid_price / risk_control / skip），这里翻译成服务端的 run/skip + ok。
     */
    record({ spu, status, reason = null, price = null, failedStep = null, durationMs = null }) {
      if (decisions.length >= MAX_DECISIONS) return
      const now = Date.now()
      const waitedMs = Math.max(0, now - lastAt)
      lastAt = now
      const skipped = status === 'skip'
      decisions.push({
        spu: String(spu || '(未命名)').slice(0, 128),
        action: skipped ? 'skip' : 'run',
        ok: skipped ? null : status === 'success',
        reason: reason ? String(reason).slice(0, 255) : null,
        failed_step: failedStep || (status === 'empty' ? 'search_empty'
          : status === 'invalid_price' ? 'price_check'
          : status === 'risk_control' ? 'risk_control'
          : status === 'fail' ? 'crawl' : null),
        price: Number.isFinite(Number(price)) ? Number(price) : null,
        waited_ms: waitedMs,
        duration_ms: durationMs
      })
    },

    size() {
      return decisions.length
    },

    /** 把这一轮报上去。失败只记一行日志——观测不能拖累业务。 */
    async flush() {
      if (!decisions.length) return { ok: true, skipped: true }
      try {
        const res = await send({
          client_id: clientId,
          account,
          trigger,
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          decisions,
          rhythm: rhythmOut
        })
        console.log(`[shadow] 已上报行情轮次 ${res?.job_id || ''}（账号 ${account} · ${decisions.length} 条）`)
        return { ok: true, jobId: res?.job_id, count: decisions.length }
      } catch (error) {
        console.warn('[shadow] 行情轮次上报失败（不影响采集）：', error?.message || error)
        return { ok: false, reason: String(error?.message || error) }
      }
    }
  }
}

/** 服务端那边的汇总，排障时给界面用。 */
export async function fetchRounds(days = 1) {
  return gcGet('/market/rounds', { days })
}
