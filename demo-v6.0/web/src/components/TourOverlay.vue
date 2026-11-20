<template>
  <div
    v-if="store.tourState.active && currentStep"
    style="position: fixed; bottom: 24px; right: 24px; z-index: 160; width: 390px; max-width: calc(100vw - 32px); background: #0f172a; color: #f8fafc; border-radius: 14px; padding: 16px 18px; box-shadow: 0 20px 44px rgba(0,0,0,0.34); border: 2px solid #f59e0b;"
  >
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
      <span class="tag amb">🧭 交互引导 第 {{ store.tourState.stepIndex + 1 }} / {{ steps.length }} 步</span>
      <button class="btn btn-sm" style="background: #1e293b; color: #cbd5e1; border-color: #334155;" @click="endTour">结束引导</button>
    </div>
    <div style="font-size: 15px; font-weight: 700; margin-bottom: 4px;">{{ currentStep.title }}</div>
    <div style="font-size: 13px; color: #cbd5e1; margin-bottom: 12px;">{{ currentStep.text }}</div>
    <div style="display: flex; justify-content: space-between;">
      <button class="btn btn-sm" :disabled="store.tourState.stepIndex === 0" @click="goStep(-1)">上一步</button>
      <button v-if="store.tourState.stepIndex < steps.length - 1" class="btn btn-sm btn-primary" @click="goStep(1)">下一步 →</button>
      <button v-else class="btn btn-sm btn-primary" @click="endTour">✓ 我学会了</button>
    </div>
  </div>
</template>

<script setup>
import { computed, watch, onUnmounted } from 'vue';
import { store } from '../store/store.js';
import { PAGE_TOURS } from '../data/tutorials.js';

const steps = computed(() => PAGE_TOURS[store.tourState.pageKey] || PAGE_TOURS.home);
const currentStep = computed(() => steps.value[store.tourState.stepIndex] || null);

function clearHighlights() {
  document.querySelectorAll('.tour-spotlight').forEach((el) => el.classList.remove('tour-spotlight'));
}

function applyHighlight() {
  clearHighlights();
  if (!store.tourState.active || !currentStep.value) return;
  const el = document.querySelector(`[data-tour="${currentStep.value.target}"]`);
  if (el) {
    el.classList.add('tour-spotlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function goStep(delta) {
  const next = store.tourState.stepIndex + delta;
  if (next >= 0 && next < steps.value.length) {
    store.tourState.stepIndex = next;
  }
}

function endTour() {
  clearHighlights();
  store.tourState.active = false;
}

watch(
  () => [store.tourState.active, store.tourState.pageKey, store.tourState.stepIndex],
  () => setTimeout(applyHighlight, 80),
  { immediate: true }
);

onUnmounted(clearHighlights);
</script>
