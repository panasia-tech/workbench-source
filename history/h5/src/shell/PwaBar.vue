<template>
  <Transition name="mp-fade">
    <div v-if="!pwa.online" class="mp-pwa-offline" role="status">网络断了，连上之前提交不了</div>
  </Transition>
  <Transition name="mp-fade">
    <div v-if="pwa.needRefresh && !dismissed" class="mp-pwa-update" role="status">
      <span>有新版本</span>
      <button type="button" class="mp-pwa-update__ok" @click="pwa.update && pwa.update()">更新</button>
      <button type="button" class="mp-pwa-update__later" aria-label="稍后" @click="dismissed = true">稍后</button>
    </div>
  </Transition>
</template>

<script setup>
import { ref } from 'vue'
import { pwa } from '../pwa/state.js'

const dismissed = ref(false)
</script>
