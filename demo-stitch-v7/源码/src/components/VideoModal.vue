<template>
  <div v-if="store.videoModal" class="mask" @click.self="store.videoModal = null">
    <div class="modal big">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3><Icon name="play" style="vertical-align:-4px;margin-right:6px;color:var(--acc)" />{{ store.videoModal.title }}</h3>
        <button class="btn sm" @click="store.videoModal = null">关闭</button>
      </div>
      <div class="vid-stage">
        <img :src="demoFrame" alt="实操视频关键帧示意" />
      </div>
      <p class="muted" style="font-size:13px">{{ store.videoModal.note || '按 SOP 录制的分段实操微课：公司网盘上传后在此配置固定播放链接。' }}</p>
    </div>
  </div>
</template>
<script setup>
import Icon from './Icon.vue'
import { store } from '../store/warehouseStore.js'
import { makeUnboxFrame } from '../data/mediaSvg.js'

const demoFrame = makeUnboxFrame({
  code: 'SOP-VIDEO-DEMO',
  waybill: '顶拍工位标准视角',
  recording: true,
  stage: '标准动作示范：先拍六面封口与运单 → 逐项全检 → 三种图归位'
})
</script>
<style scoped>
.vid-stage {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: #0f172a;
}
.vid-stage img { width: 100%; max-height: 340px; object-fit: contain; }
</style>
