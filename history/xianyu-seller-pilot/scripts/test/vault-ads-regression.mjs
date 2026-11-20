// 密码库填进 AdsPower：Node 端解密要和服务端（Python）同一套算法；写完必须读回来核对。
// 夹具 fixtures/vault-ads-box.json 是服务端 seal_for 用一把测试专用私钥加密出来的。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aadFor, fingerprint, newKeyPair, openBox, privDerFromRaw, processItem, publicKeyOf } from '../../src/main/vault-ads-core.js'

const fx = JSON.parse(readFileSync(new URL('./fixtures/vault-ads-box.json', import.meta.url), 'utf8'))
const privDer = privDerFromRaw(Buffer.from(fx.priv_raw_b64, 'base64'))
let n = 0
async function t(name, fn) { await fn(); n += 1; console.log('ok', name) }

await t('公钥、指纹和服务端算的一样', () => {
  assert.equal(publicKeyOf(privDer), fx.pub_b64)
  assert.equal(fingerprint(fx.pub_b64), fx.fingerprint)
})

await t('解得开服务端加密的包', () => {
  const plain = JSON.parse(openBox(privDer, fx.item.box, aadFor('item-1', 'pc-1')).toString('utf8'))
  assert.deepEqual(plain, fx.payload)
})

await t('换电脑 id、换条目、换私钥、改一个字节都解不开', () => {
  assert.throws(() => openBox(privDer, fx.item.box, aadFor('item-1', 'pc-2')))
  assert.throws(() => openBox(privDer, fx.item.box, aadFor('item-2', 'pc-1')))
  assert.throws(() => openBox(newKeyPair().privDer, fx.item.box, aadFor('item-1', 'pc-1')))
  const ct = Buffer.from(fx.item.box.ct, 'base64'); ct[0] ^= 1
  assert.throws(() => openBox(privDer, { ...fx.item.box, ct: ct.toString('base64') }, aadFor('item-1', 'pc-1')))
})

const base = { privDer, stationId: 'pc-1' }

await t('写进去读回来一致 → verified，写的字段名是 AdsPower v1 的', async () => {
  let wrote
  const r = await processItem(fx.item, { ...base, write: async (b) => { wrote = b }, read: async () => ({ username: 'tb_测试', password: 'DEMO_ONLY_REDACTED' }) })
  assert.deepEqual(wrote, { user_id: 'kabc123', username: 'tb_测试', password: 'DEMO_ONLY_REDACTED', fakey: 'JBSWY3DPEHPK3PXP', domain_name: 'goofish.com' })
  assert.deepEqual(r, { ack: 'ack-xyz', ok: true, verified: true, error: null })
})

await t('返回成功但读回来没变（假成功）→ 不算填好', async () => {
  const r = await processItem(fx.item, { ...base, write: async () => {}, read: async () => ({ username: '旧的', password: 'DEMO_ONLY_REDACTED' }) })
  assert.equal(r.ok, true); assert.equal(r.verified, false); assert.match(r.error, /username/)
})

await t('读不回登录名和密码 → 没核对成', async () => {
  const r = await processItem(fx.item, { ...base, write: async () => {}, read: async () => ({ name: 'x' }) })
  assert.equal(r.verified, false); assert.match(r.error, /没法核对/)
})

await t('写失败、环境找不到都如实报', async () => {
  const a = await processItem(fx.item, { ...base, write: async () => { throw new Error('code -1 too many') }, read: async () => null })
  assert.equal(a.ok, false); assert.match(a.error, /too many/)
  const b = await processItem(fx.item, { ...base, write: async () => {}, read: async () => null })
  assert.equal(b.verified, false); assert.match(b.error, /找不到/)
})

await t('包里的环境和外面说的不一样 → 不写', async () => {
  let wrote = false
  const r = await processItem({ ...fx.item, ads_user_id: 'kother' }, { ...base, write: async () => { wrote = true }, read: async () => ({}) })
  assert.equal(wrote, false); assert.equal(r.ok, false)
})

console.log(`vault-ads: ${n} passed`)
