<template>
  <div v-if="t" class="mask" @click.self="close">
    <div class="box" role="dialog">
      <p class="g">{{ t.g }} · 名词解释</p>
      <h3>{{ ui.term }}</h3>
      <p class="d">{{ t.d }}</p>
      <div class="r"><a @click="more">全部名词和说明书 ›</a><button class="btn pri sm" @click="close">知道了</button></div>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { ui } from './ui.js'
import { GLOSSARY } from './glossary.js'
const t = computed(() => GLOSSARY[ui.term])
const close = () => (ui.term = null)
const more = () => { const k = ui.term; ui.term = null; location.hash = '#/manual?t=' + encodeURIComponent(k) }
</script>
<style scoped>
.mask { position: fixed; inset: 0; z-index: 85; background: rgba(8, 12, 22, .45); display: flex; align-items: center; justify-content: center; padding: 20px; }
.box { width: min(460px, 100%); background: var(--panel); border-radius: 20px; padding: 22px 24px; box-shadow: var(--sh-up); }
.g { font-size: 12.5px; color: var(--mute); margin: 0; } h3 { margin: 4px 0 8px; font-size: 22px; } .d { line-height: 1.7; margin: 0; color: var(--ink2); }
.r { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; }
</style>
