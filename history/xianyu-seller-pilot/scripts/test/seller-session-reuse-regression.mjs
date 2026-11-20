import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this.session = {} // Electron Session shape: deliberately no getPartition().
    this.destroyed = false
  }
  isDestroyed() { return this.destroyed }
  setUserAgent() {}
  loadURL() { return Promise.resolve() }
  close() { this.destroyed = true; this.emit('destroyed') }
}

class FakeWebContentsView {
  static created = []
  constructor(options) {
    this.options = options
    this.webContents = new FakeWebContents()
    FakeWebContentsView.created.push(this)
  }
  setVisible() {}
  setBounds() {}
}

globalThis.__sellerSessionRegression = {
  WebContentsView: FakeWebContentsView,
  installSearchCapture() {}
}

const file = new URL('../../src/main/session-manager.js', import.meta.url)
const source = readFileSync(file, 'utf8')
  .replace("import { WebContentsView } from 'electron'", 'const { WebContentsView } = globalThis.__sellerSessionRegression')
  .replace("import { installSearchCapture } from './search-capture.js'", 'const { installSearchCapture } = globalThis.__sellerSessionRegression')
const manager = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`)

const account = { id: 'account-a', name: '账号 A', partition: 'persist:account-a' }
const worker1 = manager.getWebContents(account)
const worker2 = manager.getWebContents({ ...account })
const preview1 = manager.getPreviewWebContents(account)
const preview2 = manager.getPreviewWebContents({ ...account })
assert.equal(worker1, worker2, 'keyword worker is reused without Session.getPartition()')
assert.equal(preview1, preview2, 'preview is reused without Session.getPartition()')
assert.equal(FakeWebContentsView.created.length, 2, 'one worker and one preview are created')

const replaced = manager.getWebContents({ ...account, partition: 'persist:account-a-replaced' })
assert.notEqual(replaced, worker1, 'partition changes still recycle the worker')
assert.equal(worker1.isDestroyed(), true)
assert.equal(FakeWebContentsView.created.length, 3)

const closeCalls = []
globalThis.__xianyuAdsPower = {
  closeAdsPowerWebContents(accountId, purpose) {
    return new Promise((resolve) => setTimeout(() => {
      closeCalls.push(`${accountId}:${purpose}`)
      resolve()
    }, 10))
  },
  closeAllAdsPowerWebContents() { return Promise.resolve() }
}
let destroySettled = false
const destroyPromise = manager.destroyView(account.id).then(() => { destroySettled = true })
await new Promise((resolve) => setImmediate(resolve))
assert.equal(destroySettled, false, 'account deletion waits for all AdsPower purpose closes')
await destroyPromise
assert.deepEqual(closeCalls.sort(), ['account-a:preview', 'account-a:seller', 'account-a:worker'])

await manager.destroyAll()
delete globalThis.__xianyuAdsPower
delete globalThis.__sellerSessionRegression
console.log('seller session reuse regression: passed (real Electron Session API shape)')
