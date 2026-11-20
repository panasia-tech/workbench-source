// 角色菜单与路由守卫的一致性。
//
// 权限功能最常见的漏洞是「菜单里藏了，手敲 URL 还能进」——因为渲染和守卫各写
// 一份判断，改一处忘一处。所以两者共读 menu.js 这份唯一声明，这里把该性质钉死：
// 对每个角色、每条路径，可见性与可访问性必须完全一致。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MENU, ROLES, canVisit, landingPath, visibleMenu } from '../../src/renderer/src/menu.js'

const ALL_ROLES = Object.keys(ROLES)
const auth = (role) => ({ hasToken: true, staff: { id: 'x', username: 'u', role } })

// --- 声明表本身是完整的 -------------------------------------------------------
for (const item of MENU) {
  assert.ok(item.path.startsWith('/'), `菜单项 path 必须是绝对路径: ${item.path}`)
  assert.ok(item.title && item.hint && item.icon, `菜单项字段不全: ${item.path}`)
  for (const role of item.roles || []) {
    assert.ok(ALL_ROLES.includes(role), `${item.path} 引用了未知角色 ${role}`)
  }
}
assert.equal(new Set(MENU.map((m) => m.path)).size, MENU.length, '菜单路径不能重复')

// --- 可见 ⇔ 可进：逐角色逐路径核对 -------------------------------------------
for (const role of ALL_ROLES) {
  const state = auth(role)
  const visible = new Set(visibleMenu(state).map((m) => m.path))
  for (const item of MENU) {
    assert.equal(
      canVisit(state, item.path), visible.has(item.path),
      `${role} 对 ${item.path} 的「可见」与「可进」不一致——菜单藏了但 URL 能进`
    )
  }
}

// --- 具体权限矩阵（与整合方案文档里的表一致）---------------------------------
// 2026-09-16 起工作台按**人**登录（/auth/workbench-login 放行 销售/采购/管理员），
// 设备账号那两行是过渡期保留：旧客户端和存量登录态还会带着它们回来。
const EXPECT = {
  ADMIN: ['/inbox', '/listing', '/tasks', '/ops', '/seller', '/prices', '/wms'],
  // 库存商品 2026-09-16 加入：服务端放开了采购看全仓（此前 _inspector_filter 把它
  // 挡在「只看自己验过的货」那一档，而采购从不验货，点进来是一片空）。
  PURCHASER: ['/inbox', '/seller', '/prices', '/wms'],
  // 上下架 2026-09-16 加入：在这之前销售登进来只有两项，没有一件自己的活。
  SALES: ['/inbox', '/listing', '/wms'],
  WAREHOUSE: ['/wms'],
  // 巡航台自己的登录（/auth/crawler-login）只签得出 CRAWLER，所以这是日常最常见的角色。
  // 两处不给：消息聚合台（CHAT_ROLES 不含它）和运维（接口全是 require_roles(ADMIN)）。
  // 给了就是点进去吃 403——2026-09-19 /ops 真让它点进去过。
  CRAWLER: ['/tasks', '/seller', '/prices', '/wms'],
  // 现役设备账号角色。与 CRAWLER 同一份菜单：它只是多了一条「回写商品名」的窄写权限，
  // 那是服务端的事，不体现为多一个页面。
  MARKET_BOT: ['/tasks', '/seller', '/prices', '/wms']
}
for (const [role, paths] of Object.entries(EXPECT)) {
  assert.deepEqual(visibleMenu(auth(role)).map((m) => m.path), paths, `${role} 的菜单不符`)
}

// 管理员专属页面对其余角色一律关闭
// 运维四页合成 /ops 之后，管理员专属的门就是它加上行情采集
for (const role of ['PURCHASER', 'SALES', 'WAREHOUSE']) {
  for (const path of ['/ops', '/tasks']) {
    assert.equal(canVisit(auth(role), path), false, `${role} 不该能进 ${path}`)
  }
}

// --- 能登录的角色必须都有落地页 ----------------------------------------------
// 这条是本文件最该有的一条。2026-09-13 实际事故：menu.js 引入角色门禁时漏了
// CRAWLER，而桌面端日常登录拿到的就是它 —— visibleMenu 返回空 → landingPath 为
// null → 路由守卫把人送回登录页。登录明明成功了，界面上却和「密码错了」一模一样，
// 谁也看不出发生了什么。空菜单不是权限收紧，是这个账号打不开这个应用。
for (const role of ALL_ROLES) {
  const menu = visibleMenu(auth(role))
  assert.ok(menu.length > 0, `角色 ${role} 一个页面都看不到——它登录成功后会被弹回登录页`)
  assert.ok(landingPath(auth(role)), `角色 ${role} 算不出落地页`)
}

// --- 登录页不许把落地路径写死 ------------------------------------------------
// 原来写的是 router.replace('/tasks')，而 /tasks 是管理员专属：非管理员登录成功后
// 会被守卫弹走。落地页只能按角色算。
const loginSrc = readFileSync(new URL('../../src/renderer/src/views/Login.vue', import.meta.url), 'utf8')
assert.ok(loginSrc.includes('landingPath'), 'Login.vue 必须用 menu.js 的 landingPath 决定落地页')
assert.ok(
  !/router\.replace\('\/(tasks|inbox|prices|wms|seller|units|envs|accounts)'\)/.test(loginSrc),
  'Login.vue 里不许写死落地路径——角色一变就会把人锁在登录页外'
)

// --- 聚合台的角色必须与服务端 require_chat_access 一致 ------------------------
// 服务端 CHAT_ROLES = {PURCHASER, SALES, ADMIN}；菜单比接口宽会让人点进去吃 403，
// 比接口窄则是白白挡住有权限的人。
const CHAT_ROLES = ['PURCHASER', 'SALES', 'ADMIN']
const inbox = MENU.find((m) => m.path === '/inbox')
assert.deepEqual([...inbox.roles].sort(), [...CHAT_ROLES].sort(),
  '聚合台的角色必须与服务端 CHAT_ROLES 对齐')
assert.equal(canVisit(auth('WAREHOUSE'), '/inbox'), false, '仓管不在 CHAT_ROLES 里')

// --- 运维页的角色必须与服务端的 require_roles(ADMIN) 一致 ---------------------
// /ops 那四个标签用到的接口，服务端全挂着 require_roles(StaffRole.ADMIN)：
// workbench/leases 的五个动作、workbench/crawl/runs、workbench/env-purposes 的增删改。
// 2026-09-19 这里宽过接口一次——设备账号看得见「爬虫开关」，点进去每 25 秒吃一个
// 403，而界面上只写着「Request failed with status code 403」，最后是翻服务器日志
// 才定位的。看得见点不动比看不见更糟。
const ops = MENU.find((m) => m.path === '/ops')
assert.deepEqual(ops.roles, ['ADMIN'], '/ops 只给管理员——它用到的接口服务端全是 require_roles(ADMIN)')
for (const role of ALL_ROLES.filter((r) => r !== 'ADMIN')) {
  assert.equal(canVisit(auth(role), '/ops'), false, `${role} 不该能进 /ops——设备账号也不行`)
}

// --- 子路径跟随父菜单 ---------------------------------------------------------
assert.equal(canVisit(auth('PURCHASER'), '/prices/history'), true, '子路径应跟随父菜单')
assert.equal(canVisit(auth('SALES'), '/prices/history'), false, '子路径不该绕过父菜单的限制')

// --- 边界：无角色 / 未登录 / 本机模式 -----------------------------------------
assert.deepEqual(visibleMenu({ hasToken: true, staff: { role: '' } }), [], '角色为空按最小权限')
assert.equal(canVisit(null, '/tasks'), false, '无鉴权状态不得放行')
assert.equal(landingPath({ hasToken: true, staff: { role: '' } }), null, '没有可见项时落地页为空')
// 本机模式不连 ERP、没有员工身份，限制了只会得到一个空菜单，看起来像坏了
assert.deepEqual(visibleMenu({ localMode: true }).map((m) => m.path), MENU.map((m) => m.path))

// --- 落地页必须是该角色自己可进的页面 ----------------------------------------
for (const role of ALL_ROLES) {
  const landing = landingPath(auth(role))
  assert.ok(landing, `${role} 应有落地页`)
  assert.equal(canVisit(auth(role), landing), true, `${role} 的落地页 ${landing} 自己进不去`)
}

// --- 路由表与菜单表不能脱节 ---------------------------------------------------
const routerSrc = readFileSync(new URL('../../src/renderer/src/router.js', import.meta.url), 'utf8')
for (const item of MENU) {
  const child = item.path.replace(/^\//, '')
  assert.ok(
    routerSrc.includes(`path: '${child}'`) || routerSrc.includes(`path: '${item.path}'`),
    `菜单里有 ${item.path}，router.js 里却没有对应路由`
  )
}
assert.match(routerSrc, /canVisit/, 'router.js 必须用 menu.js 的 canVisit 做守卫，不能另写一套判断')

// --- 每个菜单图标都得真的存在 -------------------------------------------------
// 漏一个是**静默**的：<component :is="undefined"> 什么都不渲染，菜单项只剩文字，
// 不报错也不警告。/envs 的 Cpu 就这么漏过一次。
const consoleSrc = readFileSync(new URL('../../src/renderer/src/views/Console.vue', import.meta.url), 'utf8')
const iconMap = consoleSrc.match(/const ICONS = \{([^}]*)\}/)
assert.ok(iconMap, 'Console.vue 里找不到 ICONS 映射')
const declared = new Set(iconMap[1].split(',').map((s) => s.trim()).filter(Boolean))
for (const item of MENU) {
  assert.ok(declared.has(item.icon), `菜单 ${item.path} 用了图标 ${item.icon}，Console.vue 的 ICONS 里没有`)
  assert.match(consoleSrc, new RegExp(`\\b${item.icon}\\b[^\\n]*from '@element-plus/icons-vue'|from '@element-plus/icons-vue'`),
    `图标 ${item.icon} 没从 @element-plus/icons-vue 导入`)
}

console.log('menu-role-gating-regression: PASS')
