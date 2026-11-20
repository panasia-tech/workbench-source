import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-ai-migration-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

const storePath = join(userData, 'xianyu-task-center.json')
const legacyTask = {
  id: 'legacy-asus', name: '华硕 G259CMS', brand: '华硕', model: 'G259CMS',
  size: '24.5寸', spec: '1K 180HZ', keyword: '华硕 G259CMS', category: '显示器',
  enabled: true, referencePrice: 800, sourceRow: 2, spuCode: 'SPU-LEGACY', spu_code: 'SPU-LEGACY'
}
writeFileSync(storePath, JSON.stringify({
  activeCollectionId: 'legacy-collection',
  collections: [{ id: 'legacy-collection', name: 'legacy', tasks: [legacyTask], rowCount: 1 }],
  settings: { blacklistKeywords: ['全局配件'] }, runs: [], runResults: [], lastImport: null,
  // The startup migration must canonicalize the ledger key and strip unknown
  // fields before a task DTO is ever returned.
  spuSearchPolicies: {
    ' spu-g24 ': {
      search: { mode: 'explicit', queries: ['小米 G24 显示器'] },
      blacklist: { mode: 'replace', terms: ['滤芯'] },
      priceFence: { minListingPrice: 500 },
      localization: { displayName: '小米 G24 显示器' },
      token: 'must-not-persist'
    }
  },
  apiTaskOverrides: {
    'SPU-14600K': {
      searchPolicy: { search: { mode: 'explicit', queries: ['14600K'] } }
    }
  }
}, null, 2))

const taskStore = await import('../../src/main/task-store.js')
const migratedG24 = taskStore.getSpuSearchPolicy('SPU-G24')
assert.equal(migratedG24.canonicalSpu, 'SPU-G24')
assert.deepEqual(migratedG24.search.queries, ['小米 G24 显示器'])
assert.equal(migratedG24.token, undefined)
assert.deepEqual(migratedG24.priceFence, { minListingPrice: 500, maxListingPrice: null })
const migratedIntel = taskStore.getSpuSearchPolicy('spu-14600k')
assert.deepEqual(migratedIntel.search.queries, ['14600K'], 'legacy nested API policy must move to canonical SPU ledger')

const migration = taskStore.migrateAiPipeline()
assert.equal(migration.ok, true)
assert.equal(migration.migrated, 1)
assert.equal(migration.pending, 1)

const migrated = taskStore.getActiveTask('legacy-asus')
assert.equal(migrated.aiNormalizationStatus, 'pending')
assert.equal(migrated.aiCorrectionStatus, 'not_needed')
assert.equal(migrated.aiCorrectionAttempts, 0)
assert.equal(migrated.aiReviewStatus, 'none')
assert.equal(migrated.aiWebSearchStatus, 'not_requested')
assert.deepEqual(migrated.effectiveBlacklist, { mode: 'inherit', terms: ['全局配件'] }, 'old task without policy still inherits global blacklist')
assert.equal(taskStore.getAiNormalizationTasks({ force: true }).length, 1)
const migratedPersisted = JSON.parse(readFileSync(storePath, 'utf8'))
assert.equal(migratedPersisted.collections[0].tasks[0].model, 'G259CMS')
assert.equal(migratedPersisted.collections[0].tasks[0].aiNormalizationSource, 'legacy-migration')
taskStore.applyTaskPatches([{ id: 'legacy-asus', aiNormalizationStatus: 'pending', aiNormalizationSource: 'local-rule' }])
assert.equal(taskStore.getAiNormalizationTasks({ force: false }).length, 0)
const searched = taskStore.applyAiWebSearch('legacy-asus', {
  ok: true,
  query: '华硕 VG259CMS 显示器 官方型号 规格',
  results: [{ title: '官方规格', content: 'VG259CMS', link: 'https://example.invalid/spec', media: 'example', publish_date: '2026-08-23' }]
})
assert.equal(searched.ok, true)
assert.equal(taskStore.getActiveTask('legacy-asus').aiReviewStatus, 'needs_review')
const blockedReviewQueue = taskStore.getTaskQueues({ kind: 'ai_review', page: 1, pageSize: 10 })
assert.equal(blockedReviewQueue.total, 0, '没有成功 API 快照时旧 Excel 任务不得进入可执行复核队列')
assert.equal(blockedReviewQueue.sourceState.ready, false)
assert.ok(blockedReviewQueue.blockedReason)
assert.equal(taskStore.approveAiReview('legacy-asus').ok, true)
assert.equal(taskStore.getActiveTask('legacy-asus').aiReviewStatus, 'approved')

const persisted = JSON.parse(readFileSync(storePath, 'utf8'))
assert.equal(persisted.collections[0].tasks[0].model, 'G259CMS')
assert.equal(taskStore.getAiEvents({ limit: 1 })[0].type, 'ai-pipeline-migration')
assert.ok(persisted.spuSearchPolicies['SPU-G24'])
assert.equal(persisted.spuSearchPolicies['SPU-G24'].token, undefined, 'secrets/unknown policy fields must not enter durable DTO')

const saved = taskStore.setSpuSearchPolicy(' spu-g24 ', {
  search: { mode: 'explicit', queries: ['小米 G24', '小米 G24 显示器'] },
  blacklist: { mode: 'append', terms: ['支架'] },
  pageFilter: { enabled: true, password: 'DEMO_ONLY_REDACTED' }
}, { source: 'regression', changedBy: 'test-operator' })
assert.equal(saved.ok, true)
assert.equal(saved.canonicalSpu, 'SPU-G24')
assert.equal(saved.policy.pageFilter.password, undefined)
assert.equal(taskStore.getSpuSearchPolicy('SPU-G24').audit.changedBy, 'test-operator')

taskStore.setSpuSearchPolicy('SPU-LEGACY', {
  search: { mode: 'explicit', queries: ['VG259CMS'] },
  blacklist: { mode: 'append', terms: ['显示器支架'] },
  priceFence: { minListingPrice: 500 },
  localization: { displayName: '华硕电竞显示器' }
})
const policyDecorated = taskStore.getActiveTask('legacy-asus')
assert.deepEqual(policyDecorated.searchKeywords, ['VG259CMS'])
assert.deepEqual(policyDecorated.effectiveSearchPolicy, { mode: 'explicit', queries: ['VG259CMS'], source: 'spu' })
assert.deepEqual(policyDecorated.effectiveBlacklist, { mode: 'append', terms: ['全局配件', '显示器支架'] })
assert.deepEqual(policyDecorated.effectivePriceFence, { minListingPrice: 500, maxListingPrice: null })
assert.equal(policyDecorated.localizedDisplayName, '华硕电竞显示器')

console.log('task migration regression: passed (legacy tasks auto-enter AI normalization; SPU policies migrate canonically)')
