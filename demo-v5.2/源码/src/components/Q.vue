<template>
  <button
    type="button"
    class="qbtn"
    :aria-label="label || '这里怎么用'"
    :title="label || '点开看这一块的步骤、防呆与制度'"
    @click.stop="openHelp(k, $event.currentTarget)"
  >
    <span class="qpill" aria-hidden="true">?</span>
  </button>
</template>

<script setup>
import { openHelp } from '../store.js';

defineProps({
  k: { type: String, required: true },
  label: { type: String, default: '' },
});
</script>

<style scoped>
.qbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  margin: -9px -6px;
  border-radius: 999px;
  vertical-align: middle;
  flex: none;
}
.qpill {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--acc-soft);
  color: var(--acc);
  border: 1px solid rgba(108, 135, 255, 0.35);
  font-size: 13px;
  font-weight: 800;
  display: grid;
  place-items: center;
  transition: transform 0.12s, background 0.12s;
}
.qbtn:hover .qpill {
  background: var(--acc);
  color: #fff;
  transform: scale(1.06);
}
</style>
