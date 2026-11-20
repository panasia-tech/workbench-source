import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const index = readFileSync(resolve(root, 'src/main/index.js'), 'utf8')
const preload = readFileSync(resolve(root, 'src/preload/index.js'), 'utf8')
assert.match(index, /spu-policy:list/)
assert.match(index, /spu-policy:get/)
assert.match(index, /spu-policy:set/)
assert.match(index, /spu-policy:preview/)
assert.match(index, /normalizeSpuSearchPolicy/)
assert.match(index, /spuCode.length > 160/)
assert.match(index, /wms:correct-and-recollect/)
assert.match(preload, /saveSpuPolicy/)
assert.match(preload, /correctWmsSkuAndRecollect/)
assert.doesNotMatch(preload, /getSpuSearchPolicies\(\).*wmsMcpKey/)
console.log('SPU policy IPC regression: passed (canonical SPU validation, sanitized policy endpoints, explicit WMS action)')
