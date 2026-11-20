import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'xianyu-task-template-'))
process.env.XIAN_YU_TASK_STORE_DIR = userData

const XLSX = await import('xlsx')
const taskStore = await import('../../src/main/task-store.js')

const schema = taskStore.getTaskTemplateSchema()
assert.equal(schema.templateFileName, '巡航台任务清单_sample.xlsx')
assert.equal(schema.templateSheetName, '行情任务')
assert.deepEqual(schema.templateRequiredColumns, ['品牌', '名称（兼容型号）'])
assert.deepEqual(schema.templateColumns, ['品牌', '名称（兼容型号）', '别称（可能由SPU读取内容生成）', 'SPU编号', '采购价'])
assert.ok(schema.templateRecommendedColumns.includes('SPU编号'))
assert.deepEqual(schema.templatePreviewRequiredColumns, ['采购价'])
assert.equal(schema.templateColumnDescriptions['采购价'].includes('120%'), true)

const templatePath = taskStore.getTaskTemplatePath()
assert.equal(existsSync(templatePath), true, '代码仓库必须带有可导入的 xlsx sample')
const templateWorkbook = XLSX.read(readFileSync(templatePath), { type: 'buffer', cellDates: false })
assert.deepEqual(templateWorkbook.SheetNames, ['行情任务', 'API字段示例'])
const templateRows = XLSX.utils.sheet_to_json(templateWorkbook.Sheets['行情任务'], { header: 1, raw: false, defval: '' })
assert.deepEqual(templateRows[0], schema.templateColumns, 'xlsx 表头必须与 task-store 字段契约一致')
assert.equal(templateRows.length, 4)
const apiExampleRows = XLSX.utils.sheet_to_json(templateWorkbook.Sheets['API字段示例'], { header: 1, raw: false, defval: '' })
assert.ok(apiExampleRows.some((row) => row.includes('API商品名原文（中国商品信息网）')), 'sample 必须单独说明 API 商品名原文')
assert.ok(apiExampleRows.some((row) => row.includes('SPU：PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台')), 'sample 必须包含真实清洗示例')

const builtinSample = taskStore.getSample()
assert.equal(builtinSample.isBuiltin, true)
assert.equal(builtinSample.rowCount, 3)
assert.equal(templateRows[1][2], '', '输入页别称为空，交由 SPU 证据页补位')
assert.equal(builtinSample.rows[0].effectiveAlias, '', 'API 商品名不应自动变成任务搜索别称')
assert.equal(builtinSample.rows[0].aliasSource, '')
assert.equal(builtinSample.rows[0].spuCode, templateRows[1][3])
assert.equal(builtinSample.rows[0].referencePrice, 1200)
assert.equal(builtinSample.rows[0].apiSkuCode, 'UK02438064399')
assert.equal(builtinSample.rows[0].apiSpuCode, '90001')
assert.equal(builtinSample.rows[0].apiSpuProductName, 'SPU：PHILIPS EVNIA T #27M2N5500P PHILIPS飞利浦 1台')
assert.equal(builtinSample.rows[0].apiSpuCleanedAlias, null)
assert.equal(builtinSample.rows[0].apiSpuAliasUsed, false)

const imported = taskStore.importSpreadsheet(readFileSync(templatePath), basename(templatePath))
assert.equal(imported.ok, true)
assert.equal(imported.rowCount, 3)
const tasks = taskStore.getTasks({ page: 1, pageSize: 10 }).items
assert.equal(tasks.length, 3)
assert.equal(tasks[0].spuCode, '90001')
assert.equal(tasks[0].model, '27M2N55')
assert.equal(tasks[0].referencePrice, 1200)
assert.equal(tasks[0].referencePriceStatus, 'valid')
assert.equal(tasks[0].effectiveAlias, '')
assert.deepEqual(tasks[0].searchKeywords, ['飞利浦 27M2N55'], 'API 示例页不是任务输入，导入时不得冒充 API 数据或搜索词')

const aliasWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(aliasWorkbook, XLSX.utils.aoa_to_sheet([
  ['品牌', '型号/名称', '别名1', '别名2', 'SPU', '采购价'],
  ['AOC', '24G2', '24G2U', 'AOC 24G2', 'SPU-ALIAS-001', 500]
]), '任务')
taskStore.importSpreadsheet(XLSX.write(aliasWorkbook, { type: 'buffer', bookType: 'xlsx' }), 'legacy-alias.xlsx')
const aliasTask = taskStore.getTasks({ page: 1, pageSize: 10 }).items[0]
assert.deepEqual(aliasTask.searchKeywords, ['AOC 24G2', '24G2U'], '旧别名1/别名2 必须可读，但只取第一个有效别称')
assert.equal(aliasTask.effectiveAlias, '24G2U')
assert.equal(aliasTask.alias1, '24G2U')
assert.equal(aliasTask.alias2, 'AOC 24G2')
assert.equal(aliasTask.spuCode, 'SPU-ALIAS-001')

const sample = taskStore.getSample()
assert.equal(sample.isBuiltin, false)
assert.deepEqual(sample.templateColumns, schema.templateColumns)
assert.deepEqual(sample.templateRequiredColumns, ['品牌', '名称（兼容型号）'])
assert.deepEqual(sample.templatePreviewRequiredColumns, ['采购价'])
assert.ok(sample.templateNotes.some((note) => note.includes('SPU')))

const copiedPath = join(userData, '巡航台任务清单_copy.xlsx')
const copied = taskStore.copyTaskTemplate(copiedPath)
assert.equal(copied.ok, true)
assert.equal(copied.path, copiedPath)
assert.deepEqual(readFileSync(copiedPath), readFileSync(templatePath), '下载出的模板必须与仓库中的 sample 完全一致')
assert.throws(() => taskStore.copyTaskTemplate(join(userData, 'bad-template.csv')), /\.xlsx/)

const malformedWorkbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(malformedWorkbook, XLSX.utils.aoa_to_sheet([
  ['名称', '价格'],
  ['没有任务字段', 100]
]), '随便一张表')
assert.throws(
  () => taskStore.importSpreadsheet(XLSX.write(malformedWorkbook, { type: 'buffer', bookType: 'xlsx' }), 'bad.xlsx'),
  /下载台模板|下载卖家工作台模板|至少需要“品牌 \/ 名称（兼容型号）”/
)

console.log('task template regression: passed (schema, xlsx asset, import, copy and guidance)')
