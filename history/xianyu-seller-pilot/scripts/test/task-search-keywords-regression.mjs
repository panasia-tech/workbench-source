import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-search-keywords-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

// A collection saved by the pre-row-keyword build has no searchKeywords.
// Reading it through the task store must still produce one natural query,
// otherwise old queues would silently keep the legacy two-query fallback.
writeFileSync(join(userData, 'xianyu-task-center.json'), JSON.stringify({
  activeCollectionId: 'legacy-collection',
  collections: [{
    id: 'legacy-collection',
    name: '旧清单',
    tasks: [
      { id: 'legacy-purifier', name: '小米 5', brand: '小米', model: '5', category: '空气净化器', keyword: '5', enabled: true },
      {
        id: 'legacy-multiple', name: '云鲸 J5', brand: '云鲸', model: 'J5', category: '显示器', keyword: 'J5', enabled: true,
        searchAliasMode: 'legacy', searchKeywords: ['J5', '云鲸 J5', 'YJCC020', 'YJCC 020']
      }
    ]
  }],
  runs: [],
  runResults: [],
  settings: {},
  wmsSkus: []
}))

const XLSX = await import('xlsx')
const taskStore = await import('../../src/main/task-store.js')
const legacyRow = taskStore.getTasks({ page: 1, pageSize: 10 }).items[0]
assert.equal(legacyRow.name, '小米空气净化器5')
assert.equal(legacyRow.model, '空气净化器5')
assert.deepEqual(legacyRow.searchKeywords, ['小米空气净化器5'])
const legacyMultiple = taskStore.getTasks({ page: 1, pageSize: 10 }).items.find((row) => row.id === 'legacy-multiple')
assert.deepEqual(legacyMultiple.searchKeywords, ['J5', '云鲸 J5'], '旧持久化任务按当前显示器基础查询策略归一化')
const workbook = XLSX.utils.book_new()
const sheet = XLSX.utils.aoa_to_sheet([
  ['品牌', '型号', '型号2', '产品代码', '关键词3', '分类', '采购价', 'SPU'],
  ['HKC', 'MG25H11Q', 'G25H4', 'MG25H11Q', 'HKC MG25H11Q 屏幕', '显示器', 1000, 'SPU-001'],
  ['云鲸', 'J5', 'YJCC020', '云鲸 J5', 'YJCC020 云鲸', '扫拖机器人', 1200, 'SPU-002'],
  ['小米', '5', '', '', '', '空气净化器', 400, 'SPU-003']
])
XLSX.utils.book_append_sheet(workbook, sheet, '任务')
const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })

const imported = taskStore.importSpreadsheet(buffer, 'search-keywords.xlsx')
assert.equal(imported.ok, true)
const rows = taskStore.getTasks({ page: 1, pageSize: 10 }).items
assert.equal(rows.length, 3)
assert.equal(rows[0].spuCode, 'SPU-001', '任务清单 SPU 应进入标准任务字段')
assert.equal(rows[1].spu_code, 'SPU-002', '任务清单 SPU 应保留 snake_case 兼容字段')
assert.deepEqual(rows[0].searchKeywords, ['MG25H11Q', 'G25H4', 'HKC MG25H11Q 屏幕'])
assert.deepEqual(rows[0].searchFieldLabels, ['名称（兼容型号）', 'Excel 显式搜索字段', 'Excel 显式搜索字段'])
assert.deepEqual(rows[1].searchKeywords, ['J5', 'YJCC020', '云鲸 J5', 'YJCC020 云鲸'])
assert.deepEqual(rows[1].searchFieldLabels, ['名称（兼容型号）', 'Excel 显式搜索字段', 'Excel 显式搜索字段', 'Excel 显式搜索字段'])
assert.deepEqual(rows[2].searchKeywords, ['小米空气净化器5'])
assert.equal(rows[2].name, '小米空气净化器5')
assert.equal(rows[2].model, '空气净化器5')
assert.deepEqual(rows[2].searchFieldLabels, ['整词搜索 · 空气净化器'])

const { searchQueriesForTask } = await import('../../src/main/search-queries.js')
assert.deepEqual(searchQueriesForTask(rows[0]), rows[0].searchKeywords)
assert.deepEqual(searchQueriesForTask(rows[1]), rows[1].searchKeywords)
assert.deepEqual(searchQueriesForTask(rows[2]), ['小米空气净化器5'])

const explicitAliasPatch = taskStore.applyTaskPatches([{ id: rows[0].id, aliases: ['MG25H11Q 电竞别称'] }])
assert.equal(explicitAliasPatch.ok, true)
const explicitAliased = taskStore.getActiveTask(rows[0].id)
assert.ok(explicitAliased.searchKeywords.includes('MG25H11Q 电竞别称'), '显式搜索字段任务的人工别称也必须进入 canonical searchKeywords')
assert.deepEqual(searchQueriesForTask(explicitAliased), explicitAliased.searchKeywords, '显式搜索字段预览与执行数量不可漂移')
assert.equal(explicitAliased.searchFieldLabels.at(-1), '别称（人工填写）', '显式任务中的人工别称必须使用别称标签')

const compatibleWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(compatibleWorkbook, XLSX.utils.aoa_to_sheet([
  ['清洗品牌', '清洗型号', '清洗型号2', '清洗型号3', '清洗关键词2', '清洗别名3', '清洗商品名', '清洗类型', '建议价均值'],
  ['飞利浦', '3000系列', '3000 Series', '32M', 'Philips 3000', '飞利浦 32寸', '飞利浦 3000系列', '显示器', 620]
]), '清洗汇总')
const compatibleImport = taskStore.importSpreadsheet(XLSX.write(compatibleWorkbook, { type: 'buffer', bookType: 'xlsx' }), 'cleaned-inventory.xlsx')
assert.equal(compatibleImport.ok, true)
assert.equal(compatibleImport.sheetName, '清洗汇总')
const cleanedRow = taskStore.getTasks({ page: 1, pageSize: 10 }).items[0]
assert.equal(cleanedRow.name, '飞利浦 3000系列')
assert.deepEqual(cleanedRow.searchKeywords, ['3000系列', '3000 Series', '32M', 'Philips 3000', '飞利浦 32寸'])
assert.deepEqual(cleanedRow.searchFieldLabels, ['名称（兼容型号）', 'Excel 显式搜索字段', 'Excel 显式搜索字段', 'Excel 显式搜索字段', 'Excel 显式搜索字段'])

console.log('task search keywords regression: passed (row fields control exact search count)')
