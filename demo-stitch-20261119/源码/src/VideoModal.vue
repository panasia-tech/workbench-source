<template>
  <div v-if="ui.video" class="mask" @click.self="close">
    <div class="sheet">
      <div class="top"><h3>{{ ui.video.title }}</h3><button class="x" @click="close"><Icon name="close" /></button></div>
      <video v-if="!failed" :src="ui.video.src" controls autoplay playsinline @error="failed = true" @ended="done"></video>
      <div v-else class="miss">
        <p><b>视频文件现在打不开。</b></p>
        <p>这条视频放在外接盘 KAIXIA 里（<code>{{ ui.video.src }}</code>），盘没插上或文件被移走了。按 #95 的要求，没有真实资源就写「待补」，不编造链接：请业务把视频传到钉钉 Wiki / 公司网盘，再在这里配置链接。</p>
      </div>
      <p v-if="ui.video.note" class="note">{{ ui.video.note }}</p>
      <div class="foot"><button class="btn" @click="done">我看完了</button><span class="muted">看完会记进「学」里的进度</span></div>
    </div>
  </div>
</template>
<script setup>
import { ref, watch } from 'vue'
import Icon from './Icon.vue'
import { ui, toast } from './ui.js'
import { post } from './api.js'
const failed = ref(false)
watch(() => ui.video, () => (failed.value = false))
const close = () => (ui.video = null)
async function done() {
  if (ui.video?.key) { try { await post('/demo/watched', { key: ui.video.key }); toast('已记进学习进度') } catch { /* 记不上也不挡着看 */ } }
  close()
}
</script>
<style scoped>
.mask { position: fixed; inset: 0; background: rgba(8, 12, 22, .66); z-index: 80; display: flex; align-items: center; justify-content: center; padding: 28px; backdrop-filter: blur(4px); }
.sheet { background: var(--panel); border-radius: 26px; padding: 22px 24px; width: min(980px, 100%); box-shadow: var(--sh-up); }
.top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; } .top h3 { font-size: 18px; }
.x { width: 34px; height: 34px; border-radius: 50%; background: var(--soft); display: flex; align-items: center; justify-content: center; } .x svg { width: 18px; height: 18px; }
video { width: 100%; max-height: 62vh; border-radius: 16px; background: #000; }
.miss { background: var(--amb-soft); color: var(--amb-ink); border-radius: 16px; padding: 22px 24px; line-height: 1.6; } .miss code { font-size: 12px; word-break: break-all; }
.note { margin-top: 10px; font-size: 13px; color: var(--amb-ink); background: var(--amb-soft); border-radius: 10px; padding: 7px 12px; }
.foot { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
</style>
