<template>
  <div>
    <!-- 顶部直接内嵌高清视频播放器 -->
    <div class="card" style="margin-bottom: 14px;">
      <div class="card-header">
        <div>
          <h3 class="card-title" style="font-size: 17px;">🎬 内置系统操作与防踩坑实景视频教程（贺育诚原声解说 · 手绘标注 + 真实页面演练）</h3>
          <div class="muted">视频直接托管于本系统 `/media/tutorial-v6.mp4`（支持 HTTP 206 秒速拖拽与章节定位），点击右侧章节卡片立即跳转。</div>
        </div>
        <button class="btn btn-sm btn-primary" @click="openVideoTutorial('ch1', 0)">⛶ 大弹窗聚焦播放</button>
      </div>

      <div class="grid grid-2" style="gap: 16px; align-items: start;">
        <div style="background: #0f172a; border-radius: 10px; overflow: hidden;">
          <video
            ref="inlineVideo"
            controls
            preload="metadata"
            playsinline
            style="width: 100%; max-height: 360px; display: block;"
            :src="'/media/tutorial-v6.mp4'"
          ></video>
        </div>

        <div style="display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow-y: auto;">
          <div
            v-for="ch in VIDEO_CHAPTERS"
            :key="ch.id"
            @click="jumpInline(ch)"
            style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; background: #f8fafc;"
          >
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <strong style="font-size: 13px;">{{ ch.title }}</strong>
              <span class="tag slate num">{{ Math.floor(ch.startSec / 60) }}:{{ String(ch.startSec % 60).padStart(2, '0') }}</span>
            </div>
            <div class="muted" style="margin-top: 2px;">{{ ch.summary }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 新员工 3 关防踩坑通关测验（真实服务端解锁 newbie 403 门禁） -->
    <div class="card" style="margin-bottom: 14px;" :style="!store.staff?.practice_unlocked ? 'border: 2px solid #dc2626;' : 'border-left: 4px solid #059669;'">
      <div class="card-header">
        <div>
          <h3 class="card-title">🛡 新员工 3 关防踩坑实战通关（当前进度：{{ store.staff?.practice_passed_gates?.length || 0 }} / 3 关）</h3>
          <div class="muted">
            {{ store.staff?.practice_unlocked ? '✅ 您已全部通过 3 关防踩坑测试，拥有完整真实监控、打款、二次议价操作权限！' : '⚠ 未通关新采购员发起任何写入操作均会遭到 403 硬拦截，请现场答对以下 3 题立即解锁！' }}
          </div>
        </div>
        <span class="tag" :class="store.staff?.practice_unlocked ? 'grn' : 'red'">
          {{ store.staff?.practice_unlocked ? '已解锁正式工作权' : '保护锁定中' }}
        </span>
      </div>

      <div class="grid grid-3" style="gap: 12px;">
        <div v-for="q in PRACTICE_QUIZ" :key="q.id" style="border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #f8fafc;">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
            <strong style="font-size: 13px;">{{ q.title }}</strong>
            <span v-if="isGatePassed(q.id)" class="tag grn">✓ 已通过</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;">
            <label v-for="opt in q.options" :key="opt.key" style="display: flex; gap: 6px; font-size: 12px; cursor: pointer;">
              <input type="radio" :name="q.id" :value="opt.key" v-model="quizAnswers[q.id]" />
              <span>{{ opt.label }}</span>
            </label>
          </div>
          <button class="btn btn-sm btn-primary" style="width: 100%;" :disabled="isGatePassed(q.id)" @click="submitGate(q.id)">
            {{ isGatePassed(q.id) ? '✓ 已通关此关' : '提交本关答案' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 十二奇兵 + 16 条防呆矩阵 -->
    <div class="grid grid-2" style="align-items: start;">
      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">⚔️ P1–P6 × G1–G6 二次议价十二奇兵完整百科</h3>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div v-for="t in TWELVE_TACTICS" :key="t.code" style="border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
            <div><span class="tag slate">{{ t.group }}</span> <strong>{{ t.name }}</strong></div>
            <div class="muted" style="margin-top: 3px;">{{ t.script }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title" style="margin-bottom: 10px;">🔐 全链路 16 条服务端硬防呆校验一览</h3>
        <div style="display: flex; flex-direction: column; gap: 7px;">
          <div v-for="(r, i) in FOOLPROOF_16_RULES" :key="i" style="padding: 8px 10px; background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; font-size: 12px;">
            {{ r }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { apiRequest } from '../api/client.js';
import { store, pushToast, handleApiError, openVideoTutorial } from '../store/store.js';
import { VIDEO_CHAPTERS, PRACTICE_QUIZ, TWELVE_TACTICS, FOOLPROOF_16_RULES } from '../data/tutorials.js';

const inlineVideo = ref(null);
const quizAnswers = reactive({ gate1: 'B', gate2: 'B', gate3: 'B' });

function isGatePassed(id) {
  return Array.isArray(store.staff?.practice_passed_gates) && store.staff.practice_passed_gates.includes(id);
}

function jumpInline(ch) {
  if (inlineVideo.value) {
    inlineVideo.value.currentTime = ch.startSec;
    inlineVideo.value.play().catch(() => {});
  }
}

async function submitGate(gateId) {
  try {
    const res = await apiRequest('/api/onboarding/practice', {
      method: 'POST',
      body: { gate_id: gateId, answer: quizAnswers[gateId] },
    });
    store.staff = res.staff;
    pushToast(
      res.practice_unlocked ? '🎉 恭喜通过全部 3 关防踩坑练习！正式业务权限已全部解锁！' : '✓ 本关回答正确！继续通关下一题',
      'info'
    );
  } catch (err) {
    handleApiError(err);
  }
}
</script>
