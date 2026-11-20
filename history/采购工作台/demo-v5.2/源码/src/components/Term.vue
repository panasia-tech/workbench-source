<template>
  <button
    type="button"
    class="term-btn"
    :title="`点击查看「${labelText}」的大白话解释`"
    @click.stop="openTerm(k, $event.currentTarget)"
  >
    <slot>{{ labelText }}</slot>
  </button>
</template>

<script setup>
import { computed } from 'vue';
import { GLOSSARY } from '../onboarding/glossary.js';
import { openTerm } from '../store.js';

const props = defineProps({
  k: { type: String, required: true },
});

const labelText = computed(() => GLOSSARY[props.k]?.t || props.k);
</script>

<style scoped>
.term-btn {
  display: inline;
  color: var(--acc);
  font-weight: 700;
  border-bottom: 1.5px dashed var(--acc);
  padding: 2px 1px;
  min-height: 28px;
  line-height: 1.45;
  border-radius: 3px;
}
.term-btn:hover {
  background: var(--acc-soft);
}
</style>
