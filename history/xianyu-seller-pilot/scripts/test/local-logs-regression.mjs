// 本地日志：轮转保留 30 天、打包前打码、回传待办不重复传。
//
// 三条是这功能的要害：
//   1. **打码**——日志要离开这台机器，桌面端手上有 ERP 令牌和代理凭据；
//   2. **保留期**——只留 30 天，否则跑几个月就是一个没人敢打开的目录；
//   3. **不重复传**——上传要几十秒，期间服务端仍把它算作待办，不记就会传好几遍。
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'gc-logs-'))
process.env.GC_DESKTOP_LOG_DIR = dir
const logs = await import('../../src/main/local-logs.js')

// --- 1. 打码：明文凭据一个字都不许进包 ---------------------------------------
writeFileSync(path.join(dir, 'desktop-today.log'),
  'login ok token=abcdefghij\npassword: s3cret-value\nproxy_user: someone')
const text = gunzipSync(logs.collectLogs(7)).toString()
for (const secret of ['abcdefghij', 's3cret-value']) {
  assert.ok(!text.includes(secret), `明文凭据 ${secret} 混进日志包了`)
}
assert.match(text, /<redacted:\d+>/, '打码要留长度，排障时还能看出"有没有配"')
assert.match(text, /desktop-today\.log/, '包里要能看出每段来自哪个文件')

// --- 2. 保留期：过期的删、没过期的留 ------------------------------------------
const old = path.join(dir, 'desktop-old.log')
writeFileSync(old, 'ancient')
const longAgo = Date.now() / 1000 - 40 * 86400
utimesSync(old, longAgo, longAgo)
const removed = logs.pruneOldLogs()
assert.deepEqual(removed, ['desktop-old.log'], `应只删过期的，实际 ${JSON.stringify(removed)}`)
assert.ok(readdirSync(dir).includes('desktop-today.log'), '今天的日志被误删了')

// 过期文件也不该混进包里
assert.ok(!gunzipSync(logs.collectLogs(1)).toString().includes('ancient'))

// --- 3. 回传：认领一次就不再重复传 --------------------------------------------
{
  const store = { getSettings: () => ({ clientId: 'desktop-test' }), setSettings: () => {} }
  const uploads = []
  const deps = {
    store,
    gcGet: async () => ({ log_request: { id: 'req-1', days: 7 } }),
    gcUpload: async (id, blob, name) => { uploads.push({ id, bytes: blob.length, name }) }
  }
  assert.equal((await logs.checkAndUploadLogs(deps)).uploaded, 'req-1')
  const second = await logs.checkAndUploadLogs(deps)
  assert.ok(second.idle, '同一个待办不该传第二遍')
  assert.equal(uploads.length, 1)
  assert.match(uploads[0].name, /\.log\.gz$/)
}

// 传失败要放回去，下一轮还能重来
{
  const store = { getSettings: () => ({ clientId: 'desktop-test-2' }), setSettings: () => {} }
  let attempts = 0
  const deps = {
    store,
    gcGet: async () => ({ log_request: { id: 'req-2', days: 3 } }),
    gcUpload: async () => { attempts += 1; throw new Error('网络断了') }
  }
  assert.equal((await logs.checkAndUploadLogs(deps)).ok, false)
  await logs.checkAndUploadLogs(deps)
  assert.equal(attempts, 2, '失败的待办要留着下一轮重试，而不是被当成已完成')
}

// 服务端不可达时不许炸，也不许把待办当成已处理
{
  const store = { getSettings: () => ({ clientId: 'd3' }), setSettings: () => {} }
  const r = await logs.checkAndUploadLogs({ store, gcGet: async () => { throw new Error('down') } })
  assert.equal(r.ok, false)
}

console.log('local-logs: PASS')
