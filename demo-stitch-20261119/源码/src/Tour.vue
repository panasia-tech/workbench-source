<template>
  <div v-if="ui.tour" class="tour-layer" role="dialog" aria-label="导览">
    <div v-if="rect" class="ring" :style="ringStyle"></div>
    <div v-else class="shade"></div>
    <div class="pop" :style="popStyle" ref="pop">
      <p class="cnt">导览 · 第 {{ n }} / {{ total }} 步</p>
      <h3>{{ step?.t }}</h3>
      <p>{{ step?.d }}</p>
      <p class="note">只是高亮和说明，不会替你点任何按钮。</p>
      <div class="row">
        <button class="btn sm" @click="skip">跳过</button>
        <span class="sp"></span>
        <button class="btn sm" :disabled="idx <= 0" @click="go(-1)">上一步</button>
        <button class="btn pri sm" @click="next">{{ last ? '完成' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ui, toast } from './ui.js'
import { TOURS, saveTourPos } from './tour.js'

const idx = ref(0)
const rect = ref(null)
const pop = ref(null)
const popPos = ref({ top: 80, left: 80 })
const steps = computed(() => TOURS[ui.tour?.page] || [])
const step = computed(() => steps.value[idx.value])
const total = computed(() => steps.value.length)
const n = computed(() => idx.value + 1)
const last = computed(() => idx.value >= steps.value.length - 1)

const find = (s) => (s ? document.querySelector(s.sel) : null)
async function place(dir = 1) {
  // 找不到控件就往前/往后跳到下一个能找到的
  let guard = 0
  while (step.value && !find(step.value) && guard++ < steps.value.length) {
    const j = idx.value + dir
    if (j < 0 || j >= steps.value.length) { if (dir < 0) { dir = 1; continue } return finish(true) }
    idx.value = j
  }
  const el = find(step.value)
  if (!el) return finish(true)
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((r) => setTimeout(r, 320))
  measure()
}
function measure() {
  const el = find(step.value)
  if (!el) { rect.value = null; return }
  const r = el.getBoundingClientRect()
  rect.value = { top: r.top - 8, left: r.left - 8, width: r.width + 16, height: r.height + 16 }
  nextTick(() => {
    const ph = pop.value?.offsetHeight || 200, pw = 340, vw = innerWidth, vh = innerHeight
    const below = rect.value.top + rect.value.height + 14
    let top = below + ph < vh - 12 ? below : rect.value.top - ph - 14
    if (top < 12) top = Math.min(vh - ph - 12, Math.max(12, rect.value.top + 20))
    let left = Math.min(Math.max(16, rect.value.left), vw - pw - 16)
    // 目标太大（盖住整屏）时，把说明放到右下，不压在目标正中
    if (rect.value.height > vh * 0.7) { top = vh - ph - 24; left = vw - pw - 24 }
    popPos.value = { top, left }
  })
}
const ringStyle = computed(() => ({ top: rect.value.top + 'px', left: rect.value.left + 'px', width: rect.value.width + 'px', height: rect.value.height + 'px' }))
const popStyle = computed(() => ({ top: popPos.value.top + 'px', left: popPos.value.left + 'px' }))

function go(d) { const j = idx.value + d; if (j < 0 || j >= steps.value.length) return; idx.value = j; place(d) }
function next() { if (last.value) return finish(false); go(1) }
function skip() { saveTourPos(ui.tour.page, idx.value); ui.tour = null; toast('导览先放着，「怎么用」里可以接着看') }
function finish(missing) { saveTourPos(ui.tour.page, null); ui.tour = null; if (!missing) toast('导览看完了。随时可以在「怎么用」里重看') }
function onKey(e) { if (!ui.tour) return; if (e.key === 'Escape') skip(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') go(-1) }
const onMove = () => ui.tour && measure()
const onHash = () => { if (ui.tour) ui.tour = null }

watch(() => ui.tour, (t) => { if (t) { idx.value = Math.min(t.i || 0, Math.max(0, steps.value.length - 1)); nextTick(() => place(1)) } else rect.value = null }, { immediate: true })
onMounted(() => { window.addEventListener('keydown', onKey); window.addEventListener('hashchange', onHash); window.addEventListener('resize', onMove); window.addEventListener('scroll', onMove, true) })
onUnmounted(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); window.removeEventListener('resize', onMove); window.removeEventListener('scroll', onMove, true) })
</script>
<style scoped>
.tour-layer { position: fixed; inset: 0; z-index: 80; pointer-events: none; }
.ring { position: fixed; border-radius: 18px; box-shadow: 0 0 0 9999px rgba(6, 10, 20, .58), 0 0 0 3px var(--acc); transition: all .28s ease; pointer-events: none; }
.shade { position: fixed; inset: 0; background: rgba(6, 10, 20, .58); }
.pop { position: fixed; width: 340px; max-width: calc(100vw - 32px); background: var(--panel); color: var(--ink); border-radius: 18px; padding: 18px 20px; box-shadow: var(--sh-up); pointer-events: auto; transition: top .28s ease, left .28s ease; }
.cnt { margin: 0 0 6px; font-size: 12px; color: var(--mute); }
.pop h3 { margin: 0 0 6px; font-size: 18px; } .pop p { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--ink2); }
.note { margin-top: 8px !important; font-size: 12px !important; color: var(--mute) !important; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 14px; } .sp { flex: 1; }
</style>
