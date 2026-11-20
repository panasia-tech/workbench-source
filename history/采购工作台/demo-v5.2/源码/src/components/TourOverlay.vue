<template>
  <div v-if="curTour && step" class="tour-layer" role="dialog" aria-modal="true" aria-label="步进式页面导览">
    <div class="tour-backdrop" @click="pauseAndClose" />
    <div v-if="box" class="tour-spot" :style="spotStyle" />

    <div class="tour-card" :style="cardStyle">
      <div class="tour-top">
        <span class="tag acc">{{ curTour.title }} · {{ idx + 1 }} / {{ total }}</span>
        <button type="button" class="btn sm" @click="pauseAndClose">稍后继续 ×</button>
      </div>
      <h4>{{ step.title }}</h4>
      <p>{{ step.body }}</p>
      <div class="tour-acts">
        <button type="button" class="btn sm" :disabled="idx === 0" @click="go(-1)">← 上一步</button>
        <button v-if="idx < total - 1" type="button" class="btn sm pri" @click="go(1)">下一步 →</button>
        <button v-else type="button" class="btn sm ok" @click="finish">看懂了，完成导览 ✓</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../store.js';
import { TOURS, saveTourPos } from '../onboarding/tourSteps.js';

const box = ref(null);

const pageKey = computed(() => store.ui.tour?.page || null);
const curTour = computed(() => (pageKey.value ? TOURS[pageKey.value] || null : null));
const idx = computed(() => store.ui.tour?.i || 0);
const total = computed(() => curTour.value?.steps?.length || 0);
const step = computed(() => curTour.value?.steps?.[idx.value] || null);

const spotStyle = computed(() => {
  if (!box.value) return {};
  const b = box.value;
  return {
    top: `${Math.max(4, b.top - 6)}px`,
    left: `${Math.max(4, b.left - 6)}px`,
    width: `${b.width + 12}px`,
    height: `${b.height + 12}px`,
  };
});

const cardStyle = computed(() => {
  if (!box.value) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const b = box.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(390, vw - 24);
  const left = Math.max(12, Math.min(b.left, vw - cardW - 12));
  const below = b.bottom + 14;
  if (below + 210 < vh) {
    return { top: `${below}px`, left: `${left}px`, width: `${cardW}px` };
  }
  return { top: `${Math.max(12, b.top - 210)}px`, left: `${left}px`, width: `${cardW}px` };
});

async function locateTarget() {
  await nextTick();
  if (!step.value?.target) {
    box.value = null;
    return;
  }
  const el = document.querySelector(step.value.target);
  if (!el) {
    box.value = null;
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  box.value = { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
}

function go(delta) {
  const next = Math.max(0, Math.min(total.value - 1, idx.value + delta));
  store.ui.tour = { page: pageKey.value, i: next };
  saveTourPos(pageKey.value, next);
}

function pauseAndClose() {
  if (pageKey.value) saveTourPos(pageKey.value, idx.value);
  store.ui.tour = null;
}

function finish() {
  if (pageKey.value) saveTourPos(pageKey.value, 0);
  store.ui.tour = null;
}

function onKey(e) {
  if (!store.ui.tour) return;
  if (e.key === 'Escape') pauseAndClose();
  else if (e.key === 'ArrowRight' && idx.value < total.value - 1) go(1);
  else if (e.key === 'ArrowLeft' && idx.value > 0) go(-1);
}

watch(() => [store.ui.tour?.page, store.ui.tour?.i], locateTarget, { immediate: true });
onMounted(() => {
  window.addEventListener('resize', locateTarget);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', locateTarget);
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
.tour-layer {
  position: fixed;
  inset: 0;
  z-index: 105;
}
.tour-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(6, 10, 18, 0.58);
}
.tour-spot {
  position: fixed;
  border: 3px solid var(--acc);
  border-radius: 16px;
  box-shadow: 0 0 0 9999px rgba(6, 10, 18, 0.52);
  pointer-events: none;
  z-index: 106;
}
.tour-card {
  position: fixed;
  z-index: 107;
  background: var(--panel);
  border: 1.5px solid var(--acc);
  border-radius: 20px;
  box-shadow: var(--sh-up);
  padding: 18px 20px;
  display: grid;
  gap: 10px;
}
.tour-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.tour-card h4 {
  font-size: 17px;
  font-weight: 800;
}
.tour-card p {
  font-size: 14px;
  color: var(--ink2);
  line-height: 1.55;
}
.tour-acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
