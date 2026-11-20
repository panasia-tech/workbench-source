// 卖家主页长期调度器。与关键词行情 scheduler 完全分离，二者可以分别启动/停止。
import { crawlSellerPage, resolveAuthoritativeSellerName } from './seller-goofish.js'
import * as sellerStore from './seller-store.js'
import { getAccounts } from './store.js'
import { getSellerWebContents, recycleSellerWorker } from './seller-worker.js'
import { evaluateSellerEvidence, validateAccountIdentities } from './seller-state-machine.js'
import { evaluateSchedule, SELLER_TIMEZONE } from './seller-schedule.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TRANSIENT_CRAWL_REASONS = new Set(['NAV_TIMEOUT', 'NAV_TRANSIENT', 'RENDER_CRASH'])
const RETRYABLE_INCOMPLETE_REASONS = new Set(['SAFETY_LIMIT_REACHED', 'TRUSTED_COUNT_SHORT', 'INTERRUPTED_PARTIAL'])
const MAX_RETRYABLE_FORMAL_RETRIES = 1
let running = false
// Preflight includes three AdsPower auth probes and can take several
// seconds. Keep a separate lock so startup recovery, CLI auto-start and a
// renderer click cannot all call prepareRun before the first run has claimed
// its workers. Without this, each process overwrote the durable job record
// and the same 9977 sellers were repeatedly recovered by competing runs.
let starting = false
let stopRequested = false
let draining = false
let activeStartPromise = null
let emit = () => {}
let weeklyTimer = null
let lastAccountStats = {}
// Main injects the real partition-cookie check after Electron is ready. Tests
// keep the default permissive checker so the scheduler remains pure and
// deterministic outside the desktop runtime.
let accountEligibilityChecker = async () => true

const SNAPSHOT_SECRET_PARAM = /token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i
const SNAPSHOT_IMAGE_MIME = /^image\/(?:jpeg|png|gif|webp|avif|bmp)$/i
const SNAPSHOT_INLINE_IMAGE_MAX_BYTES = 1024 * 1024
const SNAPSHOT_INLINE_IMAGE_BUDGET = 24 * 1024 * 1024
const SNAPSHOT_INLINE_IMAGE_CANDIDATES = 200
const SNAPSHOT_PLACEHOLDER_IMAGE = /(?:-2-tps-2-2|placeholder|transparent|spacer|blank(?:\.gif)?)/i

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function snapshotBaseUrl(value, fallback = '') {
  try {
    const parsed = new URL(String(value || fallback || ''))
    if (parsed.protocol !== 'https:') throw new Error('snapshot base must be https')
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) if (SNAPSHOT_SECRET_PARAM.test(key)) parsed.searchParams.delete(key)
    return parsed.href
  } catch {
    return 'https://www.goofish.com/'
  }
}

function snapshotUrl(value, baseUrl, { item = false } = {}) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // Do not turn Goofish's transient 2x2 placeholder into a permanent
  // snapshot image. The crawler waits for the real card image and leaves an
  // explicit “无主图” marker if the platform never supplies one.
  if (/(?:-2-tps-2-2|placeholder|transparent|spacer|blank(?:\.gif)?)/i.test(raw)) return ''
  if (/^data:image\/(?:jpeg|png|gif|webp|avif|bmp);base64,[a-z0-9+/]+=*$/i.test(raw)) return raw
  if (/^(?:javascript|data|blob|file):/i.test(raw)) return ''
  try {
    const parsed = new URL(raw, baseUrl)
    if (parsed.protocol !== 'https:') return ''
    if (item && parsed.hostname !== 'goofish.com' && !parsed.hostname.endsWith('.goofish.com')) return ''
    for (const key of [...parsed.searchParams.keys()]) if (SNAPSHOT_SECRET_PARAM.test(key)) parsed.searchParams.delete(key)
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return ''
  }
}

async function fetchSnapshotImage(value, baseUrl) {
  let url = ''
  try {
    const parsed = new URL(String(value || '').trim(), baseUrl)
    if (parsed.protocol !== 'https:') return ''
    parsed.username = ''
    parsed.password = ''
    // The request may need a short-lived signed query to download the image;
    // it is used only in memory and never written to the snapshot HTML/JSON.
    url = parsed.href
  } catch {
    return ''
  }
  if (!url || typeof fetch !== 'function') return ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1800)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) return ''
    const finalUrl = new URL(response.url || url)
    if (finalUrl.protocol !== 'https:') return ''
    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim()
    const declaredBytes = Number(response.headers.get('content-length'))
    if (!SNAPSHOT_IMAGE_MIME.test(mime) || (Number.isFinite(declaredBytes) && declaredBytes > SNAPSHOT_INLINE_IMAGE_MAX_BYTES)) return ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > SNAPSHOT_INLINE_IMAGE_MAX_BYTES) return ''
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

async function inlineSnapshotImages(result = {}, baseUrl = '') {
  const sourceItems = Array.isArray(result?.items) ? result.items : []
  const items = sourceItems.map((item) => ({ ...item }))
  const candidates = items
    .map((item, index) => ({ item, index, imageUrl: String(item?.imageUrl || '').trim() }))
    .filter((entry) => entry.imageUrl && !SNAPSHOT_PLACEHOLDER_IMAGE.test(entry.imageUrl) && !/^data:/i.test(entry.imageUrl))
    .slice(0, SNAPSHOT_INLINE_IMAGE_CANDIDATES)
  let cursor = 0
  let inlineBytes = 0
  let inlineCount = 0
  const worker = async () => {
    while (cursor < candidates.length) {
      const entry = candidates[cursor++]
      const dataUrl = await fetchSnapshotImage(entry.imageUrl, baseUrl)
      if (!dataUrl) continue
      const bytes = Buffer.byteLength(dataUrl, 'utf8')
      if (inlineBytes + bytes > SNAPSHOT_INLINE_IMAGE_BUDGET) continue
      items[entry.index].imageUrl = dataUrl
      inlineBytes += bytes
      inlineCount++
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, Math.max(1, candidates.length)) }, () => worker()))
  return { ...result, items, snapshotImageStats: { inlineCount, remoteCount: Math.max(0, sourceItems.length - inlineCount), inlineBytes } }
}

function snapshotCompleteness(result = {}) {
  const branch = result?.evidence?.branches?.combined || {}
  const rawExpected = branch.expectedCount ?? result?.evidence?.expected?.combined
  const expected = rawExpected == null || rawExpected === '' ? null : Number(rawExpected)
  const observed = Array.isArray(result?.items) ? result.items.length : 0
  const expectedReached = branch.stopReason === 'expected_reached' || (Number.isFinite(expected) && expected >= 0 && observed >= expected)
  const complete = Boolean(result?.ok && !result?.capped && !branch.platformBoundaryReached && !branch.safetyLimitReached && expectedReached)
  return { complete, stopReason: String(branch.stopReason || (result?.ok ? 'unknown' : 'crawl_failed')), expectedCount: Number.isFinite(expected) ? expected : null, observedCount: observed }
}

/**
 * Build the primary seller evidence view from the durable crawl result.
 * The page DOM is virtualized, so it cannot be the source of truth for a
 * snapshot: every result item is rendered as a bounded, scrollable card.
 */
export function buildSellerEvidenceHtml(result = {}, { source = {}, pageUrl = '' } = {}) {
  const baseUrl = snapshotBaseUrl(pageUrl, source.url)
  const items = Array.isArray(result?.items) ? result.items : []
  const completeness = snapshotCompleteness(result)
  const sellerName = resolveAuthoritativeSellerName({ sourceSellerName: source.sellerName, pageSellerName: result?.sellerName })
  const sellerId = String(businessSellerId(source) || source.sellerId || '').slice(0, 128)
  const sourceUrl = snapshotUrl(source.url || baseUrl, baseUrl)
  const statusLabel = { active: '在售', sold: '已售', unknown: '未知' }
  const cards = items.map((item, index) => {
    const itemId = String(item?.itemId || '').slice(0, 200)
    const href = snapshotUrl(item?.itemUrl || (itemId ? `/item?id=${encodeURIComponent(itemId)}` : ''), baseUrl, { item: true })
    const image = snapshotUrl(item?.imageUrl, baseUrl)
    const title = String(item?.title || '').slice(0, 240)
    const category = String(item?.category || '').slice(0, 80)
    const status = statusLabel[item?.status] || statusLabel.unknown
    const price = Number.isFinite(Number(item?.price)) && Number(item.price) > 0 ? `￥${Number(item.price).toLocaleString('zh-CN')}` : '价格未知'
    const link = href
      ? `<a class="seller-item-link" data-item-link href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">打开商品</a>`
      : '<span class="seller-item-link seller-item-link--disabled">商品链接不可用</span>'
    const imageMarkup = image
      ? `<img class="seller-item-image" src="${escapeHtml(image)}" alt="${escapeHtml(title || itemId)}">`
      : '<div class="seller-item-image seller-item-image--empty" aria-label="无主图">无主图</div>'
    return `<article class="seller-item-card" data-item-index="${index}" data-item-id="${escapeHtml(itemId)}">
  ${imageMarkup}
  <div class="seller-item-body">
    <div class="seller-item-title">${escapeHtml(title || '未提供标题')}</div>
    <div class="seller-item-meta"><span>商品ID：${escapeHtml(itemId || '未知')}</span><span>分类：${escapeHtml(category || '未分类')}</span></div>
    <div class="seller-item-meta"><span>价格：${escapeHtml(price)}</span><span>状态：${escapeHtml(status)}</span></div>
    ${link}
  </div>
</article>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>卖家主页商品证据</title>
<style>
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#1f2937;background:#f5f8f7}
body{margin:0;padding:24px;background:#f5f8f7}.seller-evidence{max-width:1440px;margin:0 auto}.seller-evidence-header{padding:20px 24px;background:#fff;border:1px solid #dfe9e4;border-radius:14px;margin-bottom:16px}.seller-evidence-header h1{margin:0 0 10px;font-size:24px}.seller-evidence-header p{margin:4px 0;color:#65756e}.seller-item-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}.seller-item-card{display:flex;gap:14px;min-height:142px;padding:14px;background:#fff;border:1px solid #e4ece8;border-radius:12px;overflow:hidden}.seller-item-image{width:112px;height:112px;flex:0 0 112px;object-fit:cover;border-radius:8px;background:#edf3f0;color:#84958e;display:flex;align-items:center;justify-content:center;font-size:13px}.seller-item-body{min-width:0;display:flex;flex:1;flex-direction:column;gap:7px}.seller-item-title{font-weight:600;line-height:1.45;overflow-wrap:anywhere}.seller-item-meta{display:flex;flex-wrap:wrap;gap:10px;color:#667770;font-size:13px}.seller-item-link{margin-top:auto;color:#16845d;text-decoration:none;font-size:13px}.seller-item-link--disabled{color:#9aa7a1}.seller-evidence-note{font-size:13px;color:#73827c;margin-top:16px}
</style></head><body><main class="seller-evidence">
<header class="seller-evidence-header"><h1>卖家主页商品证据</h1><p>卖家：${escapeHtml(sellerName || '未知')}　卖家ID：${escapeHtml(sellerId || '未知')}</p><p>抓取页：${escapeHtml(sourceUrl || baseUrl)}</p><p>结果商品：${items.length} 条（${completeness.complete ? '完整结果，已达到页面可信总数' : `部分证据，停止原因：${escapeHtml(completeness.stopReason)}；不得视为完成`}）</p>${completeness.expectedCount != null ? `<p>页面可信总数：${completeness.expectedCount} · 已保存：${completeness.observedCount}</p>` : ''}</header>
<section class="seller-item-list" data-seller-item-count="${items.length}">${cards}</section>
<p class="seller-evidence-note">此文件由抓取结果生成；商品链接已归一化为 HTTPS，主图优先内嵌为校验过的图片数据，无法内嵌时保留已清洗的 HTTPS 地址，并移除敏感参数。</p>
</main></body></html>`
}

async function captureSellerSnapshot(webContents, source, runId, result) {
  if (!result) return null
  let timer = null
  let captured = null
  try {
    if (webContents && typeof webContents.executeJavaScript === 'function') {
      const execution = webContents.executeJavaScript(`(() => ({
        url: location.href,
        width: Math.round(window.innerWidth || 0),
        height: Math.round(window.innerHeight || 0)
      }))()`, true)
      execution.catch(() => {})
      captured = await Promise.race([
        execution,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10000) })
      ])
    }
    const baseUrl = captured?.url || source.url
    const snapshotResult = await inlineSnapshotImages(result, baseUrl)
    const completeness = snapshotCompleteness(snapshotResult)
    const resultHtml = () => buildSellerEvidenceHtml(snapshotResult, { source, pageUrl: baseUrl })
    // The generated result cards are always the primary content. Keeping the
    // virtual DOM out of the file prevents a huge/partial renderer snapshot
    // from hiding the complete item evidence or exhausting the 32MB budget.
    const html = resultHtml()
    const metadata = {
      runId,
      sourceId: source.id,
      sellerId: businessSellerId(source),
      sellerName: resolveAuthoritativeSellerName({ sourceSellerName: source.sellerName, pageSellerName: result?.sellerName }),
      sourceUrl: source.url,
      attemptKey: source.currentAttempt?.attemptKey || '',
      cycleKey: source.currentAttempt?.cycleKey || source.cycleKey || '',
      accountId: source.currentAttempt?.accountId || '',
      status: result?.ok ? 'captured' : (result?.reasonCode || 'crawl_failed'),
      evidenceKind: 'items-html',
      reasonCode: result?.reasonCode || '',
      itemCount: Array.isArray(result?.items) ? result.items.length : 0,
      activeCount: result?.activeCount,
      soldCount: result?.soldCount,
      pageUrl: captured?.url || source.url,
      viewport: { width: captured?.width, height: captured?.height },
      loadingKind: result?.evidence?.branches?.combined?.loadingKind,
      complete: completeness.complete,
      stopReason: completeness.stopReason,
      expectedCount: completeness.expectedCount,
      observedCount: completeness.observedCount,
      inlineImageCount: snapshotResult.snapshotImageStats?.inlineCount || 0,
      remoteImageCount: snapshotResult.snapshotImageStats?.remoteCount || 0
    }
    try {
      return sellerStore.saveSellerSnapshot(html, metadata)
    } catch (error) {
      // A pathological result can still exceed the HTML safety budget. The
      // generated card view is already bounded per field; retry once so a
      // formal attempt remains reviewable without persisting raw page data.
      return sellerStore.saveSellerSnapshot(resultHtml(), { ...metadata, evidenceKind: 'items-html' })
    }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function setEmitter(fn) {
  if (typeof fn !== 'function') {
    emit = () => {}
    return
  }
  // Renderer delivery is observational. A closed window or faulty listener
  // must not abort durable seller work or leave the scheduler marked running.
  emit = (...args) => {
    try { fn(...args) } catch { /* event delivery is best effort */ }
  }
}

export function setAccountEligibilityChecker(fn) {
  accountEligibilityChecker = typeof fn === 'function' ? fn : async () => true
}

export function isRunning() {
  return running || starting
}

export function computeSellerDelay(settings, consecutiveFailures = 0, random = Math.random, mode = 'production') {
  if (mode === 'test-fast') {
    return Math.round(500 + Math.max(0, Math.min(1, Number(random()) || 0)) * 1500)
  }
  let min = Math.max(15000, Number(settings?.throttleMinMs) || 15000)
  let max = Math.max(15000, Number(settings?.throttleMaxMs) || 30000)
  if (max < min) [min, max] = [max, min]
  const jitter = min + Math.max(0, Math.min(1, Number(random()) || 0)) * (max - min)
  const multiplier = Math.min(4, 2 ** Math.max(0, Math.min(3, Number(consecutiveFailures) || 0)))
  return Math.max(15000, Math.min(120000, Math.round(jitter * multiplier)))
}

function makeCounters(total, accounts = []) {
  const accountStats = Object.fromEntries((Array.isArray(accounts) ? accounts : []).map((account) => [String(account.id), {
    accountId: String(account.id),
    accountName: String(account.name || account.id),
    claimed: 0,
    finished: 0,
    completed: 0,
    failed: 0,
    byStatus: {}
  }]))
  return {
    total,
    formalAttempts: 0,
    formalAttemptHistory: [],
    sellersDone: 0,
    sellersFail: 0,
    items: 0,
    active: 0,
    sold: 0,
    capped: 0,
    blocked: 0,
    byStatus: {},
    accountStats
  }
}

function accountStatsFor(counters, account) {
  const id = String(account?.id || '')
  if (!id) return null
  if (!counters.accountStats[id]) {
    counters.accountStats[id] = {
      accountId: id,
      accountName: String(account?.name || id),
      claimed: 0,
      finished: 0,
      completed: 0,
      failed: 0,
      byStatus: {}
    }
  }
  return counters.accountStats[id]
}

function makeCounterState() {
  return { finalBySellerId: new Map(), attemptHistory: [] }
}

function recordFormalAttempt(counters, counterState, source, account, stateResult, result) {
  const sellerId = businessSellerId(source) || String(source.sellerId || source.id || '')
  const previous = counterState.finalBySellerId.get(sellerId)
  if (previous) {
    counters.byStatus[previous.status] = Math.max(0, (counters.byStatus[previous.status] || 0) - 1)
    if (['completed', 'no_active'].includes(previous.status)) counters.sellersDone = Math.max(0, counters.sellersDone - 1)
    else counters.sellersFail = Math.max(0, counters.sellersFail - 1)
  }
  const next = {
    accountId: String(account.id),
    sellerId,
    status: stateResult.status,
    reasonCode: stateResult.reasonCode || null,
    itemCount: Array.isArray(result.items) ? result.items.length : 0,
    finalizedAt: new Date().toISOString()
  }
  counterState.finalBySellerId.set(sellerId, next)
  counterState.attemptHistory.push(next)
  counters.formalAttemptHistory.push(next)
  counters.formalAttempts += 1
  counters.byStatus[next.status] = (counters.byStatus[next.status] || 0) + 1
  if (['completed', 'no_active'].includes(next.status)) counters.sellersDone += 1
  else counters.sellersFail += 1
}

function businessSellerId(source = {}) {
  const direct = String(source.sellerId || '').trim()
  if (/^[A-Za-z0-9_-]{1,128}$/.test(direct)) return direct
  try {
    const value = String(new URL(String(source.url || '')).searchParams.get('userId') || '').trim()
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ''
  } catch {
    return ''
  }
}

function mergeEvidence(previous = {}, incoming = {}) {
  const itemIds = sellerStore.mergeSellerItemIds(previous.itemIds || {}, incoming.itemIds || {})
  return {
    ...previous,
    ...incoming,
    expected: { ...(previous.expected || {}), ...(incoming.expected || {}) },
    expectedTrusted: { ...(previous.expectedTrusted || {}), ...(incoming.expectedTrusted || {}) },
    branches: { ...(previous.branches || {}), ...(incoming.branches || {}) },
    itemIds
  }
}

function evidenceFromFailure(result, previous = {}) {
  const riskEvidence = result?.riskEvidence && typeof result.riskEvidence === 'object'
    ? {
        signal: String(result.riskEvidence.signal || '').slice(0, 80),
        source: String(result.riskEvidence.source || '').slice(0, 80),
        url: String(result.riskEvidence.url || '').slice(0, 1000),
        confirmationCount: Math.max(0, Math.min(10, Number(result.riskEvidence.confirmationCount) || 0))
      }
    : null
  return mergeEvidence(previous, {
    loggedOut: Boolean(result.loggedOut),
    riskControl: Boolean(result.riskControl),
    persistenceFailed: Boolean(result.persistenceFailed),
    domAnomaly: Boolean(result.needsReview),
    failureReasonCode: String(result.reasonCode || ''),
    failed: !result.loggedOut && !result.riskControl && !result.persistenceFailed && !result.needsReview,
    error: result.reason || '采集失败',
    ...(riskEvidence ? { riskEvidence } : {})
  })
}

export function immediateRetryReason(result = {}) {
  if (result.loggedOut || result.riskControl || result.publicHomeFallback || result.http429 || result.needsReview) return null
  const reasonCode = String(result.reasonCode || '')
  if (reasonCode === 'NAV_TIMEOUT' || reasonCode === 'NAV_TRANSIENT') return 'NAV_TRANSIENT'
  if (reasonCode === 'RENDER_CRASH') return 'RENDER_CRASH'
  return null
}

export function buildSellerCrawlOptions(settings, source, executionMode, onEvidence) {
  return {
    ...settings,
    executionMode,
    // Carry the imported value as a fallback. The crawler now extracts the
    // target profile header (not the logged-in account nickname) and replaces
    // a masked source value with that public full name after a successful page
    // scan.
    sourceSellerName: String(source.sellerName || '').trim(),
    // A prior sold observation must not hide a newer active observation;
    // active evidence is the authoritative branch on ID collisions.
    excludeItemIds: [...(source.itemIds?.active || []), ...(source.skipItemIds || [])],
    onEvidence
  }
}

async function runWorker(account, runId, cycleKey, settings, counters, counterState, claimState, accountCount, executionMode, allowedSellerIds, incompleteSellerIds, retryableSellerIds, reviewSellerIds) {
  let sellerDoneByAccount = 0
  let consecutiveFailures = 0
  while (!stopRequested) {
    const safety = sellerStore.getAccountSafetyState(account.id)
    if (safety?.status === 'login_required') break
    if (safety?.status === 'cooling' && Date.parse(safety.coolingUntil || '') > Date.now()) break
    if (safety?.status === 'cooling') sellerStore.clearAccountSafetyState(account.id)
    if (claimState.limit > 0 && claimState.claimed >= claimState.limit) break
    const source = sellerStore.claimNext(runId, account.id, accountCount, cycleKey, {
      allowedSellerIds,
      pendingOnly: executionMode === 'test-fast',
      incompleteSellerIds,
      retryableSellerIds: [...retryableSellerIds],
      reviewSellerIds,
      maxTransientRetries: MAX_RETRYABLE_FORMAL_RETRIES
    })
    if (!source) break
    claimState.claimed++
    claimState.claimsThisRound++
    const accountStats = accountStatsFor(counters, account)
    if (accountStats) accountStats.claimed++
    sellerDoneByAccount++
    if (settings.recycleEvery > 0 && sellerDoneByAccount > 1 && sellerDoneByAccount % settings.recycleEvery === 0) {
      recycleSellerWorker(account.id)
    }
    emit('seller-progress', { accountId: account.id, accountName: account.name, sellerUrl: source.url, sellerId: businessSellerId(source) })
    let result
    let sellerWebContents = null
    let liveEvidence = source.evidence || {
      expected: { active: null, sold: null },
      expectedTrusted: { active: false, sold: false },
      itemIds: source.itemIds || { active: [], sold: [] }
    }
    const persistBranchEvidence = async (branchEvidence) => {
      const branch = branchEvidence.branch
      if (!['active', 'sold', 'combined'].includes(branch)) throw new TypeError(`unknown seller evidence branch: ${branch || 'empty'}`)
      const combined = branch === 'combined'
      const branchExpected = combined
        ? { active: branchEvidence.expectedActiveCount, sold: branchEvidence.expectedSoldCount }
        : { [branch]: branchEvidence.expectedCount }
      const branchTrusted = combined
        ? { active: branchEvidence.expectedActiveCount != null, sold: branchEvidence.expectedSoldCount != null }
        : { [branch]: branchEvidence.expectedTrusted }
      const branchItems = combined
        ? { active: branchEvidence.itemIdsActive || [], sold: branchEvidence.itemIdsSold || [] }
        : { [branch]: branchEvidence.itemIds }
      liveEvidence = mergeEvidence(liveEvidence, {
        expected: branchExpected,
        expectedTrusted: branchTrusted,
        itemIds: branchItems,
        unknownItemIds: branchEvidence.unknownItemIds || [],
        branches: {
          [branch]: {
            collectedAt: branchEvidence.collectedAt,
            loadingKind: branchEvidence.loadingKind || 'none',
            loadingBottom: Boolean(branchEvidence.loadingBottom)
          }
        }
      })
      sellerStore.markSource(source.id, {
        status: 'running',
        reasonCode: 'BRANCH_CHECKPOINT',
        evidence: liveEvidence,
        itemIds: liveEvidence.itemIds,
        expected: liveEvidence.expected
      })
      renewLease()
    }
    const attemptCycleKey = source.currentAttempt?.cycleKey || cycleKey
    const lease = source.currentAttempt?.lease || null
    const renewLease = () => {
      if (!lease || typeof sellerStore.renewLease !== 'function') return null
      return sellerStore.renewLease(source.id, {
        accountId: account.id,
        runId,
        cycleKey: attemptCycleKey,
        token: lease.token
      })
    }
    try {
      sellerWebContents = await getSellerWebContents(account)
      result = await crawlSellerPage(sellerWebContents, source.url, buildSellerCrawlOptions(settings, source, executionMode, persistBranchEvidence))
    } catch (e) {
      const message = String(e?.message || e)
      const reasonCode = /destroyed|crashed|render process gone/i.test(message) ? 'RENDER_CRASH' : 'CRAWL_EXCEPTION'
      result = { ok: false, reasonCode, reason: '采集异常: ' + message }
    }
    const transientReason = immediateRetryReason(result)
    // Shutdown must not recycle a worker and immediately open a replacement
    // page for an already-failed attempt.  before-quit waits for this run to
    // settle, so honoring the stop flag here closes the last live target only.
    if (!stopRequested && !result.ok && transientReason) {
      let retryConsumed = false
      try {
        sellerStore.consumeImmediateRetry(source.id, account.id, transientReason)
        retryConsumed = true
        recycleSellerWorker(account.id)
        sellerWebContents = await getSellerWebContents(account)
        result = await crawlSellerPage(
          sellerWebContents,
          source.url,
          buildSellerCrawlOptions(settings, source, executionMode, persistBranchEvidence)
        )
      } catch (e) {
        if (!retryConsumed && /already consumed/i.test(String(e?.message || e))) {
          // 已在这个正式尝试内用过即时重试：保留原失败，不再导航。
        } else {
        result = { ok: false, reason: `采集异常(即时重试未完成): ${e?.message || e}` }
        }
      }
    }

    // Seller evidence is a formal-attempt artifact, not a side effect of the
    // item log. Capture the final DOM after crawl/retry so the queue can open
    // the exact page that produced its counts and result.
    const sellerSnapshot = await captureSellerSnapshot(sellerWebContents, source, runId, result)
    if (sellerSnapshot) {
      result = {
        ...result,
        snapshot: sellerSnapshot,
        raw: { ...(result.raw || {}), snapshotId: sellerSnapshot.snapshotId, snapshotHash: sellerSnapshot.snapshotHash }
      }
    } else {
      // Keep snapshot persistence failures visible on the formal attempt. A
      // missing evidence artifact must never look like a successful crawl
      // that merely has no snapshot metadata.
      result = {
        ...result,
        persistenceFailed: Boolean(result.ok),
        reasonCode: result.ok ? 'PERSISTENCE_FAILED' : result.reasonCode,
        reason: result.ok ? '采集结果已完成，但页面快照持久化失败' : result.reason,
        raw: { ...(result.raw || {}), snapshotError: 'SELLER_SNAPSHOT_WRITE_FAILED' }
      }
    }

    let circuit = null
    const evidenceAt = new Date().toISOString()
    if (result.loggedOut) {
      circuit = sellerStore.setAccountLoginRequired(account.id, {
        reasonCode: result.reasonCode || 'LOGIN_EXPIRED',
        lastEvidenceAt: evidenceAt
      })
    } else if (result.riskControl || result.http429 || result.publicHomeFallback) {
      const reasonCode = result.publicHomeFallback
        ? 'PUBLIC_HOME_FALLBACK'
        : (result.http429 ? 'HTTP_429' : (result.reasonCode || 'RISK_CONTROL'))
      circuit = sellerStore.setAccountCooling(account.id, { reasonCode, lastEvidenceAt: evidenceAt })
    }
    if (circuit) {
      sellerStore.addEvent({
        type: result.loggedOut ? 'seller-account-safety' : 'seller-risk-control',
        accountId: account.id,
        accountName: account.name || account.id,
        sellerId: businessSellerId(source),
        reasonCode: circuit.reasonCode,
        riskSignal: String(result.riskEvidence?.signal || '').slice(0, 80),
        riskSource: String(result.riskEvidence?.source || '').slice(0, 80),
        riskUrl: String(result.riskEvidence?.url || '').slice(0, 1000),
        confirmationCount: Math.max(0, Math.min(10, Number(result.riskEvidence?.confirmationCount) || 0)),
        coolingUntil: circuit.coolingUntil || null,
        at: evidenceAt
      })
      if (!result.loggedOut && circuit.status === 'cooling' && typeof sellerStore.scheduleRiskRecovery === 'function') {
        const recovery = sellerStore.scheduleRiskRecovery({
          accountId: account.id,
          coolingUntil: circuit.coolingUntil,
          reasonCode: circuit.reasonCode,
          sellerId: businessSellerId(source),
          runId,
          cycleKey: attemptCycleKey
        })
        sellerStore.addEvent({
          type: 'seller-risk-recovery-scheduled',
          accountId: account.id,
          accountName: account.name || account.id,
          sellerId: businessSellerId(source),
          reasonCode: recovery.reasonCode,
          retryAt: recovery.retryAt,
          at: recovery.scheduledAt
        })
      }
    }

    liveEvidence = result.persistenceFailed || !result.ok
      ? evidenceFromFailure(result, liveEvidence)
      : mergeEvidence(liveEvidence, result.evidence || {})
    let stateResult = evaluateSellerEvidence(liveEvidence)
    const transientFailure = Boolean(
      !result.ok &&
      TRANSIENT_CRAWL_REASONS.has(String(result.reasonCode || '')) &&
      !result.loggedOut &&
      !result.riskControl &&
      !result.http429 &&
      !result.publicHomeFallback &&
      !result.needsReview &&
      Number(source.retryCount || 0) < MAX_RETRYABLE_FORMAL_RETRIES
    )
    const retryableIncomplete = Boolean(
      !transientFailure &&
      stateResult.status === 'incomplete' &&
      RETRYABLE_INCOMPLETE_REASONS.has(String(stateResult.reasonCode || '')) &&
      Number(source.retryCount || 0) < MAX_RETRYABLE_FORMAL_RETRIES
    )
    const retryableContinuation = transientFailure || retryableIncomplete
    if (retryableContinuation) {
      stateResult = {
        ...stateResult,
        status: 'incomplete',
        reasonCode: transientFailure ? 'TRANSIENT_RETRY_PENDING' : 'INCOMPLETE_RETRY_PENDING'
      }
      retryableSellerIds.add(businessSellerId(source))
      sellerStore.addEvent({
        type: transientFailure ? 'seller-transient-retry-scheduled' : 'seller-incomplete-retry-scheduled',
        accountId: account.id,
        accountName: account.name || account.id,
        sellerId: businessSellerId(source),
        reasonCode: transientFailure ? result.reasonCode : stateResult.reasonCode,
        retryCount: Number(source.retryCount || 0) + 1,
        at: new Date().toISOString()
      })
    } else {
      retryableSellerIds.delete(businessSellerId(source))
    }
    if (result.needsReview && result.reasonCode) {
      stateResult = { ...stateResult, status: 'needs_review', reasonCode: String(result.reasonCode) }
    }
    if (result.riskControl || result.publicHomeFallback || result.http429) {
      stateResult = {
        ...stateResult,
        status: 'risk_cooldown',
        reasonCode: result.publicHomeFallback ? 'PUBLIC_HOME_FALLBACK' : (result.http429 ? 'HTTP_429' : (result.reasonCode || 'RISK_CONTROL'))
      }
    }
    try {
      renewLease()
      if (result.ok) {
        const priorActive = new Set((source.itemIds?.active || []).map(String))
        const priorSold = new Set((source.itemIds?.sold || []).map(String))
        const mergedActive = new Set((liveEvidence.itemIds?.active || []).map(String))
        const resultItems = Array.isArray(result.items) ? result.items : []
        const newItems = resultItems.filter((item) => {
          const id = String(item.itemId || '')
          if (!id) return false
          if (item.status === 'active') return !priorActive.has(id)
          return !priorActive.has(id) && !priorSold.has(id) && !mergedActive.has(id)
        })
        const authoritativeSellerName = resolveAuthoritativeSellerName({ sourceSellerName: source.sellerName, pageSellerName: result.sellerName })
        sellerStore.appendItems(newItems.map((item) => ({ ...item, sellerName: authoritativeSellerName })), { runId, source, snapshotId: result.snapshot?.snapshotId || null })
      }
      const authoritativeSellerName = resolveAuthoritativeSellerName({ sourceSellerName: source.sellerName, pageSellerName: result.sellerName })
      sellerStore.finalizeFormalAttempt(source.id, {
        accountId: account.id,
        cycleKey: attemptCycleKey,
        status: stateResult.status,
        reasonCode: stateResult.reasonCode,
        reason: result.reason || null,
        sellerName: authoritativeSellerName,
        itemCount: stateResult.counts.active + stateResult.counts.sold,
        activeCount: stateResult.counts.active,
        soldCount: stateResult.counts.sold,
        evidence: liveEvidence,
        expected: stateResult.expected,
        itemIds: liveEvidence.itemIds,
        raw: result.raw,
        snapshotId: result.snapshot?.snapshotId || null,
        snapshotHash: result.snapshot?.snapshotHash || null,
        snapshotPath: result.snapshot?.path || null,
        snapshotCapturedAt: result.snapshot?.capturedAt || null,
        snapshotBytes: result.snapshot?.bytes || null,
        snapshotViewport: result.snapshot?.viewport || null,
        snapshotComplete: result.snapshot?.complete,
        snapshotExpectedCount: result.snapshot?.expectedCount,
        snapshotObservedCount: result.snapshot?.observedCount,
        snapshotInlineImageCount: result.snapshot?.inlineImageCount,
        snapshotRemoteImageCount: result.snapshot?.remoteImageCount,
        lastAccountId: account.id,
        retryable: retryableContinuation,
        retryCount: retryableContinuation ? Number(source.retryCount || 0) + 1 : Number(source.retryCount || 0),
        retryableAccountId: retryableContinuation ? account.id : null,
        completedAt: ['completed', 'no_active'].includes(stateResult.status) ? new Date().toISOString() : null,
        finalizedAt: new Date().toISOString()
      })
    } catch (error) {
      stateResult = evaluateSellerEvidence({ ...liveEvidence, persistenceFailed: true })
      try {
        sellerStore.finalizeFormalAttempt(source.id, {
          accountId: account.id,
          cycleKey: attemptCycleKey,
          status: stateResult.status,
          reasonCode: stateResult.reasonCode,
          reason: error?.message || String(error)
        })
      } catch {
        // The in-memory outcome remains failed; callers never receive completed.
      }
    }

    recordFormalAttempt(counters, counterState, source, account, stateResult, result)
    if (accountStats) {
      accountStats.finished++
      accountStats.byStatus[stateResult.status] = (accountStats.byStatus[stateResult.status] || 0) + 1
      if (['completed', 'no_active'].includes(stateResult.status)) accountStats.completed++
      if (stateResult.status === 'failed') accountStats.failed++
    }
    if (result.ok) {
      counters.items += Array.isArray(result.items) ? result.items.length : 0
      counters.active += stateResult.counts.active
      counters.sold += stateResult.counts.sold
      if (result.capped) counters.capped++
    }
    const authoritativeSellerName = resolveAuthoritativeSellerName({ sourceSellerName: source.sellerName, pageSellerName: result.sellerName })
    emit('seller-result', { accountName: account.name, sellerUrl: source.url, ...result, sellerName: authoritativeSellerName, status: stateResult.status, reasonCode: stateResult.reasonCode, itemCount: result.items?.length || 0 })
    if (stateResult.status === 'risk_cooldown') {
      counters.blocked++
      emit('seller-risk-control', {
        accountId: account.id,
        accountName: account.name,
        sellerUrl: source.url,
        reasonCode: circuit?.reasonCode || stateResult.reasonCode,
        riskSignal: String(result.riskEvidence?.signal || '').slice(0, 80),
        riskSource: String(result.riskEvidence?.source || '').slice(0, 80),
        riskUrl: String(result.riskEvidence?.url || '').slice(0, 1000),
        confirmationCount: Math.max(0, Math.min(10, Number(result.riskEvidence?.confirmationCount) || 0)),
        coolingUntil: circuit?.coolingUntil || null
      })
      emit('seller-counters', { ...counters })
      break
    }
    if (stateResult.status === 'login_expired') {
      counters.blocked++
      emit('seller-account-blocked', { accountId: account.id, accountName: account.name, reasonCode: circuit?.reasonCode || stateResult.reasonCode })
      break
    }
    consecutiveFailures = result.ok ? 0 : Math.min(3, consecutiveFailures + 1)
    emit('seller-counters', { ...counters })
    if (!stopRequested) await sleep(computeSellerDelay(settings, consecutiveFailures, Math.random, executionMode))
  }
}

async function startInternal({ reset = false, maxSellers = 0, trigger = 'manual', cycleKey = null, testFast = false, allowedSellerIds = null } = {}) {
  if (running) return { ok: false, reason: '卖家主页采集已在运行中' }
  const limit = Math.max(0, Number(maxSellers) || 0)
  if (testFast && (!String(trigger).startsWith('test-fast-') || limit !== 20 || !Array.isArray(allowedSellerIds) || allowedSellerIds.length !== limit)) {
    return { ok: false, reason: 'test-fast 仅允许测试工具触发固定 20 条样本' }
  }
  try {
    sellerStore.reconcileCanonicalSellerManifest()
  } catch (error) {
    return { ok: false, reason: `权威卖家索引校验失败: ${error?.message || error}` }
  }
  const allSources = sellerStore.getAllSourceRows()
  if (!allSources.length) return { ok: false, reason: '请先导入卖家主页链接' }
  let normalizedAllowedSellerIds = null
  if (testFast) {
    normalizedAllowedSellerIds = [...new Set(allowedSellerIds.map((sellerId) => String(sellerId || '').trim()).filter(Boolean))]
    const indexed = new Map(allSources.map((row) => [String(row.sellerId || ''), row]))
    const resolved = normalizedAllowedSellerIds.filter((sellerId) => indexed.has(sellerId))
    if (normalizedAllowedSellerIds.length !== limit || resolved.length !== limit) {
      return { ok: false, reason: '冻结 20 条样本未能完整映射到权威卖家索引' }
    }
  }
  let accounts
  try {
    accounts = validateAccountIdentities(getAccounts().filter((a) => a.enabled))
  } catch (error) {
    return { ok: false, reason: `账号配置不可用: ${error?.message || error}` }
  }
  if (!accounts.length) return { ok: false, reason: '没有启用的闲鱼账号' }
  const safetyEligibleAccounts = accounts.filter((account) => {
    const safety = sellerStore.getAccountSafetyState(account.id)
    // Automatic recovery must not re-open a profile that was previously
    // observed as logged out. A manual start is an explicit revalidation
    // request: discard the stale marker and inspect only the currently open
    // browser session. This prevents one transient probe failure from
    // permanently blocking healthy accounts.
    if (safety?.status === 'login_required') {
      if (trigger === 'manual') {
        sellerStore.clearAccountSafetyState(account.id)
        return true
      }
      emit('seller-account-safety', {
        ...safety,
        accountName: account.name || account.id
      })
      return false
    }
    if (!safety) return true
    // A manual run is also an explicit request to re-check a previously
    // confirmed page-level risk signal. Drop only RISK_CONTROL here: HTTP 429
    // and other server-side cooldowns must still wait for their deadline.
    // The account eligibility probe and the two-observation page detector run
    // before any seller result can be accepted, so a real challenge is
    // immediately restored instead of being bypassed.
    if (trigger === 'manual' && safety.status === 'cooling' && safety.reasonCode === 'RISK_CONTROL') {
      sellerStore.clearAccountSafetyState(account.id)
      return true
    }
    if (safety.status === 'cooling' && Date.parse(safety.coolingUntil || '') <= Date.now()) {
      sellerStore.clearAccountSafetyState(account.id)
      return true
    }
    emit('seller-account-safety', safety)
    return false
  })
  const eligibility = await Promise.all(safetyEligibleAccounts.map(async (account) => {
    let eligible = false
    let reasonCode = 'LOGIN_REQUIRED'
    try {
      const result = await accountEligibilityChecker(account)
      eligible = typeof result === 'object' ? result?.eligible === true : result === true
      reasonCode = typeof result === 'object' && result?.reasonCode ? String(result.reasonCode) : reasonCode
    } catch {
      eligible = false
    }
    if (!eligible) {
      const safety = typeof sellerStore.setAccountLoginRequired === 'function'
        ? sellerStore.setAccountLoginRequired(account.id, { reasonCode })
        : { accountId: account.id, status: 'login_required', reasonCode }
      sellerStore.addEvent({ type: 'seller-account-safety', ...safety, accountName: account.name || account.id })
      emit('seller-account-safety', safety)
    }
    return { account, eligible }
  }))
  const eligibleAccounts = eligibility.filter((entry) => entry.eligible).map((entry) => entry.account)
  for (const account of eligibleAccounts) {
    const safety = sellerStore.getAccountSafetyState(account.id)
    if (safety?.status === 'login_required') sellerStore.clearAccountSafetyState(account.id)
  }
  if (!eligibleAccounts.length) return { ok: false, reason: '所有账号均在等待登录修复或风控冷却' }

  const settings = sellerStore.getSettings()
  const effectiveReset = trigger === 'manual' ? reset : false
  const job = sellerStore.prepareRun({ reset: effectiveReset, cycleKey, trigger })
  const effectiveCycleKey = job.cycleKey
  const allowedSet = normalizedAllowedSellerIds ? new Set(normalizedAllowedSellerIds) : null
  const reviewSellerIds = testFast ? [] : sellerStore.getAllSourceRows()
    .filter((row) => row.status === 'needs_review' && (!allowedSet || allowedSet.has(String(row.sellerId || ''))))
    .map((row) => String(row.sellerId || ''))
  const pending = sellerStore.getAllSourceRows().filter((r) => (
    (!allowedSet || allowedSet.has(String(r.sellerId || ''))) &&
    (!r.status || r.status === 'pending' || (!testFast && (r.status === 'incomplete' || r.status === 'needs_review')))
  )).length
  if (draining) return { ok: false, reason: '卖家主页采集正在退出' }
  running = true
  const executionMode = testFast ? 'test-fast' : 'production'
  const counters = makeCounters(limit > 0 ? Math.min(pending, limit) : pending, eligibleAccounts)
  lastAccountStats = counters.accountStats
  const counterState = makeCounterState()
  const claimState = { claimed: 0, limit }
  sellerStore.addEvent({
    type: 'start',
    runId: job.runId,
    reset: effectiveReset,
    trigger,
    cycleKey: effectiveCycleKey,
    total: counters.total,
    accounts: eligibleAccounts.map((account) => ({ id: account.id, name: account.name || account.id })),
    accountStats: counters.accountStats,
    settings: {
      maxItemsPerSeller: settings.maxItemsPerSeller,
      maxScrollSteps: settings.maxScrollSteps,
      pageWaitMs: settings.pageWaitMs,
      throttleMinMs: settings.throttleMinMs,
      throttleMaxMs: settings.throttleMaxMs,
      recycleEvery: settings.recycleEvery
    }
  })
  emit('seller-start', { runId: job.runId, total: counters.total, reset: effectiveReset, accounts: eligibleAccounts.map((a) => a.name), accountStats: counters.accountStats })
  let finishRunCalled = false
  const finish = (patch) => {
    if (finishRunCalled) return
    finishRunCalled = true
    sellerStore.finishRun(patch)
  }
  try {
    // Accounts fan out in bounded rounds. Each worker retains its own serial
    // crawl/retry chain; only a durable incomplete row may be offered to an
    // unused account on a later round.
    const maxRounds = Math.max(1, eligibleAccounts.length) + MAX_RETRYABLE_FORMAL_RETRIES
    let round = 0
    while (!stopRequested && round < maxRounds) {
      round += 1
      claimState.claimsThisRound = 0
      const incompleteSellerIds = sellerStore.getAllSourceRows()
        .filter((row) => row.status === 'incomplete' && !row.currentAttempt)
        .map((row) => String(row.sellerId || ''))
      const retryableSellerIds = new Set(sellerStore.getAllSourceRows()
        .filter((row) => row.status === 'incomplete' && row.retryable === true && !row.currentAttempt)
        .map((row) => String(row.sellerId || '')))
      const workers = eligibleAccounts.map((account) => (
        runWorker(account, job.runId, effectiveCycleKey, settings, counters, counterState, claimState, eligibleAccounts.length, executionMode, normalizedAllowedSellerIds, incompleteSellerIds, retryableSellerIds, reviewSellerIds)
          .catch((error) => {
            stopRequested = true
            throw error
          })
      ))
      const settled = await Promise.allSettled(workers)
      const rejection = settled.find((entry) => entry.status === 'rejected')
      if (rejection) {
        stopRequested = true
        const reason = rejection.reason?.message || String(rejection.reason || 'account worker rejected')
        emit('seller-error', { message: reason, reasonCode: 'ACCOUNT_WORKER_REJECTED' })
        finish({ stopped: true, error: reason, workerRejected: true })
        lastAccountStats = counters.accountStats
        emit('seller-done', { ...counters, stopped: true })
        return { ok: false, reason }
      }
      if (testFast && claimState.claimed >= limit) break
      if (claimState.claimsThisRound === 0) break
      const hasReofferableIncomplete = sellerStore.getAllSourceRows().some((row) => {
        if (normalizedAllowedSellerIds && !normalizedAllowedSellerIds.includes(String(row.sellerId || ''))) return false
        if (row.status !== 'incomplete' || row.currentAttempt) return false
        if (row.retryable === true && Number(row.retryCount || 0) < MAX_RETRYABLE_FORMAL_RETRIES) {
          return eligibleAccounts.some((account) => String(row.retryableAccountId || '') === String(account.id))
        }
        return eligibleAccounts.some((account) => !(row.attemptedAccountIds || []).includes(account.id))
      })
      if (!hasReofferableIncomplete) break
    }
    if (testFast && claimState.claimed !== limit) throw new Error(`冻结 20 条技术样本只领取 ${claimState.claimed} 条，运行结果无效`)
    finish({ stopped: stopRequested, counters })
    lastAccountStats = counters.accountStats
    emit('seller-done', { ...counters, stopped: stopRequested })
    return { ok: true, ...counters, stopped: stopRequested }
  } catch (e) {
    finish({ stopped: stopRequested, counters, error: e?.message || String(e) })
    lastAccountStats = counters.accountStats
    emit('seller-error', { message: e?.message || String(e), accountStats: counters.accountStats })
    return { ok: false, reason: e?.message || String(e) }
  } finally {
    running = false
  }
}

export async function start(options = {}) {
  if (draining) return { ok: false, reason: '卖家主页采集正在退出' }
  if (running || starting) return { ok: false, reason: '卖家主页采集已在启动或运行中' }
  stopRequested = false
  starting = true
  const current = (async () => {
    try {
      return await startInternal(options)
    } finally {
      starting = false
    }
  })()
  activeStartPromise = current
  try { return await current } finally {
    if (activeStartPromise === current) activeStartPromise = null
  }
}

export function stop() {
  stopRequested = true
  return { ok: true }
}

/**
 * Stop accepting new seller claims and wait for the current start/run to
 * finish all formal-attempt persistence before browser targets are closed.
 * Keeping this separate from stop() preserves the existing synchronous IPC
 * response while giving app shutdown an ordering barrier.
 */
export async function drain() {
  draining = true
  stopRequested = true
  if (weeklyTimer) {
    clearInterval(weeklyTimer)
    weeklyTimer = null
  }
  const current = activeStartPromise
  if (current) await current.catch(() => {})
  return { ok: true }
}

export function getStatus() {
  return { running, starting, accountStats: lastAccountStats, ...sellerStore.getStatus() }
}

export function rearmWeekly() {
  if (weeklyTimer) {
    clearInterval(weeklyTimer)
    weeklyTimer = null
  }
  const tryRiskRecovery = () => {
    if (running || typeof sellerStore.getRiskRecovery !== 'function') return false
    const pending = sellerStore.getRiskRecovery()
    const retryAt = Date.parse(pending?.retryAt || '')
    if (!pending || !Number.isFinite(retryAt) || retryAt > Date.now()) return false
    const claimed = typeof sellerStore.claimRiskRecovery === 'function' ? sellerStore.claimRiskRecovery() : null
    if (!claimed) return false
    const released = typeof sellerStore.releaseRiskCooldown === 'function'
      ? sellerStore.releaseRiskCooldown(claimed.accountId)
      : { released: 0 }
    sellerStore.clearAccountSafetyState(claimed.accountId)
    const recoveryCycleKey = `seller-risk-recovery:${Date.now()}:${claimed.cycleKey || 'cooldown'}`
    sellerStore.addEvent({
      type: 'seller-risk-recovery-start',
      accountId: claimed.accountId,
      sellerId: claimed.sellerId || null,
      reasonCode: claimed.reasonCode,
      released: released.released,
      cycleKey: recoveryCycleKey,
      at: new Date().toISOString()
    })
    void start({ reset: false, trigger: 'risk-recovery', cycleKey: recoveryCycleKey }).then((result) => {
      if (result?.ok) return
      const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      const restored = sellerStore.restoreRiskRecovery?.(claimed, { retryAt, reason: result?.reason || '风险恢复未启动' })
      sellerStore.addEvent({
        type: 'seller-risk-recovery-deferred',
        accountId: claimed.accountId,
        reasonCode: 'RISK_RECOVERY_START_FAILED',
        retryAt: restored?.retryAt || retryAt,
        reason: result?.reason || '风险恢复未启动',
        at: new Date().toISOString()
      })
    }).catch((error) => {
      const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
      const restored = sellerStore.restoreRiskRecovery?.(claimed, { retryAt, reason: error?.message || String(error) })
      sellerStore.addEvent({
        type: 'seller-risk-recovery-deferred',
        accountId: claimed.accountId,
        reasonCode: 'RISK_RECOVERY_START_ERROR',
        retryAt: restored?.retryAt || retryAt,
        reason: error?.message || String(error),
        at: new Date().toISOString()
      })
    })
    return true
  }
  const recovery = sellerStore.claimRecoveryRun()
  if (recovery?.cycleKey && !running && !starting) {
    sellerStore.addEvent({ type: 'recovery_start', priorRunId: recovery.runId, cycleKey: recovery.cycleKey, recoveredSellers: recovery.recoveredSellers })
    void start({ reset: false, trigger: 'recovery', cycleKey: recovery.cycleKey })
  }
  const tick = () => {
    if (draining) return
    if (tryRiskRecovery()) return
    const s = sellerStore.getSettings()
    if (!s.weeklyEnabled) return
    const scheduleState = sellerStore.getScheduleState()
    const decision = evaluateSchedule({
      now: new Date(),
      settings: { ...s, timezone: SELLER_TIMEZONE },
      lastCycle: scheduleState,
      running
    })
    if (!decision.cycleKey || ['idle', 'duplicate', 'skipped_overlap'].includes(decision.outcome)) return
    const claim = sellerStore.claimScheduleCycle(decision)
    if (!claim.claimed) return
    sellerStore.addEvent({ type: 'schedule', ...decision })
    emit('seller-weekly-trigger', decision)
    if (decision.shouldStart) void start({ reset: false, trigger: decision.outcome, cycleKey: decision.cycleKey })
  }
  tick()
  weeklyTimer = setInterval(tick, 60 * 1000)
}
