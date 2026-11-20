<template>
  <div v-if="store.videoModal.open" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-box" style="max-width: 1020px;">
      <div class="card-header" style="margin-bottom: 10px;">
        <div>
          <h3 class="card-title" style="font-size: 17px;">内置分章演示视频</h3>
          <div class="muted">全长约 2 分半 · 覆盖登录防锁 / 监控融合 / 5%红标拦截 / 对账补抓 / 10m拒签 / 十二奇兵 / 两段10%提成</div>
        </div>
        <button class="btn btn-sm" @click="closeModal">✕ 关闭</button>
      </div>

      <div style="background: #0f172a; border-radius: 10px; overflow: hidden; margin-bottom: 12px; position: relative;">
        <video
          ref="videoEl"
          controls
          preload="metadata"
          playsinline
          style="width: 100%; max-height: 460px; display: block;"
          :src="'/media/tutorial-v6.mp4'"
          @loadedmetadata="onMetaLoaded"
          @timeupdate="onTimeUpdate"
          @error="videoError = true"
        ></video>
        <div
          v-if="videoError"
          style="padding: 28px; color: #cbd5e1; text-align: center; font-size: 13px;"
        >
          正在加载 / 合成 `/media/tutorial-v6.mp4` 视频流…… 如本地刚初始化服务请稍候刷新重试，也可先点击下方章节查看同步文字讲义。
        </div>
      </div>

      <div class="grid grid-2" style="gap: 8px;">
        <div
          v-for="ch in VIDEO_CHAPTERS"
          :key="ch.id"
          @click="seekChapter(ch)"
          style="border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; cursor: pointer; transition: all 0.14s;"
          :style="activeChapter === ch.id ? 'background: #ecfdf5; border-color: #0f766e;' : 'background: #f8fafc;'"
        >
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <strong style="font-size: 13px; color: #0f172a;">{{ ch.title }}</strong>
            <span class="tag slate num">{{ formatTime(ch.startSec) }}</span>
          </div>
          <div class="muted" style="margin-top: 3px;">{{ ch.summary }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { store } from '../store/store.js';
import { VIDEO_CHAPTERS } from '../data/tutorials.js';

const videoEl = ref(null);
const videoError = ref(false);
const activeChapter = ref(store.videoModal.chapterId || 'ch1');

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function seekChapter(ch) {
  activeChapter.value = ch.id;
  if (videoEl.value) {
    videoEl.value.currentTime = ch.startSec;
    videoEl.value.play().catch(() => {});
  }
}

function onMetaLoaded() {
  videoError.value = false;
  if (store.videoModal.startSec > 0 && videoEl.value) {
    videoEl.value.currentTime = store.videoModal.startSec;
  }
}

function onTimeUpdate() {
  if (!videoEl.value) return;
  const cur = videoEl.value.currentTime;
  for (let i = VIDEO_CHAPTERS.length - 1; i >= 0; i -= 1) {
    if (cur >= VIDEO_CHAPTERS[i].startSec) {
      activeChapter.value = VIDEO_CHAPTERS[i].id;
      break;
    }
  }
}

function closeModal() {
  if (videoEl.value) {
    videoEl.value.pause();
  }
  store.videoModal.open = false;
}

watch(
  () => store.videoModal.open,
  (isOpen) => {
    if (isOpen) {
      videoError.value = false;
      activeChapter.value = store.videoModal.chapterId || 'ch1';
    }
  }
);
</script>
