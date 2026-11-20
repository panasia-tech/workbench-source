<template>
  <div class="grid" style="grid-template-columns: 300px 1fr 310px; align-items: start; gap: 14px;">
    <!-- 左侧会话池 -->
    <div class="card" style="padding: 12px;">
      <h3 class="card-title" style="margin-bottom: 10px;">💬 前台监管对话队列 ({{ convs.length }})</h3>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div
          v-for="c in convs"
          :key="c.conv_id"
          @click="selectedId = c.conv_id"
          style="padding: 9px 10px; border-radius: 8px; border: 1px solid var(--border); cursor: pointer;"
          :style="selectedId === c.conv_id ? 'background: #ecfdf5; border-color: #0f766e;' : 'background: #ffffff;'"
        >
          <div style="display: flex; justify-content: space-between;">
            <strong style="font-size: 13px;">{{ c.seller_nick }}</strong>
            <span class="tag" :class="c.matched_status === 'conflict_pending' ? 'red' : c.pause_state === 'paused' ? 'amb' : 'grn'">
              {{ c.matched_status === 'conflict_pending' ? '描述冲突暂停' : c.pause_state === 'paused' ? '人工独占中' : '在线议价' }}
            </span>
          </div>
          <div class="muted" style="margin-top: 3px;">{{ c.title }}</div>
        </div>
      </div>
    </div>

    <!-- 中间聊天气泡与422发送栏 -->
    <div class="card" v-if="activeConv">
      <div class="card-header">
        <div>
          <h3 class="card-title">{{ activeConv.title }}</h3>
          <div class="muted">
            卖家：{{ activeConv.seller_nick }} · 绑定号：<strong>{{ activeConv.account?.account_name || activeConv.account_id }}</strong>
            <span v-if="activeConv.account" class="tag" :class="activeConv.account.risk_level" style="margin-left: 6px;">
              退款率 {{ activeConv.account.refund_rate_pct }}%
            </span>
          </div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button
            v-if="activeConv.snapshot"
            class="btn btn-sm btn-blue"
            @click="openLightbox(activeConv.title, activeConv.snapshot.images, `不可篡改快照 ${activeConv.snapshot.snapshot_id}`)"
          >
            📸 看锁图快照 ({{ activeConv.snapshot.images.length }})
          </button>
          <button class="btn btn-sm btn-amber" @click="togglePause">
            {{ activeConv.pause_state === 'paused' ? '▶ 恢复托管' : '✋ 暂停独占接管' }}
          </button>
        </div>
      </div>

      <div v-if="activeConv.advice_summary" class="banner amb" style="font-size: 12px; padding: 8px 10px;">
        {{ activeConv.advice_summary }}
      </div>

      <div style="min-height: 290px; max-height: 410px; overflow-y: auto; background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px;">
        <div
          v-for="m in activeConv.messages"
          :key="m.msg_id"
          style="max-width: 82%; padding: 9px 12px; border-radius: 10px; font-size: 13px;"
          :style="msgStyle(m.sender_type)"
        >
          <div style="font-size: 11px; opacity: 0.78; margin-bottom: 2px;">
            {{ m.sender_name }} <span v-if="m.offer_cents" class="num">· 报价 {{ fmtYuan(m.offer_cents) }}</span>
          </div>
          <div>{{ m.body }}</div>
        </div>
      </div>

      <div style="margin-top: 12px;">
        <div class="muted" style="margin-bottom: 6px;">
          🛡 422 违禁词实时守卫已开启（阻断：底价/参考价/提成、加微信/vx:、小二介入/法庭见）
        </div>
        <div style="display: flex; gap: 8px;">
          <input v-model="draftBody" class="input" placeholder="输入回复卖家的消息..." @keyup.enter="sendMsg" />
          <input v-model.number="draftOffer" type="number" class="input" style="width: 115px;" placeholder="附带报价 ¥" />
          <button class="btn btn-primary" :disabled="busy" @click="sendMsg">发送</button>
        </div>
      </div>
    </div>

    <!-- 右侧行情出价参考 -->
    <div class="card" v-if="activeConv">
      <h3 class="card-title" style="margin-bottom: 10px;">📊 行情参考与买前提成测算</h3>
      <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
        <div style="display: flex; justify-content: space-between;"><span>卖家挂价</span><strong class="num">{{ fmtYuan(activeConv.listed_cents) }}</strong></div>
        <div style="display: flex; justify-content: space-between;"><span>行情参考价 M</span><strong class="num">{{ fmtYuan(activeConv.ref_cents) }}</strong></div>
        <div style="display: flex; justify-content: space-between;"><span>建议首探试报价</span><strong class="num" style="color: #0f766e;">{{ fmtYuan(activeConv.initial_offer_cents) }}</strong></div>
        <div style="display: flex; justify-content: space-between;"><span>理想目标成交价</span><strong class="num" style="color: #1d4ed8;">{{ fmtYuan(activeConv.target_cents) }}</strong></div>
        <div style="display: flex; justify-content: space-between;"><span>绝不可破上限 C</span><strong class="num" style="color: #dc2626;">{{ fmtYuan(activeConv.ceiling_cents) }}</strong></div>
      </div>
      <div class="banner grn" style="margin-top: 12px; font-size: 12px; flex-direction: column; align-items: start; gap: 4px;">
        <strong>买前 10% 独立提成预期</strong>
        <span class="num">按目标价谈妥可省 {{ fmtYuan(Math.max(0, activeConv.ref_cents - activeConv.target_cents)) }}，预计买前段个人拿 {{ fmtYuan(Math.round(Math.max(0, activeConv.ref_cents - activeConv.target_cents) * 0.1)) }}。</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError, openLightbox, pushToast } from '../store/store.js';

const convs = ref([]);
const selectedId = ref('');
const draftBody = ref('');
const draftOffer = ref(null);
const busy = ref(false);

const activeConv = computed(() => convs.value.find((c) => c.conv_id === selectedId.value) || convs.value[0]);

function msgStyle(type) {
  if (type === 'seller') return 'align-self: flex-start; background: #ffffff; border: 1px solid #cbd5e1;';
  if (type === 'system') return 'align-self: center; background: #fef3c7; border: 1px solid #fcd34d; max-width: 96%;';
  return 'align-self: flex-end; background: #0f766e; color: #ffffff;';
}

async function load() {
  try {
    const res = await apiRequest('/api/conversations');
    convs.value = res.conversations || [];
    if (!selectedId.value && convs.value.length) selectedId.value = convs.value[0].conv_id;
  } catch (err) {
    handleApiError(err);
  }
}

async function sendMsg() {
  if (!activeConv.value) return;
  busy.value = true;
  try {
    await apiRequest(`/api/conversations/${encodeURIComponent(activeConv.value.conv_id)}/send`, {
      method: 'POST',
      body: { body: draftBody.value, offer_yuan: draftOffer.value },
    });
    draftBody.value = '';
    draftOffer.value = null;
    pushToast('消息通过 422 违禁扫描并已发送！', 'info');
    await load();
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function togglePause() {
  if (!activeConv.value) return;
  const next = activeConv.value.pause_state === 'paused' ? 'auto' : 'paused';
  try {
    await apiRequest(`/api/conversations/${encodeURIComponent(activeConv.value.conv_id)}/pause`, {
      method: 'POST',
      body: { pause_state: next, pause_reason: '人工前端独占接管' },
    });
    await load();
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
