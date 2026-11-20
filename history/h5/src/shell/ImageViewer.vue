<template>
  <Transition name="mp-fade">
    <div v-if="preview.visible" class="mp-viewer" @touchmove.prevent>
      <div
        class="mp-viewer__track"
        :style="{ transform: `translate3d(${-index * 100}%, 0, 0) translate3d(${dragX}px, 0, 0)`, transition: dragging ? 'none' : 'transform .28s ease' }"
        @touchstart="onStart"
        @touchmove="onMove"
        @touchend="onEnd"
        @touchcancel="onEnd"
        @click="onClick"
      >
        <div v-for="(item, i) in preview.items" :key="i" class="mp-viewer__slide">
          <video
            v-if="item.type === 'video'"
            class="mp-viewer__video"
            :src="i === index ? item.url : undefined"
            :poster="item.poster || undefined"
            controls
            playsinline
            webkit-playsinline
            :autoplay="i === index"
            @click.stop
          />
          <img
            v-else-if="Math.abs(i - index) <= 1"
            class="mp-viewer__img"
            :src="item.url"
            alt=""
            draggable="false"
            :style="i === index ? { transform: `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`, transition: gesturing ? 'none' : 'transform .2s ease' } : null"
          >
        </div>
      </div>
      <div v-if="preview.items.length > 1" class="mp-viewer__count">{{ index + 1 }} / {{ preview.items.length }}</div>
      <!-- 鼠标设备上切图的左右箭头（触屏照旧左右滑，按钮不显示，见 shell.css）；键盘 ← → 也能切 -->
      <template v-if="preview.items.length > 1">
        <button type="button" class="mp-viewer__nav mp-viewer__nav--prev" aria-label="上一张" :disabled="index === 0" @click.stop="go(-1)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button type="button" class="mp-viewer__nav mp-viewer__nav--next" aria-label="下一张" :disabled="index === preview.items.length - 1" @click.stop="go(1)">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </template>
      <button type="button" class="mp-viewer__close" aria-label="关闭" @click.stop="close">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { closePreview, preview } from '../runtime/ui.js'

const index = computed({
  get: () => preview.index,
  set: (v) => { preview.index = v },
})
const dragX = ref(0)
const dragging = ref(false)
const scale = ref(1)
const panX = ref(0)
const panY = ref(0)
const gesturing = ref(false)

let start = null
let pinch = null
let moved = false
let lastTap = 0
let tapTimer = null

watch(() => preview.index, resetZoom)
watch(() => preview.visible, (v) => { if (!v) resetZoom() })

function resetZoom() {
  scale.value = 1
  panX.value = 0
  panY.value = 0
}

function close() {
  clearTimeout(tapTimer)
  closePreview()
}

const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

function onStart(e) {
  moved = false
  if (e.touches.length === 2) {
    gesturing.value = true
    pinch = { d: dist(e.touches), s: scale.value }
    return
  }
  const t = e.touches[0]
  start = { x: t.clientX, y: t.clientY, px: panX.value, py: panY.value, time: Date.now() }
  dragging.value = scale.value === 1
  gesturing.value = scale.value !== 1
}

function onMove(e) {
  if (e.touches.length === 2 && pinch) {
    moved = true
    scale.value = Math.min(4, Math.max(1, (pinch.s * dist(e.touches)) / pinch.d))
    return
  }
  if (!start) return
  const t = e.touches[0]
  const dx = t.clientX - start.x
  const dy = t.clientY - start.y
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true
  if (scale.value > 1) {
    panX.value = start.px + dx
    panY.value = start.py + dy
  } else {
    dragX.value = dx
  }
}

function onEnd(e) {
  if (pinch && e.touches.length < 2) {
    pinch = null
    gesturing.value = false
    if (scale.value <= 1.02) resetZoom()
    start = null
    return
  }
  if (!start) return
  const dx = dragX.value
  const fast = Date.now() - start.time < 300 && Math.abs(dx) > 30
  if (scale.value === 1 && (Math.abs(dx) > window.innerWidth / 5 || fast)) {
    if (dx < 0 && index.value < preview.items.length - 1) index.value += 1
    else if (dx > 0 && index.value > 0) index.value -= 1
  }
  dragX.value = 0
  dragging.value = false
  gesturing.value = false
  start = null
}

function go(step) {
  const next = index.value + step
  if (next >= 0 && next < preview.items.length) index.value = next
}

// 电脑上的键盘：← → 切图（Esc 关弹层是 Overlays 里统一处理的）
function onKey(e) {
  if (!preview.visible) return
  if (e.key === 'ArrowLeft') go(-1)
  else if (e.key === 'ArrowRight') go(1)
  else return
  e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// 单击关闭，双击放大 / 还原
function onClick() {
  if (moved) return
  const now = Date.now()
  if (now - lastTap < 280) {
    clearTimeout(tapTimer)
    lastTap = 0
    if (scale.value > 1) resetZoom()
    else scale.value = 2.5
    return
  }
  lastTap = now
  tapTimer = setTimeout(() => {
    if (scale.value === 1) close()
  }, 280)
}
</script>
