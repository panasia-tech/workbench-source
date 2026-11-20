<template>
  <button
    type="button"
    class="q-pill"
    :title="label || '点开查看当前步骤怎么用、防呆与考核说明'"
    @click.stop="store.ui.helpKey = k"
  >
    <span>?</span>
    <em v-if="label">{{ label }}</em>
  </button>
</template>

<script setup>
import { store } from '../store.js';

defineProps({
  k: { type: String, required: true },
  label: { type: String, default: '' },
});
</script>

<style scoped>
.q-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border-radius: 999px;
  background: var(--soft);
  border: 1px solid var(--line);
  color: var(--ink2);
  font-size: 12px;
  font-weight: 700;
}
.q-pill:hover {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: rgba(41, 82, 255, 0.35);
}
.q-pill span {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--acc);
  color: #fff;
  font-size: 11px;
  font-weight: 900;
  display: inline-grid;
  place-items: center;
}
.q-pill em {
  font-style: normal;
}
</style>
