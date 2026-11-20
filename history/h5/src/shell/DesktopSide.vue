<template>
  <aside class="dk-side">
    <div class="dk-side__brand">
      <span class="dk-side__logo">泛</span>
      <span class="dk-side__name">{{ appName }}</span>
    </div>
    <nav class="dk-side__menu">
      <button
        v-for="item in menu"
        :key="item.key"
        type="button"
        class="dk-side__item"
        :class="{ 'dk-side__item--on': item.route === current }"
        @click="open(item)"
      >
        <span class="dk-side__icon" :class="item.iconClass">{{ item.icon }}</span>
        <span class="dk-side__text">{{ item.title }}</span>
        <span v-if="badgeOf(item)" class="dk-side__badge" :title="badgeTip(item)">{{ badgeOf(item) }}</span>
      </button>
    </nav>
    <div v-if="user" class="dk-side__user" :title="user.name || user.username">
      <span class="dk-side__avatar">{{ (user.name || user.username || '?')[0] }}</span>
      <span class="dk-side__who">
        <span class="dk-side__uname">{{ user.name || user.username }}</span>
        <span class="dk-side__role">{{ roleText }}</span>
      </span>
    </div>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getApp } from '../runtime/app.js'
import { nav, navigateTo, switchTab, windowConfig } from '../runtime/router.js'
import workbench from '../../../miniprogram/services/workbench.js'
import { refreshSalesBadges, salesBadges } from './sales-badges.js'

// 电脑上的左侧菜单：工作台 + 当前角色能用的功能入口（和手机工作台同一张表）+ 我的。
// 点功能入口 = 回到工作台再打开它，页面栈只留一层，跟管理后台切菜单一样
const WORKBENCH = 'pages/workbench/index'
const PROFILE = 'pages/profile/index'
const ROLE_TEXT = {
  ADMIN: '管理员', PURCHASER: '采购', WAREHOUSE: '仓管', NEGOTIATOR: '议价', BUSINESS: '业务', SALES: '销售', FINANCE: '财务',
}

const appName = windowConfig().navigationBarTitleText || '泛亚货运社'
const routeOf = (url) => url.replace(/^\//, '').split('?')[0]

// globalData 不是响应式的：登录、换人时 auth 发 mp:session 事件，这里跟着重取
const user = ref(null)
const readUser = () => { user.value = (getApp().globalData || {}).user || null }
readUser()
onMounted(() => window.addEventListener('mp:session', readUser))
onBeforeUnmount(() => window.removeEventListener('mp:session', readUser))

// 销售工作台几个入口的红点：红的有几条（练习是还差几步）。换人、切页时刷新，另外每 2 分钟刷一次
const BADGE_TIP = { today: '条红的要处理', goods: '件货要处理', orders: '单有问题', assist: '个买家等太久没人回', practice: '步练习没做' }
const badgeOf = (item) => {
  const n = item.badge && salesBadges.value ? salesBadges.value[item.badge] : 0
  return n ? (n > 99 ? '99+' : n) : ''
}
const badgeTip = (item) => `${salesBadges.value[item.badge]} ${BADGE_TIP[item.badge]}`
const syncBadges = (force) => refreshSalesBadges(user.value && user.value.role, force)
watch(user, () => syncBadges(true), { immediate: true })
// 练习没做完时每次切页都拉（做完一步顶栏的锁要马上变），平时 30 秒内不重复拉
// 看最上面那一页换没换（redirectTo 不改页数，只看页数会漏）
watch(() => { const t = nav.stack[nav.stack.length - 1] || nav.base; return t && t.id }, () => syncBadges(!!(salesBadges.value && salesBadges.value.practice)))
// 页面里做了会改红点的事（比如练习做完一步）发 mp:sales-badges，马上重拉
const onBadgeEvent = () => syncBadges(true)
let badgeTimer = 0
onMounted(() => {
  badgeTimer = setInterval(() => syncBadges(true), 120000)
  window.addEventListener('mp:sales-badges', onBadgeEvent)
})
onBeforeUnmount(() => {
  clearInterval(badgeTimer)
  window.removeEventListener('mp:sales-badges', onBadgeEvent)
})
const roleText = computed(() => (user.value && ROLE_TEXT[user.value.role]) || '')

const menu = computed(() => {
  const entries = user.value ? workbench.getEntriesForRole(user.value.role) : []
  return [
    { key: 'workbench', icon: '台', iconClass: 'dk-side__icon--home', title: '工作台', route: WORKBENCH, tab: true },
    ...entries.map((e) => ({ ...e, route: routeOf(e.url) })),
    { key: 'profile', icon: '我', iconClass: 'dk-side__icon--me', title: '我的', route: PROFILE, tab: true },
  ]
})

// 高亮：页面栈最底下那层功能页（详情、编辑这些子页面算在它名下）
const current = computed(() => {
  const first = nav.stack[0] || nav.base
  return first ? first.route : ''
})

function open(item) {
  if (item.tab) {
    switchTab(`/${item.route}`)
    return
  }
  if (nav.stack.length === 1 && nav.stack[0].route === item.route) return
  switchTab(`/${WORKBENCH}`).then(() => navigateTo(item.url))
}
</script>
