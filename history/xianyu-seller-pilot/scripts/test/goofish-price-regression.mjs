import assert from 'node:assert/strict'
import { confirmRiskObservations, detectRiskPage, pickPrice } from '../../src/main/goofish.js'

const baitCluster = pickPrice([39, 39, 300, 319, 366])
assert.equal(baitCluster.price, 328.33, '多个 39 元诱饵剔除后应计算有效挂牌平均价')
assert.equal(baitCluster.droppedBelowMinimum, 2, '应记录被丢弃的低于100元候选数量')
assert.deepEqual(baitCluster.validPrices, [300, 319, 366], '平均价只能使用清洗后的有效挂牌')
assert.deepEqual(baitCluster.rejectedBelow100, [39, 39], '低于100元的诱饵应进入剔除明细')

const singleBait = pickPrice([39, 280, 300, 399])
assert.equal(singleBait.price, 326.33, '单个低价诱饵剔除后应计算有效挂牌平均价')

const allInvalid = pickPrice([39, 50, 69])
assert.equal(allInvalid.price, 52.67, '全部候选都低于100元时仍返回低于100的平均价，交给错误 Excel')
assert.equal(allInvalid.validPrices.length, 0, '全部低价时不能产生有效挂牌')

const normal = pickPrice([280, 300, 399])
assert.equal(normal.price, 326.33, '正常挂牌应取平均价而不是最低价')

const highBait = pickPrice([280, 300, 399, 99999999])
assert.equal(highBait.price, 326.33, '明显异常高价不能污染清洗后平均价')
assert.deepEqual(highBait.rejectedOverMaximum, [99999999], '异常高价应进入剔除明细')

assert.equal(pickPrice([]), null, '没有价格时应返回空结果')

function riskPageRuntime({ url = 'https://www.goofish.com/personal?userId=1', title = '正常卖家_闲鱼', body = '', normalContent = true, candidates = [] } = {}) {
  const document = {
    title,
    body: { innerText: body },
    querySelector: () => normalContent ? {} : null,
    querySelectorAll: () => candidates
  }
  const location = { href: url }
  const getComputedStyle = (element) => element.style || { display: 'block', visibility: 'visible' }
  return async (script) => new Function('document', 'location', 'getComputedStyle', `return ${script}`)(document, location, getComputedStyle)
}

const keywordOnly = await detectRiskPage({
  executeJavaScript: riskPageRuntime({ body: '商品标题：自动识别安全验证码教程，正常在售 ¥199' })
}, { wait: async () => {} })
assert.equal(keywordOnly.riskControl, false, '普通商品文本包含“安全验证码”不得触发风控')
assert.equal(keywordOnly.confirmationCount, 0, '普通业务页关键词不应成为风控候选')

const sellerNameKeyword = await detectRiskPage({
  executeJavaScript: riskPageRuntime({ title: '安全验证专家_闲鱼', body: '安全验证专家 暂无在售商品', normalContent: true })
}, { wait: async () => {} })
assert.equal(sellerNameKeyword.riskControl, false, '卖家昵称或页面标题包含风控词不得触发风控')

const hiddenChallenge = {
  innerText: '安全验证',
  textContent: '安全验证',
  tagName: 'DIV',
  style: { display: 'none', visibility: 'visible' },
  getAttribute: () => null,
  getBoundingClientRect: () => ({ width: 400, height: 200 })
}
const hiddenOnly = await detectRiskPage({
  executeJavaScript: riskPageRuntime({ body: '安全验证 正常商品列表', candidates: [hiddenChallenge] })
}, { wait: async () => {} })
assert.equal(hiddenOnly.riskControl, false, '隐藏验证节点不得触发风控')

const visibleChallenge = {
  innerText: '请求频繁，请稍后再试',
  textContent: '请求频繁，请稍后再试',
  tagName: 'DIV',
  style: { display: 'block', visibility: 'visible' },
  getAttribute: () => null,
  getBoundingClientRect: () => ({ width: 400, height: 200 })
}
const visibleRuntime = riskPageRuntime({ body: '请求频繁，请稍后再试', normalContent: false, candidates: [visibleChallenge] })
const visibleRisk = await detectRiskPage({ executeJavaScript: visibleRuntime }, { wait: async () => {} })
assert.equal(visibleRisk.riskControl, true, '连续两次可见验证组件必须触发风控')
assert.equal(visibleRisk.source, 'visible-challenge-component', '可见验证组件必须保留证据来源')

const challengeRouteRuntime = riskPageRuntime({ url: 'https://www.goofish.com/security/verify', body: '', normalContent: false })
const challengeRouteRisk = await detectRiskPage({ executeJavaScript: challengeRouteRuntime }, { wait: async () => {} })
assert.equal(challengeRouteRisk.riskControl, true, '连续两次稳定挑战路径必须触发风控')
assert.equal(challengeRouteRisk.source, 'challenge-route', '挑战路径必须保留证据来源')

const ordinaryPageKeyword = confirmRiskObservations(
  { candidate: false, signal: '', source: '', url: 'https://www.goofish.com/personal?userId=1' },
  { candidate: false, signal: '', source: '', url: 'https://www.goofish.com/personal?userId=1' }
)
assert.equal(ordinaryPageKeyword.riskControl, false, '普通卖家页文本不能仅凭关键词进入风控')

const transientRisk = confirmRiskObservations(
  { candidate: true, signal: '安全验证', source: 'visible-challenge-component', url: 'https://www.goofish.com/personal?userId=1' },
  { candidate: false, signal: '', source: '', url: 'https://www.goofish.com/personal?userId=1' }
)
assert.equal(transientRisk.riskControl, false, '单次瞬态风控候选不得冷却账号')
assert.equal(transientRisk.confirmationCount, 1, '单次瞬态候选应保留一次确认计数')

const routeChanged = confirmRiskObservations(
  { candidate: true, signal: '验证页', source: 'challenge-route', url: 'https://www.goofish.com/verify' },
  { candidate: true, signal: '安全验证', source: 'visible-challenge-component', url: 'https://www.goofish.com/personal?userId=1' }
)
assert.equal(routeChanged.riskControl, false, '导航离开验证路径后不得沿用旧页面风控证据')

const observations = [
  { candidate: true, signal: '请求频繁', source: 'visible-challenge-component', url: 'https://www.goofish.com/personal?userId=1', visibleText: '请求频繁，请稍后再试', visibleTag: 'div' },
  { candidate: true, signal: '请求频繁', source: 'visible-challenge-component', url: 'https://www.goofish.com/personal?userId=1', visibleText: '请求频繁，请稍后再试', visibleTag: 'div' }
]
const risk = await detectRiskPage({ executeJavaScript: async () => observations.shift() }, { wait: async () => {} })
assert.equal(risk.riskControl, true, '连续两次可见请求频繁证据应识别为风控页面')
assert.equal(risk.signal, '请求频繁', '应保留风控页面信号')
assert.equal(risk.source, 'visible-challenge-component', '应保留风控证据来源')
assert.equal(risk.confirmationCount, 2, '真实风控必须经过两次连续确认')

console.log('goofish price regression: passed (cleaned average + confirmed visible risk guard)')
