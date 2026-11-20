import { createRouter, createWebHashHistory } from 'vue-router'
import Login from './views/Login.vue'
import Console from './views/Console.vue'
import Prices from './views/Prices.vue'
import PriceHistory from './views/PriceHistory.vue'
import SellerCrawl from './views/SellerCrawl.vue'
import TaskCenter from './views/TaskCenter.vue'
import Wms from './views/Wms.vue'
import Inbox from './views/Inbox.vue'
import Ops from './views/Ops.vue'
import Listing from './views/Listing.vue'
import { canVisit, landingPath } from './menu.js'

const routes = [
  { path: '/login', component: Login },
  {
    path: '/',
    component: Console,
    children: [
      { path: 'inbox', component: Inbox },
      { path: 'listing', component: Listing },
      { path: 'tasks', component: TaskCenter },
      { path: 'ops', component: Ops },
      // 旧地址仍然进得去：合并前的书签和「去配一下环境」这类跳转还在用它们
      { path: 'envs', redirect: '/ops?tab=envs' },
      { path: 'accounts', redirect: '/ops?tab=accounts' },
      { path: 'units', redirect: '/ops?tab=units' },
      { path: 'crawlers', redirect: '/ops?tab=crawlers' },
      { path: 'prices', component: Prices },
      { path: 'prices/history', component: PriceHistory },
      // Retain a safe redirect for old deep links; no Electron preview route
      // remains, so stale bookmarks cannot recreate an embedded web view.
      { path: 'preview', redirect: '/accounts' },
      { path: 'wms', component: Wms },
      { path: 'seller', component: SellerCrawl }
    ]
  }
]

const router = createRouter({ history: createWebHashHistory(), routes })

let authenticatedUntil = 0
let cachedAuth = null

// 进入控制台前确认已登录，并按角色拦截越权路径。
//
// 权限判断读 menu.js 这份**唯一声明**——侧边栏也读它。分开写就会出现
// “菜单里藏了但手敲 URL 还能进”，那是权限功能最常见的漏洞。
router.beforeEach(async (to) => {
  if (to.path === '/login') {
    authenticatedUntil = 0
    cachedAuth = null
    return true
  }
  // 菜单切换不应每次都等待一轮 IPC。只短暂缓存“已登录”，
  // 未登录从不缓存，因此登录后仍会立即重新检查。
  if (Date.now() >= authenticatedUntil) {
    try {
      const state = await window.erp.getAuthState()
      if (!state.hasToken && !state.localMode) return '/login'
      cachedAuth = state
      authenticatedUntil = Date.now() + 30_000
    } catch {
      return '/login'
    }
  }
  if (to.path === '/') return landingPath(cachedAuth) || '/login'
  if (canVisit(cachedAuth, to.path)) return true
  // 越权：送回该角色自己的落地页，而不是丢一个空白页面。
  const landing = landingPath(cachedAuth)
  return landing && landing !== to.path ? landing : '/login'
})

export default router
