<template>
  <div class="fold-box" :class="{ open: isOpen }">
    <button
      type="button"
      class="fold-head"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
    >
      <span class="fold-arrow">{{ isOpen ? '▾' : '▸' }}</span>
      <b class="fold-title">{{ title }}</b>
      <span v-if="chip" class="fold-chip" :class="chipTone">{{ chip }}</span>
    </button>
    <div v-if="isOpen" class="fold-body">
      <slot />
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  title: { type: String, required: true },
  chip: { type: String, default: '' },
  chipTone: { type: String, default: '' }, // '' | 'ok' | 'warn' | 'pri'
  defaultOpen: { type: Boolean, default: false },
});

const isOpen = ref(props.defaultOpen);
watch(
  () => props.defaultOpen,
  (v) => {
    isOpen.value = v;
  },
);
</script>

<style scoped>
.fold-box {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  overflow: hidden;
  transition: border-color 0.14s;
}
.fold-box.open {
  border-color: rgba(22, 119, 255, 0.42);
}
.fold-head {
  width: 100%;
  min-height: 38px;
  padding: 7px 11px;
  display: flex;
  align-items: center;
  gap: 7px;
  text-align: left;
  background: var(--panel-alt);
  font-size: 12.5px;
}
.fold-head:hover {
  background: var(--soft);
}
.fold-arrow {
  color: var(--mute);
  font-size: 12px;
  width: 12px;
  flex-shrink: 0;
}
.fold-title {
  font-weight: 700;
  color: var(--ink);
}
.fold-chip {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: var(--soft);
  color: var(--ink2);
  white-space: nowrap;
}
.fold-chip.ok {
  background: var(--grn-soft);
  color: #00801e;
}
.fold-chip.warn {
  background: var(--red-soft);
  color: var(--red);
}
.fold-chip.pri {
  background: var(--pri-soft);
  color: var(--pri);
}
.fold-body {
  padding: 12px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 9px;
}
</style>
