<template>
  <!-- 1. 仓管高拍仪「一件一拍」通电实测视频可交互播放器弹窗 -->
  <div v-if="sku && sku.video" class="modal-mask" role="dialog" aria-modal="true" @click.self="closeVideo">
    <div class="video-dialog">
      <header class="vd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag grn">🎬 仓管高拍仪原片存档</span>
            <span class="tag acc">{{ sku.video.resolution }} · {{ sku.video.duration }}</span>
            <span class="tag">货号 {{ sku.skuCode }}</span>
          </div>
          <h3>{{ sku.video.title }}</h3>
        </div>
        <button type="button" class="btn sm" @click="closeVideo">
          <Icon name="close" size="15" /> 关闭预览
        </button>
      </header>

      <div class="vd-stage" :style="{ background: stageBg }">
        <div class="vd-hud-top">
          <span>● REC 高拍仪工位 WH01-CAM02</span>
          <span>原厂序列号：{{ sku.sn }}（与机身贴纸同框防调包）</span>
        </div>

        <div class="vd-center-visual">
          <div class="vd-screen-box" :style="{ background: screenColor }">
            <div class="vd-frame-badge">当前画面（{{ currentChapter.t }}）</div>
            <div class="vd-frame-title">{{ currentChapter.label }}</div>
            <div class="vd-sub">
              成色定级：{{ sku.grade }} ｜ 配件袋：{{ sku.bagCode }}
            </div>
          </div>
        </div>

        <div class="vd-controls">
          <button type="button" class="btn sm pri" @click="togglePlay">
            {{ playing ? '⏸ 暂停回放' : '▶ 播放高拍仪实测全片' }}
          </button>
          <div class="vd-bar" @click="jumpProgress">
            <div class="vd-bar-fill" :style="{ width: progressPct + '%' }" />
          </div>
          <span class="vd-time">{{ formattedSec }} / {{ sku.video.duration }}</span>
        </div>
      </div>

      <div class="vd-chapters">
        <div style="font-size: 12.5px; font-weight: 800; color: var(--mute)">
          视频强制五步披露关键帧（点击任意时间点跳看）：
        </div>
        <div class="chap-grid">
          <button
            v-for="(ch, idx) in sku.video.chapters"
            :key="idx"
            type="button"
            class="chap-btn"
            :class="{ active: activeChapIdx === idx }"
            @click="selectChapter(idx)"
          >
            <b>{{ ch.t }}</b>
            <span>{{ ch.label }}</span>
          </button>
        </div>
        <div class="channel-tip">
          📡 <b>发送通道保障：</b>{{ sku.video.channelMode }}（自动剥离库位图与采购单截图，100% 买家安全）
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 本机实拍照片高清灯箱预览 -->
  <div v-if="store.ui.photoPreviewUrl" class="modal-mask" role="dialog" aria-modal="true" @click.self="closePhoto">
    <div class="photo-dialog">
      <header class="vd-head">
        <h3>📷 {{ store.ui.photoPreviewTitle || '本机一物一码高清实拍预览' }}</h3>
        <button type="button" class="btn sm" @click="closePhoto">
          <Icon name="close" size="15" /> 关闭
        </button>
      </header>
      <div style="padding: 16px; background: #090d16; display: grid; place-items: center">
        <img :src="store.ui.photoPreviewUrl" alt="本机实拍大图" style="max-width: 100%; max-height: 68vh; border-radius: 12px" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { store } from '../store.js';
import Icon from './Icon.vue';

const playing = ref(false);
const sec = ref(0);
let timer = null;

const sku = computed(() => store.ui.videoModalSku);
const totalSec = computed(() => {
  const d = sku.value?.video?.duration || '00:15';
  const parts = d.split(':');
  return Number(parts[1] || 15);
});

const progressPct = computed(() => Math.min(100, Math.round((sec.value / totalSec.value) * 100)));
const formattedSec = computed(() => `00:${String(Math.min(totalSec.value, sec.value)).padStart(2, '0')}`);

const activeChapIdx = computed(() => {
  const chs = sku.value?.video?.chapters || [];
  let idx = 0;
  chs.forEach((c, i) => {
    const cSec = Number((c.t || '00:00').split(':')[1] || 0);
    if (sec.value >= cSec) idx = i;
  });
  return idx;
});

const currentChapter = computed(() => {
  const chs = sku.value?.video?.chapters || [{ t: '00:00', label: '整机实拍核验' }];
  return chs[activeChapIdx.value] || chs[0];
});

const screenColors = ['#0f172a', '#0284c7', '#15803d', '#b91c1c'];
const screenColor = computed(() => screenColors[activeChapIdx.value % screenColors.length]);
const stageBg = computed(() => 'linear-gradient(160deg, #090d16 0%, #172033 100%)');

function startTimer() {
  stopTimer();
  playing.value = true;
  timer = setInterval(() => {
    if (sec.value >= totalSec.value) {
      sec.value = 0;
      playing.value = false;
      stopTimer();
    } else {
      sec.value += 1;
    }
  }, 800);
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function togglePlay() {
  if (playing.value) {
    playing.value = false;
    stopTimer();
  } else {
    startTimer();
  }
}

function selectChapter(idx) {
  const ch = sku.value?.video?.chapters?.[idx];
  if (!ch) return;
  sec.value = Number((ch.t || '00:00').split(':')[1] || 0);
}

function jumpProgress(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  sec.value = Math.round(ratio * totalSec.value);
}

function closeVideo() {
  playing.value = false;
  stopTimer();
  store.ui.videoModalSku = null;
}

function closePhoto() {
  store.ui.photoPreviewUrl = null;
}

watch(sku, (v) => {
  sec.value = 0;
  if (v) startTimer();
  else stopTimer();
});

onBeforeUnmount(stopTimer);
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  background: rgba(9, 13, 22, 0.72);
  display: grid;
  place-items: center;
  padding: 24px;
}
.video-dialog {
  width: 780px;
  background: var(--panel);
  border-radius: 20px;
  border: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  overflow: hidden;
}
.photo-dialog {
  width: 720px;
  background: var(--panel);
  border-radius: 20px;
  border: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  overflow: hidden;
}
.vd-head {
  padding: 15px 20px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.vd-head h3 {
  font-size: 16px;
  margin-top: 5px;
}
.vd-stage {
  padding: 16px 20px;
  color: #f8fafc;
  display: grid;
  gap: 14px;
}
.vd-hud-top {
  display: flex;
  justify-content: space-between;
  font-family: monospace;
  font-size: 12px;
  color: #94a3b8;
}
.vd-center-visual {
  height: 240px;
  display: grid;
  place-items: center;
}
.vd-screen-box {
  width: 86%;
  height: 210px;
  border-radius: 14px;
  border: 2px solid rgba(255, 255, 255, 0.22);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  text-align: center;
  transition: background 0.35s ease;
}
.vd-frame-badge {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  font-weight: 700;
}
.vd-frame-title {
  font-size: 19px;
  font-weight: 900;
}
.vd-sub {
  font-size: 12.5px;
  opacity: 0.86;
}
.vd-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.vd-bar {
  flex: 1;
  height: 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  cursor: pointer;
  overflow: hidden;
}
.vd-bar-fill {
  height: 100%;
  background: #38bdf8;
  transition: width 0.25s linear;
}
.vd-time {
  font-family: monospace;
  font-size: 12.5px;
}
.vd-chapters {
  padding: 15px 20px 18px;
  display: grid;
  gap: 10px;
}
.chap-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.chap-btn {
  text-align: left;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.chap-btn b {
  color: var(--acc);
  font-family: monospace;
}
.chap-btn.active {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.channel-tip {
  font-size: 12px;
  color: var(--grn-ink);
  background: var(--grn-soft);
  padding: 8px 12px;
  border-radius: 9px;
}
</style>
