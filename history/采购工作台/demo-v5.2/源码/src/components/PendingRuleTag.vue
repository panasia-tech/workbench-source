<template>
  <span class="tag" :class="cls">{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  code: { type: String, default: 'D' },
});

const META = {
  D: { t: 'D · 本机已实装', c: 'acc' },
  V: { t: 'V · 夹具待实机', c: '' },
  L: { t: 'L · 文档样例', c: '' },
  U: { t: 'U · 外部待联调', c: 'amb' },
  Q: { t: 'Q · 规则待拍板', c: 'amb' },
};

const label = computed(() => META[props.code]?.t || props.code);
const cls = computed(() => META[props.code]?.c || '');
</script>
