<template>
  <div class="mp-wheel" :style="{ height: `${itemHeight * 5}px` }">
    <div ref="el" class="mp-wheel__scroll">
      <div :style="{ height: `${itemHeight * 2}px` }" />
      <div
        v-for="(label, i) in items"
        :key="i"
        class="mp-wheel__item"
        :class="{ 'mp-wheel__item--on': i === modelValue }"
        :style="{ height: `${itemHeight}px`, lineHeight: `${itemHeight}px` }"
        @click="pick(i)"
      >{{ label }}</div>
      <div :style="{ height: `${itemHeight * 2}px` }" />
    </div>
    <div class="mp-wheel__mask" />
    <div class="mp-wheel__indicator" :style="{ top: `${itemHeight * 2}px`, height: `${itemHeight}px` }" />
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createWheel } from './wheel.js'

const props = defineProps({
  items: { type: Array, default: () => [] },
  modelValue: { type: Number, default: 0 },
  itemHeight: { type: Number, default: 44 },
})
const emit = defineEmits(['update:modelValue'])
const el = ref(null)
let wheel = null

function pick(i) {
  wheel.scrollTo(i, true)
  emit('update:modelValue', i)
}

onMounted(() => {
  wheel = createWheel(el.value, {
    itemHeight: () => props.itemHeight,
    onSettle: (i) => emit('update:modelValue', Math.min(i, Math.max(props.items.length - 1, 0))),
  })
  nextTick(() => wheel.scrollTo(props.modelValue))
})

watch(() => props.modelValue, (v) => {
  if (wheel && wheel.current() !== v) wheel.scrollTo(v)
})
watch(() => props.items, () => nextTick(() => wheel && wheel.scrollTo(props.modelValue)))

onBeforeUnmount(() => wheel && wheel.destroy())
</script>
