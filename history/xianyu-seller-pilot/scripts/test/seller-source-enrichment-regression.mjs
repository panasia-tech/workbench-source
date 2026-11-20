import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import XLSXPkg from 'xlsx'
import { buildMetadataIndex, enrichRows } from '../release/enrich-seller-source-metadata.mjs'

const XLSX = XLSXPkg.default || XLSXPkg
const dataDir = mkdtempSync(join(tmpdir(), 'seller-source-enrichment-'))
const workbookPath = join(dataDir, 'delivery.xlsx')

try {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['主页链接', '类目', '城市', '榜单', '排名', '卖家名称', '主营内容', '主营类型'],
    ['https://www.goofish.com/personal?userId=enrich-001', '显示器', '全国', '热门榜', 3, '显示器店', '显示器回收', '数码'],
    ['https://www.goofish.com/personal?userId=enrich-001', '显示器', '全国', '服务榜', 22, '显示器店', '显示器回收', '数码'],
    ['https://www.goofish.com/personal?userId=enrich-002', '云鲸', '上海', '热门榜', 8, '云鲸店', '扫地机回收', '家电']
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, '主页链接')
  XLSX.writeFile(workbook, workbookPath)

  const { index } = buildMetadataIndex(workbookPath)
  assert.equal(index.size, 2)
  const result = enrichRows([
    { sellerId: 'enrich-001', sellerName: '已有名称' },
    { sellerId: 'enrich-002' },
    { sellerId: 'not-in-workbook' }
  ], index)
  assert.equal(result.matched, 2)
  assert.equal(result.enriched, 2)
  const first = result.rows[0]
  assert.equal(first.sellerName, '已有名称')
  assert.equal(first.category, '显示器')
  assert.equal(first.board, '热门榜、服务榜')
  assert.equal(first.sourceRank, 3)
  assert.match(first.sourceBoardRanks, /热门榜 TOP3/)
  assert.match(first.sourceBoardRanks, /服务榜 TOP22/)
  assert.equal(result.rows[2].category, undefined)
  console.log('seller source enrichment regression: PASS')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
