// 端上的爬虫租约语义（纯离线，不碰真服务端）。
//
// 服务端负责判归属，端上负责**服从判决**。这个文件钉的是"服从"那一半：
//
//   1. 没拿到租约就不许自动开爬 —— 否则一个账号在两台电脑上登录，两台都会按点
//      自己跑起来，去抢同一批 AdsPower 环境、重复采集、重复写库。这正是租约要
//      解决的那个问题。
//   2. 续期被服务端拒（409）要立刻放下持有态 —— 掉线的机器网络恢复后必须自己
//      停手，不能和新持有者一起跑。
//   3. 管理员请求让位时，跑完当前这轮才交接，不掐断。
//
// 跑法：node scripts/test/crawler-lease-regression.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const deviceSrc = readFileSync(join(root, 'src/main/workbench-device.js'), 'utf8')
const schedulerSrc = readFileSync(join(root, 'src/main/scheduler.js'), 'utf8')

// --- 1. 定时开爬必须过租约这一关 ---------------------------------------------
assert.match(
  schedulerSrc,
  /if \(!holdsLease\('market'\)\) return/,
  '每日定时那一路必须先问租约：没有它，两台电脑会各自按点跑起来'
)
assert.match(
  schedulerSrc,
  /trigger === 'schedule' && !holdsLease\('market'\)/,
  'start() 也要挡一次：定时触发绕开 rearmDaily 直接调它的路径同样存在'
)

// 11-11：定时不再看本机「自动开爬」开关（默认关、没人开，一直只有手动在采）；
// 有租约 + 有启用的账号就按点采
assert.doesNotMatch(schedulerSrc, /if \(!s\.dailyEnabled\) return/, '定时不能再被本机开关挡住')
assert.match(
  schedulerSrc,
  /if \(!getAccounts\(\)\.some\(\(account\) => account\.enabled\)\) return/,
  '没有启用的账号就不按点开爬'
)

// 顺序要对：租约判定必须在 running 置位、在真正开爬之前
const gateAt = schedulerSrc.indexOf("trigger === 'schedule' && !holdsLease('market')")
const runningAt = schedulerSrc.indexOf('running = true')
assert.ok(gateAt > 0 && gateAt < runningAt, '租约没过就把 running 置成 true，会把这台锁在"运行中"')

// --- 2. 续期被拒 = 立刻放下持有态 --------------------------------------------
assert.match(
  deviceSrc,
  /error\?\.response\?\.status === 409/,
  '续期要能认出 409（租约已易主），这是"掉线的机器回来自己停手"的唯一信号'
)
assert.match(deviceSrc, /mine: false/, '续期失败后 mine 必须落回 false，调度下一拍才会停')

// 心跳打不通 ≠ 租约没了：网抖一下不该让本机自己放弃
assert.match(
  deviceSrc,
  /保留上一份租约快照/,
  '心跳失败时不能顺手清掉租约——那会让一次网络抖动变成一次让位'
)

// --- 3. 让位等这一轮跑完 ------------------------------------------------------
assert.match(schedulerSrc, /yieldLeaseIfAsked/, '要有"跑完再让位"这一步')
const finallyAt = schedulerSrc.indexOf('running = false')
const yieldAt = schedulerSrc.indexOf('await yieldLeaseIfAsked()')
assert.ok(yieldAt > finallyAt, '让位必须发生在本轮结束之后，不能打断正在跑的采集')
assert.ok(
  !/stopRequested\s*=\s*true[\s\S]{0,200}handoff/i.test(schedulerSrc),
  '让位不该走"手动停止"那条路——那会把当前这轮判成被中断'
)

// --- 4. 设备 id 的性质 --------------------------------------------------------
assert.match(deviceSrc, /store\.set\('deviceId', id\)/, '设备 id 要落盘，不能每次启动变一个')
assert.ok(
  !/deviceId.*(?:staff|token|adspower)/i.test(deviceSrc),
  '设备 id 不能掺进登录账号或 AdsPower 的东西：换个人登录、重装 AdsPower 都还是这台机器'
)

// --- 5. 端上不自己发明"谁在跑" ------------------------------------------------
assert.ok(
  !/leases\s*=\s*\[[^\]]*held:\s*true/.test(deviceSrc),
  '端上不许凭空造出一个"持有中"的租约，持有态只能来自服务端的答复'
)
assert.match(
  deviceSrc,
  /export function holdsLease/,
  '判定收在一个函数里：界面和调度问同一个，不各自解释租约'
)

console.log('crawler-lease regression: passed (定时/手动双闸 + 409 即停手 + 跑完再让位 + 设备 id 稳定)')
