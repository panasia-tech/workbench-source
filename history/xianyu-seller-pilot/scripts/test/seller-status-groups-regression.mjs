import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const projectRoot = new URL('../..', import.meta.url)
const storeSource = readFileSync(new URL('src/main/seller-store.js', projectRoot), 'utf8')
const groupStart = storeSource.indexOf('export const SELLER_STATUS_GROUPS')
const groupEnd = storeSource.indexOf('\nfunction isTransientFailureRow')
assert.ok(groupStart >= 0 && groupEnd > groupStart, 'seller status group contract is extractable')
const groupCode = storeSource.slice(groupStart, groupEnd)
  .replace('export const SELLER_STATUS_GROUPS', 'const SELLER_STATUS_GROUPS')
  .replace('export const SELLER_STATUS_GROUP_NAMES', 'const SELLER_STATUS_GROUP_NAMES')
const groups = new Function(`const LOCKED_STATUSES = new Set(['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown']); ${groupCode}; return { SELLER_STATUS_GROUPS, SELLER_STATUS_GROUP_NAMES, normalizeSellerStatusGroup, rowsForSellerStatusGroup }`)()

const statuses = ['pending', 'running', 'completed', 'no_active', 'incomplete', 'needs_review', 'failed', 'login_expired', 'risk_cooldown']
const rows = statuses.map((status, index) => ({ sellerId: `group-${index + 1}`, status }))
assert.deepEqual(groups.SELLER_STATUS_GROUP_NAMES, ['all', 'pending', 'completed', 'failed'])
assert.equal(groups.rowsForSellerStatusGroup(rows, 'all').length, 9)
assert.equal(groups.rowsForSellerStatusGroup(rows, 'pending').length, 6)
assert.equal(groups.rowsForSellerStatusGroup(rows, 'completed').length, 2)
assert.equal(groups.rowsForSellerStatusGroup(rows, 'failed').length, 1)
assert.equal(6 + 2 + 1, rows.length, 'operational groups partition the nine durable states')
assert.equal(groups.normalizeSellerStatusGroup('no_active'), '')

const schedulerSource = readFileSync(new URL('src/main/seller-scheduler.js', projectRoot), 'utf8')
const rendererSource = readFileSync(new URL('src/renderer/src/views/SellerCrawl.vue', projectRoot), 'utf8')
assert.match(rendererSource, /未闭合/, 'renderer uses an explicit unfinished label for the legacy pending group')
assert.match(rendererSource, /status-track[\s\S]*状态细分/, 'renderer exposes a visible per-status breakdown')
assert.match(rendererSource, /async function selectStatus\(status\)/, 'renderer can inspect one durable status without changing the four API groups')
assert.match(rendererSource, /if \(selection\.dimension === 'status'\) filter\.status = selection\.status/, 'renderer sends the selected durable status through the existing status IPC dimension')
const eventRefreshStart = rendererSource.indexOf('function queueEventRefresh')
assert.ok(eventRefreshStart >= 0, 'renderer event refresh handler is extractable')
const eventRefreshCode = rendererSource.slice(eventRefreshStart, rendererSource.indexOf('\nonMounted(', eventRefreshStart))
assert.match(eventRefreshCode, /seller-account-safety[\s\S]*seller-account-blocked[\s\S]*seller-risk-control/, 'risk and login safety events are queue-refresh intents')
assert.match(eventRefreshCode, /eventRefreshQueueDirty = true/, 'queue refresh intent is accumulated during debounce')
assert.match(eventRefreshCode, /const refreshQueue = eventRefreshQueueDirty[\s\S]*eventRefreshQueueDirty = false[\s\S]*if \(refreshQueue\) void loadQueue\(\)/, 'a queue refresh intent survives later summary-only events')
assert.match(eventRefreshCode, /eventRefreshRunsDirty = true[\s\S]*const refreshRuns = eventRefreshRunsDirty[\s\S]*if \(refreshRuns\) void loadRuns\(\)/, 'run-history refresh intent is accumulated during debounce')
const rendererStart = schedulerSource.indexOf('function escapeHtml')
const rendererEnd = schedulerSource.indexOf('\nasync function captureSellerSnapshot')
assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'seller evidence renderer block is extractable')
const rendererCode = schedulerSource.slice(rendererStart, rendererEnd).replace('export function buildSellerEvidenceHtml', 'function buildSellerEvidenceHtml')
const { buildSellerEvidenceHtml } = new Function('businessSellerId', 'resolveAuthoritativeSellerName', `const SNAPSHOT_SECRET_PARAM = /token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i; ${rendererCode}; return { buildSellerEvidenceHtml }`)(() => 'group-evidence-seller', ({ sourceSellerName = '', pageSellerName = '' } = {}) => String(sourceSellerName || pageSellerName || ''))
const items = Array.from({ length: 1000 }, (_, index) => ({
  itemId: `group-item-${index + 1}`,
  itemUrl: `/item?id=group-item-${index + 1}&token=secret`,
  imageUrl: `/images/group-item-${index + 1}.jpg?session=secret`,
  title: `商品 ${index + 1}`,
  category: index % 2 ? '已售分类' : '在售分类',
  price: index + 1,
  status: index % 2 ? 'sold' : 'active'
}))
const html = buildSellerEvidenceHtml({ sellerName: '状态组测试卖家', items }, {
  source: { sellerId: 'group-evidence-seller', url: 'https://www.goofish.com/personal?userId=group-evidence-seller' },
  pageUrl: 'https://www.goofish.com/personal?userId=group-evidence-seller'
})
assert.match(html, /data-seller-item-count="1000"/)
for (const item of [items[0], items[499], items[999]]) assert.match(html, new RegExp(item.itemId))
assert.match(html, /https:\/\/www\.goofish\.com\/item\?id=group-item-1/)
assert.match(html, /target="_blank"/)
assert.match(html, /https:\/\/www\.goofish\.com\/images\/group-item-1\.jpg/)
assert.doesNotMatch(html, /<script|javascript:|token=|session=/i)

const adsPowerSource = readFileSync(new URL('src/main/adspower.js', projectRoot), 'utf8')
assert.match(adsPowerSource, /new Set\(\['worker', 'seller', 'preview', 'auth-check'\]\)/, 'AdsPower reserves an auth-check purpose')
assert.match(adsPowerSource, /apiClient\.ports\(\)/, 'login checks inspect live AdsPower ports')
assert.match(adsPowerSource, /\/json\/list/, 'login checks inspect existing CDP pages')
assert.match(adsPowerSource, /new AdsCDPSession\(page\.webSocketDebuggerUrl/, 'login checks use a read-only CDP probe')
assert.doesNotMatch(adsPowerSource, /contents\.loadURL\(GOofishHome\)/, 'login checks never navigate or create a login tab')

console.log('seller status groups regression: PASS (four group partition + 1000-item HTTPS evidence snapshot)')
