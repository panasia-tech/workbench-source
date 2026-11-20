import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import XLSXPkg from 'xlsx'

const XLSX = XLSXPkg.default || XLSXPkg
const dataDir = mkdtempSync(join(tmpdir(), 'seller-source-metadata-'))
process.env.XIANYU_SELLER_DATA_DIR = dataDir
process.env.XIANYU_SELLER_CANONICAL_MANIFEST = join(dataDir, 'missing-manifest.json')

try {
  const store = await import(`../../src/main/seller-store.js?source-metadata=${Date.now()}`)

  const csv = [
    'sellerName,sellerId,mainType,boardName,sourceRank,sourceSlotCount',
    '显示器店A,csv-seller-001,显示器,显示器榜,7,100'
  ].join('\n')
  const csvResult = store.importLinks(csv, 'seller-list.csv')
  assert.equal(csvResult.added, 1)
  const csvRow = store.getAllSourceRows().find((row) => row.sellerId === 'csv-seller-001')
  assert.equal(csvRow.sellerName, '显示器店A')
  assert.equal(csvRow.mainType, '显示器')
  assert.equal(csvRow.boardName, '显示器榜')
  assert.equal(csvRow.sourceRank, 7)
  assert.equal(csvRow.sourceSlotCount, 100)

  const jsonl = [
    JSON.stringify({ sellerId: 'jsonl-seller-001', sellerName: 'JSONL店一', category: '空气净化器', rank: 3 }),
    JSON.stringify({ sellerId: 'jsonl-seller-002', sellerName: 'JSONL店二', category: '云鲸', rank: 4 })
  ].join('\n')
  const jsonlResult = store.importLinks(jsonl, 'seller-list.jsonl')
  assert.equal(jsonlResult.added, 2)
  const jsonlRows = store.getAllSourceRows().filter((row) => row.sellerId.startsWith('jsonl-')).sort((a, b) => a.sellerId.localeCompare(b.sellerId))
  assert.deepEqual(jsonlRows.map((row) => [row.sellerName, row.category, row.rank]), [
    ['JSONL店一', '空气净化器', 3],
    ['JSONL店二', '云鲸', 4]
  ])

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['卖家主页', '卖家名称', '分类', '榜单名称', '来源榜单（最多10条）', '榜单排名', '主营'],
    ['https://www.goofish.com/personal?userId=xlsx-seller-001', 'Excel店', '显示器', '显示器榜', '显示器/全国/热门榜 TOP12；显示器/全国/服务榜 TOP38', 12, '显示器回收'],
    ['xlsx-seller-002', 'Excel店二', '云鲸', '云鲸榜', 2, '扫地机回收']
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, '唯一卖家主页')
  const xlsxResult = store.importSpreadsheet(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'seller-list.xlsx')
  assert.equal(xlsxResult.added, 2)
  const xlsxRow = store.getAllSourceRows().find((row) => row.sellerId === 'xlsx-seller-001')
  assert.equal(xlsxRow.sellerName, 'Excel店')
  assert.equal(xlsxRow.category, '显示器')
  assert.equal(xlsxRow.boardName, '显示器榜')
  assert.equal(xlsxRow.sourceBoardRanks, '显示器/全国/热门榜 TOP12；显示器/全国/服务榜 TOP38')
  assert.equal(xlsxRow.sourceRank, 12)
  assert.equal(xlsxRow.mainContent, '显示器回收')
  assert.equal(xlsxRow.sourceSheet, '唯一卖家主页')
  assert.equal(xlsxRow.excelRow, 2)

  console.log('seller source metadata regression: PASS')
} finally {
  delete process.env.XIANYU_SELLER_DATA_DIR
  delete process.env.XIANYU_SELLER_CANONICAL_MANIFEST
  rmSync(dataDir, { recursive: true, force: true })
}
