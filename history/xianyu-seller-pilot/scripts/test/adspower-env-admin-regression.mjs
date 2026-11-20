// 浏览器环境管理（新建 / 改用途 / 删除 / 清单）。
//
// 这一层是给「浏览器环境」页用的，规矩照搬 adspower-executor 的 manage.py——
// 那边每一条都是拿事故换来的。这里逐条钉死：
//   1. 用途必填，且必须在登记表里 —— 打错一个字就建出谁也不认领的孤儿环境；
//   2. 新建走 user/create 且**带 group_id**，环境出生即有归属；
//   3. 改用途走 user/regroup，**绝不能**用 user/update（它返回 code=0 "Success"
//      而 group_id 原封不动，是静默失败）；
//   4. 写完一律**读回校验**，不信接口返回码；
//   5. 清单是白名单 —— 原始记录里带明文 proxy_user / proxy_password，
//      只许折成一个布尔 hasProxy 出去。
//   6. 用途登记表来自本机代理（唯一事实来源），代理没起时降级并如实标记。
import assert from 'node:assert/strict'
import {
  AdsPowerApi,
  createEnv,
  listEnvPurposes,
  listExecutors,
  removeEnvPurpose,
  saveEnvPurpose,
  deleteEnvs,
  fetchEnvPurposes,
  listEnvs,
  mapEnvListing,
  setEnvPurpose,
  startExecutorFor,
  stopExecutorFor
} from '../../src/main/adspower.js'

const PURPOSES = { 行情: 'executor', 采购: 'executor', 销售: 'desktop', 未分配: 'none' }

function ok(body) {
  return new Response(JSON.stringify({ code: 0, msg: 'success', data: body }), { status: 200 })
}

/** 一个够用的假 AdsPower：分组、环境、运行中列表都在内存里，写操作真的改状态。 */
function fakeAds({ envs = [], groups = [{ group_id: 'g1', group_name: '行情' }], brokerUp = true } = {}) {
  const calls = []
  const state = { envs: envs.map((e) => ({ ...e })), groups: groups.map((g) => ({ ...g })), nextId: 100 }
  const api = new AdsPowerApi({
    minIntervalMs: 0,
    fetchImpl: async (url, init) => {
      const target = new URL(String(url))
      const body = init?.body ? JSON.parse(init.body) : null
      const method = init?.method || 'GET'
      calls.push({ path: target.pathname, body, method })
      switch (target.pathname) {
        case '/broker/health':
          if (!brokerUp) return new Response('not found', { status: 404 })
          return ok({ broker: 'ads-broker', purposes: PURPOSES })
        case '/broker/executor':
          return ok({ executors: [
            { user_id: 'u1', browser: '运行中', executor: '运行中 (pid=123)' },
            { user_id: 'u2', browser: '未启动', executor: '已停止' }
          ] })
        case '/broker/executor/stop':
          return ok({ note: `已停 ${body.user_id}`, stop_browser: body.stop_browser })
        case '/broker/purposes':
          if (method === 'GET') {
            return ok({ purposes: PURPOSES, source: 'file', valid_owners: ['executor', 'desktop', 'none'] })
          }
          // 代理那边校验 owner 白名单；这里复刻它的拒绝形态，验客户端如实转述
          if (!['executor', 'desktop', 'none'].includes(body.owner)) {
            return new Response(JSON.stringify({ code: -1, msg: `owner 只能是 executor / desktop / none，收到 '${body.owner}'` }), { status: 400 })
          }
          return ok({ name: body.name, owner: body.owner, before: null })
        case '/broker/purposes/delete':
          if (body.name === '采购') {
            return new Response(JSON.stringify({ code: -1, msg: '用途「采购」下还有 5 个环境，先把它们改到别的用途再删' }), { status: 400 })
          }
          return ok({ name: body.name, owner: 'none' })
        case '/api/v1/group/list':
          return ok({ list: state.groups })
        case '/api/v1/group/create': {
          const g = { group_id: `g${state.groups.length + 1}`, group_name: body.group_name }
          state.groups.push(g)
          return ok({ group_id: g.group_id })
        }
        case '/api/v1/user/list': {
          const wanted = target.searchParams.get('group_id')
          const list = wanted
            ? state.envs.filter((e) => e.group_id === wanted)
            : state.envs
          return ok({ list })
        }
        case '/api/v1/user/create': {
          const group = state.groups.find((g) => g.group_id === String(body.group_id))
          const env = {
            user_id: `u${state.nextId++}`,
            name: body.name,
            group_id: String(body.group_id),
            group_name: group?.group_name || '',
            serial_number: '9',
            user_proxy_config: body.user_proxy_config
          }
          state.envs.push(env)
          return ok({ id: env.user_id, serial_number: env.serial_number })
        }
        case '/api/v1/user/regroup': {
          const group = state.groups.find((g) => g.group_id === String(body.group_id))
          for (const id of body.user_ids) {
            const env = state.envs.find((e) => e.user_id === id)
            if (env) {
              env.group_id = String(body.group_id)
              env.group_name = group?.group_name || ''
            }
          }
          return ok({})
        }
        case '/api/v1/user/delete':
          state.envs = state.envs.filter((e) => !body.user_ids.includes(e.user_id))
          return ok({})
        case '/api/v1/browser/local-active':
          return ok({ list: [] })
        default:
          return ok({})
      }
    }
  })
  // ports() 走的是 local-active，这里直接给结果，免得每条用例都铺一遍
  api.ports = async () => []
  return { api, calls, state }
}

// --- 1. 用途必填，且必须在登记表里 -------------------------------------------
{
  const { api, calls } = fakeAds()
  await assert.rejects(
    () => createEnv({ name: '采购-张三', purpose: '' }, { apiClient: api }),
    /必须选择环境用途/,
    '没用途必须直接拒绝：用途就是归属，没有用途的环境谁也不驱动'
  )
  await assert.rejects(
    () => createEnv({ name: '采购-张三', purpose: '采够' }, { apiClient: api }),
    /不在登记表里/,
    '打错字的用途必须拒绝，否则会建出一个没人认领的分组'
  )
  assert.equal(calls.filter((c) => c.path === '/api/v1/user/create').length, 0, '拒绝的请求不该真去建环境')
  await assert.rejects(
    () => createEnv({ name: '  ', purpose: '采购' }, { apiClient: api }),
    /环境名不能为空/
  )
}

// --- 2. 新建：先查后建分组，user/create 必须带 group_id，并读回校验 ----------
{
  const { api, calls, state } = fakeAds()
  const created = await createEnv({ name: '采购-张三', purpose: '采购' }, { apiClient: api })

  const createCall = calls.find((c) => c.path === '/api/v1/user/create')
  assert.ok(createCall, '必须调 user/create')
  assert.equal(createCall.method, 'POST', 'user/create 是 POST')
  assert.ok(createCall.body.group_id, 'group_id 必填：环境出生就要有归属，不留「建完忘了分组」的空档')
  assert.equal(createCall.body.user_proxy_config.proxy_soft, 'no_proxy', '没填代理就显式不走代理')

  // Local API 没有 group/delete，所以分组一律先查后建，不留同名垃圾分组
  assert.ok(calls.some((c) => c.path === '/api/v1/group/list'), '建分组前必须先查')
  assert.equal(state.groups.filter((g) => g.group_name === '采购').length, 1, '不该建出重名分组')

  assert.equal(created.group, '采购')
  assert.equal(created.owner, 'executor', '归属要从登记表里带出来')
  // 读回校验：写完必须再查一次，不信返回码
  const readBacks = calls.filter((c) => c.path === '/api/v1/user/list' && c.body === null)
  assert.ok(readBacks.length >= 1, '建完必须读回校验')
}

// --- 3. 改用途：走 regroup，绝不用 user/update -------------------------------
{
  const { api, calls, state } = fakeAds({
    envs: [{ user_id: 'u1', name: '老环境', group_id: 'g1', group_name: '行情' }]
  })
  const moved = await setEnvPurpose('u1', '采购', { apiClient: api })
  assert.equal(moved.group, '采购')
  assert.ok(calls.some((c) => c.path === '/api/v1/user/regroup'), '必须用 user/regroup')
  assert.ok(
    !calls.some((c) => c.path === '/api/v1/user/update'),
    'user/update 带 group_id 会返回 Success 却什么都不改 —— 静默失败，永远不要用它'
  )
  assert.equal(state.envs[0].group_name, '采购', '环境应真的落到新分组')
}

// --- 4. 接口报成功但东西没动 → 必须报错，不能假装改好了 ----------------------
{
  const { api } = fakeAds({
    envs: [{ user_id: 'u1', name: '老环境', group_id: 'g1', group_name: '行情' }]
  })
  // 复刻那次真实的静默失败：regroup 回 code=0，但环境纹丝不动
  const original = api.fetchImpl
  api.fetchImpl = async (url, init) => {
    if (String(url).includes('/api/v1/user/regroup')) return ok({})
    return original(url, init)
  }
  await assert.rejects(
    () => setEnvPurpose('u1', '采购', { apiClient: api }),
    /仍不在分组/,
    '读回校验必须抓住静默失败'
  )
}

// --- 5. 删除：读回校验「真的没了」---------------------------------------------
{
  const { api, state } = fakeAds({ envs: [{ user_id: 'u1', name: 'X', group_id: 'g1', group_name: '行情' }] })
  await deleteEnvs(['u1'], { apiClient: api })
  assert.equal(state.envs.length, 0)

  const stubborn = fakeAds({ envs: [{ user_id: 'u1', name: 'X', group_id: 'g1', group_name: '行情' }] })
  const original = stubborn.api.fetchImpl
  stubborn.api.fetchImpl = async (url, init) => {
    if (String(url).includes('/api/v1/user/delete')) return ok({})   // 报成功却没删
    return original(url, init)
  }
  await assert.rejects(() => deleteEnvs(['u1'], { apiClient: stubborn.api }), /仍在/)

  await assert.rejects(() => deleteEnvs([], { apiClient: stubborn.api }), /没有要删除的环境/)
}

// --- 6. 清单：白名单，代理凭据一个字都不许出去 --------------------------------
{
  const rows = mapEnvListing(
    {
      list: [
        {
          user_id: 'u1', name: '采购-张三', group_name: '采购', serial_number: '3',
          user_proxy_config: {
            proxy_soft: 'other', proxy_type: 'socks5', proxy_host: '1.2.3.4',
            proxy_user: 'secret-user', proxy_password: 'DEMO_ONLY_REDACTED'
          }
        },
        { user_id: 'u2', name: '没分组的', group_name: '', user_proxy_config: { proxy_soft: 'no_proxy' } }
      ]
    },
    [{ id: 'u1', port: 51234 }],
    PURPOSES
  )
  const dumped = JSON.stringify(rows)
  assert.ok(!dumped.includes('secret-user') && !dumped.includes('secret-pass'),
    '代理凭据是明文的，绝不能随清单出到渲染层')
  assert.ok(!dumped.includes('1.2.3.4'), '出口 IP 同理')
  assert.equal(rows[0].hasProxy, true, '配没配代理是运维要看的，折成布尔即可')

  // AdsPower 的 user/list **不返回** user_proxy_config 明细，只给 has_proxy。
  // 光看明细会把配好代理的环境显示成「未配」——而那在这套体系里等于说"这个号跑不了活"。
  const listShape = mapEnvListing(
    { list: [
      { user_id: 'p1', name: '配了代理', group_name: '采购', has_proxy: true, user_proxy_config: {} },
      { user_id: 'p2', name: '没配', group_name: '采购', has_proxy: false, user_proxy_config: {} }
    ] }, [], PURPOSES)
  assert.equal(listShape[0].hasProxy, true, 'has_proxy=true 却显示未配')
  assert.equal(listShape[1].hasProxy, false)
  assert.equal(rows[0].owner, 'executor')
  assert.equal(rows[0].running, true, '运行中状态来自 ports()')
  assert.equal(rows[1].hasProxy, false)
  assert.equal(rows[1].owner, '', '没登记用途的环境显示「未登记」，不能假装它归谁')
}

// --- 7. 用途登记表：以代理为准；代理没起要如实标记降级 ------------------------
{
  const up = fakeAds()
  const fromBroker = await fetchEnvPurposes({ apiClient: up.api })
  assert.equal(fromBroker.source, 'broker')
  assert.deepEqual(fromBroker.table, PURPOSES)

  const down = fakeAds({ brokerUp: false })
  const fallback = await fetchEnvPurposes({ apiClient: down.api })
  assert.equal(fallback.source, 'fallback', '代理没起必须如实标记：此时归属保护不生效')
  assert.equal(fallback.table['采购'], 'executor')
  // 09-15 起销售号也在浏览器上、归执行端。兜底表写成 desktop 时，代理一不在，
  // 「登录闲鱼」就只开浏览器不起执行端——号登上了，店铺却永远长不出来。
  assert.equal(fallback.table['销售'], 'executor')
}

// --- 8. listEnvs：不做分组过滤，孤儿环境也要看得见 ---------------------------
{
  const { api } = fakeAds({
    envs: [
      { user_id: 'u1', name: '行情爬虫', group_id: 'g1', group_name: '行情' },
      { user_id: 'u2', name: '孤儿', group_id: '', group_name: '' }
    ]
  })
  const { envs, purposeSource } = await listEnvs({ apiClient: api })
  assert.equal(envs.length, 2, '环境管理页要看见全机所有环境，包括没登记用途的——看不见就没法收编')
  assert.equal(purposeSource, 'broker')
}

// --- 9. 用途登记表：读写都经本机代理，拒绝理由要如实转述 --------------------
{
  const { api, calls } = fakeAds()
  const table = await listEnvPurposes({ apiClient: api })
  assert.deepEqual(table.purposes, PURPOSES)
  assert.equal(table.source, 'file', '要如实告诉界面这张表是落盘副本还是出厂默认')
  assert.deepEqual(table.validOwners, ['executor', 'desktop', 'none'])

  const saved = await saveEnvPurpose('售后', 'desktop', { apiClient: api })
  assert.equal(saved.owner, 'desktop')
  const post = calls.find((c) => c.path === '/broker/purposes' && c.method === 'POST')
  assert.ok(post, '保存用途必须打代理，而不是在端上自己记一份')

  await assert.rejects(() => saveEnvPurpose('', 'desktop', { apiClient: api }), /用途名不能为空/)

  // 代理拒绝时，界面要看到**它给的那句话**，不能被包装成一句含糊的"保存失败"
  await assert.rejects(
    () => saveEnvPurpose('乱来', 'boss', { apiClient: api }),
    /owner 只能是/,
    '后端的判词必须原样透出，否则用的人不知道哪里错了'
  )
  await assert.rejects(
    () => removeEnvPurpose('采购', { apiClient: api }),
    /还有 5 个环境/,
    '"下面还有环境所以不能删"是这条功能最要紧的一句话，不能被吞掉'
  )
  assert.equal((await removeEnvPurpose('空用途', { apiClient: api })).name, '空用途')
}

// --- 10. 执行端状态要能看见 ---------------------------------------------------
// 归执行端驱动的环境，浏览器是执行端在管：界面看不见这个进程，人就只剩"关不掉"。
{
  const { api } = fakeAds()
  const map = await listExecutors({ apiClient: api })
  assert.equal(map.u1.executor, '运行中 (pid=123)')
  assert.equal(map.u2.executor, '已停止')

  // 代理挂了也不该让整页打不开：少一列信息 > 整页报错
  const down = fakeAds({ brokerUp: false })
  down.api.listExecutors = async () => { throw new Error('代理连不上') }
  const listed = await listEnvs({ apiClient: down.api })
  assert.ok(Array.isArray(listed.envs), '读不到执行端状态时，环境清单仍要给出来')
}

// --- 11. 代理不是必须项：它不在时执行端改由本机直控 ---------------------------
{
  const brokerDown = () => Object.assign(new Error('本机代理没在跑'), { code: 'BROKER_DOWN' })
  const used = []
  const local = {
    ready: true,
    start: async (id) => { used.push(`start:${id}`); return { note: 'local start' } },
    stop: async (id, browser) => { used.push(`stop:${id}:${browser}`); return { note: 'local stop' } },
    status: async () => ({ u1: { executor: '运行中 (pid=9)', browser: '' } })
  }
  const { api } = fakeAds({
    envs: [{ user_id: 'u1', name: '销售01', group_id: 'g1', group_name: '行情' }]
  })
  api.startExecutor = async () => { throw brokerDown() }
  api.stopExecutor = async () => { throw brokerDown() }
  api.listExecutors = async () => { throw brokerDown() }

  assert.equal((await startExecutorFor('u1', { apiClient: api, local })).note, 'local start')
  assert.equal((await stopExecutorFor('u1', { apiClient: api, local, stopBrowser: true })).note, 'local stop')
  assert.deepEqual(used, ['start:u1', 'stop:u1:true'])
  const { envs } = await listEnvs({ apiClient: api, local })
  assert.equal(envs[0].executor, '运行中 (pid=9)', '代理不在时执行端那一列要从本机台账读出来')

  // 代理在、但它说不行：那句话原样给人看，不能偷偷换路绕过去
  const { api: up } = fakeAds()
  up.startExecutor = async () => { throw new Error('代理未带完整配置启动，无法控制执行端进程') }
  await assert.rejects(() => startExecutorFor('u1', { apiClient: up, local }), /未带完整配置/)
  assert.deepEqual(used, ['start:u1', 'stop:u1:true'])

  // 代理在：照旧经代理，本机直控一下都不碰
  const { api: normal } = fakeAds()
  await stopExecutorFor('u1', { apiClient: normal, local, stopBrowser: true })
  assert.equal((await listExecutors({ apiClient: normal, local })).u1.executor, '运行中 (pid=123)')
  assert.deepEqual(used, ['start:u1', 'stop:u1:true'])
}

console.log('adspower-env-admin: PASS')
