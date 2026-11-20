<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>学 · 新员工 3 关防踩坑练习</h1>
        <p class="page-sub">
          不用看厚手册、不用老员工手把手盯：花 2 分钟把最容易亏钱的 3 个坑点一遍，真单按钮就全部解锁！
        </p>
      </div>
      <div class="page-acts">
        <a href="#/manual" class="btn"><Icon name="book" size="15" /> 看图文说明书</a>
        <Q k="learn" label="怎么练" />
      </div>
    </header>

    <!-- 1. 当前账号通关状态卡 -->
    <section class="card gate-hero" :class="unlocked ? 'ok' : 'locked'">
      <div class="gh-left">
        <span class="badge-l" :class="unlocked ? 'grn' : 'amb'">
          {{ unlocked ? '✓ 已解锁全部采购单操作' : `! 还差 ${3 - doneCount} 关解锁操作按钮` }}
        </span>
        <h2>当前登录：{{ role.name }}（{{ role.role_label }}） · 已完成 {{ doneCount }} / 3 关</h2>
        <p class="muted">
          {{
            unlocked
              ? '你已经掌握「聊天不说漏底价」、「先看闲鱼改价再付钱」、「到货有问题先点退货再谈差价」三大规矩！想测试第一天新员工上岗保护锁，可以点右边切换【周小新】。'
              : '为了防止新同事第一天误付款或漏锁退货赔钱，点完下面 3 个假单小游戏就立刻解锁真单操作。'
          }}
        </p>
      </div>

      <div class="gh-acts">
        <button v-if="store.actorId !== 'newbie'" type="button" class="btn" @click="switchNewbie">
          切「周小新（新员工）」体验保护锁
        </button>
        <button v-else type="button" class="btn" @click="switchLiming">
          切回「李明（熟手采购员）」
        </button>

        <button v-if="!unlocked" type="button" class="btn" @click="unlockAll">
          熟手直接一键通关 ›
        </button>

        <template v-if="!confirmReset">
          <button type="button" class="btn sm" @click="confirmReset = true">清零重练一遍</button>
        </template>
        <template v-else>
          <button type="button" class="btn sm bad" @click="doReset">确认清零</button>
          <button type="button" class="btn sm" @click="confirmReset = false">取消</button>
        </template>
      </div>
    </section>

    <!-- 2. 3 个交互练习关卡 -->
    <section class="lvl-grid">
      <div v-for="lv in levels" :key="lv.k" class="card lvl-card">
        <div class="lvl-top">
          <span class="tag" :class="prog[lv.k] >= 3 ? 'grn' : 'amb'">
            {{ prog[lv.k] >= 3 ? '✓ 已学会 (3/3)' : `进度 ${prog[lv.k] || 0} / 3` }}
          </span>
          <span class="muted">约 40 秒</span>
        </div>
        <h3>{{ lv.title }}</h3>
        <p class="muted" style="font-size: 13.5px; line-height: 1.55">{{ lv.desc }}</p>
        <ul class="lvl-pts">
          <li v-for="(pt, i) in lv.points" :key="i">{{ pt }}</li>
        </ul>
        <button type="button" class="btn pri" style="margin-top: auto" @click="store.ui.practice = lv.k">
          {{ prog[lv.k] >= 3 ? '再玩一遍巩固' : '点此开始练习 ›' }}
        </button>
      </div>
    </section>

    <!-- 3. 现场聚光灯带看入口 -->
    <section class="card" style="margin-top: 20px">
      <h3>
        ✨ 跟着聚光灯认界面（步进导览）
        <small>点一下自动跳去对应页面，一格一格指给你看先点哪里</small>
      </h3>
      <div class="tour-grid">
        <button type="button" class="tour-item" @click="goTour('#/today', 'today')">
          <b>① 「今天」页面带看</b>
          <span class="muted">看懂红黄绿待办、我的 10%/20% 提成与买货预算</span>
        </button>
        <button type="button" class="tour-item" @click="goTour('#/cases', 'cases')">
          <b>② 「采购订单」三大分类带看</b>
          <span class="muted">今天采购的、问题订单、已经完结的一秒分清</span>
        </button>
        <button type="button" class="tour-item" @click="goTour('#/case/CASE-006', 'case-detail')">
          <b>③ 「问题订单二次议价」手把手带看</b>
          <span class="muted">看圆圈进度条、算账对比黄框卡与卖家顶嘴应对器</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import {
  store,
  currentRole,
  myOnboarding,
  practiceDoneCount,
  isPracticeUnlocked,
  callAction,
  setActor,
  notify,
} from '../store.js';
import { tourPos } from '../onboarding/tourSteps.js';
import Icon from '../components/Icon.vue';
import Q from '../components/Q.vue';

const confirmReset = ref(false);
const role = computed(() => currentRole());
const prog = computed(() => myOnboarding());
const doneCount = computed(() => practiceDoneCount());
const unlocked = computed(() => isPracticeUnlocked());

const levels = [
  {
    k: 'chat_guard',
    title: '第 1 关：几乎全新/图糊不追问 + 给仓管打标',
    desc: '练一下收货前进阶心法：遇到卖家写「几乎全新」或拍得模糊不清，绝不多嘴问清划痕，直接打上「质疑成色」标让仓管到货重点抓差！',
    points: ['写几乎全新/图糊绝不追问成色，直接打标锁快照', '发“参考价/二次议价”被系统自动挡住', '插话前先让自动助手停嘴'],
  },
  {
    k: 'price_pay',
    title: '第 2 关：先核闲鱼改价 + 填单号锁死快照',
    desc: '练一下付款前核对闲鱼购买页标价一分不差，付完回填企业支付宝单号把卖家承诺与仓管重点验机标锁死推送仓库。',
    points: ['标价差一块钱都会自动锁住提醒你', '填支付宝单号永久锁死卖家原始承诺', '没买成取消时顺手把预算退回组里'],
  },
  {
    k: 'return_planb',
    title: '第 3 关：双10m拒签加微 + 12大心理博弈 + 整单退走对公',
    desc: '练透二次议价核心利润引擎：拒签10分钟确认面单并电联加微 → 首刀半价/P3精确锚 + 欲擒故纵「不用了谢谢」+ G3柠檬市场破幻想 → 整单全退走次日10点支付宝对公支付！',
    points: ['禁在闲鱼发微信号/退差价，10m内确认面单拒签电联加微', '首刀半价/P3精确锚，卖家急问少退点冷回「不用啦，谢谢」', '大额折让整单退关单脱离管辖，走次日10:00 T+1支付宝对公支付'],
  },
];

function switchNewbie() {
  setActor('newbie');
  notify('已切换为【周小新（新员工）】，可以去任意订单里体验新员工保护锁！');
}

function switchLiming() {
  setActor('liming');
  notify('已切换回【李明（采购业务员）】');
}

async function unlockAll() {
  await callAction('/api/onboarding/practice', { unlock_all: true }, '已全部通关解锁！');
}

async function doReset() {
  await callAction('/api/onboarding/practice', { reset: true }, '练习进度已重置，可以重新体验');
  confirmReset.value = false;
}

function goTour(hash, page) {
  window.location.hash = hash;
  setTimeout(() => {
    store.ui.tour = { page, i: tourPos(page) };
  }, 120);
}
</script>

<style scoped>
.gate-hero {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.gate-hero.locked { border-color: var(--amb); }
.gate-hero.ok { border-color: var(--grn); }
.gh-left {
  display: grid;
  gap: 6px;
  max-width: 720px;
}
.gh-left h2 {
  font-size: 20px;
  font-weight: 800;
}
.gh-acts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.lvl-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.lvl-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lvl-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
}
.lvl-pts {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink2);
}

.tour-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.tour-item {
  padding: 15px 16px;
  border-radius: 15px;
  background: var(--soft);
  border: 1.5px solid var(--line);
  text-align: left;
  display: grid;
  gap: 4px;
}
.tour-item:hover {
  border-color: var(--acc);
  background: var(--acc-soft);
}

@media (max-width: 960px) {
  .lvl-grid, .tour-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
