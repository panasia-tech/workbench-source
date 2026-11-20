<template>
  <div v-if="route" class="tr-layer" role="dialog" aria-label="新手导览">
    <div v-if="rect" class="tr-ring" :style="ringStyle"></div>
    <div v-else class="tr-shade"></div>
    <div ref="pop" class="tr-pop" :style="popStyle">
      <p class="tr-cnt">新手导览 · 第 {{ idx + 1 }} / {{ steps.length }} 步</p>
      <h3>{{ step && step.t }}</h3>
      <p>{{ step && step.d }}</p>
      <p class="tr-note">只是高亮和说明，不会替你点任何按钮。</p>
      <div class="tr-row">
        <button type="button" class="tr-btn" @click="skip">跳过</button>
        <span class="tr-sp"></span>
        <button type="button" class="tr-btn" :disabled="idx <= 0" @click="go(-1)">上一步</button>
        <button type="button" class="tr-btn tr-btn--pri" @click="next">{{ last ? '完成' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { topEntry } from '../runtime/router.js'
import { showToast } from '../runtime/ui.js'
import { isDesktop } from '../runtime/viewport.js'
import { TOURS, resetTours, saveTour, tourPos, tourSeen } from './tours.js'

// 第一次进「今天」「库存商品」「一件货」自动走一遍；之后点页面上的「怎么用」（发 mp:tour）重看。
// 只找当前这一页里的控件（底下压着的页面也在 DOM 里）
const route = ref('')
const idx = ref(0)
const rect = ref(null)
const pop = ref(null)
const popPos = ref({ top: 80, left: 80 })
const steps = computed(() => TOURS[route.value] || [])
const step = computed(() => steps.value[idx.value])
const last = computed(() => idx.value >= steps.value.length - 1)

const visible = (el) => el && el.getClientRects().length > 0
function find(s) {
  if (!s) return null
  const root = document.querySelector('.mp-host--active') || document
  for (const sel of s.sel.split(',')) {
    // 协同请求浮层不在页面里，到整个文档里找
    const scope = sel.trim().startsWith('.cb') ? document : root
    const el = [...scope.querySelectorAll(sel.trim())].find(visible)
    if (el) return el
  }
  return null
}

async function place(dir = 1) {
  let guard = 0
  while (step.value && !find(step.value) && guard++ <= steps.value.length) {
    const j = idx.value + dir
    if (j < 0) { dir = 1; continue }
    if (j >= steps.value.length) return finish()
    idx.value = j
  }
  const el = find(step.value)
  if (!el) return finish()
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((r) => setTimeout(r, 320))
  measure()
}

function measure() {
  const el = find(step.value)
  if (!el) { rect.value = null; return }
  const r = el.getBoundingClientRect()
  rect.value = { top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 }
  nextTick(() => {
    const ph = (pop.value && pop.value.offsetHeight) || 200
    const pw = Math.min(340, innerWidth - 32)
    const below = rect.value.top + rect.value.height + 12
    let top = below + ph < innerHeight - 12 ? below : rect.value.top - ph - 12
    if (top < 12) top = Math.min(innerHeight - ph - 12, Math.max(12, rect.value.top + 20))
    let left = Math.min(Math.max(16, rect.value.left), innerWidth - pw - 16)
    if (rect.value.height > innerHeight * 0.7) { top = innerHeight - ph - 24; left = innerWidth - pw - 16 }
    popPos.value = { top, left }
  })
}

const ringStyle = computed(() => ({ top: `${rect.value.top}px`, left: `${rect.value.left}px`, width: `${rect.value.width}px`, height: `${rect.value.height}px` }))
const popStyle = computed(() => ({ top: `${popPos.value.top}px`, left: `${popPos.value.left}px` }))

function start(r, at = 0) {
  if (!TOURS[r]) return
  route.value = r
  idx.value = Math.min(at, TOURS[r].length - 1)
  nextTick(() => place(1))
}
function go(d) {
  const j = idx.value + d
  if (j < 0 || j >= steps.value.length) return
  idx.value = j
  place(d)
}
function next() {
  if (last.value) {
    finish()
    showToast({ title: `导览看完了，点「${isDesktop.value ? '怎么用' : '?'}」随时重看`, icon: 'none' })
  } else go(1)
}
function skip() {
  saveTour(route.value, idx.value)
  route.value = ''
  showToast({ title: `先放着，点「${isDesktop.value ? '怎么用' : '?'}」接着看`, icon: 'none' })
}
function finish() {
  saveTour(route.value, 0)
  route.value = ''
  rect.value = null
}

// 第一次进：等页面数据出来（第一步的控件出现）再开始，最多等 8 秒
let waitTimer = 0
function autoStart(r) {
  clearInterval(waitTimer)
  if (!TOURS[r] || tourSeen(r)) return
  let n = 0
  waitTimer = setInterval(() => {
    const t = topEntry()
    if (!t || t.route !== r || ++n > 40) { clearInterval(waitTimer); return }
    if (find(TOURS[r][0])) { clearInterval(waitTimer); setTimeout(() => { if (!route.value) start(r) }, 400) }
  }, 200)
}
watch(() => { const t = topEntry(); return t ? `${t.id}|${t.route}` : '' }, (k) => {
  if (route.value) { route.value = ''; rect.value = null } // 换页就收起
  autoStart(k.split('|')[1])
}, { immediate: true })

const onTour = () => { const t = topEntry(); if (t) start(t.route, tourPos(t.route)) }
const onReset = () => resetTours()
const onKey = (e) => {
  if (!route.value) return
  if (e.key === 'Escape') skip()
  if (e.key === 'ArrowRight') next()
  if (e.key === 'ArrowLeft') go(-1)
}
const onMove = () => { if (route.value) measure() }
onMounted(() => {
  window.addEventListener('mp:tour', onTour)
  window.addEventListener('mp:tour-reset', onReset)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
})
onBeforeUnmount(() => {
  clearInterval(waitTimer)
  window.removeEventListener('mp:tour', onTour)
  window.removeEventListener('mp:tour-reset', onReset)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
})
</script>

<style scoped>
.tr-layer { position: fixed; inset: 0; z-index: 90; pointer-events: none; }
.tr-ring { position: fixed; border-radius: 14px; box-shadow: 0 0 0 9999px rgba(6, 10, 20, .55), 0 0 0 3px #2563eb; transition: all .28s ease; }
.tr-shade { position: fixed; inset: 0; background: rgba(6, 10, 20, .55); }
.tr-pop { box-sizing: border-box; position: fixed; width: 340px; max-width: calc(100vw - 32px); background: #fff; color: #111827; border-radius: 16px; padding: 16px 18px; box-shadow: 0 12px 32px rgba(15, 23, 42, .25); pointer-events: auto; transition: top .28s ease, left .28s ease; }
.tr-cnt { margin: 0 0 6px; font-size: 12px; color: #6b7280; }
.tr-pop h3 { margin: 0 0 6px; font-size: 17px; }
.tr-pop p { margin: 0; font-size: 14px; line-height: 1.6; color: #374151; }
.tr-pop .tr-note { margin-top: 8px; font-size: 12px; color: #9ca3af; }
.tr-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.tr-sp { flex: 1; }
.tr-btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #374151; font-size: 13px; cursor: pointer; }
.tr-btn--pri { border-color: #2563eb; background: #2563eb; color: #fff; }
.tr-btn:disabled { opacity: .4; cursor: not-allowed; }
</style>
