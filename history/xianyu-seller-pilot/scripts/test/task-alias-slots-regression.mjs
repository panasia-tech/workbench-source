import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-alias-slots-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

const XLSX = await import('xlsx')
const taskStore = await import('../../src/main/task-store.js')
const { searchQueriesForTask } = await import('../../src/main/search-queries.js')

assert.equal(
  taskStore.cleanApiSpuAlias('PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台'),
  '27M2N5500P'
)
assert.equal(taskStore.cleanApiSpuAlias('飞利浦 EVNIA 显示器 1台'), '')

const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价', '分类'],
  ['飞利浦', '27M2N55', '', 'SPU-DIFFERENT', 1200, '显示器'],
  ['KTC', '27GS820', '', 'SPU-SAME', 500, '显示器'],
  ['AOC', '24G10ZF', '24G10ZFE', 'SPU-MANUAL', 500, '显示器']
]), '行情任务')

const result = taskStore.importSpreadsheet(
  XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
  'alias-slots.xlsx'
)
assert.equal(result.ok, true)

taskStore.replaceWmsCache([{
  sku_code: 'UK02438064399',
  spu_code: 'SPU-DIFFERENT',
  brand: '飞利浦',
  model: '27M2N55',
  product_name: 'SPU：PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台',
  status: 'IN_STOCK'
}, {
  sku_code: 'K71724310308',
  spu_code: 'SPU-SAME',
  brand: 'KTC',
  model: '27GS820',
  product_name: '27GS820 KTC 1台',
  status: 'IN_STOCK'
}, {
  sku_code: '690000000003',
  spu_code: 'SPU-MANUAL',
  brand: 'AOC',
  model: '24G10ZF',
  product_name: 'AOC 电竞显示器 #24G10ZNE 经典版',
  status: 'IN_STOCK'
}], '2026-08-24T10:00:00.000Z')

const rows = taskStore.getTasks({ page: 1, pageSize: 10 }).items
assert.deepEqual(rows.map((row) => row.searchKeywords), [
  ['27M2N55', '飞利浦 27M2N55'],
  ['27GS820', 'KTC 27GS820'],
  ['24G10ZF', 'AOC 24G10ZF', '24G10ZFE']
])
assert.ok(rows.every((row) => row.searchKeywords.length <= 12), '每个 SKU 的实际搜索词必须受 12 项上限保护')
assert.deepEqual(rows.map((row) => searchQueriesForTask(row)), rows.map((row) => row.searchKeywords))
assert.equal(rows[0].searchDerivedNames, false)
assert.equal(rows[0].effectiveAlias, '')
assert.equal(rows[0].aliasSource, '')
assert.equal(rows[0].apiSpuAlias, null)
assert.deepEqual(rows[0].searchFieldLabels, ['名称（兼容型号）', '名称（兼容型号）'])
assert.equal(rows[1].apiSpuProductName, '27GS820 KTC 1台')
assert.equal(rows[1].apiSpuAlias, null)
assert.equal(rows[1].apiSpuAliasUsed, false)
assert.equal(rows[1].effectiveAlias, '')
assert.equal(rows[1].aliasSource, '')
assert.match(rows[1].apiSpuAliasReason, /仅展示 API 原文/)
assert.deepEqual(rows[1].searchFieldLabels, ['名称（兼容型号）', '名称（兼容型号）'])
assert.equal(rows[2].effectiveAlias, '24G10ZFE')
assert.equal(rows[2].aliasSource, 'manual')
assert.equal(rows[2].apiSpuAliasUsed, false)
assert.match(rows[2].apiSpuAliasReason, /仅展示 API 原文/)
assert.equal(rows[0].searchKeywords.includes(rows[0].apiSpuProductName || ''), false, 'API 商品名不得进入搜索关键词')

const aliasSave = taskStore.setTaskAliases(rows[0].id, ['手动别称1', '手动别称2', '手动别称3'])
assert.equal(aliasSave.ok, true)
assert.deepEqual(aliasSave.aliases, ['手动别称1'])
const aliasedTask = taskStore.getActiveTask(rows[0].id)
assert.deepEqual(aliasedTask.aliases, ['手动别称1'])
assert.ok(aliasedTask.searchKeywords.includes('手动别称1'), '人工别称必须进入任务的 canonical searchKeywords')
assert.deepEqual(searchQueriesForTask(aliasedTask), aliasedTask.searchKeywords, '预览 query 数量必须与实际执行 query 数量一致')

const legacyDerivedWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(legacyDerivedWorkbook, XLSX.utils.aoa_to_sheet([
  ['清洗品牌', '清洗型号', '清洗别称', 'SPU编号', '采购价'],
  ['云鲸', 'J5', '云鲸 J5 Pro', 'SPU-NARWAL-MANUAL', 900],
  ['云鲸', 'J5', '', 'SPU-NARWAL-DERIVED', 900]
]), '清洗汇总')
taskStore.importSpreadsheet(
  XLSX.write(legacyDerivedWorkbook, { type: 'buffer', bookType: 'xlsx' }),
  'legacy-derived.xlsx'
)
const legacyDerivedRows = taskStore.getTasks({ page: 1, pageSize: 10 }).items
assert.deepEqual(legacyDerivedRows[0].searchKeywords, ['云鲸 J5', '云鲸 J5 Pro'], '人工旧别称必须阻止全部衍生/SPU 扩搜')
assert.equal(legacyDerivedRows[0].effectiveAlias, '云鲸 J5 Pro')
assert.equal(legacyDerivedRows[0].aliasSource, 'manual')
assert.deepEqual(legacyDerivedRows[0].derivedNames, ['YJCC 020', 'YJCC020'], '未采用的衍生候选仍保留为证据')
assert.deepEqual(legacyDerivedRows[1].searchKeywords, ['云鲸 J5'], '无人工或有效 API SPU 别称时只保留基础搜索')
assert.equal(legacyDerivedRows[1].effectiveAlias, '')
assert.equal(legacyDerivedRows[1].aliasSource, '')
assert.deepEqual(legacyDerivedRows[1].derivedNames, ['YJCC 020', 'YJCC020'], '代码衍生值只保留为证据')

const clearReplaceWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(clearReplaceWorkbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '名称（兼容型号）', '别称1', '别称2', 'SPU编号', '采购价'],
  ['AOC', '24G2', '24G2X', '24G2Y', 'SPU-CLEAR-REPLACE', 500]
]), '行情任务')
taskStore.importSpreadsheet(
  XLSX.write(clearReplaceWorkbook, { type: 'buffer', bookType: 'xlsx' }),
  'legacy-clear-replace.xlsx'
)
let editedAliasTask = taskStore.getTasks({ page: 1, pageSize: 10 }).items[0]
assert.deepEqual(editedAliasTask.searchKeywords, ['AOC 24G2', '24G2X'])

const cleared = taskStore.setTaskAliases(editedAliasTask.id, [])
assert.equal(cleared.ok, true)
editedAliasTask = taskStore.getActiveTask(editedAliasTask.id)
assert.deepEqual(editedAliasTask.aliases, [])
assert.equal(editedAliasTask.effectiveAlias, '')
assert.deepEqual(editedAliasTask.searchKeywords, ['AOC 24G2'], '显式清空后旧 alias1/alias2 不得复活')

const replaced = taskStore.setTaskAliases(editedAliasTask.id, ['AOC 24G2', '24G2U'])
assert.equal(replaced.ok, true)
assert.deepEqual(replaced.aliases, ['24G2U'], '必须先过滤与主型号等价的值，再选择第一个有效别称')
editedAliasTask = taskStore.getActiveTask(editedAliasTask.id)
assert.equal(editedAliasTask.effectiveAlias, '24G2U')
assert.deepEqual(editedAliasTask.searchKeywords, ['AOC 24G2', '24G2U'])

console.log('task alias slots regression: passed (manual alias only; API product name remains evidence-only)')
