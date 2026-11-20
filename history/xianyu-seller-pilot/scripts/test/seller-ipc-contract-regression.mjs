import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequestGeneration } from '../../src/renderer/src/request-generation.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(testDir, '../..')
const mainSource = readFileSync(join(projectDir, 'src/main/index.js'), 'utf8')
const sessionManagerSource = readFileSync(join(projectDir, 'src/main/session-manager.js'), 'utf8')
const preloadSource = readFileSync(join(projectDir, 'src/preload/index.js'), 'utf8')
const rendererSource = readFileSync(join(projectDir, 'src/renderer/src/views/SellerCrawl.vue'), 'utf8')
const consoleSource = readFileSync(join(projectDir, 'src/renderer/src/views/Console.vue'), 'utf8')
const taskCenterSource = readFileSync(join(projectDir, 'src/renderer/src/views/TaskCenter.vue'), 'utf8')
const sellerRulesPath = join(projectDir, 'src/renderer/src/docs/seller-rules.md')
const installerSource = readFileSync(join(projectDir, 'scripts/release/install-seller-pilot.sh'), 'utf8')
const routerSource = readFileSync(join(projectDir, 'src/renderer/src/router.js'), 'utf8')
const offlineSuitePath = join(projectDir, 'scripts/test/seller-offline-suite.mjs')

const dimensions = ['indexed', 'loaded', 'crawled']
const statuses = ['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown']
const channels = [
  'seller:summary',
  'seller:queues:query',
  'seller:queues:export',
  'seller:queues:export-detail',
  'seller:queue:detail',
  'seller:snapshots:query',
  'seller:snapshot',
  'seller:runs:query',
  'seller:run:get',
  'seller:schedule:get',
  'seller:schedule:set',
  'seller:accounts:status',
  'seller:start',
  'seller:stop'
]

for (const channel of channels) {
  assert.match(mainSource, new RegExp(`ipcMain\\.handle\\(['\"]${channel.replaceAll(':', '\\:')}['\"]`), `main registers fixed ${channel} handler`)
  assert.match(preloadSource, new RegExp(`ipcRenderer\\.invoke\\(['\"]${channel.replaceAll(':', '\\:')}['\"]`), `preload exposes fixed ${channel} method`)
}

assert.match(mainSource, /SELLER_QUEUE_DIMENSIONS[\s\S]*indexed[\s\S]*loaded[\s\S]*crawled[\s\S]*status/, 'main owns the dimension allowlist')
assert.match(mainSource, /SELLER_QUEUE_STATUSES[\s\S]*pending[\s\S]*running[\s\S]*completed[\s\S]*no_active[\s\S]*incomplete[\s\S]*needs_review[\s\S]*failed[\s\S]*login_expired[\s\S]*risk_cooldown/, 'main owns the nine-state allowlist')
assert.match(mainSource, /SELLER_QUEUE_STATUS_GROUPS[\s\S]*all[\s\S]*pending[\s\S]*completed[\s\S]*failed/, 'main owns the four queue status groups')
assert.match(mainSource, /pageSize[^\n]+100/, 'main caps renderer queue pages at 100')
assert.match(mainSource, /showSaveDialog/, 'export destination is selected by Electron main')
assert.doesNotMatch(preloadSource, /sellerQueuesExport[^\n]*(?:path|filePath|outputPath)/i, 'preload export method accepts no renderer path')
assert.match(mainSource, /SELLER_SAMPLE_LIMITS/, 'start samples are fixed in main')
assert.match(mainSource, /SELLER_SAMPLE_LIMITS[^\n]+canary20:\s*20/, 'test sample is capped at 20 in main')
assert.doesNotMatch(mainSource, /observation154|20\/154|\[20,\s*154\]/, 'retired 154 benchmark path is absent')
assert.match(mainSource, /serializeSellerError/, 'main serializes errors through one redacting boundary')
assert.match(preloadSource, /typeof cb !== ['"]function['"][\s\S]*let active = true[\s\S]*removeListener\(['"]seller:event['"]/, 'seller subscription validates callbacks and releases once')
assert.match(mainSource, /reconcileCanonicalSellerManifest\(\)/, 'runtime startup reconciles the packaged canonical seller universe')
assert.match(mainSource, /app\.on\(['"]before-quit['"], \(event\) =>/, 'app shutdown owns an explicit asynchronous cleanup gate')
assert.match(mainSource, /event\.preventDefault\(\)/, 'app shutdown waits before allowing Electron to terminate')
assert.match(mainSource, /Promise\.allSettled\(\[[\s\S]*sm\.destroyAll\(\)[\s\S]*destroySellerWorkers\(\)/, 'app shutdown waits for Electron and seller worker cleanup')
assert.match(sessionManagerSource, /return adsPowerBridge\(\)\?\.closeAllAdsPowerWebContents\(\) \|\| Promise\.resolve\(\)/, 'session manager exposes asynchronous AdsPower cleanup')

const trayStart = mainSource.indexOf('function createTray()')
const trayEnd = mainSource.indexOf('function applyLaunchAtLogin', trayStart)
assert.ok(trayStart >= 0 && trayEnd > trayStart, 'tray menu block is extractable')
const traySource = mainSource.slice(trayStart, trayEnd)
assert.match(traySource, /显示主窗口/, 'tray can reopen the app')
assert.match(traySource, /退出/, 'tray can quit the app')
assert.doesNotMatch(traySource, /scheduler\.(?:start|stop)\(/, 'tray cannot control the Excel queue outside the task center')

const contractStart = mainSource.indexOf('const SELLER_QUEUE_DIMENSIONS')
const contractEnd = mainSource.indexOf('function sellerQueueRowDto')
assert.ok(contractStart >= 0 && contractEnd > contractStart, 'pure IPC validation block is extractable for direct regression')
const contract = new Function(`${mainSource.slice(contractStart, contractEnd)}; return { validateSellerQueueFilter, validateSellerListPaging, validateSellerSettings, serializeSellerError }`)()
assert.deepEqual(contract.validateSellerQueueFilter({ dimension: 'indexed', page: 1, pageSize: 100, q: ' seller ' }), { dimension: 'indexed', status: null, q: 'seller', page: 1, pageSize: 100 })
assert.deepEqual(contract.validateSellerQueueFilter({ dimension: 'status', status: 'pending' }, { paging: false }), { dimension: 'status', status: 'pending', q: '' })
assert.deepEqual(contract.validateSellerQueueFilter({ dimension: 'status', statusGroup: 'pending' }, { paging: false }), { dimension: 'status', status: null, q: '', statusGroup: 'pending' })
for (const payload of [
  {},
  { dimension: 'unknown' },
  { dimension: 'indexed', status: 'pending' },
  { dimension: 'status' },
  { dimension: 'status', status: 'done' },
  { dimension: 'indexed', page: 0 },
  { dimension: 'indexed', pageSize: 101 },
  { dimension: 'indexed', q: {} },
  { dimension: 'indexed', q: 'x'.repeat(129) },
  { dimension: 'indexed', path: '/tmp/private' },
  { dimension: 'indexed', action: 'delete' },
  { dimension: 'indexed', time: '02:00' }
]) assert.throws(() => contract.validateSellerQueueFilter(payload), /dimension|status|page|pageSize|q|unsupported/i)
assert.throws(() => contract.validateSellerQueueFilter({ dimension: 'indexed', page: 1 }, { paging: false }), /unsupported/i, 'export rejects renderer paging and any path-like extension')
assert.deepEqual(contract.validateSellerListPaging({ page: 2, pageSize: 20, q: ' x ', status: 'active' }, ['active', 'sold']), { page: 2, pageSize: 20, q: 'x', status: 'active', sellerId: '', sourceId: '', runId: '', snapshotId: '' })
assert.deepEqual(contract.validateSellerListPaging({ page: 1, statusGroup: 'completed' }, ['pending', 'running', 'completed']), { page: 1, pageSize: 20, q: '', status: null, statusGroup: 'completed', sellerId: '', sourceId: '', runId: '', snapshotId: '' })
assert.throws(() => contract.validateSellerListPaging({ status: 'private' }, ['active', 'sold']), /status/i)
assert.deepEqual(contract.validateSellerSettings({ throttleMinMs: 15000, throttleMaxMs: 30000 }), { throttleMinMs: 15000, throttleMaxMs: 30000 })
for (const badSettings of [{}, { throttleMinMs: 14999, throttleMaxMs: 30000 }, { throttleMinMs: 30000, throttleMaxMs: 20000 }, { throttleMinMs: 15000, throttleMaxMs: 30000, reset: true }]) {
  assert.throws(() => contract.validateSellerSettings(badSettings), /throttle|unsupported/i)
}
assert.deepEqual(contract.serializeSellerError('network failed', 'query'), { code: 'SELLER_REQUEST_FAILED', message: 'network failed', context: 'query' })
assert.equal(contract.serializeSellerError({ message: 'token=secret cookie:private', code: 'BAD_INPUT' }, 'query').message, 'token=[REDACTED] cookie=[REDACTED]')
assert.notEqual(contract.serializeSellerError({}, 'query').message, '[object Object]')

for (const value of [...dimensions, ...statuses]) {
  assert.match(rendererSource, new RegExp(`\\b${value}\\b`), `renderer has a selectable ${value} evidence queue`)
}
assert.match(rendererSource, /继续未完成任务/)
assert.match(rendererSource, /安全停止并保存断点/)
assert.match(rendererSource, /每周一 02:00 自动继续/)
assert.doesNotMatch(rendererSource, /开始新一周|reset\s*:/, 'renderer cannot reset durable seller state')
assert.match(rendererSource, /summaryLoading[\s\S]*queueLoading[\s\S]*historyLoading/, 'loading is scoped to evidence, queue and history regions')
assert.doesNotMatch(rendererSource, /v-loading=["'](?:loading|pageLoading|full)/, 'renderer has no page-level loading overlay')
assert.match(rendererSource, /账号[\s\S]*当前分支[\s\S]*已采 \/ 期望[\s\S]*安全节流[\s\S]*最近持久写入/, 'current run shows the approved operational evidence')
assert.match(rendererSource, /每周一 02:00 自动继续；错过后 24 小时内补跑一次/, 'schedule copy states the fixed default and catch-up window')
assert.match(rendererSource, /主页随机间隔（秒）/, 'renderer labels homepage intervals in seconds')
assert.match(rendererSource, /throttleMinSeconds/, 'renderer stores interval controls as seconds')
assert.match(rendererSource, /throttleMaxSeconds/, 'renderer stores both interval controls as seconds')
assert.match(rendererSource, /:min=["']15["']/, 'renderer cannot configure below the 15-second safety floor')
assert.match(rendererSource, /millisecondsToSeconds/, 'renderer converts the existing millisecond settings contract to seconds on load')
assert.match(rendererSource, /throttleMinMs/, 'renderer reads the existing minimum millisecond field')
assert.match(rendererSource, /secondsToMilliseconds/, 'renderer converts seconds back to the existing millisecond settings contract on save')
assert.match(rendererSource, /throttleMaxMs/, 'renderer writes the existing maximum millisecond field')
assert.match(rendererSource, /setSellerSettings\(\{ throttleMinMs: secondsToMilliseconds\(settings\.throttleMinSeconds\), throttleMaxMs: secondsToMilliseconds\(settings\.throttleMaxSeconds\) \}\)/, 'renderer sends unchanged millisecond API fields')
assert.match(rendererSource, /prefers-reduced-motion/, 'renderer respects reduced motion')
assert.match(rendererSource, /min-height:\s*48px/, 'high-frequency rows retain at least a 44px target')
assert.doesNotMatch(rendererSource, /onBeforeRouteLeave|beforeRouteLeave|onUnmounted\(\(\)\s*=>\s*\{[^}]*stopSellerCrawl/, 'route teardown never stops or restarts main work')
assert.doesNotMatch(rendererSource, /observation154|154 \u4e2a/, 'seller UI offers no 154 benchmark run')
assert.match(rendererSource, /partitionConsistent[\s\S]*\u961f\u5217\u7edf\u8ba1/, 'summary, partition and export consistency is visible and enforced')
assert.match(rendererSource, /queueRequestId/, 'stale queue responses cannot replace the latest selection')
for (const generation of ['summaryRequestId', 'historyRequestId']) {
  assert.match(rendererSource, new RegExp(`${generation}[\\s\\S]*requestId !== ${generation}`), `${generation} rejects stale responses`)
}
assert.match(rendererSource, /settingsRequests\.canApply\(request\)[\s\S]*settingsRequests\.isLatestRequest\(request\)[\s\S]*settingsLoading\.value = false/, 'settings loads separate apply validity from loading ownership')
assert.match(rendererSource, /startSellerCrawl\(/, 'seller page starts only the seller homepage queue')
assert.match(rendererSource, /stopSellerCrawl\(/, 'seller page stops only the seller homepage queue')
assert.doesNotMatch(rendererSource, /(?:startCrawl|stopCrawl|crawlStatus|getTaskResume)\(/, 'seller page cannot control or read the Excel queue')
assert.match(rendererSource, /seller-rules\.md\?raw/, 'seller page uses a dedicated homepage rules entry')
assert.doesNotMatch(rendererSource, /search-rules\.md\?raw/, 'seller page cannot reuse the Excel rules entry')
assert.match(rendererSource, /Excel 行情的开始\/停止与搜索字段配置只在任务中心/, 'seller page makes the queue boundary visible')
assert.match(taskCenterSource, /Excel 字段自动识别/, 'task center exposes automatic row search configuration')
assert.match(taskCenterSource, /每个 SKU 按实际字段生成对应查询；显示器默认拆分为“型号”和“品牌\+型号”两条，明确别称非空时再追加一条/, 'task center explains the row-field search contract')
assert.match(taskCenterSource, /showRules = ref\(false\)/, 'task center owns the Excel rules dialog')
assert.equal(existsSync(sellerRulesPath), true, 'seller page rules are stored as a separate markdown entry')

const settingsGate = createRequestGeneration()
const beforeSave = settingsGate.begin()
settingsGate.mutate()
assert.equal(settingsGate.canApply(beforeSave), false, 'a save start invalidates older settings data')
assert.equal(settingsGate.isLatestRequest(beforeSave), true, 'invalid data response still owns and clears its loading state')
const duringSave = settingsGate.begin()
settingsGate.mutate()
assert.equal(settingsGate.canApply(duringSave), false, 'save completion invalidates a load started while the save was in flight')
assert.equal(settingsGate.isLatestRequest(duringSave), true, 'save completion never strands the latest load spinner')
const afterSave = settingsGate.begin()
assert.equal(settingsGate.canApply(afterSave), true, 'a load started after save completion may apply')
assert.match(rendererSource, /eventRefreshTimer[\s\S]*clearTimeout/, 'high-frequency seller events are coalesced and released')
assert.match(consoleSource, /\u95f2\u9c7c\u5356\u5bb6\u5de1\u822a\u53f0/, 'shell brand matches the product title')
assert.match(consoleSource, /当前功能域/, 'shared shell labels the active domain instead of exposing a queue control')
assert.match(consoleSource, /Excel 行情队列专用/, 'shell explains the Excel queue scope')
assert.match(consoleSource, /卖家主页队列专用/, 'shell explains the seller queue scope')
assert.doesNotMatch(consoleSource, /(?:startCrawl|stopCrawl|crawlStatus|getTaskResume)\(/, 'shared shell cannot control either queue')
assert.doesNotMatch(consoleSource, /ElMessage\.(?:success|error|warning)\(`(?:爬取结束|检测到闲鱼风控)/, 'shared shell does not duplicate Excel completion/risk toasts')
assert.match(installerSource, /KeepAlive:\s*\{\s*SuccessfulExit:\s*false\s*\}/, 'LaunchAgent restarts the app after an abnormal exit')
assert.match(installerSource, /while \/usr\/bin\/pgrep -f[\s\S]*exit 1/, 'LaunchAgent starter stays attached to the app and returns failure after a crash')
assert.match(installerSource, /seller-progress\.jsonl/, 'LaunchAgent watches the durable seller heartbeat file')
assert.match(installerSource, /run_id[\s\S]*HEARTBEAT_STALE[\s\S]*kill -TERM/, 'LaunchAgent restarts a live app whose seller heartbeat is stale and records the run')
assert.match(installerSource, /staleSeconds = 600/, 'watchdog uses a bounded ten-minute stale heartbeat threshold')
assert.match(mainSource, /seller-watchdog-restart/, 'run history includes watchdog recovery events')
assert.match(routerSource, /authenticatedUntil[\s\S]*30_000/, 'menu navigation uses a bounded successful-auth cache')
assert.equal(existsSync(offlineSuitePath), true, 'Task 2 provides one aggregate seller offline suite')

const itemDtoStart = mainSource.indexOf('function sellerQueueRowDto')
const itemDtoEnd = mainSource.indexOf('function sellerSettingsDto')
assert.ok(itemDtoStart >= 0 && itemDtoEnd > itemDtoStart, 'seller item DTO block is extractable')
const itemDto = new Function('SELLER_QUEUE_STATUSES', `${mainSource.slice(itemDtoStart, itemDtoEnd)}; return sellerItemRowDto`)(statuses)
const publicItem = itemDto({
  observationId: 'obs-1',
  itemId: 'item-1',
  itemUrl: 'https://www.goofish.com/item?id=item-1&token=secret&spm=tracking',
  imageUrl: 'https://img.example/a.jpg?w=800&signature=secret&session=secret',
  title: 'item',
  status: 'active',
  cookie: 'never-return'
})
assert.equal(publicItem.itemUrl, 'https://www.goofish.com/item?id=item-1')
assert.equal(publicItem.imageUrl, 'https://img.example/a.jpg?w=800')
assert.doesNotMatch(JSON.stringify(publicItem), /secret|cookie|token|signature|session/)

const tempDir = mkdtempSync(join(tmpdir(), 'seller-ipc-contract-'))
try {
  const dataDir = join(tempDir, 'store')
  const manifestPath = join(tempDir, 'canonical.manifest.json')
  mkdirSync(dataDir, { recursive: true })
  const sellerIds = statuses.map((_, index) => `ipc-${String(index + 1).padStart(2, '0')}`)
  const sha256 = createHash('sha256').update(sellerIds.join('\n')).digest('hex')
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256(sortedSellerIdsJoinedByNewline)',
    generatedAt: '2026-08-22T00:00:00.000Z',
    provenance: { label: 'seller-ipc-contract-regression', sourcePath: 'generated-test-fixture' },
    count: sellerIds.length,
    sha256,
    sellerIds
  }))
  process.env.XIANYU_SELLER_DATA_DIR = dataDir
  process.env.XIANYU_SELLER_CANONICAL_MANIFEST = manifestPath
  const store = await import(`../../src/main/seller-store.js?ipc-contract=${Date.now()}`)
  store.importCanonicalSellerManifest(manifestPath, { expectedCount: sellerIds.length })
  const indexed = store.querySellerMembership({ dimension: 'indexed', pageSize: 100 })
  indexed.items.forEach((row, index) => store.markSource(row.id, {
    status: statuses[index],
    reasonCode: `IPC_${statuses[index].toUpperCase()}`,
    ...(index === 0 ? {
      checkpointHash: 'a'.repeat(64),
      persistedAt: '2026-08-22T01:00:00.000Z',
      itemIds: { active: ['private-item-id'], sold: [] }
    } : {}),
    ...(index === 1 ? {
      attempts: [{
        cycleKey: 'ipc-cycle',
        accountId: 'private-account-id',
        crawlStartedAt: '2026-08-22T01:00:00.000Z',
        crawlFinishedAt: '2026-08-22T01:01:00.000Z',
        crawlResult: 'failed'
      }]
    } : {})
  }))

  const summary = store.getSellerEvidenceSummary()
  assert.equal(summary.indexed, statuses.length)
  assert.equal(Object.values(summary.statuses).reduce((sum, count) => sum + count, 0), summary.indexed)
  assert.equal(summary.groupCounts.all, summary.indexed)
  assert.equal(summary.groupCounts.pending + summary.groupCounts.completed + summary.groupCounts.failed, summary.indexed, 'three operational groups partition indexed sellers')
  for (const [dimension, expected] of [
    ['indexed', summary.indexed],
    ['loaded', summary.loaded],
    ['crawled', summary.crawled],
    ...statuses.map((status) => [`status:${status}`, summary.statuses[status]])
  ]) {
    const [kind, state] = dimension.split(':')
    const filter = kind === 'status' ? { dimension: kind, status: state } : { dimension: kind }
    const membership = []
    for (let page = 1; membership.length < expected; page += 1) {
      const result = store.querySellerMembership({ ...filter, page, pageSize: 1 })
      if (!result.items.length) break
      membership.push(...result.items)
    }
    assert.equal(membership.length, expected, `${dimension} summary equals full paged membership`)
    assert.doesNotMatch(JSON.stringify(membership), /private-item-id|skipItemIds|legacyUnclassifiedItemIds|cookie|token/i, `${dimension} DTO excludes session and private item IDs`)
  }
  for (const [group, statusesInGroup] of Object.entries({
    all: statuses,
    pending: ['pending', 'running', 'incomplete', 'needs_review', 'login_expired', 'risk_cooldown'],
    completed: ['completed', 'no_active'],
    failed: ['failed']
  })) {
    const result = store.querySellerMembership({ dimension: 'status', statusGroup: group, pageSize: 100 })
    assert.equal(result.total, statusesInGroup.length, `status group ${group} filters the expected nine-state subset`)
  }
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  delete process.env.XIANYU_SELLER_CANONICAL_MANIFEST
  rmSync(tempDir, { recursive: true, force: true })
}

console.log(JSON.stringify({ ok: true, suite: 'seller-ipc-contract', selections: 12, statuses: statuses.length }))
