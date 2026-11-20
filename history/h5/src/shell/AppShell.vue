<template>
  <div class="mp-app" :class="{ 'mp-app--desktop': framed }">
    <DesktopSide v-if="framed" />
    <div class="mp-stage">
      <DesktopTop v-if="framed" />
      <div class="mp-pages">
        <PageHost v-for="e in bottom" :key="e.id" :entry="e" :active="top === e" :z="1" />
        <TransitionGroup :name="framed ? '' : 'mp-push'">
          <PageHost v-for="(e, i) in nav.stack" :key="e.id" :entry="e" :active="top === e" :z="i + 2" />
        </TransitionGroup>
      </div>
    </div>
    <Overlays />
    <ImageViewer />
    <Scanner />
    <PwaBar />
    <CollabBar v-if="top && top.route !== entryRoute()" />
    <Tour />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { entryRoute, nav, topEntry } from '../runtime/router.js'
import { isDesktop } from '../runtime/viewport.js'
import PageHost from './PageHost.vue'
import DesktopSide from './DesktopSide.vue'
import DesktopTop from './DesktopTop.vue'
import Overlays from './Overlays.vue'
import ImageViewer from './ImageViewer.vue'
import Scanner from './Scanner.vue'
import PwaBar from './PwaBar.vue'
import CollabBar from './CollabBar.vue'
import Tour from './Tour.vue'

const top = computed(() => topEntry())
// 底层：活着的 tab 页 + （如果有）非 tab 的底页
const bottom = computed(() => {
  const list = nav.tabs.filter((t) => !t.dead)
  if (nav.base && !nav.base.isTab) list.push(nav.base)
  return list
})
// 电脑上（≥1024）登录后换成管理后台的样子：左侧菜单 + 顶栏面包屑；登录页照旧整页
const framed = computed(() => isDesktop.value && !!top.value && top.value.route !== entryRoute())
</script>
