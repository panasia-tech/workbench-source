<template>
  <section class="fold">
    <div class="fh" role="button" tabindex="0" :aria-expanded="open" @click="toggle" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <b>{{ title }}</b><Q v-if="help" :k="help" />
      <span class="chips"><slot name="chips" /></span>
      <span class="tg">{{ open ? '收起' : '展开' }}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" :style="{ transform: open ? 'rotate(180deg)' : 'none' }"><path d="M6 9l6 6 6-6" /></svg></span>
    </div>
    <div v-show="open" class="fb"><slot /></div>
  </section>
</template>
<script setup>
import { computed } from 'vue'
import Q from './Q.vue'
const props = defineProps({ modelValue: Boolean, title: { type: String, default: '更多详情' }, help: String })
const emit = defineEmits(['update:modelValue'])
const open = computed(() => props.modelValue)
const toggle = () => emit('update:modelValue', !props.modelValue)
</script>
