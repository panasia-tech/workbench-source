import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

import { crawlOne } from '../../src/main/goofish.js'
import { installSearchCapture } from '../../src/main/search-capture.js'
import { searchQueriesForTask } from '../../src/main/search-queries.js'

const navigated = []
const fixture = {
  noResult: false,
  loggedOut: false,
  cardCount: 3,
  pricedCount: 3,
  blockedCount: 0,
  nonTargetCount: 0,
  lowest: 39,
  prices: [300, 399, 39],
  candidates: [
    { key: 'a', itemId: 'a', itemUrl: 'https://www.goofish.com/item?id=100001', title: '显示器 A', price: 300, picUrl: 'https://img.alicdn.com/bao/uploaded/a.jpg' },
    { key: 'b', itemId: 'b', itemUrl: 'https://www.goofish.com/item?id=100002', title: '显示器 B', price: 399 },
    { key: 'bait', itemId: 'bait', itemUrl: 'https://www.goofish.com/item?id=100003', title: '芯片回收', price: 39 }
  ]
}
const protocol = new EventEmitter()
protocol.attached = false
protocol.isAttached = () => protocol.attached
protocol.attach = () => { protocol.attached = true }
protocol.detach = () => { protocol.attached = false }
protocol.sendCommand = async (method) => {
  if (method === 'Network.getResponseBody') {
    const aliasSearch = /G25H4/.test(navigated.at(-1) || '')
    const mainFieldSearch = /MG25H11Q/.test(navigated.at(-1) || '')
    const responseCandidates = aliasSearch
      ? [{ key: 'alias-price', itemId: 'alias-price', itemUrl: 'https://www.goofish.com/item?id=100004', title: 'HKC G25H4 显示器', price: 300 }]
      : mainFieldSearch
        ? [{ key: 'main-price', itemId: 'main-price', itemUrl: 'https://www.goofish.com/item?id=100005', title: 'HKC MG25H11Q 显示器', price: 100 }]
      : fixture.candidates
    return {
      body: JSON.stringify({
        data: {
          resultList: responseCandidates.map((candidate) => ({
            data: { item: { main: { exContent: {
              itemId: candidate.itemId,
              title: candidate.title,
              price: [{ text: String(candidate.price) }],
              ...(candidate.picUrl ? { picUrl: candidate.picUrl } : {})
            } } } }
          }))
        }
      })
    }
  }
  return {}
}
const wc = new EventEmitter()
Object.assign(wc, {
  debugger: protocol,
  isDestroyed: () => false,
  loadURL: async (url) => {
    navigated.push(url)
    const requestUrl = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch/1.0/pc.search'
    protocol.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'fixture-1', request: { url: requestUrl } })
    protocol.emit('message', {}, 'Network.responseReceived', { requestId: 'fixture-1', response: { url: requestUrl } })
    protocol.emit('message', {}, 'Network.loadingFinished', { requestId: 'fixture-1' })
    await new Promise((resolve) => setImmediate(resolve))
  },
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: navigated.at(-1) || '' }
    return fixture
  }
})
installSearchCapture(wc)
const snapshots = []
const result = await crawlOne(wc, '飞利浦 25M2N32', {
  accountName: '回归账号',
  captureSnapshot: async ({ query, pageUrl, result: captured }) => {
    snapshots.push({ query, pageUrl, candidates: captured.candidates.length })
    return { path: '/fixture/task-snapshot.html', pageUrl, viewport: { width: 1280, height: 820 } }
  }
})

assert.equal(result.ok, true)
assert.equal(result.source, 'cleaned_average')
assert.equal(result.price, 349.5, '关键词行情仍是删除低价垃圾后的平均挂牌价')
assert.deepEqual(navigated, ['https://www.goofish.com/search?q=%E9%A3%9E%E5%88%A9%E6%B5%A6%2025M2N32'])
assert.equal(navigated.some((url) => /\/item(?:\?|\/)/.test(url)), false, '商品 URL 只是记录，关键词采集不得导航详情页')
assert.deepEqual(snapshots, [{
  query: '飞利浦 25M2N32',
  pageUrl: 'https://www.goofish.com/search?q=%E9%A3%9E%E5%88%A9%E6%B5%A6%2025M2N32',
  candidates: 3
}])
assert.equal(result.snapshotPath, '/fixture/task-snapshot.html')
assert.equal(result.priceBreakdown.includedListings.length, 2)
// ERP 近期价格记录拿 picUrl 当缩略图：参与算价的挂牌要带着图
assert.deepEqual(result.priceBreakdown.includedListings.map((item) => item.picUrl),
  ['https://img.alicdn.com/bao/uploaded/a.jpg', ''])
assert.equal(result.priceBreakdown.rejectedBelow100.length, 1)

// 任务中心把 Excel 显式搜索字段作为实际查询数组传给执行层；超过 12
// 项时只能保留清洗后的前 12 项，不能在调度器里重新扩成无限别称。
const boundedSearchKeywords = Array.from({ length: 15 }, (_, index) => `显式型号-${index + 1}`)
assert.deepEqual(
  searchQueriesForTask({ searchKeywords: boundedSearchKeywords }),
  boundedSearchKeywords.slice(0, 12),
  '显式搜索词超过 12 项时必须在执行层保持有界'
)

// 每行三个型号/别名时，别名结果只会命中当前字段，不应因为没有同时包含主型号
// 而被错误标成 nonTarget；两个搜索结果都必须进入合并平均。
const multiField = await crawlOne(wc, ['MG25H11Q', 'G25H4'], {
  accountName: '回归账号',
  relevanceKeywords: ['MG25H11Q', 'G25H4'],
  queryDelayMinMs: 1,
  queryDelayMaxMs: 1
})
assert.equal(multiField.ok, true)
assert.equal(multiField.price, 200, '主型号 ¥100 与别名 ¥300 应合并为 ¥200 平均价')
assert.deepEqual(multiField.priceBreakdown.queryResults.map((item) => item.priced), [1, 1])
assert.equal(multiField.priceBreakdown.queryResults[1].nonTarget, 0, '别名搜索结果不能被主型号过滤掉')

const schedulerSource = readFileSync(new URL('../../src/main/scheduler.js', import.meta.url), 'utf8')
const taskStoreSource = readFileSync(new URL('../../src/main/task-store.js', import.meta.url), 'utf8')
assert.match(schedulerSource, /taskStore\.recordRunResult\(runId, task, saved\)/, '旧行情 runResult 写入必须保留')
assert.match(schedulerSource, /addResult\(saved\)/, '旧行情结果表写入必须保留')
assert.match(schedulerSource, /captureHtmlSnapshot\(wc\)/, '关键词 DOM 快照行为必须保留')
assert.match(taskStoreSource, /snapshotEntries:\s*persistedSnapshotEntries/)
assert.match(taskStoreSource, /priceBreakdown:\s*result\.priceBreakdown \|\| null/)

console.log('seller keyword boundary regression: passed (route, legacy writes, snapshot/detail behavior unchanged)')
