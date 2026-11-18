<template>
  <div v-if="store.tour" class="tour-layer" role="dialog" aria-label="本页导览">
    <div v-if="rect" class="ring" :style="ringStyle"></div>
    <div v-else class="shade"></div>
    <div class="pop" :style="popStyle" ref="pop">
      <p class="cnt">本页导览 · 第 {{ n }} / {{ total }} 步</p>
      <h3>{{ step?.t }}</h3>
      <p>{{ step?.d }}</p>
      <p class="note">只做真实控件高亮说明，不会替你点任何业务按钮。</p>
      <div class="row">
        <button class="btn sm" @click="close">关闭导览</button>
        <span class="sp"></span>
        <button class="btn sm" :disabled="idx <= 0" @click="move(-1)">上一步</button>
        <button class="btn pri sm" @click="next">{{ last ? '完成' : '下一步' }}</button>
      </div>
    </div>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { store, TOURS, notify } from '../store/warehouseStore.js'

const idx = ref(0)
const rect = ref(null)
const pop = ref(null)
const popPos = ref({ top: 90, left: 90 })
const steps = computed(() => TOURS[store.tour?.page] || [])
const step = computed(() => steps.value[idx.value])
const total = computed(() => steps.value.length)
const n = computed(() => idx.value + 1)
const last = computed(() => idx.value >= steps.value.length - 1)

const find = (s) => (s ? document.querySelector(s.sel) : null)

async function place() {
  const el = find(step.value)
  if (!el) {
    close()
    return
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise(r => setTimeout(r, 240))
  measure()
}

function measure() {
  const el = find(step.value)
  if (!el) { rect.value = null; return }
  const r = el.getBoundingClientRect()
  rect.value = { top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 }
  nextTick(() => {
    const ph = pop.value?.offsetHeight || 190
    const pw = 350
    const vw = innerWidth
    const vh = innerHeight
    const below = rect.value.top + rect.value.height + 14
    let top = below + ph < vh - 16 ? below : rect.value.top - ph - 14
    if (top < 16) top = 24
    let left = Math.min(Math.max(16, rect.value.left), vw - pw - 16)
    if (rect.value.height > vh * 0.65) { top = vh - ph - 24; left = vw - pw - 24 }
    popPos.value = { top, left }
  })
}

const ringStyle = computed(() => ({
  top: rect.value.top + 'px',
  left: rect.value.left + 'px',
  width: rect.value.width + 'px',
  height: rect.value.height + 'px'
}))
const popStyle = computed(() => ({ top: popPos.value.top + 'px', left: popPos.value.left + 'px' }))

function move(d) {
  const j = idx.value + d
  if (j < 0 || j >= steps.value.length) return
  idx.value = j
  place()
}
function next() {
  if (last.value) {
    store.tour = null
    notify('本页导览看完了，随时可在「怎么用」里重看', 'ok')
    return
  }
  move(1)
}
function close() { store.tour = null }
function onKey(e) { if (store.tour && e.key === 'Escape') close() }
const onMove = () => store.tour && measure()

watch(() => store.tour, (t) => {
  if (t) { idx.value = t.i || 0; nextTick(place) } else rect.value = null
})
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onMove)
  window.removeEventListener('scroll', onMove, true)
})
</script>
<style scoped>
.tour-layer { position: fixed; inset: 0; z-index: 95; pointer-events: none; }
.ring {
  position: fixed;
  border-radius: 12px;
  box-shadow: 0 0 0 9999px rgba(15, 23, 42, .52), 0 0 0 3px var(--acc);
  transition: all .24s ease;
}
.shade { position: fixed; inset: 0; background: rgba(15, 23, 42, .52); }
.pop {
  position: fixed;
  width: 350px;
  background: var(--panel);
  color: var(--ink);
  border-radius: var(--r);
  padding: 16px 18px;
  box-shadow: var(--sh-up);
  pointer-events: auto;
}
.cnt { font-size: 12px; color: var(--acc); font-weight: 700; margin-bottom: 4px; }
.pop h3 { font-size: 17px; margin-bottom: 6px; }
.pop p { font-size: 13.5px; color: var(--ink2); line-height: 1.55; }
.note { margin-top: 8px !important; font-size: 12px !important; color: var(--mute) !important; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.sp { flex: 1; }
</style>
