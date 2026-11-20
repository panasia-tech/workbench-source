import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), 'src/renderer/src/views/SellerCrawl.vue')
const source = readFileSync(file, 'utf8')
const checks = [
  ['seller-four-primary-groups', ['全部', '未闭合', '已完成', '失败'].every((label) => source.includes(`label: '${label}'`)) && source.includes('groupCards') && source.includes('groupCounts')],
  ['seller-group-filter-contract', source.includes('dimension: selection.dimension') && source.includes('filter.group = selection.group') && source.includes('selectQueue(group)')],
  ['seller-group-partition-copy', source.includes('未闭合（原 pending 组）包含运行中、部分采集、需复核、登录失效和风控冷却') && source.includes('已完成包含已完成和无在售') && source.includes('partitionConsistent')],
  ['seller-account-parallel-progress', source.includes('runAccountStats') && source.includes('账号并行进度') && source.includes('seller-counters')],
  ['seller-account-safety-visibility', source.includes('runInactiveAccounts') && source.includes('accountState(account)') && source.includes('coolingUntil')],
  ['seller-nine-state-breakdown', source.includes('status-track') && source.includes('statusCards') && source.includes('async function selectStatus(status)') && source.includes('statusLabel(row.status')],
  ['seller-detail-entry', source.includes('openSellerDetail(row)') && source.includes('卖家采集详情')],
  ['seller-items-table', source.includes('detailItems') && source.includes('商品明细') && source.includes('商品 ID') && source.includes('row.status || row.branch') && source.includes('row.capturedAt || row.observedAt')],
  ['seller-item-links', source.includes('class="item-link"') && source.includes('class="item-source-link"') && source.includes('target="_blank"') && source.includes('safeGoofishUrl(itemUrl(row))')],
  ['seller-item-category', source.includes('label="分类"') && source.includes('itemCategoryLabel(row)') && source.includes("|| '未分类'" )],
  ['seller-source-category-context', source.includes('categoryLabel(row)') && source.includes('主类型来源') && source.includes('主内容来源')],
  ['seller-detail-envelope', source.includes("result?.detail || (result?.seller ? result : result || row)") && source.includes('expectedActive: source.expectedActive ?? expected.active')],
  ['seller-detail-source-id', source.includes('sourceId: row.id || row.sourceId || null')],
  ['seller-evidence-tab', source.includes('正式尝试与页面边界') && source.includes('prettyEvidence(detailData)')],
  ['seller-snapshot-preview', source.includes('openSnapshot(row)') && source.includes('完整商品证据快照') && source.includes('包含本次已采商品') && source.includes('scrolling="yes"') && source.includes('sandbox="allow-same-origin allow-popups"')],
  ['seller-summary-export', source.includes("exportQueue('summary')") && source.includes('导出队列概览')],
  ['seller-detail-export', source.includes("exportQueue('detail')") && source.includes('导出详细 Excel')],
  ['run-structured-detail', source.includes('runDetailVisible') && source.includes('运行历史 · 结构化证据')],
  ['seller-page-no-keyword-controls', !source.includes('startTaskQueue') && !source.includes('searchKeywords')]
]

let failed = 0
for (const [id, ok] of checks) {
  if (ok) console.log(`PASS ${id}`)
  else { failed += 1; console.error(`FAIL ${id}`) }
}
if (failed) process.exitCode = 1
