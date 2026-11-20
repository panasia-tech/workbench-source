<template>
  <header class="dk-top">
    <button v-if="nav.stack.length" class="dk-top__btn" type="button" title="返回上一页" aria-label="返回" @click="back(1)">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <ol class="dk-top__crumbs">
      <li v-for="(c, i) in crumbs" :key="c.id" class="dk-top__crumb" :class="{ 'dk-top__crumb--last': i === crumbs.length - 1 }">
        <button v-if="i < crumbs.length - 1" type="button" @click="back(crumbs.length - 1 - i)">{{ c.title }}</button>
        <span v-else>{{ c.title }}</span>
      </li>
    </ol>
    <div v-if="lockLeft" class="dk-top__lock">
      <span>🔒 真实任务先锁着：先做完上手练习（还差 {{ lockLeft }} 步），才能上架、审批、发货</span>
      <button v-if="!onPractice" type="button" @click="goPractice">去做练习</button>
    </div>
    <button v-if="canRefresh" class="dk-top__btn dk-top__btn--text" type="button" title="刷新本页" :disabled="refreshing" @click="refresh">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span>刷新</span>
    </button>
  </header>
</template>

<script setup>
import { computed, ref } from 'vue'
import { hostOf, nav, navigateBack, navigateTo, pageJsonOf, titleOf, topEntry } from '../runtime/router.js'
import { salesBadges } from './sales-badges.js'

// 电脑上的顶栏：面包屑代替手机导航栏（工作台 / 仓库 / 商品详情，点前面的层级直接退回去），右边刷新本页
const crumbs = computed(() => [nav.base, ...nav.stack].filter(Boolean).map((e) => ({ id: e.id, title: titleOf(e) || '　' })))
const canRefresh = computed(() => {
  const t = topEntry()
  return !!(t && pageJsonOf(t.route).enablePullDownRefresh)
})
const refreshing = ref(false)

// 练习门禁开着、这个销售还没做完（红点接口里 practice = 还差几步；没拦着就是 0）
const PRACTICE = 'pages/practice/index'
const lockLeft = computed(() => (salesBadges.value && salesBadges.value.practice) || 0)
const onPractice = computed(() => {
  const t = topEntry()
  return !!(t && t.route === PRACTICE)
})
function goPractice() {
  navigateTo(`/${PRACTICE}`)
}

function back(n) {
  navigateBack(n)
}

function refresh() {
  const host = hostOf(topEntry())
  if (!host || !host.startPullDownRefresh) return
  refreshing.value = true
  host.startPullDownRefresh()
  setTimeout(() => { refreshing.value = false }, 800)
}
</script>
