// 采集轮次上服务端（纯离线，读源码）。
//
// 这是「把采集搬进任务模型」的第一刀：只搬**派发与记账**，采集本身仍在端上跑。
// 一轮几十分钟、中途断点续跑，把它做成服务端队列会把端上跑了三个月的调度推倒重来。
//
// 钉的是这一刀的四条边界：
//
//   1. 服务端派来的活要先认领再跑 —— 认领会在服务端再查一次租约，
//      派单和开跑之间隔着一次心跳，这中间租约可能已经转走；
//   2. 认领不到就别跑 —— 不拦的话两台会一起跑，正是租约要解决的问题；
//   3. 登记失败照跑 —— 采集是本机能力，不该因为网抖就停；
//   4. 上报失败不算本轮失败 —— 结果已经落了本地历史。
//
// 跑法：node scripts/test/crawl-run-regression.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const scheduler = read('src/main/scheduler.js')
const device = read('src/main/workbench-device.js')
const api = read('src/main/api.js')

// --- 1. 接口齐了 --------------------------------------------------------------
for (const path of ['/workbench/crawl/runs', '/claim', '/finish']) {
  assert.ok(api.includes(path), `缺接口 ${path}`)
}

// --- 2. 派来的活先认领再跑 ----------------------------------------------------
assert.match(scheduler, /pendingCrawlRunId\(\)/, '调度要问服务端有没有派活')
assert.match(
  scheduler,
  /takeCrawlRun\(dispatched\)[\s\S]{0,120}if \(!ok\) return/,
  '认领不到必须直接返回——那意味着租约已经转走，再跑就是两台一起跑'
)
// 认领成功才开跑，顺序不能反
const claimAt = scheduler.indexOf('takeCrawlRun(dispatched)')
const startAt = scheduler.indexOf('serverRunId: dispatched')
assert.ok(claimAt > 0 && claimAt < startAt, '必须先认领后开跑')

// --- 3. 租约这道闸还在（这一刀不该把它弄丢）---------------------------------
assert.match(scheduler, /if \(!holdsLease\('market'\)\) return/, '定时那一路的租约闸不能丢')
assert.match(scheduler, /trigger === 'schedule' && !holdsLease\('market'\)/, 'start 里那道闸也不能丢')

// --- 4. 登记与上报都不许把本轮弄失败 -----------------------------------------
assert.match(
  device,
  /export async function openCrawlRun[\s\S]{0,900}catch \{\s*return null/,
  '登记失败要返回 null 照跑：采集是本机能力，不该因为网抖就停'
)
assert.match(
  device,
  /export async function closeCrawlRun[\s\S]{0,700}catch \{/,
  '上报失败不许抛——本轮已经跑完并落了本地历史'
)

// --- 5. 服务端那条要能对回本机那条 -------------------------------------------
assert.match(
  scheduler,
  /openCrawlRun\(\{ trigger, localRunId: runId/,
  '登记要带上本地 run id，否则出问题时服务端这条对不到本机那份历史'
)

// --- 6. 收尾一定会上报 --------------------------------------------------------
const finallyAt = scheduler.indexOf('running = false')
const closeAt = scheduler.indexOf('await closeCrawlRun(serverRun')
assert.ok(closeAt > finallyAt, '上报要放在 finally 里——中途抛异常那一轮也得有结论')
assert.match(
  scheduler,
  /closeCrawlRun\(serverRun, \{[\s\S]{0,200}total: counters\.total/,
  '上报要带真实计数，不是只报个成功失败'
)

console.log('crawl-run regression: passed（先认领后跑 + 租约闸还在 + 登记/上报失败都不拖垮本轮 + 收尾必报）')

// --- 7. 界面：轮次看得见、能发起 ----------------------------------------------
// 上一刀把轮次记到了服务端，但界面上看不见——那就是「服务端记了一堆没人看得见
// 的数」。这一节钉住它真的落到人手上了。
const view = read('src/renderer/src/views/Crawlers.vue')
const preload = read('src/preload/index.js')
const main = read('src/main/index.js')

for (const fn of ['getCrawlRuns', 'runCrawlNow']) {
  assert.ok(preload.includes(fn), `preload 缺 ${fn}`)
}
assert.match(view, /最近几轮采集/, '要有轮次列表，否则服务端那些数没人看得见')
assert.match(view, /跑一轮/, '要有手动发起的入口')

// 「跑一轮」只在有人持有行情爬虫时出现：没人持有时派单会 409，
// 给一个点了必然失败的按钮不如不给。
assert.match(
  view,
  /lease\.feature === 'market' && lease\.held/,
  '「跑一轮」只对持有中的行情爬虫显示——图片爬虫还没接入，没人持有时点了必然 409'
)

// 点按钮只登记、不在本机开跑：开跑由持有租约的那台在下一拍心跳里认领后自己起，
// 哪怕点按钮的人就坐在那台机器前。这样「谁在跑」永远只有服务端一个答案。
assert.match(main, /crawler:run-now/, '主进程要有发起入口')
assert.ok(
  !/crawler:run-now[\s\S]{0,400}scheduler\.start|crawler:run-now[\s\S]{0,400}startCrawl/.test(main),
  '「跑一轮」不许直接在本机开跑——那会绕开租约，两台一起跑'
)
assert.match(view, /已派给/, '提示要说「派出去了」，不是「开始了」——它确实还没开始')

console.log('crawl-run regression: 界面 6 条追加通过')

// --- 8. 这页自己别又变长 ------------------------------------------------------
// 加完轮次列表之后它一度是「三节 + 两张表上下堆」，正是刚治过的毛病：
// 表一长就把开关顶出视口，而人来这页十有八九是为了开关，不是为了看表。
assert.match(view, /class="crawlers page"/, '这页要用页框，整页不滚')
assert.match(view, /class="page-head"/, '开关卡片留在页头，永远看得见')
assert.match(view, /page-tabs/, '两张表放标签里，不上下堆')
assert.ok(
  (view.match(/<el-table /g) || []).length === 2 &&
  (view.match(/<el-tab-pane/g) || []).length === 2,
  '两张表要各占一个标签，不能又堆回一页'
)

console.log('crawl-run regression: 页框 4 条追加通过')

// --- 9. 上报断了要出声 --------------------------------------------------------
// 2026-09-16 量出来的教训：工作台登录门改成按人登录之后，本机存的设备账号
// （MARKET_BOT）被挡在门外，而上报那段是「拿不到 token 就跳过」——于是爬照跑、
// 价照算、本地照存，就是不再往 ERP 传，**没有任何地方说得出这件事**。
//
// 这种「看着全绿、实际空转」是最难发现的一类故障。所以：
//   1. 机器凭据走机器的门（crawler-login），不打人的那扇；
//   2. 跳过和失败都要计数，并写进这一轮的「说明」里。
const erpSync = read('src/main/erp-sync.js')
assert.match(erpSync, /deviceLogin/, '设备凭据要走设备的门，不能打工作台那扇')
assert.ok(
  !/[^e]\blogin\(username, password\)/.test(erpSync),
  'erp-sync 不该再用工作台登录——它拿的是设备账号，那扇门不放行'
)
assert.match(api, /\/auth\/crawler-login/, 'deviceLogin 要打设备登录')

assert.match(scheduler, /uploadSkipped/, '拿不到登录态跳过的要计数')
assert.match(scheduler, /uploadFailed/, '上报失败的要计数')
assert.match(scheduler, /function uploadNote/, '要把上报情况汇总进这一轮的说明')
// 一条都没漏时不占「说明」列
assert.match(
  scheduler,
  /if \(!skipped && !failed\) return ''/,
  '正常情况不该在说明列里占位置'
)
// 上报失败不许把这一条判成采集失败：价已经算出来了，本地也存了
const uploadBlock = scheduler.slice(scheduler.indexOf('counters.uploadFailed++') - 400,
                                   scheduler.indexOf('counters.uploadFailed++') + 200)
assert.ok(
  !/counters\.fail\+\+/.test(uploadBlock),
  '上报失败不该把这一条采集判成失败——传不上去和没爬到是两回事'
)

console.log('crawl-run regression: 上报可见性 7 条追加通过')
