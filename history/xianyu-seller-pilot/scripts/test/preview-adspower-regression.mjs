import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const read = (relative) => readFileSync(resolve(root, relative), 'utf8')

const preview = read('src/renderer/src/views/Preview.vue')
const accounts = read('src/renderer/src/views/Accounts.vue')
const consoleView = read('src/renderer/src/views/Console.vue')
const router = read('src/renderer/src/router.js')
const preload = read('src/preload/index.js')
const main = read('src/main/index.js')

assert.match(preview, /openAdsPowerProfile/)
assert.doesNotMatch(preview, /attachPreview|setPreviewBounds|detachPreview|previewGotoHome|previewReload|WebContentsView|ResizeObserver/)
assert.match(accounts, /window\.erp\.openAdsPowerProfile\(row\.id\)/)
assert.doesNotMatch(accounts, /router\.push\(\{ path: '\/preview'/)
assert.doesNotMatch(consoleView, /index="\/preview"|闲鱼预览/)
assert.match(router, /path: 'preview', redirect: '\/accounts'/)
assert.match(preload, /openAdsPowerProfile: \(accountId\) => ipcRenderer\.invoke\('adspower:open-preview'/)
assert.doesNotMatch(preload, /attachPreview:|setPreviewBounds:|detachPreview:|previewGotoHome:|previewReload:/)

const previewHandlers = main.match(/\/\/ ---- 预览（已禁用） ----[\s\S]*?\/\/ ---- 窗口 ----/)?.[0] || ''
assert.ok(previewHandlers, 'disabled preview IPC handlers must remain explicit for stale renderers')
assert.doesNotMatch(previewHandlers, /sm\.attach|sm\.setBounds|sm\.detach|sm\.getPreviewWebContents|gotoHome/)
assert.match(previewHandlers, /Electron 内置预览已禁用/)

console.log(JSON.stringify({ ok: true, checks: 11, mode: 'source-contract' }))
