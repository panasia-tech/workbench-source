import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-derived-name-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

const XLSX = await import('xlsx')
const taskStore = await import('../../src/main/task-store.js')

assert.deepEqual(taskStore.derivedNamesForTask({ brand: '云鲸', model: 'J5' }), ['YJCC 020', 'YJCC020'])
assert.deepEqual(taskStore.derivedNamesForTask({ brand: '小米', model: '空气净化器5', category: '空气净化器' }), ['ACM25SC'])
assert.deepEqual(taskStore.derivedNamesForTask({ brand: 'HKC', model: 'G25H4' }), ['Mg25h11Q'])

assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 七代64G' }),
  ['A2737'],
  'Apple TV 七代 64G 只能映射 A2737'
)
assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 七代64G版本' }),
  ['A2737'],
  'Apple TV 七代 64G 版本描述仍只能映射 A2737'
)
assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: '苹果', model: 'Apple TV 七代', spec: '128G带以太网' }),
  ['A2843'],
  'Apple TV 七代 128G 带以太网只能映射 A2843'
)
assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 七代', spec: '128带以太网的版本' }),
  ['A2843'],
  'Apple TV 128 带以太网的版本描述仍映射 A2843'
)
assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 七代', spec: '64G' }),
  ['A2737'],
  'Apple TV 规格字段也必须参与精确映射'
)
assert.deepEqual(
  taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 七代', spec: '128G' }),
  [],
  '没有带以太网标记时不能把 128G 猜成 A2843'
)
assert.deepEqual(taskStore.derivedNamesForTask({ brand: 'Apple', model: 'Apple TV 八代64G' }), [])
assert.deepEqual(taskStore.derivedNamesForTask({ brand: 'HKC', model: 'G27H4' }), [])

const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '名称（兼容型号）', '别称1', '别称2', 'SPU编号', '采购价', '规格', '分类'],
  ['云鲸', 'J5', '云鲸 J5', '', 'SPU-YJ-J5', 1200, '', '扫拖机器人'],
  ['小米', '5', '米家空气净化器5', '', 'SPU-MI-5', 400, '', '空气净化器'],
  ['HKC', 'G25H4', '', '', 'SPU-HKC-G25H4', 1000, '', '显示器'],
  ['Apple', 'Apple TV 七代64G', '', '', 'SPU-APPLE-A2737', 800, '', 'Apple产品'],
  ['Apple', 'Apple TV 七代', '', '', 'SPU-APPLE-A2843', 900, '128G带以太网', 'Apple产品'],
  ['Apple', 'Apple TV 七代', '', '', 'SPU-APPLE-UNKNOWN', 900, '128G', 'Apple产品']
]), '行情任务')

const imported = taskStore.importSpreadsheet(
  XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
  basename('derived-name-fixture.xlsx')
)
assert.equal(imported.ok, true)
assert.equal(imported.rowCount, 6)

const tasks = taskStore.getTasks({ page: 1, pageSize: 20 }).items
const bySpu = (spu) => tasks.find((task) => task.spuCode === spu)

assert.deepEqual(bySpu('SPU-YJ-J5').derivedNames, ['YJCC 020', 'YJCC020'])
assert.deepEqual(bySpu('SPU-YJ-J5').searchKeywords, ['云鲸 J5'])
assert.equal(bySpu('SPU-YJ-J5').model, 'J5')
assert.equal(bySpu('SPU-YJ-J5').spuCode, 'SPU-YJ-J5')

const xiaomi = bySpu('SPU-MI-5')
assert.equal(xiaomi.model, '空气净化器5', '小米空气净化器短型号仍按本地规则规范化')
assert.deepEqual(xiaomi.searchKeywords, ['小米空气净化器5', '米家空气净化器5'])
assert.equal(xiaomi.spuCode, 'SPU-MI-5')

assert.deepEqual(bySpu('SPU-HKC-G25H4').searchKeywords, ['G25H4', 'HKC G25H4'])
assert.deepEqual(bySpu('SPU-HKC-G25H4').derivedNames, ['Mg25h11Q'])
assert.equal(bySpu('SPU-HKC-G25H4').searchKeywords.includes('Mg25h11Q'), false, 'derived name is evidence-only')
assert.deepEqual(bySpu('SPU-APPLE-A2737').searchKeywords, ['Apple TV 七代64G'])
assert.deepEqual(bySpu('SPU-APPLE-A2843').searchKeywords, ['Apple TV 七代'])
assert.equal(bySpu('SPU-APPLE-UNKNOWN').derivedNames.length, 0)
assert.equal(bySpu('SPU-APPLE-UNKNOWN').searchKeywords.includes('A2843'), false)

// Internal model enrichments are search-only and must never become the WMS
// canonical identity or replace the user-supplied SPU.
for (const task of tasks) {
  assert.equal(task.model.includes('A2737') || task.model.includes('A2843'), false)
  assert.equal(task.spuCode.startsWith('SPU-'), true)
}

console.log('derived name regression: passed (exact mappings, variants, import and canonical identity)')
