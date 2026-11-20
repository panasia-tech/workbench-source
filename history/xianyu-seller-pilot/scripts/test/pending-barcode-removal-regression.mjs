import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const renderer = read('src/renderer/src/views/Wms.vue')
const preload = read('src/preload/index.js')
const main = read('src/main/index.js')
const wms = read('src/main/wms.js')
const taskStore = read('src/main/task-store.js')
const packageJson = read('package.json')

assert.doesNotMatch(renderer, /待补 69 码|BARCODE REPAIR|回写并查 SPU|getWmsBarcodeQueue|updateWmsBarcode/)
assert.doesNotMatch(preload, /getWmsBarcodeQueue|updateWmsBarcode|wms:barcode-queue|wms:update-barcode/)
assert.doesNotMatch(main, /wms:barcode-queue|wms:update-barcode|getWmsBarcodeQueue|updateWmsBarcode/)
assert.doesNotMatch(wms, /wms-barcode|getWmsBarcodeQueue|updateWmsBarcode|appendWmsBarcodeAudit/)
assert.doesNotMatch(taskStore, /wmsBarcodeAudits|appendWmsBarcodeAudit|getWmsBarcodeAudits/)
assert.doesNotMatch(packageJson, /test:wms-barcode|wms-barcode-regression/)

console.log('Pending barcode removal regression: passed (UI, IPC, preload, WMS service, audit store, test command)')
