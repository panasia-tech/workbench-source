// 调度：库存 API-SPU 是自动采集主来源；Excel 只补充 API 当前不存在的采购扩展 SPU。
// 每次计划/开爬前先尝试刷新 API，刷新失败则继续使用最近一次有效缓存，避免丢失历史。
import { uploadPrice } from './api.js'
import { annotateSnapshotCards, captureHtmlSnapshot, crawlOne, prepareSnapshotResources, promoteSnapshotImages } from './goofish.js'
import { getWebContents, recycleView } from './session-manager.js'
import { effectiveCrawlPolicyForTask } from './search-queries.js'
import { addResult as storeAddResult, getAccounts, getSettings, getToken } from './store.js'
import { correctTask, normalizeImportedTasks, sanitizePublicationPrice } from './llm-alias.js'
import * as taskStore from './task-store.js'
import { dailyDecision } from './daily-schedule.js'
import { wmsMatchSummary } from './wms-match.js'
import { getWmsSyncService } from './wms-sync-service.js'
import { buildUnifiedSchedulerSource } from './scheduler-source.js'
import {
  closeCrawlRun,
  handoffRequested,
  holdsLease,
  openCrawlRun,
  pendingCrawlRunId,
  takeCrawlRun,
  turnOff
} from './workbench-device.js'
import { beginRound } from './shadow-report.js'
import { ensureCrawlerToken, syncCrawlProducts } from './erp-sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MIN_VALID_PRICE = 100
const MAX_BATCH = 25
const withTimeout = (promise, timeoutMs, label) => Promise.race([
  promise,
  sleep(timeoutMs).then(() => { throw new Error(`${label}超时（${timeoutMs}ms）`) })
])

function attachPurchasePriceFence(saved, task, {
  status = 'not_evaluated',
  applied = false,
  reason = ''
} = {}) {
  const fence = {
    scope: 'task',
    reasonCode: 'purchase_price_fence',
    status,
    applied,
    allSnapshots: true,
    purchasePrice: task.referencePrice ?? null,
    purchasePriceStatus: task.referencePriceStatus || (task.referencePrice == null ? 'missing' : 'valid'),
    reason: String(reason || task.referencePriceReason || '').slice(0, 300)
  }
  return {
    ...saved,
    purchasePriceFence: fence,
    queryLogs: Array.isArray(saved.queryLogs)
      ? saved.queryLogs.map((log) => ({ ...log, purchasePriceFence: fence }))
      : []
  }
}

function snapshotPathsForResult(result = {}) {
  return [...new Set([
    ...(Array.isArray(result.snapshotEntries) ? result.snapshotEntries.map((entry) => entry?.path) : []),
    result.snapshotPath,
    ...(Array.isArray(result.snapshotPaths) ? result.snapshotPaths : [])
  ].map((path) => String(path || '').trim()).filter(Boolean))]
}

// 任务间隔：在 [min, max] 内取随机延迟（更像真人、降低风控）
function randomDelay(settings) {
  let min = Number(settings.throttleMinMs) || 1500
  let max = Number(settings.throttleMaxMs) || 3500
  if (max < min) [min, max] = [max, min]
  return Math.round(min + Math.random() * (max - min))
}

let running = false
let stopRequested = false
let emit = () => {} // 进度事件回调（main 注入）
let dailyTimer = null
let lastDailyTrigger = ''
let lastCatchUpDay = ''
let stopReason = ''
let aiNormalizationPromise = null
const activeWebContents = new Set()
// The main process injects a partition-cookie check after Electron is ready.
// Keeping the default permissive preserves node-only scheduler regressions.
let accountEligibilityChecker = async () => true

export function setEmitter(fn) {
  emit = fn || (() => {})
}

export function setAccountEligibilityChecker(fn) {
  accountEligibilityChecker = typeof fn === 'function' ? fn : async () => true
}

async function getEligibleAccounts(accounts) {
  const enabled = accounts.filter((account) => account.enabled)
  const checked = await Promise.all(enabled.map(async (account) => {
    try {
      const result = await accountEligibilityChecker(account)
      const eligible = typeof result === 'object' ? result?.eligible === true : result === true
      if (!eligible) {
        emit('account-login-required', {
          accountId: account.id,
          accountName: account.name,
          reasonCode: typeof result === 'object' && result?.reasonCode ? String(result.reasonCode) : 'LOGIN_REQUIRED'
        })
      }
      return { account, eligible }
    } catch {
      emit('account-login-required', { accountId: account.id, accountName: account.name, reasonCode: 'LOGIN_CHECK_FAILED' })
      return { account, eligible: false }
    }
  }))
  return checked.filter((entry) => entry.eligible).map((entry) => entry.account)
}

export function isRunning() {
  return running
}

/** 把任务按启用账号轮询切片，返回 [{account, tasks:[...]}] */
export function planDistribution(tasks, accounts) {
  const enabled = accounts.filter((a) => a.enabled)
  if (!enabled.length) return []
  const buckets = enabled.map((a) => ({ account: a, tasks: [] }))
  tasks.forEach((t, i) => buckets[i % buckets.length].tasks.push(t))
  return buckets
}

/** 预览/账号页用：算每个账号会分到多少词（不实际爬） */
export async function previewPlan() {
  const resolved = await resolveTaskSource()
  const tasks = resolved.tasks
  const settings = resolved.settings
  const limited = settings.maxTasks > 0 ? tasks.slice(0, settings.maxTasks) : tasks
  const buckets = planDistribution(limited, await getEligibleAccounts(getAccounts()))
  return {
    total: limited.length,
    source: resolved.source,
    sourceState: resolved.sourceState || null,
    blockedReason: resolved.blockedReason || null,
    buckets: buckets.map((b) => ({ accountId: b.account.id, accountName: b.account.name, count: b.tasks.length }))
  }
}

async function resolveTaskSource() {
  const settings = taskStore.getSettings()
  const { getWmsSecrets } = await import('./store.js')
  const protectedSecrets = getWmsSecrets()
  const hasRestConfig = Boolean(protectedSecrets.restUsername && protectedSecrets.restPassword)
  const hasMcpConfig = Boolean(settings.wmsMcpUrl && protectedSecrets.mcpKey)
  const hasWmsConfig = settings.wmsSource === 'mcp'
    ? hasMcpConfig
    : settings.wmsSource === 'rest'
      ? hasRestConfig
      : hasRestConfig || hasMcpConfig
  if (hasWmsConfig) {
    try {
      const synced = await getWmsSyncService().refresh({ reason: 'scheduler-preflight', source: settings.wmsSource })
      emit('wms-sync', { ...synced, automatic: true })
    } catch (error) {
      // Keep the last valid cache. A transient API outage must not turn a
      // 10k-SPU installation into an empty run or force an Excel re-import.
      emit('wms-sync-warning', { reason: error?.safeReason || error?.message || '库存 API 自动刷新失败，继续使用最近缓存' })
    }
  }
  // The task-store projection is the only scheduler source boundary. In
  // particular, do not fall back to getActiveTasks()/local_excel when the
  // first API snapshot has not succeeded: an Excel file is an extension
  // source only after the warehouse API has established its authority.
  const sourceState = taskStore.getUnifiedApiSourceState()
  const tasks = taskStore.getUnifiedTasks()
  return buildUnifiedSchedulerSource({ tasks, settings, sourceState })
}

/**
 * 历史任务/新导入任务的第一阶段清洗统一入口。
 * 由启动后台任务和每次本地开爬前共同调用，保证旧数据不需要用户重新导入 Excel。
 */
export async function runAiNormalization({ force = false, reason = 'scheduler-preflight' } = {}) {
  if (aiNormalizationPromise) return aiNormalizationPromise
  aiNormalizationPromise = (async () => {
    const migration = taskStore.migrateAiPipeline()
    if (!migration.ok) return { ...migration, attempted: 0, updated: 0 }
    const tasks = taskStore.getAiNormalizationTasks({ includeDisabled: true, force })
    if (!tasks.length) return { ok: true, collectionId: migration.collectionId, attempted: 0, updated: 0, pending: migration.pending, skipped: true }
    emit('ai-normalization-start', {
      collectionId: migration.collectionId,
      total: tasks.length,
      reason
    })
    let appliedCount = 0
    const result = await normalizeImportedTasks(tasks, {
      onBatch: async ({ patches }) => {
        // Apply each bounded slice before yielding so the snapshot epoch is
        // invalidated after every write, while summary/list IPC can continue
        // serving the previous immutable snapshot during provider work.
        if (patches.length > MAX_BATCH) throw new Error(`AI normalization batch exceeds ${MAX_BATCH} tasks`)
        const appliedBatch = taskStore.applyTaskPatches(patches, { collectionId: migration.collectionId })
        appliedCount += appliedBatch.updated || 0
      }
    })
    const applied = { updated: appliedCount }
    const event = taskStore.recordAiNormalizationRun({
      collectionId: migration.collectionId,
      attempted: tasks.length,
      updated: applied.updated || 0,
      configured: result.configured,
      ok: result.ok,
      fallback: result.fallback,
      errors: result.errors || []
    })
    const payload = {
      ...result,
      collectionId: migration.collectionId,
      attempted: tasks.length,
      updated: applied.updated || 0,
      pending: taskStore.getAiNormalizationTasks({ includeDisabled: true, force: true }).length,
      event
    }
    emit('ai-normalization', payload)
    return payload
  })().finally(() => {
    aiNormalizationPromise = null
  })
  return aiNormalizationPromise
}

// 这些症状通常意味着渲染进程已崩/已销毁，重建视图后当条可救回来
const CRASH_PATTERN = /页面无响应|导航失败|destroyed|crashed|Render process gone/i

/**
 * 第二次清洗：第一次行情异常时只自动尝试一次型号纠改，避免同一型号
 * 在每轮重试中无限消耗模型额度；模型必须返回候选，低置信度候选交给人工复核。
 */
async function autoCorrectFailedTask(task, stage, reason) {
  if (!task?.id || task.aiCorrectionStatus === 'done' || (Number(task.aiCorrectionAttempts) || 0) > 0) return null
  const marked = taskStore.markAiCorrectionAttempt(task.id)
  if (!marked.ok) return null
  const correction = await correctTask(task, { stage, reason })
  taskStore.applyAiCorrection(task.id, correction)
  emit('ai-correction', {
    taskId: task.id,
    name: task.name,
    ok: !!(correction.ok && correction.corrected),
    source: correction.source || 'zhipu',
    reason: correction.reason || ''
  })
  return correction
}

/** AI 纠改队列：候选生成后立即用放宽搜索复核一次，低置信度结果进入人工复核。 */
async function prepareAiCorrectionQueue(tasks = []) {
  if (stopRequested) return []
  const processOne = async (queuedTask) => {
    const task = taskStore.getActiveTask(queuedTask.id) || queuedTask
    emit('progress', { current: `AI 纠改：${task.name}` })
    const marked = taskStore.markAiCorrectionAttempt(task.id)
    if (!marked.ok) return null
    const correction = await correctTask(task, {
      stage: 'AI 纠改队列',
      reason: task.lastReason || '前一次行情采集仍未得到可信结果'
    })
    taskStore.applyAiCorrection(task.id, correction)
    if (correction.ok && correction.corrected) {
      const savedTask = taskStore.getActiveTask(task.id) || task
      return {
        ...savedTask,
        ...correction,
        id: task.id,
        name: correction.name || `${correction.brand} ${correction.model}`.trim(),
        keyword: correction.keyword || `${correction.brand} ${correction.model}`.trim(),
        queueKind: 'ai_correction',
        queueStrategy: 'broad'
      }
    }
    return null
  }
  // Qwen 可并发处理整个 AI 纠改队列；不再沿用旧智谱逐条等待。
  const results = await Promise.all(tasks.map(processOne))
  return results.filter(Boolean)
}

async function runBucket(bucket, settings, counters, runId, sourceType) {
  const recycleEvery = Number(settings.recycleEvery) || 0
  let done = 0
  // 影子模式（S3-0）：本轮的每一次处置都记一条，跑完一次性报给服务端。
  // 它是 S3-1 把决策权搬走之后唯一的对照基准；纯观测，失败不影响采集。
  const shadow = beginRound({
    clientId: settings.clientId || 'desktop',
    account: bucket.account?.name || '(未命名账号)',
    trigger: sourceType || 'manual',
    // 把本机**实际在用**的节奏一并报上去（S3-0 只上报，服务端不下发）：
    // S3-1 搬走决策权之后，要靠它回答「新调度是不是比原来跑得慢了」。
    rhythm: settings
  })
  const addResult = (saved) => {
    shadow.record({
      spu: saved?.name,
      status: saved?.status,
      reason: saved?.reason,
      price: saved?.price
    })
    return storeAddResult(saved)
  }
  for (const task of bucket.tasks) {
    if (stopRequested) break
    // WMS 对应只依赖当前缓存，不在这里发网络请求；同步动作由任务中心显式触发。
    const wmsMatch = wmsMatchSummary(task, taskStore.getWmsSkus())
    // 每爬 N 条主动销毁重建视图，释放渲染进程积累的内存（长任务列表防崩）
    if (recycleEvery > 0 && done > 0 && done % recycleEvery === 0) {
      recycleView(bucket.account.id)
    }
    done++
    emit('progress', { accountId: bucket.account.id, accountName: bucket.account.name, current: task.name })
    const searchStrategy = task.queueStrategy || 'normal'
    // task-store has already resolved the canonical SPU policy. Keep it as one
    // crawl contract so a renderer crash retry or a broad exception retry can
    // expand queries without losing the SPU blacklist/fence/page-filter intent.
    const crawlPolicy = effectiveCrawlPolicyForTask(task, {
      globalBlacklist: settings.blacklistKeywords || [],
      strategy: searchStrategy
    })
    const searchKeywords = crawlPolicy.queries
    const captureSnapshot = async ({ query, pageUrl, result, decisionMap, decisionMapByQuery, policyEvidence }) => {
      const wc = getWebContents(bucket.account)
      const filePath = taskStore.createSnapshotPath({ runId, taskId: task.id, query })
      // Keep the exact query-scoped object from goofish for both projections;
      // no second map is rebuilt from page text after saving.
      const queryDecisionMap = decisionMapByQuery?.[query] || decisionMap || { entries: [], byKey: {} }
      let annotation = null
      try {
        // 接口结果提供 query-scoped item ID/link 判定；保存前只投影这份 map，
        // 不再根据快照 DOM 文本或完整型号重新推断。
        annotation = await annotateSnapshotCards(
          wc,
          crawlPolicy.blacklist.terms,
          crawlPolicy.relevanceKeywords,
          queryDecisionMap,
          policyEvidence || crawlPolicy
        )
      } catch {
        // 标记失败不影响快照和行情结果。
      }
      let promotedImages = 0
      try {
        // 价格计算只保留相关商品，但快照仍要用接口中的全部 picUrl，
        // 这样被打叉的无关卡片也不会只剩文字或 2×2 占位图。
        const promoted = await promoteSnapshotImages(wc, result?.snapshotCandidates || result?.candidates || [])
        promotedImages = Number(promoted?.updated) || 0
      } catch {
        // 接口图片地址注入失败时仍继续保存当前页面，避免影响行情结果。
      }
      if (!promotedImages) {
        try {
          // 仅在接口没有提供可用图片时走浏览器兜底，正常路径不再等待懒加载。
          await withTimeout(prepareSnapshotResources(wc), 12000, '快照图片预热')
        } catch {
          // 页面资源预热失败时仍继续保存当前页面，避免影响行情采集。
        }
      }
      try {
        // 主路径只保存已经注入真实 picUrl 的 DOM，不再等待 HTMLComplete 下载整页图片；
        // 员工打开快照时仍能看到当时的闲鱼卡片和商品图，抓价速度不被资源下载拖住。
        const snapshot = await withTimeout(captureHtmlSnapshot(wc), 10000, 'DOM 快照保存')
        const saved = taskStore.saveSnapshot(snapshot.html, {
          runId,
          taskId: task.id,
          query,
          pageUrl: snapshot.url || pageUrl,
          viewport: { width: snapshot.width, height: snapshot.height }
        })
        taskStore.markSnapshotNonTarget({ ...saved, query }, { decisionMap: queryDecisionMap })
        return { ...saved, annotation }
      } catch {
        // DOM 快照失败时再用 HTMLComplete 兜底，行情本身不受影响。
        await withTimeout(wc.savePage(filePath, 'HTMLComplete'), 30000, '网页快照保存')
        const registered = taskStore.registerSnapshot(filePath, { query, pageUrl: wc.getURL() || pageUrl })
        taskStore.markSnapshotNonTarget({ ...registered, query }, { decisionMap: queryDecisionMap })
        return { ...registered, annotation }
      }
    }
    let res
    const webContents = getWebContents(bucket.account)
    activeWebContents.add(webContents)
    try {
      res = await crawlOne(webContents, searchKeywords, {
        accountName: bucket.account.name,
        effectivePolicy: crawlPolicy,
        queryDelayMinMs: settings.queryDelayMinMs,
        queryDelayMaxMs: settings.queryDelayMaxMs,
        captureSnapshot
      })
    } catch (e) {
      res = { ok: false, reason: '爬取异常: ' + (e?.message || e) }
    } finally {
      activeWebContents.delete(webContents)
    }
    // 疑似渲染进程崩溃：重建视图重试一次
    if (!res.ok && !res.empty && CRASH_PATTERN.test(res.reason || '')) {
      recycleView(bucket.account.id)
      try {
        res = await crawlOne(getWebContents(bucket.account), searchKeywords, {
          accountName: bucket.account.name,
          effectivePolicy: crawlPolicy,
          queryDelayMinMs: settings.queryDelayMinMs,
          queryDelayMaxMs: settings.queryDelayMaxMs,
          captureSnapshot
        })
      } catch (e) {
        res = { ok: false, reason: '爬取异常(重试后): ' + (e?.message || e) }
      }
    }

    const observedQueries = [...new Set([
      ...(Array.isArray(res.snapshotEntries) ? res.snapshotEntries.map((entry) => entry?.query) : []),
      ...(Array.isArray(res.priceBreakdown?.queryResults) ? res.priceBreakdown.queryResults.map((item) => item?.query) : [])
    ].map((query) => String(query || '').trim()).filter(Boolean))]
    const base = {
      name: task.name,
      keyword: task.keyword || task.name,
      // A risk-control stop may intentionally abort before later planned
      // queries. Persist the attempted query list in the same DTO as entries,
      // logs and price projections; keep the full plan only when no projection
      // was produced (for example, a pre-navigation scheduler exception).
      searchKeywords: observedQueries.length ? observedQueries : searchKeywords,
      account: bucket.account.name,
      snapshotPath: res.snapshotPath || null,
      snapshotQuery: res.snapshotQuery || '',
      snapshotPaths: Array.isArray(res.snapshotPaths) ? res.snapshotPaths : [],
      snapshotViewport: res.snapshotViewport || null,
      pageUrl: res.pageUrl || '',
      snapshotEntries: Array.isArray(res.snapshotEntries) ? res.snapshotEntries : [],
      queryLogs: Array.isArray(res.queryLogs) ? res.queryLogs : [],
      decisionMapByQuery: res.decisionMapByQuery || {},
      priceBreakdown: res.priceBreakdown || null,
      // The durable task-store row keeps priceBreakdown intact, which makes
      // this non-secret policy evidence available alongside each run result.
      policyEvidence: res.policyEvidence || res.priceBreakdown?.policyEvidence || null,
      wmsMatch,
      queueKind: task.queueKind || null,
      attemptStrategy: searchStrategy,
      at: new Date().toISOString()
    }

    if (res.riskControl) {
      counters.riskControl++
      stopRequested = true
      stopReason = res.reason || '检测到闲鱼风控页面，已暂停本轮采集'
      const saved = attachPurchasePriceFence({ ...base, status: 'risk_control', reason: res.reason || '检测到闲鱼风控页面，已暂停本轮采集' }, task, {
        status: 'not_evaluated',
        reason: '任务未进入销售价围栏；风控页面已暂停采集'
      })
      addResult(saved)
      if (runId) taskStore.recordRunResult(runId, task, saved)
      emit('risk-control', {
        accountName: bucket.account.name,
        current: task.name,
        reason: saved.reason
      })
      emit('counters', { ...counters })
      break
    }

    if (res.ok) {
      // 低于 100 元的显示器行情不进入正常结果，也不上报服务端；交给员工更正型号并扫码确认。
      const marketPrice = Number(res.price)
      if (!Number.isFinite(marketPrice) || marketPrice < MIN_VALID_PRICE) {
        counters.invalidPrice++
        taskStore.markSnapshotPriceError(snapshotPathsForResult(res), res.price)
        const reason = !Number.isFinite(marketPrice)
          ? '未取到有效行情价格，判定为错误价格，请更正型号并重新扫码确认'
          : `抓取价格 ¥${res.price} 低于 ${MIN_VALID_PRICE} 元，判定为错误价格，请更正型号并重新扫码确认`
        const correction = await autoCorrectFailedTask(task, '最低价/有效价格校验', reason)
        const saved = attachPurchasePriceFence({
          ...base,
          price: res.price,
          source: res.source,
          status: 'invalid_price',
          reason: correction?.ok && correction?.corrected ? `${reason}；已应用 AI 型号纠改，等待复核` : reason
        }, task, { status: 'blocked', applied: true, reason })
        addResult(saved)
        if (runId) taskStore.recordRunResult(runId, task, saved)
      } else {
        try {
          // 第三次清洗：采购价是发布前不可被模型覆盖的硬下限，120% 不再是硬门槛。
          const publicationCheck = await sanitizePublicationPrice({ task, marketPrice })
          if (!publicationCheck.shouldPublish) {
            counters.invalidPrice++
            taskStore.markSnapshotPriceError(snapshotPathsForResult(res), res.price, {
              kind: 'purchase_price_fence',
              reason: publicationCheck.reason,
              purchasePrice: task.referencePrice,
              marketPrice
            })
            const correction = await autoCorrectFailedTask(task, '销售价围栏校验(采购价)', publicationCheck.reason)
            const saved = attachPurchasePriceFence({
              ...base,
              price: marketPrice,
              source: res.source,
              publicationCheck,
              status: 'invalid_price',
              reason: correction?.ok && correction?.corrected
                ? `${publicationCheck.reason}；已应用 AI 型号纠改，等待复核`
                : publicationCheck.reason
            }, task, { status: 'blocked', applied: true, reason: publicationCheck.reason })
            addResult(saved)
            if (runId) taskStore.recordRunResult(runId, task, saved)
            emit('counters', { ...counters })
            if (!stopRequested) await sleep(randomDelay(settings))
            continue
          }
          // 上报行情。Excel 任务的 task.id 是本机 ID,不是 ERP 的 product_id,
          // 所以按型号名上报,由服务端解析/自动登记监控商品。
          //
          // 上报失败**不阻断爬取**——价已经算出来了，本地也存了，为了传不上去
          // 而把这一条判成失败不值得。但**必须计数**：这里原来是「拿不到 token
          // 就静默跳过」，于是 2026-09-16 登录门改动把设备账号挡在外面时，
          // 爬照跑、价照存、就是不再往 ERP 传，而没有任何地方说得出这件事。
          // 静默失效比失败本身贵得多。
          try {
            if (await ensureCrawlerToken()) {
              await uploadPrice({
                productId: sourceType === 'server' ? task.id : null,
                productName: task.name,
                price: publicationCheck.finalPrice,
                raw: { ...(res.raw || {}), wms: wmsMatch }
              })
            } else {
              counters.uploadSkipped++
            }
          } catch (uploadError) {
            counters.uploadFailed++
            lastUploadError = String(uploadError?.response?.data?.detail || uploadError?.message || '上报失败').slice(0, 120)
          }
          counters.success++
          const saved = attachPurchasePriceFence({ ...base, price: publicationCheck.finalPrice, source: res.source, publicationCheck, status: 'success' }, task, {
            status: 'passed',
            reason: publicationCheck.reason
          })
          addResult(saved)
          if (runId) taskStore.recordRunResult(runId, task, saved)
        } catch (e) {
          counters.fail++
          const detail = e?.response?.data?.detail || e?.message || '上报失败'
          const saved = attachPurchasePriceFence({ ...base, price: res.price, source: res.source, status: 'fail', reason: '上报失败: ' + JSON.stringify(detail) }, task, {
            status: 'not_evaluated',
            reason: '上报失败，未完成销售价围栏记录'
          })
          addResult(saved)
          if (runId) taskStore.recordRunResult(runId, task, saved)
        }
      }
    } else if (res.empty) {
      // 闲鱼无此商品在售：不算失败，也不上报脏价
      counters.empty++
      const correction = await autoCorrectFailedTask(task, '行情搜索无在售', res.reason)
      const saved = attachPurchasePriceFence({ ...base, status: 'empty', reason: correction?.ok && correction?.corrected ? `${res.reason}；已应用 AI 型号纠改，等待复核` : res.reason }, task, {
        status: 'not_evaluated',
        reason: '未取得可用行情价，未进入销售价围栏'
      })
      addResult(saved)
      if (runId) taskStore.recordRunResult(runId, task, saved)
    } else {
      counters.fail++
      const correction = await autoCorrectFailedTask(task, '行情搜索失败', res.reason)
      const saved = attachPurchasePriceFence({ ...base, status: 'fail', reason: correction?.ok && correction?.corrected ? `${res.reason}；已应用 AI 型号纠改，等待复核` : res.reason }, task, {
        status: 'not_evaluated',
        reason: '行情搜索失败，未进入销售价围栏'
      })
      addResult(saved)
      if (runId) taskStore.recordRunResult(runId, task, saved)
    }

    emit('counters', { ...counters })
    if (!stopRequested) await sleep(randomDelay(settings))
  }
  // 一轮一次上报：逐条发既吵又慢，而对照要看的本来就是「这一轮整体如何」。
  await shadow.flush()
}

/** 开始一轮爬取（所有启用账号并发，各自串行其分片） */
export async function start({ trigger = 'manual', resume = false, resumeIfAvailable = false, queueKind = null, serverRunId = null } = {}) {
  if (running) return { ok: false, reason: '已在运行中' }
  // 定时触发的那一路在 rearmDaily 里已经判过租约；这里挡的是人工点「开始」——
  // 同一个人在两台电脑上各点一次，本地都会答应，只有服务端知道该谁跑。
  if (trigger === 'schedule' && !holdsLease('market')) {
    return { ok: false, reason: '行情爬虫当前不归这台电脑，已跳过本轮' }
  }
  running = true
  stopRequested = false
  stopReason = ''
  const counters = { success: 0, fail: 0, empty: 0, invalidPrice: 0, riskControl: 0, total: 0, uploadSkipped: 0, uploadFailed: 0 }
  let lastUploadError = ''
  let runId = null
  // 服务端那一轮的 id。派发来的已经认领过（带着 serverRunId 进来），自己起的
  // 要现登记一次——登记不上就是 null，照跑，只是这一轮服务端没有记录。
  // 采集是本机能力，不该因为网抖就停：宁可少一条记录，不要少跑一轮。
  let serverRun = serverRunId
  try {
    let resolved = await resolveTaskSource()
    if (resolved.source === 'local_excel' && taskStore.hasActiveCollection()) {
      await runAiNormalization({
        reason: queueKind ? `queue:${queueKind}` : trigger,
        force: false
      })
      // 首轮清洗可能已经改了品牌/型号/关键词；重新读取，避免本轮继续使用旧搜索词。
      resolved = await resolveTaskSource()
    }
    const settings = resolved.settings
    let tasks = resolved.tasks
    let resumeInfo = null
    if (queueKind) {
      if (!['local_excel', 'api_spu'].includes(resolved.source)) {
        running = false
        return { ok: false, reason: '异常队列只支持当前 API-SPU/Excel 任务清单' }
      }
      const queued = taskStore.getQueueTasks(queueKind)
      if (!queued.ok) {
        running = false
        return { ok: false, reason: queued.reason }
      }
      tasks = queued.tasks
      if (queueKind === 'ai_correction') {
        const correctionLimit = settings.maxTasks > 0 ? tasks.slice(0, settings.maxTasks) : tasks
        tasks = await prepareAiCorrectionQueue(correctionLimit)
        if (!tasks.length) {
          running = false
          return { ok: false, reason: 'AI 没有找到可安全应用的型号更正，未进入行情复核；任务仍保留在 AI 纠改队列' }
        }
      }
    }
    if (resume && !queueKind) {
      const resumed = taskStore.getResumeTasks(tasks)
      resumeInfo = resumed.info
      if (!resumeInfo.available) {
        if (!resumeIfAvailable) {
          running = false
          return { ok: false, reason: '没有可继续的中断任务' }
        }
      } else {
        tasks = resumed.tasks
      }
    }
    if (!tasks.length) {
      running = false
      return { ok: false, reason: resolved.blockedReason || (taskStore.getWmsSkus().length ? '当前 API-SPU 没有启用任务' : (taskStore.hasActiveCollection() ? '当前清单没有启用任务' : '请先配置库存 API 或导入 Excel 扩展任务')) }
    }
    const limited = settings.maxTasks > 0 ? tasks.slice(0, settings.maxTasks) : tasks
    const buckets = planDistribution(limited, await getEligibleAccounts(getAccounts()))
    if (!buckets.length) {
      running = false
      return { ok: false, reason: '没有启用的账号' }
    }
    counters.total = limited.length
    const run = taskStore.startRun({ trigger, total: counters.total, source: resolved.source, resumeOf: resumeInfo?.available ? resumeInfo.runId : null, queueKind })
    runId = run.id
    // 自己起的这一轮向服务端登记一次，带上本地 run id——出问题时要能从服务端那条
    // 对到本机这份历史记录上。登记不上就 null，照跑。
    if (!serverRun) {
      serverRun = await openCrawlRun({ trigger, localRunId: runId, offlineStarted: true })
    }
    emit('start', { total: counters.total, runId, source: resolved.source, queueKind, resumedFrom: resumeInfo?.available ? resumeInfo.runId : null, buckets: buckets.map((b) => ({ accountName: b.account.name, count: b.tasks.length })) })
    // 开爬前把本轮要跑的型号同步进 ERP 的行情监控列表（合并导入，不删）。
    // 失败只记日志：行情采集本身不依赖 ERP，不能因为同步不上就不爬。
    try {
      emit('progress', { accountName: 'ERP', current: '同步型号清单…' })
      const synced = await syncCrawlProducts(tasks)
      // 只有真失败才弹提示；未配凭据属正常的纯本地模式，不打扰
      if (!synced.ok && !synced.skipped) {
        emit('crawl-product-sync', { ok: false, reason: synced.reason })
      } else if (synced.ok) {
        emit('crawl-product-sync', { ok: true, sent: synced.sent, created: synced.created, updated: synced.updated })
      }
    } catch (e) {
      emit('crawl-product-sync', { ok: false, reason: '型号同步异常：' + (e?.message || e) })
    }

    await Promise.all(buckets.map((b) => runBucket(b, settings, counters, runId, resolved.source)))
    taskStore.finishRun(runId, { ...counters, stopped: stopRequested, ...(stopReason ? { reason: stopReason } : {}) })
    // 一轮下来每个搜索词都落了一份整页 DOM，跑完顺手清掉已经没人引用得到的旧快照。
    // 清理失败不影响本轮结果，下次开爬还会再试。
    try {
      const pruned = taskStore.pruneSnapshots()
      if (pruned.deleted) {
        emit('snapshot-prune', pruned)
      }
    } catch (error) {
      emit('snapshot-prune', { ok: false, reason: String(error?.message || error) })
    }
    emit('done', { ...counters, runId, source: resolved.source, queueKind, resumedFrom: resumeInfo?.available ? resumeInfo.runId : null, stopped: stopRequested })
    return { ok: true, ...counters, queueKind, resumedFrom: resumeInfo?.available ? resumeInfo.runId : null, stopped: stopRequested }
  } catch (e) {
    if (runId) taskStore.finishRun(runId, { status: 'failed', reason: e?.message || String(e) })
    const message = e?.response?.status === 401
      ? '服务端登录已失效，请重新登录；如果使用本机 Excel 模式，请先在任务中心导入 Excel。'
      : (e?.response?.data?.detail || e?.message || String(e))
    emit('error', { message })
    return { ok: false, reason: message }
  } finally {
    running = false
    // 上报结果。派发来的那轮服务端在等它收尾；自己起的那轮如果登记上了也要收。
    // 报不上去不影响本轮——结果已经落了本地历史，服务端那条会停在「运行中」，
    // 人看得见，比把跑完的一轮判成失败强。
    if (serverRun) {
      // 三类失败分开报：它们要采取的动作完全不同，只报一个「失败 12 条」
      // 等于让看的人再去那台电脑上翻一遍。风控那个数尤其要单独出来——
      // 它意味着账号正在被盯上，该停手等冷却，而不是重试。
      await closeCrawlRun(serverRun, {
        ok: !stopRequested && counters.fail < counters.total,
        total: counters.total,
        success: counters.success,
        failed: counters.fail,
        empty: counters.empty,
        invalid_price: counters.invalidPrice,
        risk_control: counters.riskControl,
        reason: [stopReason, uploadNote(counters, lastUploadError)].filter(Boolean).join('；') || ''
      })
    }
    await yieldLeaseIfAsked()
  }
}

/**
 * 一轮跑完，看看管理员是不是在等着把行情爬虫转到另一台电脑上。
 *
 * 转移之所以不直接改判、而是留一个让位请求，就是为了等到这里：采集跑到一半被
 * 拔掉，留下的是半批脏数据和一个开着的浏览器。为了少等一轮不值得。
 *
 * 让位失败（网断、服务端不可达）不抛出去：本轮结果已经跑完并落库了，不该因为
 * 交接没办成就把它报成失败。租约会在 TTL 到期后自己释放，对面照样接得到手。
 */
/**
 * 这一轮有多少条没传到 ERP。
 *
 * 一条都没漏就返回空串——正常情况不该在「说明」列里占位置。漏了就必须写出来：
 * 采集本身成功、价也算对了，但 ERP 那边什么都没收到，这种「看着全绿实际空转」
 * 是最难发现的一类故障。
 */
function uploadNote(counters, lastError) {
  const skipped = counters.uploadSkipped || 0
  const failed = counters.uploadFailed || 0
  if (!skipped && !failed) return ''
  const parts = []
  if (skipped) parts.push(`${skipped} 条没上报（拿不到 ERP 登录态）`)
  if (failed) parts.push(`${failed} 条上报失败${lastError ? `：${lastError}` : ''}`)
  return parts.join('，')
}

async function yieldLeaseIfAsked() {
  const target = handoffRequested('market')
  if (!target) return
  try {
    await turnOff('market')
    emit('lease-handoff', { feature: 'market', to: target })
  } catch (error) {
    emit('lease-handoff', { feature: 'market', to: target, ok: false, reason: String(error?.message || error) })
  }
}

export function stop() {
  stopRequested = true
  stopReason = '用户手动停止，已保存当前进度；下次可继续未完成任务'
  for (const wc of activeWebContents) {
    try { wc.stop() } catch {}
  }
  return { ok: true }
}

// ---------- 每日定时 ----------
export function rearmDaily() {
  if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
  // 每分钟检查一次是否到点（简单稳健，避免长 setTimeout 漂移）
  dailyTimer = setInterval(() => {
    const s = taskStore.hasActiveCollection() ? taskStore.getSettings() : getSettings()
    if (running) return
    // 一个账号可以在多台电脑上登录，而行情爬虫**同时只能有一台在跑**——两台一起
    // 跑会去抢同一批 AdsPower 环境、重复采集、重复写库。归属由服务端的租约判。
    if (!holdsLease('market')) return

    // 服务端派来的一轮（管理员在任意一台点了「跑一轮」）。认领要过服务端那两道闸，
    // 认领不到就是租约已经转走——那就别跑。
    const dispatched = pendingCrawlRunId()
    if (dispatched) {
      void takeCrawlRun(dispatched).then((ok) => {
        if (!ok) return
        emit('daily-trigger', { time: '手动派发' })
        start({ trigger: 'schedule', resume: true, resumeIfAvailable: true, serverRunId: dispatched })
      })
      return
    }

    // 11-11 起不看本机「自动开爬」开关（默认关、没人去开，一直只有手动在采）：
    // 持有租约（上面判过）+ 配了启用的账号，到点就采。账号登没登上留给 start() 去查。
    if (!getAccounts().some((account) => account.enabled)) return
    // 到点开一轮；过了点、今天还没跑过就补一轮（一天只补一次，见 daily-schedule.js）
    const decision = dailyDecision({
      now: new Date(),
      dailyTime: s.dailyTime,
      runs: taskStore.getRuns({ page: 1, pageSize: 50 }).items,
      firedKey: lastDailyTrigger,
      catchUpDay: lastCatchUpDay
    })
    if (!decision) return
    lastCatchUpDay = decision.day   // 到点那轮起不来，也别下一分钟又按「补」再试
    if (decision.kind === 'due') lastDailyTrigger = decision.key
    emit('daily-trigger', { time: decision.kind === 'due' ? (s.dailyTime || '02:00') : '错过补采' })
    start({ trigger: 'schedule', resume: true, resumeIfAvailable: true })
  }, 60 * 1000)
}
