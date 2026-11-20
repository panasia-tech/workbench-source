// 风控判据只有一份（纯离线，读源码与那份共用 JSON）。
//
// 2026-09-16 合并前，三处判据各写各的，而且内容真的不一样——两边只共享「验证码」
// 和「安全验证」两个词：群控认不出「访问受限/请求频繁/非法访问/风控拦截」，
// 桌面端认不出「账号异常/申诉/违规/人机验证」。
//
// 不是重复，是各学各的教训，谁也没拿到对方那半。而漏判风控的症状是「照常重试」——
// 重试风控页就是往枪口上撞，代价是账号被判异常。
//
// 所以这个文件钉的不是「代码整洁」，是**两边永远看同一张表**。
//
// 跑法：node scripts/test/risk-anchors-regression.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RISK_ANCHORS, RISK_SIGNALS, riskSignalFor } from '../../src/main/risk-anchors.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const SHARED = '../groupcontrol-server/app/flow/risk_anchors.json'

// --- 1. 真的读到了共用那份 ----------------------------------------------------
const shared = JSON.parse(read(SHARED))
assert.deepEqual(RISK_SIGNALS, shared.signals, '桌面端读到的判据必须就是共用那份')
assert.ok(RISK_ANCHORS.length >= 15, `锚点只有 ${RISK_ANCHORS.length} 条，共用表可能没加载进来`)

// --- 2. 两边各自的教训都在里面 ------------------------------------------------
// 合并前群控独有的（桌面端从前认不出）
for (const w of ['账号异常', '申诉', '违规', '人机验证', '身份验证']) {
  assert.ok(RISK_ANCHORS.includes(w), `群控学到的「${w}」丢了`)
}
// 合并前桌面端独有的（群控从前认不出）
for (const w of ['访问受限', '请求频繁', '非法访问', '风控拦截', '访问异常']) {
  assert.ok(RISK_ANCHORS.includes(w), `桌面端学到的「${w}」丢了`)
}
// 网页版流程实测踩中的滑块文案
for (const w of ['请拖动下方滑块', '请按住滑块']) {
  assert.ok(RISK_ANCHORS.includes(w), `网页版实测踩中的「${w}」丢了`)
}

// --- 3. 没人再私藏一份硬编码 --------------------------------------------------
const goofish = read('src/main/goofish.js')
assert.ok(
  !/\['访问异常',\s*\/访问异常\//.test(goofish),
  'goofish.js 里那张手写的 signals 表该没了——留着就会和共用表各走各的'
)
assert.match(goofish, /riskSignalsLiteral\(\)/, '判据要从共用表注入页面脚本')
// 整页判据里原来把锚点手抄了一遍，抄漏就是静默失效
assert.ok(
  !/访问异常\|访问受限\|请求频繁/.test(goofish),
  '整页判据不许再手抄锚点，要走同一张表'
)

const engine = read('../groupcontrol-server/app/flow/engine.py')
assert.match(engine, /risk_anchors\.json/, '群控也要读共用那份')
assert.ok(
  !/RISK_ANCHORS = \["验证码"/.test(engine),
  'engine.py 里那份硬编码列表该没了'
)
// 读不到就抛，不给兜底默认：静默降级 = 风控判据悄悄少一半，等账号被封才发现
assert.match(engine, /不给兜底默认值|宁可起不来/, 'engine 读判据失败时必须抛，不许退回内置列表')

const web = read('../groupcontrol-server/app/flow/web/goods_flows_web.py')
assert.ok(
  !/\("请拖动下方滑块", "请按住滑块"\)/.test(web),
  '网页版的滑块锚点已并入共用表，不该再单独拼一份'
)

// --- 4. 分类还认得出来 --------------------------------------------------------
assert.equal(riskSignalFor('页面提示请求频繁，请稍后再试'), '请求频繁')
assert.equal(riskSignalFor('请按住滑块拖到最右边'), '滑块')
assert.equal(riskSignalFor('这是一个正常的商品详情页'), '')

console.log(`risk-anchors regression: passed（${RISK_ANCHORS.length} 条锚点，一份表，两端共用）`)
