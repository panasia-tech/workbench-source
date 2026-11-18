<template>
  <div class="fold">
    <div
      class="fh"
      role="button"
      tabindex="0"
      :aria-expanded="String(!!modelValue)"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <b>{{ title }}</b>
      <div class="chips">
        <slot name="chips" />
      </div>
      <Q v-if="help" :k="help" />
      <span class="tg">{{ modelValue ? '收起 ▴' : '展开 ▾' }}</span>
    </div>
    <div v-if="modelValue" class="fb">
      <slot />
    </div>
  </div>
</template>

<script setup>
import Q from './Q.vue';

const props = defineProps({
  title: { type: String, required: true },
  help: { type: String, default: '' },
  modelValue: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue']);

function toggle() {
  emit('update:modelValue', !props.modelValue);
}
</script>
