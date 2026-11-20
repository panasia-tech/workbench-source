import { createRouter, createWebHashHistory } from 'vue-router'
import Login from './views/Login.vue'
import Console from './views/Console.vue'
import Accounts from './views/Accounts.vue'
import Prices from './views/Prices.vue'
import Preview from './views/Preview.vue'

const routes = [
  { path: '/login', component: Login },
  {
    path: '/',
    component: Console,
    redirect: '/accounts',
    children: [
      { path: 'accounts', component: Accounts },
      { path: 'prices', component: Prices },
      { path: 'preview', component: Preview }
    ]
  }
]

const router = createRouter({ history: createWebHashHistory(), routes })

// 进入控制台前确认已登录
router.beforeEach(async (to) => {
  if (to.path === '/login') return true
  const state = await window.erp.getAuthState()
  if (!state.hasToken) return '/login'
  return true
})

export default router
