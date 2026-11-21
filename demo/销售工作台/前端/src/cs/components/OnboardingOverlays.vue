<template>
  <!-- 1. 步进式聚光灯导览浮层 -->
  <div v-if="activeTour" class="tour-mask" role="dialog" aria-modal="true">
    <div class="tour-card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span class="tag acc">新手 60 秒导览 · {{ store.ui.tourStep + 1 }} / {{ TOUR_STEPS.length }}</span>
        <button type="button" class="btn sm" @click="store.ui.tourStep = -1">跳过导览</button>
      </div>
      <h3>{{ activeTour.title }}</h3>
      <p style="font-size: 13.5px; color: var(--ink2)">{{ activeTour.body }}</p>
      <div style="display: flex; justify-content: space-between; margin-top: 6px">
        <button
          type="button"
          class="btn sm"
          :disabled="store.ui.tourStep <= 0"
          @click="store.ui.tourStep -= 1"
        >
          ← 上一步
        </button>
        <button v-if="store.ui.tourStep < TOUR_STEPS.length - 1" type="button" class="btn sm pri" @click="nextTour">
          下一步 ›
        </button>
        <button v-else type="button" class="btn sm grn" @click="store.ui.tourStep = -1">
          ✓ 看懂了，开始接待
        </button>
      </div>
    </div>
  </div>

  <!-- 2. 新人 3 关防踩坑情景练习弹窗 -->
  <div v-if="activePractice" class="practice-mask" role="dialog" aria-modal="true" @click.self="closePractice">
    <div class="practice-dialog">
      <header style="display: flex; justify-content: space-between; align-items: center">
        <span class="tag amb">🎓 演练沙盒（不碰真实买家订单）· 第 {{ activePractice.stepNo }} / 3 关</span>
        <button type="button" class="btn sm" @click="closePractice">关闭</button>
      </header>
      <h3 style="font-size: 18px; margin-top: 8px">{{ activePractice.title }}</h3>
      <div class="scn-box">
        <b>真实买家情景：</b>{{ activePractice.scenario }}
      </div>

      <div class="opt-stack">
        <button
          v-for="opt in activePractice.options"
          :key="opt.id"
          type="button"
          class="opt-btn"
          :class="{
            right: picked === opt.id && opt.correct,
            wrong: picked === opt.id && !opt.correct,
          }"
          @click="chooseOption(opt)"
        >
          <span class="opt-id">{{ opt.id.toUpperCase() }}</span>
          <span>{{ opt.label }}</span>
        </button>
      </div>

      <div v-if="feedback" class="fb-box" :class="passedCurrent ? 'ok' : 'bad'">
        {{ feedback }}
      </div>

      <footer style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px">
        <button v-if="passedCurrent" type="button" class="btn pri" @click="goNextPractice">
          {{ nextPracticeKey ? '进入下一关 ›' : '🎉 3 关全通！解锁真实接待台' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, completePracticeStep, showToast } from '../store.js';
import { PRACTICES, TOUR_STEPS } from '../data/helpAndRules.js';

const picked = ref('');
const feedback = ref('');
const passedCurrent = ref(false);

const activeTour = computed(() =>
  store.ui.tourStep >= 0 && store.ui.tourStep < TOUR_STEPS.length
    ? TOUR_STEPS[store.ui.tourStep]
    : null,
);

const activePractice = computed(() =>
  PRACTICES.find((p) => p.key === store.ui.practiceOpenKey) || null,
);

const nextPracticeKey = computed(() => {
  if (!activePractice.value) return null;
  const idx = PRACTICES.findIndex((p) => p.key === activePractice.value.key);
  return PRACTICES[idx + 1]?.key || null;
});

watch(
  () => store.ui.practiceOpenKey,
  () => {
    picked.value = '';
    feedback.value = '';
    passedCurrent.value = false;
  },
);

watch(activeTour, (step) => {
  document.querySelectorAll('.tour-highlight-ring').forEach((el) => el.classList.remove('tour-highlight-ring'));
  if (step?.sel) {
    const el = document.querySelector(step.sel);
    if (el) {
      el.classList.add('tour-highlight-ring');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
});

function nextTour() {
  store.ui.tourStep += 1;
}

async function chooseOption(opt) {
  picked.value = opt.id;
  feedback.value = opt.feedback;
  passedCurrent.value = opt.correct;
  if (opt.correct && activePractice.value) {
    await completePracticeStep(activePractice.value.key);
  }
}

function goNextPractice() {
  if (nextPracticeKey.value) {
    store.ui.practiceOpenKey = nextPracticeKey.value;
  } else {
    store.ui.practiceOpenKey = null;
    store.ui.route = 'chat';
    showToast('🎉 恭喜通关全部 3 关防呆练习，已解锁全部接待与挑货操作！');
  }
}

function closePractice() {
  store.ui.practiceOpenKey = null;
}
</script>

<style>
.cs-embed-root .tour-highlight-ring {
  position: relative;
  z-index: 96 !important;
  box-shadow: 0 0 0 4px #2952ff, 0 0 0 10px rgba(41, 82, 255, 0.25) !important;
  border-radius: 12px;
}
</style>

<style scoped>
.tour-mask {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 98;
}
.tour-card {
  width: 410px;
  background: var(--panel);
  border: 2px solid var(--acc);
  border-radius: 18px;
  padding: 18px 20px;
  box-shadow: var(--sh-pop);
  display: grid;
  gap: 10px;
}
.practice-mask {
  position: fixed;
  inset: 0;
  z-index: 105;
  background: rgba(15, 23, 42, 0.65);
  display: grid;
  place-items: center;
  padding: 24px;
}
.practice-dialog {
  width: 640px;
  background: var(--panel);
  border-radius: 20px;
  border: 1px solid var(--line);
  padding: 22px 24px;
  box-shadow: var(--sh-pop);
}
.scn-box {
  margin: 12px 0 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  font-size: 13.5px;
}
.opt-stack {
  display: grid;
  gap: 9px;
}
.opt-btn {
  text-align: left;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1.5px solid var(--line);
  background: var(--panel);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13.5px;
  line-height: 1.45;
}
.opt-btn:hover {
  border-color: var(--acc);
  background: var(--panel-alt);
}
.opt-btn.right {
  border-color: var(--grn);
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-weight: 700;
}
.opt-btn.wrong {
  border-color: var(--red);
  background: var(--red-soft);
  color: var(--red-ink);
}
.opt-id {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--soft);
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 12px;
  flex: none;
}
.fb-box {
  margin-top: 12px;
  padding: 11px 14px;
  border-radius: 11px;
  font-size: 13px;
  font-weight: 700;
}
.fb-box.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.fb-box.bad {
  background: var(--red-soft);
  color: var(--red-ink);
}
</style>
