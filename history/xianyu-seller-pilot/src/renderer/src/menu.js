// 菜单与权限的**唯一声明**：侧边栏渲染和路由守卫都读这里。
//
// 分开写是权限功能最常见的漏洞来源——菜单藏了、URL 还能直接进。所以两处共用
// 同一份表：加一个页面只改这里，忘不了另一半。
//
// 文案纪律：**title 是这页叫什么，hint 是这页能干什么**，两句都用干活的人的话写。
// 不要把内部数据模型搬上界面——「账号 × 执行端 × 配额」「API-SPU 主数据」这类写法
// 对写代码的人很顺，对采购和销售就是一片空白（2026-09-13 老板原话：不是开发人员
// 根本看不懂）。判据很简单：一个刚入职的采购第一次看到这行字，知不知道该不该点进去。
// 长度也是纪律：侧栏一行放得下约 12 个汉字，写长了会被直接切掉——
// 半句话比黑话更糟，因为它看起来像是坏了。
//
// 角色沿用 ERP 员工体系（server 签发的 JWT 里的 role claim），不新建账号体系。
// 群控服务端验的是同一个 jwt_secret，所以这份 role 在两边都成立。
// 小程序端 profile 页已在用同一套判断（PURCHASER / WAREHOUSE / SALES / ADMIN）。
//
// 2026-09-16 起登录走 /auth/workbench-login：**人**用自己的员工账号登，
// 角色决定看见什么。服务端那份放行名单（auth.WORKBENCH_ROLES）和这张表必须对得上，
// 已由 server/tests/test_workbench_login.py 直接读本文件钉死——它会检查放行的角色
// 在这里认得出、且至少看得见一个页面。漏一个的症状不是报错，是「登录成功却被弹回
// 登录页」（菜单为空 → 落地页算不出来），2026-09-13 真踩过一次。

export const ROLES = {
  PURCHASER: '采购',
  SALES: '销售',
  ADMIN: '管理员',
  // 仓管不走工作台（服务端也不放行），留着只为旧令牌不至于拿到空菜单。
  WAREHOUSE: '仓管',
  // 设备账号：/auth/crawler-login 那条路还在（无人值守的执行端用）。人已经不
  // 走这条了，但旧版本客户端和存量登录态还会带着这个角色回来，摘掉它们等于
  // 让那批人下次刷新令牌就被弹回登录页。过渡期保留。
  CRAWLER: '设备账号',
  MARKET_BOT: '设备账号'
}

// roles 留空 = 所有已登录角色可见。
export const MENU = [
  {
    // 销售的主战场，放最前。角色对齐服务端 require_chat_access 的 CHAT_ROLES
    // （PURCHASER / SALES / ADMIN）——菜单比接口宽会让人点进去吃 403。
    path: '/inbox',
    title: '买家消息',
    hint: '所有账号的买家消息',
    icon: 'ChatDotRound',
    roles: ['PURCHASER', 'SALES', 'ADMIN']
  },
  {
    path: '/listing',
    title: '上下架',
    hint: '把货发到店铺、从店铺撤下',
    icon: 'Sell',
    roles: ['SALES', 'ADMIN']
  },
  {
    path: '/tasks',
    title: '行情采集',
    hint: '要盯哪些型号的价格',
    icon: 'DataAnalysis',
    roles: ['ADMIN', 'CRAWLER', 'MARKET_BOT']
  },
  {
    // 浏览器环境 / 账号绑定 / 机器现状 / 爬虫开关 合成一页四个标签。
    // 这四件事本来就是一条链（建环境→定用途→登号→绑店铺→看它在哪台机器上跑），
    // 原来在侧栏各占一行，九项里四项是运维管道，日常干活的反被挤到下半截。
    //
    // 只给管理员。原来把设备账号（CRAWLER / MARKET_BOT）也放进来了，而这一页
    // 用到的接口服务端全挂着 require_roles(ADMIN)——租约的五个动作、采集轮次、
    // 用途登记的增删改。2026-09-19 现场就是这么炸的：一台机器带着设备账号的旧
    // 令牌进来，爬虫开关那屏每 25 秒吃一个 403，界面上只写「Request failed with
    // status code 403」，最后是翻服务器日志才定位的。
    // 看得见点不动比看不见更糟——菜单宽过接口，人就会点进去吃 403。
    path: '/ops',
    title: '运维',
    hint: '环境、账号、机器、爬虫',
    icon: 'Tools',
    roles: ['ADMIN']
  },
  {
    path: '/seller',
    title: '看同行',
    hint: '对手在卖什么、卖多少钱',
    icon: 'Link',
    roles: ['PURCHASER', 'ADMIN', 'CRAWLER', 'MARKET_BOT']
  },
  {
    path: '/prices',
    title: '行情记录',
    hint: '查过的价格都留在这里',
    icon: 'List',
    roles: ['PURCHASER', 'ADMIN', 'CRAWLER', 'MARKET_BOT']
  },
  {
    // 采购 2026-09-16 加入：服务端已放开它看全仓（此前只看得到自己验过的货，
    // 而采购从不验货，点进来是一片空）。
    path: '/wms',
    title: '库存商品',
    hint: '仓库里现在有什么货',
    icon: 'Connection',
    roles: ['SALES', 'PURCHASER', 'ADMIN', 'WAREHOUSE', 'CRAWLER', 'MARKET_BOT']
  }
]

/**
 * 本机模式没有员工身份（不连 ERP，供单机联调用），此时不做角色限制——
 * 否则会得到一个空菜单，看起来像坏了。有 staff 但 role 为空则按最小权限处理。
 */
export function visibleMenu(authState) {
  if (authState?.localMode && !authState?.staff) return MENU
  const role = String(authState?.staff?.role || '').trim().toUpperCase()
  if (!role) return []
  return MENU.filter((item) => !item.roles?.length || item.roles.includes(role))
}

/** 该角色能否进这个路径；子路径（如 /prices/history）跟随其父菜单。 */
export function canVisit(authState, path) {
  const target = String(path || '')
  const allowed = visibleMenu(authState)
  return allowed.some((item) => target === item.path || target.startsWith(`${item.path}/`))
}

/**
 * 登录后的落地页：该角色可见的第一项。
 *
 * 返回 null 表示这个角色一个页面都进不去。调方**必须**把这句话说出来——
 * 路由守卫遇到 null 会把人送回登录页，而登录本身是成功的，
 * 症状就成了「登录成功但没反应」，没人查得出为什么（2026-09-13 实际踩到）。
 */
export function landingPath(authState) {
  return visibleMenu(authState)[0]?.path || null
}
