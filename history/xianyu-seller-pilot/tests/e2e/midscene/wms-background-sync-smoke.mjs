import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPriceCandidatePreview, selectPriceCandidate } from '../../../src/main/price-candidate.js'

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const read = (file) => readFileSync(resolve(root, file), 'utf8')
const main = read('src/main/index.js')
const preload = read('src/preload/index.js')
const wms = read('src/renderer/src/views/Wms.vue')
const prices = read('src/renderer/src/views/Prices.vue')
const history = read('src/renderer/src/views/PriceHistory.vue')

// Deterministic fixture contract for the workbench. This intentionally does
// not claim an installed Electron GUI pass; the real artifact gate needs a
// desktop session, configured credentials, and the later installed-app plan.
assert.match(main, /wmsService\.start\(\)/)
assert.match(main, /getWmsSyncService\(\)\.stop\(\)/)
assert.match(main, /ipcMain\.handle\('wms:projection'/)
assert.match(main, /ipcMain\.handle\('market:price-preview'/)
assert.match(main, /ipcMain\.handle\('market:price-select'/)
assert.match(preload, /getWmsProjection/)
assert.match(preload, /onWmsSyncState/)
assert.doesNotMatch(preload, /wmsMcpKey|wmsRestPassword/)
assert.match(wms, /API-SPU 是唯一主键/)
assert.match(wms, /onWmsSyncState/)
assert.match(prices, /key: 'all',[\s\S]*key: 'failed',[\s\S]*key: 'pending',[\s\S]*key: 'success',[\s\S]*key: 'review'/)
assert.match(prices, /价格意图已记录，API 价格未修改/)
assert.match(history, /queryMarketHistory/)

const preview = createPriceCandidatePreview({
  spuCode: 'SPU-FIXTURE-001',
  skuCode: 'SKU-FIXTURE-001',
  costPrice: 100,
  apiCurrentSalePrice: 180,
  apiSuggestPrice: 200,
  marketObservations: [
    { observationId: 'fixture-a', source: 'goofish', price: 220, observedAt: '2026-08-25T08:00:00.000Z' },
    { observationId: 'fixture-b', source: 'goofish', price: 230, observedAt: '2026-08-25T08:05:00.000Z' },
    { observationId: 'fixture-c', source: 'goofish', price: 240, observedAt: '2026-08-25T08:10:00.000Z' }
  ]
}, { now: '2026-08-25T08:30:00.000Z' })
assert.equal(preview.status, 'ready')
assert.equal(preview.facts.apiCurrentSalePrice, 180)
assert.equal(preview.market.sampleCount, 3)
assert.ok(preview.candidates.length >= 2)
const selected = selectPriceCandidate(preview, { choice: preview.candidates[0].key, confirmed: true, operatorId: 'fixture', note: 'fixture review' })
assert.equal(selected.status, 'selected')
assert.equal(selected.selection.previewId, preview.previewId)

console.log(JSON.stringify({
  ok: true,
  mode: 'development-fixture-contract',
  formalInstalledGui: 'BLOCKED',
  reason: '本次仅运行确定性 IPC/UI/价格策略夹具；未启动已安装 Electron 应用或真实上游 API。',
  checks: 20
}))
