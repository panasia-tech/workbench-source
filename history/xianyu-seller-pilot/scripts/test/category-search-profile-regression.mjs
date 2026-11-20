import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-category-search-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

const XLSX = await import('xlsx')
const taskStore = await import('../../src/main/task-store.js')
const { searchQueriesForTask } = await import('../../src/main/search-queries.js')
const categorySearch = await import('../../src/shared/category-search.js')

assert.deepEqual(categorySearch.CATEGORY_SEARCH_QUERY_LIMITS, { primary: 2, alias: 1, total: 3 })
assert.deepEqual(categorySearch.normalizeCategorySearchInput(null), { brand: '', model: '', category: '' })
assert.deepEqual(categorySearch.normalizeCategorySearchInput({ brand: ['小米'], model: 5, category: ' 空气净化器 ' }), {
  brand: '',
  model: '5',
  category: '空气净化器'
})
assert.equal(categorySearch.buildCategorySearchQuery(null), '')
assert.deepEqual(categorySearch.normalizeCategorySearchModes(), {
  显示器: 'split',
  空气净化器: 'combined',
  音响: 'combined',
  脱毛仪: 'combined',
  Apple产品: 'combined',
  '默认/其它': 'combined'
})
assert.equal(categorySearch.categorySearchProfile('显示器').mode, 'split')
assert.equal(categorySearch.categorySearchProfile('Apple产品').composition, 'model')
assert.equal(categorySearch.categorySearchProfile('显示器').modeExamples.split, '主搜索：27GS820')
assert.equal(categorySearch.categorySearchModeLabel('COMBINED'), '整词搜索')
assert.equal(categorySearch.categorySearchModeExample(categorySearch.categorySearchProfile('显示器'), 'combined'), '主搜索：KTC 27GS820')
assert.deepEqual(categorySearch.categorySearchModeSummary({ 显示器: 'combined' }), { split: 0, combined: 6, text: '0 个主型号 · 6 个整词' })
assert.equal(categorySearch.categorySearchProfile('未知分类').category, '默认/其它')
assert.equal(categorySearch.categorySearchProfile('显示 器', { '显示 器': ' COMBINED ' }).mode, 'combined', '带空格的品类键应仍能命中策略')
assert.equal(categorySearch.buildCategorySearchQuery({ brand: '小米', model: '空气 净化器5', category: '空气 净化器' }), '小米空气 净化器5', '固定品类组合不得重复插入已存在的品类词')

const plan = categorySearch.categorySearchQueryPlan({ brand: 'KTC', model: '27GS820', category: '监视器' })
assert.equal(plan.category, '显示器')
assert.equal(plan.primaryQuery, '27GS820')
assert.deepEqual(plan.primaryQueries, ['27GS820', 'KTC 27GS820'])
assert.equal(plan.aliasSource, 'effectiveAlias')
assert.equal(plan.primaryQueryLimit, 2)
assert.equal(plan.aliasQueryLimit, 1)
assert.equal(plan.maxQueryCount, 3)
assert.deepEqual(plan.queries, ['27GS820', 'KTC 27GS820'])

const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '名称（兼容型号）', '别称1', '别称2', 'SPU编号', '采购价', '分类'],
  ['飞利浦', '27M2N5500P', '', '', 'SPU-MONITOR', 1000, '显示器'],
  ['KTC', '27GS820', 'G27P', 'G27Q', 'SPU-MONITOR-ALIAS', 500, '显示器'],
  ['小米', '5', '', '', 'SPU-PURIFIER', 400, '空气净化器'],
  ['Sonos', 'PLAY5', '', '', 'SPU-SPEAKER', 2200, '音响'],
  ['飞利浦', 'Lumea', '', '', 'SPU-IPL', 1500, '脱毛仪'],
  ['Apple', 'HOMEPODMINI', '', '', 'SPU-APPLE', 2000, 'Apple产品'],
  ['佳明', 'Forerunner 265', '', '', 'SPU-GARMIN', 1800, '默认/其它'],
  ['AOC', '24G10ZE', '', '', 'SPU-UNKNOWN', 500, '']
]), '行情任务')

const imported = taskStore.importSpreadsheet(
  XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
  'category-search.xlsx'
)
assert.equal(imported.ok, true)

const rows = taskStore.getTasks({ page: 1, pageSize: 20 }).items
const bySpu = (spu) => rows.find((row) => row.spuCode === spu)
const expected = new Map([
  ['SPU-MONITOR', ['27M2N5500P', '飞利浦 27M2N5500P']],
  ['SPU-MONITOR-ALIAS', ['27GS820', 'KTC 27GS820', 'G27P']],
  ['SPU-PURIFIER', ['小米空气净化器5']],
  ['SPU-SPEAKER', ['SonosPLAY5']],
  ['SPU-IPL', ['飞利浦 Lumea']],
  ['SPU-APPLE', ['HomePod mini']],
  ['SPU-GARMIN', ['佳明 Forerunner 265']],
  ['SPU-UNKNOWN', ['AOC 24G10ZE']]
])
for (const [spu, queries] of expected) {
  assert.deepEqual(bySpu(spu).searchKeywords, queries, `${spu} 基础搜索策略`)
  assert.deepEqual(searchQueriesForTask(bySpu(spu)), queries, `${spu} 搜索执行策略`)
}
assert.ok(rows.filter((row) => !row.effectiveAlias).every((row) => row.searchKeywords.length <= 2), '无唯一别称时基础查询受品类上限保护')
assert.equal(bySpu('SPU-MONITOR-ALIAS').searchKeywords.length, 3, '显示器保留两条基础查询并追加一个唯一别称')

const changed = taskStore.setSettings({ categorySearchModes: { 显示器: 'combined' } })
assert.equal(changed.categorySearchModes.显示器, 'combined')
assert.equal(taskStore.getSettings().categorySearchModes.显示器, 'combined')
const changedMonitor = taskStore.getTasks({ page: 1, pageSize: 20 }).items.find((row) => row.spuCode === 'SPU-MONITOR')
assert.deepEqual(changedMonitor.searchKeywords, ['飞利浦 27M2N5500P'], '显示器整词模式应使用一条品牌+型号搜索')
const changedAliasMonitor = taskStore.getTasks({ page: 1, pageSize: 20 }).items.find((row) => row.spuCode === 'SPU-MONITOR-ALIAS')
assert.deepEqual(changedAliasMonitor.searchKeywords, ['KTC 27GS820', 'G27P'], '整词模式仍只能是一条主搜索加一个唯一别称')
assert.equal(changedAliasMonitor.searchKeywords.length, 2)

// Legacy alias columns may contain more than one value, but the accepted alias
// contract remains one slot. Explicit search columns use a separate contract:
// they take precedence over category defaults and exact duplicate values are
// still de-duplicated instead of becoming repeated searches.
const explicitWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(explicitWorkbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '型号', '型号2', '产品代码', '关键词3', '分类', '采购价', 'SPU'],
  ['KTC', '27GS820', '27GS820', 'G27P', 'KTC 27GS820', '显示器', 500, 'SPU-EXPLICIT']
]), '任务')
const explicitImport = taskStore.importSpreadsheet(
  XLSX.write(explicitWorkbook, { type: 'buffer', bookType: 'xlsx' }),
  'category-search-explicit.xlsx'
)
assert.equal(explicitImport.ok, true)
const explicitRow = taskStore.getTasks({ page: 1, pageSize: 10 }).items[0]
assert.deepEqual(explicitRow.searchKeywords, ['27GS820', 'G27P', 'KTC 27GS820'])
assert.deepEqual(explicitRow.searchFieldLabels, ['名称（兼容型号）', 'Excel 显式搜索字段', 'Excel 显式搜索字段'])
assert.deepEqual(searchQueriesForTask(explicitRow), explicitRow.searchKeywords)

console.log('category search profile regression: passed (two modes, category-only config, import and persistence)')
