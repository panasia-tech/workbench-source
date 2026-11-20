<template>
  <section class="mp-host" :class="{ 'mp-host--active': active, 'mp-host--tab': entry.isTab, 'mp-host--narrow': narrow, 'mp-host--wide': wide }" :style="{ zIndex: z }" :aria-hidden="active ? null : 'true'" @wheel.passive="onGutterWheel">
    <header v-if="!customNav" class="mp-nav" :style="navStyle">
      <button v-if="canBack" class="mp-nav__btn" type="button" aria-label="返回" @click="back">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <button v-else-if="showHome" class="mp-nav__btn" type="button" aria-label="回首页" @click="home">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h4.5v-5.5h3V20H18V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <h1 class="mp-nav__title">{{ title }}</h1>
      <!-- 电脑上没有下拉手势：开了下拉刷新的页面给一个刷新按钮（只在鼠标设备上显示，见 shell.css） -->
      <button v-if="pullEnabled" class="mp-nav__btn mp-nav__btn--refresh" type="button" aria-label="刷新" title="刷新" :disabled="refreshing" @click="startPullDownRefresh">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </header>
    <div ref="viewport" class="mp-viewport">
      <div ref="scroller" class="mp-scroller" @scroll.passive="onScroll">
        <div v-if="pullEnabled" class="mp-ptr" :class="{ 'mp-ptr--drag': dragging }" :style="{ height: `${pull}px` }">
          <span class="mp-ptr__dots" :class="{ 'mp-ptr__dots--on': refreshing }"><i /><i /><i /></span>
        </div>
        <div class="mp-page-wrap">
          <component :is="entry.component" v-if="entry.component" />
          <div v-else-if="entry.loadError" class="mp-load-error">
            <p>页面没加载出来</p>
            <p class="mp-load-error__sub">{{ offline ? '网络断了，连上后再试' : '可能刚发了新版本，刷新一下' }}</p>
            <button type="button" @click="retry">重试</button>
          </div>
          <div v-else class="mp-page-loading"><span class="mp-spinner" /></div>
        </div>
      </div>
      <component :is="tabBar" v-if="entry.isTab && tabBar" ref="tabBarRef" />
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { MP_HOST } from '../runtime/page.js'
import * as router from '../runtime/router.js'
import { desktopColumnOf } from './desktop-layout.js'
import { isDesktop } from '../runtime/viewport.js'

const props = defineProps({
  entry: { type: Object, required: true },
  active: { type: Boolean, default: false },
  z: { type: Number, default: 1 },
})

const scroller = ref(null)
const viewport = ref(null)
const tabBarRef = ref(null)
const pull = ref(0)
const refreshing = ref(false)
const dragging = ref(false)
const offline = ref(!navigator.onLine)

const tabBar = computed(() => router.nav.tabBar)
const json = computed(() => router.pageJsonOf(props.entry.route))
const pullEnabled = computed(() => !!json.value.enablePullDownRefresh)
// 页面配置 navigationStyle: custom = 页面自己画导航栏（和小程序一样），外壳不再画
const customNav = computed(() => json.value.navigationStyle === 'custom')
const title = computed(() => router.titleOf(props.entry))
// 宽屏上收成窄列（表单、详情）；手机上这个 class 不起作用
const narrow = desktopColumnOf(props.entry.route) === 'narrow'
// 有电脑版模板的页面在电脑上铺满内容区（表格、多栏表单），不收成一列
const wide = computed(() => isDesktop.value && !!(props.entry.component && props.entry.component.__mpDesktop))
const canBack = computed(() => router.nav.stack.includes(props.entry))
// 小程序的规矩：不是首页（app.json 第一页）、也不是 tab 页的底页，才给「回首页」
const showHome = computed(() => !props.entry.isTab && router.nav.base === props.entry && props.entry.route !== router.entryRoute())
const win = router.windowConfig()
const navStyle = {
  background: win.navigationBarBackgroundColor || '#fff',
  color: win.navigationBarTextStyle === 'white' ? '#fff' : '#000',
}

// ---------------------------------------------------------------- 页面上下文
const host = {
  entry: props.entry,
  components: new Set(),
  pageVm: null,
  tabBar: () => tabBarRef.value || null,
  scroller: () => scroller.value,
  pageEl: () => (scroller.value ? scroller.value.querySelector('wx-page') : null),
  startPullDownRefresh,
  stopPullDownRefresh,
}
provide(MP_HOST, host)
router.bindHost(props.entry, host)

function back() {
  router.navigateBack(1)
}

function home() {
  router.goHome()
}

function retry() {
  // 发版后旧分片没了（浏览器报的是模块加载失败）：整页刷新换新版本
  const missingChunk = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i
  if (!offline.value && missingChunk.test(props.entry.loadError || '')) {
    location.reload()
    return
  }
  router.loadEntry(props.entry)
}

// 宽屏上页面是居中一列，两边留白不在滚动区里：鼠标在留白上滚轮也滚页面
function onGutterWheel(e) {
  const el = scroller.value
  if (!el || !viewport.value || viewport.value.contains(e.target)) return
  el.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
}

// ---------------------------------------------------------------- 触底
let bottomArmed = true
function onScroll() {
  const el = scroller.value
  const vm = host.pageVm
  if (!el || !vm) return
  const distance = Number(json.value.onReachBottomDistance) || 50
  const near = el.scrollHeight - el.scrollTop - el.clientHeight <= distance
  if (near && bottomArmed) {
    bottomArmed = false
    if (typeof vm.onReachBottom === 'function') {
      try { vm.onReachBottom() } catch (e) { console.error(e) }
    }
  } else if (!near) {
    bottomArmed = true
  }
  if (typeof vm.onPageScroll === 'function') vm.onPageScroll({ scrollTop: el.scrollTop })
}

// ---------------------------------------------------------------- 下拉刷新
const TRIGGER = 56
let startY = 0
let pulling = false
let refreshTimer = null

function startPullDownRefresh() {
  if (!pullEnabled.value || refreshing.value) return
  if (scroller.value) scroller.value.scrollTop = 0
  pull.value = TRIGGER
  triggerRefresh()
}

function triggerRefresh() {
  refreshing.value = true
  clearTimeout(refreshTimer)
  // 页面忘了 stopPullDownRefresh 也别一直转
  refreshTimer = setTimeout(stopPullDownRefresh, 15000)
  const vm = host.pageVm
  if (vm && typeof vm.onPullDownRefresh === 'function') {
    try { vm.onPullDownRefresh() } catch (e) { console.error(e) }
  } else {
    stopPullDownRefresh()
  }
}

function stopPullDownRefresh() {
  clearTimeout(refreshTimer)
  refreshing.value = false
  pull.value = 0
}

function onTouchStart(e) {
  if (!pullEnabled.value || refreshing.value || e.touches.length !== 1) return
  if (scroller.value.scrollTop > 0) return
  startY = e.touches[0].clientY
  pulling = true
  dragging.value = true
}

function onTouchMove(e) {
  if (!pulling) return
  const dy = e.touches[0].clientY - startY
  if (dy <= 0 || scroller.value.scrollTop > 0) {
    pull.value = 0
    return
  }
  if (e.cancelable) e.preventDefault()
  pull.value = Math.min(90, dy * 0.45)
}

function onTouchEnd() {
  if (!pulling) return
  pulling = false
  dragging.value = false
  if (pull.value >= TRIGGER * 0.9) {
    pull.value = TRIGGER
    triggerRefresh()
  } else {
    pull.value = 0
  }
}

// ---------------------------------------------------------------- 视口高度（小程序的 100vh 不含导航栏）
let ro = null
function syncVh() {
  const el = viewport.value
  if (el) el.style.setProperty('--mp-vh', `${el.clientHeight / 100}px`)
}

const onOnline = () => { offline.value = !navigator.onLine }

onMounted(() => {
  const el = scroller.value
  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  el.addEventListener('touchend', onTouchEnd, { passive: true })
  el.addEventListener('touchcancel', onTouchEnd, { passive: true })
  syncVh()
  if (window.ResizeObserver) {
    ro = new ResizeObserver(syncVh)
    ro.observe(viewport.value)
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOnline)
})

onBeforeUnmount(() => {
  clearTimeout(refreshTimer)
  if (ro) ro.disconnect()
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOnline)
  router.unbindHost(props.entry)
})

// 页面内容变了（翻页加载出新数据）要重新允许触底
watch(() => props.active, (v) => { if (v) bottomArmed = true })
</script>
