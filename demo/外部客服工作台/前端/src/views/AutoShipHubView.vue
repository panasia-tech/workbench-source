<template>
  <div class="page-scroll">
    <div class="page-wrap">
      <!-- 页面头 -->
      <header class="card page-hero">
        <div>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="tag acc">一件一拍前置 + 静默自动发货引擎</span>
            <span class="tag grn">与仓管工作台(5351)波次池实时联动</span>
          </div>
          <h1 style="font-size: 21px; margin-top: 6px">发货前置与自动推仓监控台</h1>
          <p class="muted" style="font-size: 13px; margin-top: 3px">
            核心逻辑：先从 WMS 挑定唯一真机并发出当时仓管拍的【实拍视频 + 照片】→ 开启静默观察倒计时 → <b>客人没疑问全自动推入仓库打顺丰单；客人一旦发消息提问，毫秒级自动暂停转人工介入！</b>
          </p>
        </div>

        <div class="hero-actions">
          <div class="window-cfg">
            <span>静默观察时长：</span>
            <select v-model.number="store.data.kpi.config.autoShipWindowMin">
              <option :value="15">15 分钟无异议自动推仓</option>
              <option :value="30">30 分钟无异议自动推仓（推荐）</option>
              <option :value="60">60 分钟无异议自动推仓</option>
            </select>
          </div>
          <Q k="autoship" label="本页怎么用" />
        </div>
      </header>

      <!-- 四列看板泳道 -->
      <div class="kanban-grid">
        <!-- 第1列：待挑WMS单品并发实拍 -->
        <section class="kb-col red-col">
          <header class="kb-head">
            <b>① 待挑WMS单品并发实拍</b>
            <span class="tag red">{{ laneWaitPick.length }} 单阻塞</span>
          </header>
          <p class="kb-desc">通卖链接尚未指定具体哪台机器，物理锁死不可进仓库</p>
          <div class="kb-cards">
            <div v-for="c in laneWaitPick" :key="c.id" class="kb-card">
              <div class="kc-top">
                <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
                <span class="kc-amt">¥{{ c.paidAmount }}</span>
              </div>
              <div class="kc-meta">订单号：{{ c.orderNo }} ｜ 付款于 {{ c.paidAt }}</div>
              <div class="kc-alert red">🔴 需从同款在库槽挑 1 台四关全绿真机并发出实拍视频</div>
              <button type="button" class="btn sm pri block" @click="jumpToChat(c.id)">
                去接待台挑货发实拍 ›
              </button>
            </div>
            <div v-if="!laneWaitPick.length" class="kb-empty">✓ 当前无待挑货积压单</div>
          </div>
        </section>

        <!-- 第2列：静默倒计时观察窗中 -->
        <section class="kb-col amb-col">
          <header class="kb-head">
            <b>② 实拍已发 · 静默自动发货观察中</b>
            <span class="tag amb">{{ laneObserving.length }} 单倒计时</span>
          </header>
          <p class="kb-desc">无需人工值守催确认，倒计时归零无异议全自动推仓</p>
          <div class="kb-cards">
            <div v-for="c in laneObserving" :key="c.id" class="kb-card">
              <div class="kc-top">
                <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
                <span class="kc-timer">⏱ {{ fmtSec(c.autoShipRemainSec) }}</span>
              </div>
              <div class="kc-meta">已锁真机：<b class="mono">{{ c.boundSkuCode }}</b> ｜ 实拍视频+照片已发</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 4px">
                <button type="button" class="btn sm amb" @click="simBreak(c.id)">
                  💬 模拟买家发问熔断
                </button>
                <button type="button" class="btn sm grn" @click="autoPass(c.id)">
                  🚀 模拟到点自动推仓
                </button>
              </div>
            </div>
            <div v-if="!laneObserving.length" class="kb-empty">当前无观察窗订单（可在第①列挑货体验）</div>
          </div>
        </section>

        <!-- 第3列：买家提疑问已熔断暂停（人工介入） -->
        <section class="kb-col red-col">
          <header class="kb-head">
            <b>③ 客人提疑问 · 已自动熔断待人工</b>
            <span class="tag red">{{ lanePaused.length }} 单需介入</span>
          </header>
          <p class="kb-desc">买家在观察期说了话，自动推仓已毫秒级暂停防错发</p>
          <div class="kb-cards">
            <div v-for="c in lanePaused" :key="c.id" class="kb-card">
              <div class="kc-top">
                <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
                <span class="tag red">⚡ 已暂停发货</span>
              </div>
              <div class="kc-meta">锁定货号：<b class="mono">{{ c.boundSkuCode }}</b></div>
              <div class="kc-alert red">{{ c.autoShipPausedReason }}</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px">
                <button type="button" class="btn sm pri" @click="jumpToChat(c.id)">
                  去聊天解答/换台 ›
                </button>
                <button type="button" class="btn sm grn" @click="manualPass(c.id)">
                  ✓ 已确认·恢复推仓
                </button>
              </div>
            </div>
            <div v-if="!lanePaused.length" class="kb-empty">✓ 当前无疑问熔断单</div>
          </div>
        </section>

        <!-- 第4列：已推入仓管波次 / 409红屏拦截 -->
        <section class="kb-col grn-col">
          <header class="kb-head">
            <b>④ 已推入仓管波次 / 打包复核</b>
            <span class="tag grn">{{ lanePushed.length }} 单流转</span>
          </header>
          <p class="kb-desc">仓管激光枪扫四码出库；出库前仍支持 409 红屏紧急拦截</p>
          <div class="kb-cards">
            <div v-for="c in lanePushed" :key="c.id" class="kb-card">
              <div class="kc-top">
                <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
                <b>{{ c.buyerNick }}</b>
                <span
                  class="tag"
                  :class="c.workflowStep === 'WMS_409_INTERCEPTED' ? 'red' : 'grn'"
                >
                  {{ c.workflowStep === 'WMS_409_INTERCEPTED' ? '🛑 409已拦截' : '🏃 波次拣货中' }}
                </span>
              </div>
              <div class="kc-meta">货号：<b class="mono">{{ c.boundSkuCode }}</b></div>
              <div class="kc-alert" :class="c.workflowStep === 'WMS_409_INTERCEPTED' ? 'red' : 'grn'">
                {{ c.wmsWaveNo }}
              </div>
              <button
                v-if="c.workflowStep === 'PUSHED_TO_WMS_WAVE'"
                type="button"
                class="btn sm bad block"
                @click="intercept(c.id)"
              >
                🛑 买家改址/退单 · 紧急触发 409 红屏拦截
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import {
  store,
  simulateBuyerQuestionDuringAutoShip,
  pushOrderToWmsWave,
  triggerEmergencyWmsIntercept,
} from '../store.js';
import Q from '../components/Q.vue';

const paidConvs = computed(() => store.data.conversations.filter((c) => c.orderNo));

const laneWaitPick = computed(() =>
  paidConvs.value.filter((c) => c.workflowStep === 'PAID_WAIT_PICK_SKU'),
);
const laneObserving = computed(() =>
  paidConvs.value.filter((c) => c.workflowStep === 'AUTO_OBSERVING'),
);
const lanePaused = computed(() =>
  paidConvs.value.filter((c) => c.workflowStep === 'AUTO_PAUSED_BY_BUYER'),
);
const lanePushed = computed(() =>
  paidConvs.value.filter((c) =>
    ['PUSHED_TO_WMS_WAVE', 'WMS_409_INTERCEPTED'].includes(c.workflowStep),
  ),
);

function fmtSec(sec) {
  const s = Math.max(0, Number(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function jumpToChat(convId) {
  store.ui.selectedConvId = convId;
  store.ui.route = 'chat';
}

async function simBreak(convId) {
  await simulateBuyerQuestionDuringAutoShip(convId);
}

async function autoPass(convId) {
  await pushOrderToWmsWave(convId, 'timer_auto');
}

async function manualPass(convId) {
  await pushOrderToWmsWave(convId, 'manual_resolved');
}

async function intercept(convId) {
  await triggerEmergencyWmsIntercept(convId, '买家在自动推仓后临时要求改址/退单');
}
</script>

<style scoped>
.page-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.window-cfg {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  padding: 6px 12px;
  border-radius: 10px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
}
.window-cfg select {
  border: 0;
  background: transparent;
  font-weight: 800;
  color: var(--acc);
}

.kanban-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.kb-col {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 15px;
  display: grid;
  gap: 10px;
  box-shadow: var(--sh);
}
.kb-col.red-col {
  border-top: 4px solid var(--red);
}
.kb-col.amb-col {
  border-top: 4px solid var(--amb);
}
.kb-col.grn-col {
  border-top: 4px solid var(--grn);
}

.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}
.kb-desc {
  font-size: 12px;
  color: var(--mute);
}
.kb-cards {
  display: grid;
  gap: 10px;
}
.kb-card {
  padding: 12px;
  border-radius: 13px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  display: grid;
  gap: 7px;
}
.kc-top {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.kc-amt {
  margin-left: auto;
  font-weight: 900;
  color: var(--acc);
}
.kc-timer {
  margin-left: auto;
  font-family: monospace;
  font-weight: 900;
  color: var(--amb-ink);
}
.kc-meta {
  font-size: 12px;
  color: var(--mute);
}
.kc-alert {
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
}
.kc-alert.red {
  background: var(--red-soft);
  color: var(--red-ink);
}
.kc-alert.grn {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.kb-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--mute);
  border: 1px dashed var(--line);
  border-radius: 12px;
}
</style>
