import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createSellerWorkerController,
  normalizeSellerHomeUrl,
  sellerNavigationKind
} from '../../src/main/seller-worker.js'
import {
  crawlSellerPage,
  isMaskedSellerName,
  resolveAuthoritativeSellerName,
  serializeSellerCard
} from '../../src/main/seller-goofish.js'

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.windowOpenHandler = null
    this.userAgent = ''
  }

  isDestroyed() { return this.destroyed }
  setUserAgent(value) { this.userAgent = value }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  close() { this.destroyed = true }
}

class FakeBrowserWindow extends EventEmitter {
  static created = []

  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.destroyed = false
    this.skipTaskbar = false
    FakeBrowserWindow.created.push(this)
  }

  isDestroyed() { return this.destroyed }
  setSkipTaskbar(value) { this.skipTaskbar = value }
  destroy() {
    this.destroyed = true
    this.webContents.destroyed = true
    this.emit('closed')
  }
}

assert.equal(normalizeSellerHomeUrl(' seller_123 '), 'https://www.goofish.com/personal?userId=seller_123')
assert.equal(normalizeSellerHomeUrl('https://www.goofish.com/personal?userId=seller_123&utm_source=x'), 'https://www.goofish.com/personal?userId=seller_123')
assert.throws(() => normalizeSellerHomeUrl('https://evil.example/personal?userId=seller_123'), /seller/i)
assert.equal(sellerNavigationKind('https://www.goofish.com/personal?userId=seller_123'), 'seller')
assert.equal(sellerNavigationKind('https://www.goofish.com/item?id=123456'), 'item_detail')
assert.equal(sellerNavigationKind('https://www.goofish.com/'), 'public_home')
assert.equal(sellerNavigationKind('https://login.taobao.com/member/login.jhtml'), 'login')
assert.equal(sellerNavigationKind('https://www.taobao.com/seller/user'), 'blocked', '淘宝普通页不属于闲鱼卖家采集边界')
assert.equal(sellerNavigationKind('https://www.goofish.com:8443/personal?userId=seller_123'), 'blocked')
assert.equal(sellerNavigationKind('https://evil.example/steal'), 'blocked')

const navigationEvidence = []
const controller = createSellerWorkerController({
  BrowserWindow: FakeBrowserWindow,
  onNavigationEvidence: (entry) => navigationEvidence.push(entry)
})
const accountA = { id: 'account-a', name: '账号 A', partition: 'persist:xianyu-account-a' }
const accountB = { id: 'account-b', name: '账号 B', partition: 'persist:xianyu-account-b' }
const wcA = await controller.getSellerWebContents(accountA)
const wcB = await controller.getSellerWebContents(accountB)
const [wcAConcurrent1, wcAConcurrent2] = await Promise.all([
  controller.getSellerWebContents(accountA),
  controller.getSellerWebContents(accountA)
])
assert.equal(wcAConcurrent1, wcAConcurrent2, '同一账号并发取 worker 不得重复创建窗口')

assert.notEqual(wcA, wcB, '不同账号必须使用独立 webContents')
assert.equal(FakeBrowserWindow.created.length, 2)
for (const [index, win] of FakeBrowserWindow.created.entries()) {
  const account = index === 0 ? accountA : accountB
  assert.equal(win.options.show, false)
  assert.equal(win.options.paintWhenInitiallyHidden, true)
  assert.equal(win.options.skipTaskbar, true)
  assert.equal(win.skipTaskbar, true)
  assert.equal(win.options.webPreferences.partition, account.partition)
  assert.equal(win.options.webPreferences.backgroundThrottling, false)
  assert.equal(win.options.webPreferences.focusOnNavigation, false)
  assert.equal(Object.hasOwn(win.options.webPreferences, 'offscreen'), false, '禁止 offscreen 渲染')
  assert.equal(Object.hasOwn(win.options, 'parent'), false, '卖家 worker 不得挂到预览/主窗口')
}

let prevented = false
wcA.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://www.goofish.com/item?id=123456')
assert.equal(prevented, true, '卖家链路必须取消商品详情导航')
assert.equal(navigationEvidence.at(-1)?.reasonCode, 'ITEM_DETAIL_BLOCKED')
assert.deepEqual(wcA.windowOpenHandler({ url: 'https://www.goofish.com/item?id=654321' }), { action: 'deny' })

wcA.emit('render-process-gone', {}, { reason: 'crashed' })
await new Promise((resolve) => setImmediate(resolve))
const recycled = await controller.getSellerWebContents(accountA)
assert.notEqual(recycled, wcA, '崩溃后必须重建 worker')
assert.equal(FakeBrowserWindow.created.at(-1).options.webPreferences.partition, accountA.partition, '重建不得更换账号分区')

const serialized = serializeSellerCard({
  itemId: '10001',
  itemUrl: 'https://www.goofish.com/item?id=10001',
  title: '显示器',
  imageUrl: 'https://img.example/1.jpg',
  price: '399.00',
  status: 'active',
  wants: '12',
  category: '数码',
  capturedAt: '2026-08-23T00:00:00.000Z',
  text: '不得外泄的整卡文本',
  cookie: '不得序列化'
})
assert.deepEqual(Object.keys(serialized).sort(), [
  'capturedAt', 'category', 'imageUrl', 'itemId', 'itemUrl', 'price', 'status', 'title', 'wants'
].sort())
assert.equal(serialized.price, 399)
assert.equal(serialized.wants, 12)
assert.equal(serializeSellerCard({ itemId: 'x', itemUrl: 'https://evil.example/item?id=x', imageUrl: 'javascript:alert(1)', price: -1 }).itemUrl, '')
assert.equal(serializeSellerCard({ itemId: 'x', itemUrl: 'https://evil.example/item?id=x', imageUrl: 'javascript:alert(1)', price: -1 }).imageUrl, '')
assert.equal(serializeSellerCard({ itemId: 'x', price: -1 }).price, null)
assert.equal(serializeSellerCard({ itemId: 'unknown-status', status: 'unknown' }).status, 'unknown', '综合列表无法识别状态时不得伪装成在售')
const sanitizedUrls = serializeSellerCard({
  itemId: '10001',
  itemUrl: 'https://www.goofish.com/item?id=10001&token=item-secret&spm=tracking#fragment',
  imageUrl: 'https://img.example/1.jpg?w=800&signature=image-secret&session=session-secret&token=token-secret#fragment'
})
assert.equal(sanitizedUrls.itemUrl, 'https://www.goofish.com/item?id=10001')
assert.equal(sanitizedUrls.imageUrl, 'https://img.example/1.jpg?w=800')

// A seller tab can report a five-digit total while the virtualized page only
// exposes a small window of cards at a time. There is no fixed 1,000-card
// completion line: the collector follows page evidence and the scroll budget.
for (const expectedCount of [10000, 20000]) {
  const largeFixtureItems = Array.from({ length: 1300 }, (_, index) => ({
    itemId: `large-${expectedCount}-${index}`,
    itemUrl: `https://www.goofish.com/item?id=${200000 + index}`,
    title: `large-seller-${expectedCount}-${index}`,
    imageUrl: `https://img.example/large-${index}.jpg`,
    price: 300 + index,
    status: 'active',
    wants: index,
    category: '数码'
  }))
  let visibleCount = 180
  let scrollCalls = 0
  let largeNowCalls = 0
  let debuggerAttachedForLarge = false
  let debuggerDetachedForLarge = 0
  const largeSellerWc = {
    loadURL: async () => {},
    debugger: {
      isAttached: () => debuggerAttachedForLarge,
      attach: () => { debuggerAttachedForLarge = true },
      detach: () => { debuggerAttachedForLarge = false; debuggerDetachedForLarge++ },
      sendCommand: async () => {}
    },
    executeJavaScript: async (script) => {
      if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
      if (script.includes('scrollIntoView')) return { found: true, wheelTarget: { x: 520, y: 420 } }
      if (script.includes('document.scrollingElement')) {
        if (script.includes('scrollBy')) {
          scrollCalls += 1
          visibleCount = Math.min(largeFixtureItems.length, visibleCount + 150)
        }
        return {
          windowTop: scrollCalls,
          windowMax: 10000,
          rootTop: scrollCalls,
          rootMax: 10000,
          candidates: [{ top: scrollCalls, max: 10000, rect: { left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720 } }],
          wheelTargets: [{ x: 520, y: 420 }],
          atBottom: false
        }
      }
      return {
        loggedOut: false,
        http429: false,
        items: largeFixtureItems.slice(0, visibleCount),
        tabs: [{ text: `在售 ${expectedCount}`, count: expectedCount, active: true }],
        sellerName: 'large-fixture',
        endHints: false
      }
    }
  }
  const largeResult = await crawlSellerPage(largeSellerWc, `seller-large-${expectedCount}`, {
    maxItemsPerSeller: 0,
    maxScrollSteps: 8,
    pageWaitMs: 300,
    now: () => { largeNowCalls += 1; return 0 }
  })
  assert.equal(largeResult.ok, true, `${expectedCount} seller fixture must remain crawlable`)
  assert.ok(largeResult.items.length > 1000, `${expectedCount} seller must continue past 1,000 cards when the page still advances`)
  assert.equal(largeResult.evidence.expected.active, expectedCount)
  assert.equal(largeResult.evidence.branches.active.stopReason, 'safety_limit', `${expectedCount} seller must retain bounded scroll evidence`)
  assert.equal(largeResult.evidence.platformBoundaryReached, false, `${expectedCount} fixture has no bottom/loading boundary signal`)
  assert.equal(largeResult.evidence.safetyLimitReached, true, `${expectedCount} fixture must expose the bounded scroll limit`)
  assert.equal(largeResult.capped, false, `${expectedCount} fixture must not be count-capped`)
  assert.equal(scrollCalls, 8, `${expectedCount} seller must keep scrolling after crossing 1,000 cards`)
  assert.equal(debuggerAttachedForLarge, false, `${expectedCount} seller scroll must release CDP debugger`)
  assert.equal(debuggerDetachedForLarge, scrollCalls, `${expectedCount} seller must release one debugger attachment per scroll`)
}

// 快速回归模式是显式、内存内的测试选项：即使 fixture 给出 25 条，也只能处理 20 条。
const fixtureItems = Array.from({ length: 25 }, (_, index) => ({
  itemId: String(100000 + index),
  itemUrl: `https://www.goofish.com/item?id=${100000 + index}`,
  title: `fixture-${index}`,
  imageUrl: `https://img.example/${index}.jpg`,
  price: 200 + index,
  status: 'active',
  wants: index,
  category: '数码'
}))
const crawlWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    return {
      loggedOut: false,
      http429: false,
      items: fixtureItems,
      tabs: [{ text: '在售 25', count: 25, active: true }],
      sellerName: 'fixture',
      endHints: true
    }
  }
}
const fastResult = await crawlSellerPage(crawlWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 999,
  pageWaitMs: 1,
  sourceSellerName: '导入卖家甲'
})
assert.equal(fastResult.ok, true)
assert.equal(fastResult.items.length, 20, '快速回归样本硬上限为 20')
assert.equal(fastResult.sellerName, 'fixture', '卖家主页渲染出的全名优先于导入表名称')
assert.equal(isMaskedSellerName('N***s'), true, '来源表脱敏名必须被识别')
assert.equal(resolveAuthoritativeSellerName({ sourceSellerName: 'N***s', pageSellerName: '页面全名' }), '页面全名', '页面已渲染全名时必须覆盖脱敏来源名')
assert.equal(resolveAuthoritativeSellerName({ sourceSellerName: '导入卖家甲', pageSellerName: '页面全名' }), '页面全名', '页面全名必须覆盖旧导入名称')
const maskedNameResult = await crawlSellerPage(crawlWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 999,
  pageWaitMs: 1,
  sourceSellerName: 'N***s'
})
assert.equal(maskedNameResult.sellerName, 'fixture', '采集结果不得继续保存脱敏卖家名')

let debuggerAttached = false
let debuggerDetached = 0
let debuggerWheelEvents = 0
let inputWheelEvents = 0
let anchorScrolled = false
const scrollWc = {
  loadURL: async () => {},
  // Hidden seller workers must never use the focus-dependent input path when
  // CDP is available. Keep both APIs in this fixture to catch regressions
  // where sendInputEvent is accidentally preferred again.
  sendInputEvent: () => { inputWheelEvents += 1 },
  debugger: {
    isAttached: () => debuggerAttached,
    attach: () => { debuggerAttached = true },
    detach: () => { debuggerAttached = false; debuggerDetached++ },
    sendCommand: async (method) => {
      if (method === 'Input.dispatchMouseEvent') debuggerWheelEvents += 1
    }
  },
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('scrollIntoView')) { anchorScrolled = true; return true }
    if (script.includes('document.scrollingElement')) {
      return { windowTop: 0, windowMax: 100, rootTop: 0, rootMax: 100, candidates: [], atBottom: false }
    }
    return {
      loggedOut: false,
      http429: false,
      items: [fixtureItems[0]],
      tabs: [],
      sellerName: 'fixture',
      endHints: false
    }
  }
}
const scrollResult = await crawlSellerPage(scrollWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 20,
  maxScrollSteps: 1,
  pageWaitMs: 1
})
assert.equal(scrollResult.ok, true)
assert.equal(debuggerAttached, false, '滚动后不得遗留 Chromium debugger 连接')
assert.equal(debuggerDetached, 1, '本次采集自己连接的 debugger 必须释放')
assert.equal(anchorScrolled, true, '滚动前必须把当前最后一张商品卡定位到视口末端')
assert.ok(debuggerWheelEvents > 0, '后台隐藏窗口必须通过 CDP 派发滚轮事件')
assert.equal(inputWheelEvents, 0, 'CDP 可用时不得调用需要窗口聚焦的 sendInputEvent')

// 已经有到底证据时，即使主页统计总数尚未满足，也不得继续派发无效滚轮；
// 结果保留为 page_bottom 短缺证据，不能伪装成完成。
let expectedCountScrolls = 0
let stalledExpectedMode = false
const expectedCountWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('document.scrollingElement')) {
      if (script.includes('scrollBy')) expectedCountScrolls += 1
      return { windowTop: 100, windowMax: 100, rootTop: 100, rootMax: 100, candidates: [], atBottom: !stalledExpectedMode }
    }
    return {
      loggedOut: false,
      http429: false,
      items: [fixtureItems[0]],
      tabs: [{ text: '在售 5', count: 5, active: true }],
      sellerName: 'fixture',
      endHints: false
    }
  }
}
const expectedCountResult = await crawlSellerPage(expectedCountWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 20,
  maxScrollSteps: 3,
  pageWaitMs: 1
})
assert.equal(expectedCountResult.ok, true)
assert.equal(expectedCountResult.evidence.branches.active.steps, 0, '已经到底且没有加载提示时不应再派发任何滚轮')
assert.equal(expectedCountResult.evidence.branches.active.stopReason, 'page_bottom')
assert.equal(expectedCountScrolls, 0, '到底证据不得继续派发滚轮')

// 第一次滚动就确认到底时，也必须立即收口；不能为了等 stableRounds 再做
// 第二次 scan 或把同一个底部容器继续当成可滚动目标。
let bottomAfterFirstScroll = false
let bottomAfterFirstScrollScans = 0
let bottomAfterFirstScrollCalls = 0
const bottomAfterFirstScrollWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('document.scrollingElement')) {
      if (script.includes('scrollBy')) {
        bottomAfterFirstScrollCalls += 1
        bottomAfterFirstScroll = true
      }
      return {
        windowTop: bottomAfterFirstScroll ? 100 : 0,
        windowMax: 100,
        rootTop: bottomAfterFirstScroll ? 100 : 0,
        rootMax: 100,
        candidates: [{ top: bottomAfterFirstScroll ? 100 : 0, max: 100, rect: { left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720 } }],
        atBottom: bottomAfterFirstScroll
      }
    }
    if (script.includes('const body = document.body') && !bottomAfterFirstScroll) bottomAfterFirstScrollScans += 1
    return {
      loggedOut: false,
      http429: false,
      items: [fixtureItems[0]],
      tabs: [{ text: '在售 5', count: 5, active: true }],
      sellerName: 'fixture',
      loading: false,
      endHints: false
    }
  }
}
const bottomAfterFirstScrollResult = await crawlSellerPage(bottomAfterFirstScrollWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 20,
  maxScrollSteps: 3,
  pageWaitMs: 1
})
assert.equal(bottomAfterFirstScrollResult.ok, true)
assert.equal(bottomAfterFirstScrollResult.evidence.branches.active.stopReason, 'page_bottom', '第一次滚动确认到底时必须立即收口')
assert.equal(bottomAfterFirstScrollScans, 2, '确认到底后不应再做第三次扫描')
assert.equal(bottomAfterFirstScrollCalls, 1, '确认到底后不得继续派发滚轮')

// A trusted total must not make a stalled virtualized renderer consume the
// entire production scroll budget. A shortfall gets a larger but still finite
// stable-round allowance, then persists an incomplete attempt for retry.
expectedCountScrolls = 0
stalledExpectedMode = true
const stalledExpectedResult = await crawlSellerPage(expectedCountWc, 'seller_123', {
  maxItemsPerSeller: 20,
  maxScrollSteps: 45,
  pageWaitMs: 1
})
assert.equal(stalledExpectedResult.ok, true)
assert.equal(stalledExpectedResult.evidence.branches.active.steps, 40, '卡住的可信总数页面必须在扩大的有限无进展阈值处收敛')
assert.equal(stalledExpectedResult.evidence.branches.active.stopReason, 'stable_without_proof')
assert.equal(expectedCountScrolls, 40, '无进展收敛仍需持久化每一轮滚动证据')
stalledExpectedMode = false

// “加载中”与“已经到底”是两种不同证据：前者只等待当前批次，不派发
// 下一次滚轮；加载结束后若已到底，才收口为 page_bottom。
let loadingScanCount = 0
let loadingScrolls = 0
const loadingBottomWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('document.scrollingElement')) {
      if (script.includes('scrollBy')) loadingScrolls += 1
      return { windowTop: 100, windowMax: 100, rootTop: 100, rootMax: 100, candidates: [], atBottom: true }
    }
    loadingScanCount += 1
    return {
      loggedOut: false,
      http429: false,
      items: [fixtureItems[0]],
      tabs: [{ text: '在售 5', count: 5, active: true }],
      sellerName: 'fixture',
      loading: loadingScanCount <= 2,
      endHints: false
    }
  }
}
const loadingBottomResult = await crawlSellerPage(loadingBottomWc, 'seller_123', {
  executionMode: 'test-fast',
  maxItemsPerSeller: 20,
  maxScrollSteps: 8,
  pageWaitMs: 1
})
assert.equal(loadingBottomResult.ok, true)
assert.equal(loadingBottomResult.evidence.branches.active.stopReason, 'page_bottom', '加载完成后到底应收口为 page_bottom')
assert.equal(loadingBottomResult.evidence.branches.active.loadingObserved, true, '必须留下加载中证据')
assert.equal(loadingScrolls, 0, '加载中和到底阶段都不得继续向下滚动')

// 页面明确报告底部“加载中”且连续 5 秒没有新卡片时，按代码证据判定
// 读取边界；样本只有 120 条，证明这个分支不依赖 1,000 这个数字。
const thresholdItems = Array.from({ length: 120 }, (_, index) => ({
  ...fixtureItems[0],
  itemId: `threshold-${index}`,
  itemUrl: `https://www.goofish.com/item?id=threshold-${index}`
}))
let thresholdNowCalls = 0
const thresholdLoadingWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('document.scrollingElement')) return { windowTop: 0, windowMax: 100, rootTop: 0, rootMax: 100, candidates: [], atBottom: false }
    return {
      loggedOut: false,
      http429: false,
      items: thresholdItems,
      tabs: [{ text: '在售 2万', count: 20000, active: true }],
      sellerName: 'threshold-fixture',
      loading: true,
      loadingKind: 'bottom',
      loadingBottom: true,
      endHints: false
    }
  }
}
const thresholdLoadingResult = await crawlSellerPage(thresholdLoadingWc, 'seller_123', {
  maxItemsPerSeller: 0,
  maxScrollSteps: 5,
  pageWaitMs: 300,
  now: () => { thresholdNowCalls += 1; return [1, 2501, 5001][Math.min(thresholdNowCalls - 1, 2)] }
})
assert.equal(thresholdLoadingResult.ok, true)
assert.equal(thresholdLoadingResult.platformBoundaryReached, true, '底部加载超过5秒必须判定代码读取边界')
assert.equal(thresholdLoadingResult.platformCapReached, true, '旧字段仍兼容映射到读取边界')
assert.equal(thresholdLoadingResult.evidence.branches.active.stopReason, 'platform_boundary')
assert.equal(thresholdLoadingResult.evidence.branches.active.loadingObserved, true)
assert.ok(thresholdNowCalls >= 3, '平台阈值判定必须经过多次加载时钟采样')

// 普通请求加载即使超过 5 秒也不能被当成平台阈值；它走自己的较长超时
// 预算，并在测试步数耗尽时留下普通 safety_limit 证据。
let normalLoadingNowCalls = 0
const normalLoadingWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    return {
      loggedOut: false,
      http429: false,
      items: thresholdItems,
      tabs: [{ text: '在售 2万', count: 20000, active: true }],
      sellerName: 'normal-loading-fixture',
      loading: true,
      loadingKind: 'request',
      loadingBottom: false,
      endHints: false
    }
  }
}
const normalLoadingResult = await crawlSellerPage(normalLoadingWc, 'seller_123', {
  maxItemsPerSeller: 0,
  maxScrollSteps: 3,
  pageWaitMs: 1,
  now: () => { normalLoadingNowCalls += 1; return [1, 2501, 5001][Math.min(normalLoadingNowCalls - 1, 2)] }
})
assert.equal(normalLoadingResult.ok, true)
assert.equal(normalLoadingResult.platformCapReached, false, '普通请求加载不得误判为平台读取阈值')
assert.equal(normalLoadingResult.evidence.branches.active.stopReason, 'safety_limit', '普通请求加载应走独立超时预算')

// 页面同时提供在售/已售分支时，采集器必须切换两个分支并保留各自的
// 可信计数；这避免综合列表把所有商品状态留成 unknown。
let tabClicks = 0
let selectedSection = 'combined'
const activeItem = { ...fixtureItems[0], itemId: 'active-1', status: 'active' }
const soldItem = { ...fixtureItems[1], itemId: 'sold-1', status: 'sold' }
const combinedTabWc = {
  loadURL: async () => {},
  executeJavaScript: async (script) => {
    if (script.includes("['访问异常'")) return { riskControl: false, signal: '', url: '' }
    if (script.includes('.click(')) {
      tabClicks += 1
      selectedSection = script.includes('"sold"') ? 'sold' : 'active'
      return { clicked: true, section: selectedSection }
    }
    if (script.includes('document.scrollingElement')) {
      return { windowTop: 100, windowMax: 100, rootTop: 100, rootMax: 100, candidates: [], atBottom: true }
    }
    return {
      loggedOut: false,
      http429: false,
      items: selectedSection === 'active' ? [activeItem] : selectedSection === 'sold' ? [soldItem] : [activeItem, soldItem],
      tabs: [{ text: '综合 2', count: 2, active: true }, { text: '在售 1', count: 1, active: false }, { text: '已售 1', count: 1, active: false }],
      sellerName: 'fixture',
      endHints: true
    }
  }
}
const combinedResult = await crawlSellerPage(combinedTabWc, 'seller_123', {
  maxItemsPerSeller: 20,
  maxScrollSteps: 3,
  pageWaitMs: 1
})
assert.equal(combinedResult.ok, true)
assert.equal(tabClicks, 2, '有在售/已售分支时必须各切换一次')
assert.equal(combinedResult.activeCount, 1, '综合列表必须保留在售卡片状态')
assert.equal(combinedResult.soldCount, 1, '综合列表必须保留已售卡片状态')
assert.deepEqual(combinedResult.evidence.firstPageExpected, { active: 1, sold: 1 }, '阈值判定必须锁定首次页面在售/已售统计')
assert.equal(combinedResult.evidence.branches.combined.stopReason, 'expected_reached', '综合列表应按可信总数收口')

const tempDataDir = mkdtempSync(join(tmpdir(), 'seller-safety-'))
try {
  process.env.XIANYU_SELLER_DATA_DIR = tempDataDir
  const sellerStore = await import(`../../src/main/seller-store.js?safety=${Date.now()}`)
  const login = sellerStore.setAccountLoginRequired('account-a', {
    reasonCode: 'LOGIN_EXPIRED',
    lastEvidenceAt: '2026-08-23T00:00:00.000Z'
  })
  assert.deepEqual(login, {
    accountId: 'account-a',
    status: 'login_required',
    reasonCode: 'LOGIN_EXPIRED',
    lastEvidenceAt: '2026-08-23T00:00:00.000Z',
    coolingUntil: null
  })
  assert.deepEqual(sellerStore.getAccountSafetyState('account-a'), login)

  const beforeCooling = Date.now()
  const cooling = sellerStore.setAccountCooling('account-b', {
    coolingUntil: new Date(beforeCooling + 12 * 60 * 60 * 1000).toISOString(),
    reasonCode: 'RISK_CONTROL',
    lastEvidenceAt: '2026-08-23T00:01:00.000Z'
  })
  assert.equal(cooling.status, 'cooling')
  assert.ok(Date.parse(cooling.coolingUntil) >= beforeCooling + 6 * 60 * 60 * 1000, '风控冷却不得少于 6 小时')
  const originalCoolingUntil = cooling.coolingUntil
  const repeatedCooling = sellerStore.setAccountCooling('account-b', {
    coolingUntil: new Date(beforeCooling + 60_000).toISOString(),
    reasonCode: 'HTTP_429',
    lastEvidenceAt: '2026-08-23T00:02:00.000Z'
  })
  assert.ok(Date.parse(repeatedCooling.coolingUntil) >= Date.parse(originalCoolingUntil), '重复风控证据不得缩短已有冷却')
  const reloaded = await import(`../../src/main/seller-store.js?safety-reload=${Date.now()}`)
  assert.deepEqual(reloaded.getAccountSafetyState('account-b'), repeatedCooling, '冷却状态必须跨进程持久化')
  assert.equal(Object.values(cooling).some((value) => /cookie|token/i.test(String(value))), false, '安全 DTO 不包含凭据')
  assert.deepEqual(reloaded.listAccountSafetyStates().map((row) => row.accountId).sort(), ['account-a', 'account-b'])
  assert.equal(JSON.stringify(reloaded.listAccountSafetyStates()).includes('partition'), false, '冷却列表不得泄露分区/会话')
  reloaded.clearAccountSafetyState('account-b')
  assert.equal(reloaded.getAccountSafetyState('account-b'), null)

  const clamped = sellerStore.setSettings({ throttleMinMs: 1, throttleMaxMs: 2 })
  assert.equal(clamped.throttleMinMs, 15000)
  assert.ok(clamped.throttleMaxMs >= 15000)
  assert.equal(clamped.maxScrollSteps, 500, '生产主页滚动上限应允许大卖家继续取证，但仍受 500 步硬上限约束')

  const imported = sellerStore.importLinks([
    'https://www.goofish.com/personal?userId=valid_seller&utm_source=removed',
    'https://www.goofish.com/item?id=123456&token=must-not-persist',
    'https://www.taobao.com/seller/user?session=must-not-persist',
    'https://www.goofish.com:8443/personal?userId=wrong-port',
    'https://www.goofish.com/personal?userId=%20'
  ].join('\n'), 'seller-boundary.txt')
  assert.equal(imported.needsReview, 4)
  const importedRows = sellerStore.getAllSourceRows()
  assert.equal(importedRows.find((row) => row.sellerId === 'valid_seller')?.url, 'https://www.goofish.com/personal?userId=valid_seller')
  assert.equal(importedRows.filter((row) => row.status === 'needs_review' && row.reasonCode === 'INVALID_SELLER_URL').length, 4)
  assert.doesNotMatch(JSON.stringify(importedRows), /must-not-persist/)
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  rmSync(tempDataDir, { recursive: true, force: true })
}

const schedulerSource = readFileSync(new URL('../../src/main/seller-scheduler.js', import.meta.url), 'utf8')
assert.match(schedulerSource, /getSellerWebContents/)
assert.doesNotMatch(schedulerSource, /getWebContents\s*\(/, '卖家调度不得回退到关键词 worker')
assert.match(schedulerSource, /Math\.max\(15000/)
assert.match(schedulerSource, /setAccountLoginRequired/)
assert.match(schedulerSource, /setAccountCooling/)
const delayFunctionSource = schedulerSource
  .slice(schedulerSource.indexOf('export function computeSellerDelay'), schedulerSource.indexOf('\n\nfunction makeCounters'))
  .replace('export function', 'function')
const computeSellerDelay = new Function(`${delayFunctionSource}; return computeSellerDelay`)()
assert.equal(computeSellerDelay({ throttleMinMs: 1, throttleMaxMs: 2 }, 0, () => 0), 15000)
assert.equal(computeSellerDelay({ throttleMinMs: 15000, throttleMaxMs: 30000 }, 0, () => 1), 30000)
assert.equal(computeSellerDelay({ throttleMinMs: 15000, throttleMaxMs: 30000 }, 1, () => 0), 30000)
assert.equal(computeSellerDelay({ throttleMinMs: 15000, throttleMaxMs: 30000 }, 99, () => 1), 120000, '连续失败退避必须有上限')
assert.equal(computeSellerDelay({ throttleMinMs: 15000, throttleMaxMs: 30000 }, 0, () => 0, 'test-fast'), 500)
assert.equal(computeSellerDelay({ throttleMinMs: 15000, throttleMaxMs: 30000 }, 3, () => 1, 'test-fast'), 2000)
assert.match(schedulerSource, /immediateRetryReason[\s\S]*result\.loggedOut[\s\S]*result\.riskControl[\s\S]*result\.publicHomeFallback[\s\S]*return null/, '登录/风控/公共首页不得消费即时重试')

const sellerGoofishSource = readFileSync(new URL('../../src/main/seller-goofish.js', import.meta.url), 'utf8')
assert.match(sellerGoofishSource, /getBoundingClientRect\(\)/, '卖家滚动必须读取真实容器位置')
assert.match(sellerGoofishSource, /wheelTargets/, '卖家滚轮必须定位到可见滚动容器，而不是固定坐标')
assert.match(sellerGoofishSource, /node = node\.parentElement/, '卖家滚轮必须优先定位商品卡所属的最近滚动祖先')
assert.doesNotMatch(sellerGoofishSource, /SELECT_COMBINED_TAB_FN|selectCombinedTab/, '默认进入综合列表，不应执行综合标签选择')
assert.match(sellerGoofishSource, /SELECT_SELLER_SECTION_FN/, '有独立在售/已售分支时必须选择对应分支')
assert.match(sellerGoofishSource, /target\.click\(\)/, '分支选择必须点击页面真实标签，而不是打开商品详情')
assert.match(sellerGoofishSource, /countOf[\s\S]*万/, '主页标签总数必须支持 1万/2万 形式')
assert.match(sellerGoofishSource, /PLATFORM_LOADING_TIMEOUT_MS/, '持续加载超时必须进入平台阈值判定')
assert.match(sellerGoofishSource, /platformBoundaryReached/, '读取边界必须由页面证据字段决定')
assert.doesNotMatch(sellerGoofishSource, /SELLER_PLATFORM_ITEM_CAP|PLATFORM_CAP_NEAR_THRESHOLD/, '主页采集不得把 1,000 写死为默认完成线')
assert.match(sellerGoofishSource, /if \(scroll\?\.atBottom\)/, '滚动确认到底后必须立即停止')
assert.match(sellerGoofishSource, /const primary = rows\[0\]/, '到底判定必须优先使用主滚动容器')
assert.doesNotMatch(sellerGoofishSource, /rows\.every\(\(row\) => row\.max === 0\)/, '空候选列表不能伪造到底证据')
assert.match(sellerGoofishSource, /data-original/, '图片采集必须优先读取懒加载真实资源地址')
assert.match(sellerGoofishSource, /naturalWidth/, '卖家采集必须检查图片实际尺寸，不能只信任 src')
assert.match(sellerGoofishSource, /-2-tps-2-2/, '卖家采集必须拒绝闲鱼 2x2 占位图')
assert.match(sellerGoofishSource, /直接下单/, '闲鱼当前在售卡片的直接下单文案必须归类为在售')
assert.match(sellerGoofishSource, /小时\|一周.*内发布/, '闲鱼当前预发布卡片文案必须归类为在售')
assert.match(sellerGoofishSource, /SETTLE_VISIBLE_IMAGES_FN/, '卖家采集必须对可见占位图执行有界等待')
assert.match(sellerGoofishSource, /loadingMetrics/, '到底判定前必须等待异步懒加载信号收口')
assert.doesNotMatch(sellerGoofishSource, /const loadingText = \/加载中\|正在加载\|努力加载\/.test\(body\)/, '页面底部虚拟化文案不在当前视口时不得伪造加载中')
assert.match(sellerGoofishSource, /loadingNodes\.some\(\(el\) => \/加载中\|正在加载\|努力加载\//, '加载文案必须绑定到当前可见的加载节点')

const sessionManagerSource = readFileSync(new URL('../../src/main/session-manager.js', import.meta.url), 'utf8')
assert.match(sessionManagerSource, /const workerViews = new Map\(\)/)
assert.match(sessionManagerSource, /const previewViews = new Map\(\)/)
assert.match(sessionManagerSource, /account requires a persistent partition/)
assert.match(sessionManagerSource, /baseWindow = null/, '全量销毁后必须释放主窗口引用')

let releaseBrowserWindow
const delayedController = createSellerWorkerController({
  resolveBrowserWindow: () => new Promise((resolve) => { releaseBrowserWindow = () => resolve(FakeBrowserWindow) })
})
const pendingWindow = delayedController.getSellerWebContents({ id: 'delayed', partition: 'persist:delayed' })
await new Promise((resolve) => setImmediate(resolve))
const teardown = delayedController.destroySellerWorkers()
releaseBrowserWindow()
await teardown
await assert.rejects(pendingWindow, /cancelled by controller teardown/)
assert.equal(FakeBrowserWindow.created.some((win) => win.options.webPreferences.partition === 'persist:delayed'), false, 'teardown cancels an in-flight worker before construction')

await controller.destroySellerWorkers()
console.log('seller worker isolation regression: passed (hidden headful, bounded navigation, durable circuit)')
