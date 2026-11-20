// 每天按点开爬 + 错过就补（src/main/daily-schedule.js）。
// 跑法：node scripts/test/daily-schedule-regression.mjs
import assert from 'node:assert/strict'
import { dailyDecision, ranToday } from '../../src/main/daily-schedule.js'

const at = (h, m, d = 11) => new Date(2026, 10, d, h, m, 30)
const run = (date) => ({ startedAt: date.toISOString() })

// 正好到点：开一轮；同一分钟再问不重复开
const due = dailyDecision({ now: at(10, 0), dailyTime: '10:00' })
assert.equal(due.kind, 'due')
assert.equal(dailyDecision({ now: at(10, 0), dailyTime: '10:00', firedKey: due.key }), null)

// 还没到点：什么都不做
assert.equal(dailyDecision({ now: at(9, 59), dailyTime: '10:00' }), null)

// 过了点、今天没跑过：补一轮（工位夜里关机，默认 02:00 碰不上的那种）
assert.deepEqual(dailyDecision({ now: at(9, 5), dailyTime: '02:00' }), { kind: 'catch_up', day: '2026-11-11' })

// 今天已经跑过（手动也算）：不补
assert.equal(dailyDecision({ now: at(9, 5), dailyTime: '02:00', runs: [run(at(8, 0))] }), null)

// 昨天跑过不算今天
assert.equal(dailyDecision({ now: at(9, 5), dailyTime: '02:00', runs: [run(at(23, 0, 10))] }).kind, 'catch_up')

// 今天补过一次（比如没任务没起来）：不每分钟重试
assert.equal(dailyDecision({ now: at(9, 6), dailyTime: '02:00', catchUpDay: '2026-11-11' }), null)

// 第二天又可以补
assert.equal(dailyDecision({ now: at(9, 6, 12), dailyTime: '02:00', catchUpDay: '2026-11-11' }).kind, 'catch_up')

// 时间设置坏了按 02:00 算
assert.equal(dailyDecision({ now: at(2, 0), dailyTime: '' }).kind, 'due')

assert.equal(ranToday([], at(1, 0)), false)
console.log('daily-schedule 通过')
