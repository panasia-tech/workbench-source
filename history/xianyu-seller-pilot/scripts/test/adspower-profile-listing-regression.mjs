// listAdsPowerProfiles is what the renderer receives over the
// `adspower:profiles` IPC channel.
//
// On a paid subscription /api/v1/user/list answers with each environment's
// full record, and that record embeds `user_proxy_config` carrying a plaintext
// proxy username and password.  Those must never leave the main process, so
// the mapping is an allowlist and this regression pins it: the fixture below
// is the real response shape, secrets included.
import assert from 'node:assert/strict'
import { AdsPowerApi, mapProfileListing } from '../../src/main/adspower.js'

const PAID_LIST = {
  code: 0,
  msg: 'success',
  data: {
    page: 1,
    page_size: 100,
    list: [
      {
        user_id: 'env-running',
        name: '环境甲',
        remark: '',
        group_name: '销售',
        serial_number: '5',
        ip: '183.141.172.65',
        ip_country: 'cn',
        password: 'DEMO_ONLY_REDACTED',
        username: 'account-username',
        user_proxy_config: {
          proxy_soft: 'other',
          proxy_type: 'socks5',
          proxy_host: 's3023.example.invalid',
          proxy_port: '9347',
          proxy_user: 'proxy-user-secret',
          proxy_password: 'DEMO_ONLY_REDACTED'
        }
      },
      {
        user_id: 'env-idle',
        name: '',
        remark: '备注甲',
        group_name: '行情',
        serial_number: '4',
        user_proxy_config: { proxy_user: 'another-secret', proxy_password: 'DEMO_ONLY_REDACTED' }
      }
    ]
  }
}

const ACTIVE = {
  code: 0,
  msg: 'success',
  data: { list: [{ user_id: 'env-running', debug_port: '53979', ws: { puppeteer: 'ws://127.0.0.1:53979/devtools/browser/x' } }] }
}

function respond(body) {
  return new Response(JSON.stringify(body), { status: 200 })
}

// --- paid tier: every environment is listed, running state merged in --------
const requested = []
globalThis.__adsPowerFetch = async (url) => {
  requested.push(String(url))
  if (String(url).includes('/api/v1/user/list')) return respond(PAID_LIST)
  if (String(url).includes('/api/v1/browser/local-active')) return respond(ACTIVE)
  throw new Error(`unexpected fetch ${url}`)
}

// listAdsPowerProfiles uses the module singleton, so exercise the same mapping
// through a locally constructed client plus the exported helper's contract.
const api = new AdsPowerApi({ baseUrl: 'http://fake', fetchImpl: globalThis.__adsPowerFetch, minIntervalMs: 0 })
const listed = await api.listProfiles(1, 100)
const running = await api.ports()

assert.equal(listed?.list?.length, 2, 'paid listing returns every environment')
assert.equal(listed?.paidOnly, undefined, 'a successful paid listing is not flagged as paid-only')
assert.deepEqual(running, [{ id: 'env-running', port: 53979, ws: 'ws://127.0.0.1:53979/devtools/browser/x' }],
  'local-active is normalised to {id, port, ws}')

// --- the allowlist the renderer actually receives ---------------------------
// mapProfileListing is the shipped mapping, not a copy of it: these assertions
// fail if someone spreads the raw profile into the result.
const mapped = mapProfileListing(listed, running)

assert.deepEqual(mapped, [
  { id: 'env-running', name: '环境甲', remark: '', seq: '5', status: 'Active', running: true, group: '销售' },
  { id: 'env-idle', name: '备注甲', remark: '备注甲', seq: '4', status: '', running: false, group: '行情' }
], 'profiles are mapped to the binding UI shape with running state and group merged')

// --- 环境归属：同机还有 adspower-executor 在驱动 AdsPower --------------------
// 归属边界用 AdsPower 分组划。这里钉死三条语义：
//   1. 设了分组 → 只认领该分组；
//   2. 没有分组的环境 → 谁也不碰（opt-in，漏分组只是不纳管，不会被错误一方接管）；
//   3. 没设分组 → 不过滤（还没建分组时的过渡默认）。
const WITH_LOOSE = {
  ...listed,
  list: [...listed.list, { user_id: 'env-loose', name: '没分组', group_name: '', serial_number: '9' }]
}
const ids = (group) => mapProfileListing(WITH_LOOSE, running, group).map((p) => p.id)

assert.deepEqual(ids('销售'), ['env-running'], 'a configured group claims only that group')
assert.deepEqual(ids('行情'), ['env-idle'], 'the other side claims a disjoint set')
for (const group of ['销售', '行情']) {
  assert.equal(ids(group).includes('env-loose'), false,
    `an ungrouped environment must not be claimed by ${group}`)
}
assert.deepEqual(ids(''), ['env-running', 'env-idle', 'env-loose'], 'no configured group means no filtering')
assert.deepEqual(ids('不存在的分组'), [], 'an unknown group claims nothing rather than falling back to all')

const serialised = JSON.stringify(mapped)
for (const secret of ['proxy-user-secret', 'proxy-password-secret', 'another-secret', 'account-password-secret', 'account-username', 's3023.example.invalid', '183.141.172.65']) {
  assert.equal(serialised.includes(secret), false, `profile listing must not forward ${secret}`)
}
assert.equal(/proxy/i.test(serialised), false, 'no proxy field of any kind reaches the renderer')

// --- free tier: user/list refuses, running environments stand in ------------
globalThis.__adsPowerFetch = async (url) => {
  if (String(url).includes('/api/v1/user/list')) {
    return respond({ code: -1, msg: 'This feature is only available in paid subscriptions.' })
  }
  if (String(url).includes('/api/v1/browser/local-active')) return respond(ACTIVE)
  throw new Error(`unexpected fetch ${url}`)
}
const freeApi = new AdsPowerApi({ baseUrl: 'http://fake', fetchImpl: (url) => globalThis.__adsPowerFetch(url), minIntervalMs: 0 })
const freeListed = await freeApi.listProfiles(1, 100)
assert.deepEqual(freeListed, { list: [], paidOnly: true }, 'a paid-only refusal degrades instead of throwing')

// A non-subscription failure must still surface.
const brokenApi = new AdsPowerApi({
  baseUrl: 'http://fake',
  fetchImpl: async () => respond({ code: -1, msg: 'user_id is required' }),
  minIntervalMs: 0
})
await assert.rejects(() => brokenApi.listProfiles(1, 100), /user_id is required/,
  'only the paid-subscription refusal is swallowed')

console.log('adspower-profile-listing-regression: PASS')
