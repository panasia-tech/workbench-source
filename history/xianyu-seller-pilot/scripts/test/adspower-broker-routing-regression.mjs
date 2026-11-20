// 桌面端经本机 AdsPower 代理的路由与降级。
//
// 代理（adspower-executor 的 manage.py broker）是全机唯一一条通往 AdsPower
// Local API 的路：它做全局节流，并按用途登记表强制环境归属。桌面端默认走它。
//
// 这里钉死两条，二者很容易顾此失彼：
//   1. 代理连不上 → 自动降级直连 AdsPower 本体。引入代理不能引入新的单点故障。
//   2. 代理返回的 403 归属拒绝 → **不降级**。那是正确判决，绕过去直连就等于
//      把归属保护作废，正是这套机制要防的事。
import assert from 'node:assert/strict'
import { AdsPowerApi } from '../../src/main/adspower.js'

const BROKER = 'http://127.0.0.1:50326'
const DIRECT = 'http://127.0.0.1:50325'

function ok(body) {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data: body }), { status: 200 })
}
function refuse() {
  const error = new Error('fetch failed')
  error.cause = { code: 'ECONNREFUSED' }
  return error
}

// --- 默认走代理，并声明身份 --------------------------------------------------
{
  const seen = []
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), owner: init?.headers?.['X-Ads-Owner'] })
      return ok({ list: [] })
    }
  })
  assert.equal(api.baseUrl, BROKER, '默认 baseUrl 必须是本机代理')
  await api.listProfiles(1, 10)
  assert.ok(seen[0].url.startsWith(BROKER), `请求应发往代理，实际 ${seen[0].url}`)
  assert.equal(seen[0].owner, 'desktop', '必须声明身份，否则代理会拒绝写操作')
}

// --- 代理连不上 → 降级直连，且只降一次 ---------------------------------------
{
  const hosts = []
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      const href = String(url)
      hosts.push(new URL(href).origin)
      if (href.startsWith(BROKER)) throw refuse()
      return ok({ list: [{ user_id: 'a', name: 'A', group_name: '销售', serial_number: '1' }] })
    }
  })
  const first = await api.listProfiles(1, 10)
  assert.equal(first.list.length, 1, '降级后必须照常拿到数据')
  assert.equal(api.baseUrl, DIRECT, '降级后 baseUrl 应切到直连')
  assert.deepEqual(hosts, [BROKER, DIRECT], '首次应先试代理再直连')

  hosts.length = 0
  await api.listProfiles(1, 10)
  assert.deepEqual(hosts, [DIRECT], '已降级后不应再反复试代理')
}

// --- 代理的 403 归属拒绝：不降级，如实报错 -----------------------------------
{
  const hosts = []
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      hosts.push(new URL(String(url)).origin)
      return new Response(JSON.stringify({
        code: -1,
        msg: '归属校验失败：环境 mkt-1 属于分组「行情」，归 executor 驱动，但请求方自称 desktop'
      }), { status: 403 })
    }
  })
  await assert.rejects(() => api.listProfiles(1, 10), /归属校验失败/,
    '归属拒绝必须如实上抛')
  assert.equal(api.baseUrl, BROKER, '403 不是连接失败，绝不能触发降级')
  assert.deepEqual(hosts, [BROKER], '不应绕过代理重试')
}

// --- 代理独有的接口（/broker/*）：代理不在就明说，绝不降级去打本体 -------------
// 本体没有这些路径，降级发过去只会拿回 404「Not Found」——界面上就剩这三个词，
// 执行端控制也就分不出「代理不在」该改走本机直控。
{
  const hosts = []
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      const href = String(url)
      hosts.push(new URL(href).origin)
      if (href.startsWith(BROKER)) throw refuse()
      if (href.includes('/broker/')) return new Response('Not Found', { status: 404 })
      return ok({ list: [] })
    }
  })
  await assert.rejects(() => api.startExecutor('k1'),
    (error) => error.code === 'BROKER_DOWN' && /本机代理没在跑/.test(error.message))
  assert.deepEqual(hosts, [BROKER], '代理独有的接口不能降级去打 AdsPower 本体')
  assert.equal(api.baseUrl, DIRECT, '其余请求照常降级直连')

  hosts.length = 0
  await assert.rejects(() => api.listExecutors(), (error) => error.code === 'BROKER_DOWN')
  assert.deepEqual(hosts, [], '已知代理不在，就别再白发一次')
  await api.listProfiles(1, 10)
  assert.deepEqual(hosts, [DIRECT])
}

// --- 非连接类错误也不降级 -----------------------------------------------------
{
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ code: -1, msg: 'user_id is required' }), { status: 200 })
  })
  await assert.rejects(() => api.listProfiles(1, 10).then(() => api.ports()), /user_id is required/)
  assert.equal(api.baseUrl, BROKER)
}

console.log('adspower-broker-routing-regression: PASS')
