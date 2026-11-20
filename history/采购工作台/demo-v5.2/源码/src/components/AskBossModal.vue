<template>
  <div
    v-if="store.ui.askBossOpen"
    class="m-mask"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ask-boss-title"
    @click.self="close"
  >
    <div class="m-card">
      <div class="m-hd">
        <div>
          <span class="tag amb">不瞎猜 · 留痕升级</span>
          <h3 id="ask-boss-title">遇到没见过的情况 · 问主管</h3>
        </div>
        <button type="button" class="btn sm" @click="close"><Icon name="close" size="16" /> 关闭</button>
      </div>

      <p class="muted" style="font-size: 13.5px">
        说明书没写的新套路、超上限好货特批、成色拿不准，直接在这里发给<strong>王主管</strong>。主管结案后会一键沉淀为新防呆规则草案。
      </p>

      <label class="field">
        <span>遇到了哪类情况<b class="req">*</b></span>
        <select v-model="category" class="select">
          <option>卖家价格高于授权上限，机器极好申请特批</option>
          <option>卖家要求微信定金 / 站外链接 / 不肯改闲鱼价</option>
          <option>序列号/爱思报告异常，拿不准是不是翻新扩容机</option>
          <option>售后退货卖家拒签或提出特殊拆分补款方案</option>
          <option>其他说明书里没见过的情况</option>
        </select>
      </label>

      <label class="field">
        <span>用大白话说清现场情况（失败不清空草稿）<b class="req">*</b></span>
        <textarea
          v-model="note"
          class="textarea"
          placeholder="例如：卖家 iPhone 15 Pro 电池 99% 在保，最低咬死 4780 元超上限 30 元，能收吗？"
        />
      </label>

      <div v-if="err" class="errbox">{{ err }}</div>

      <div class="m-ft">
        <button type="button" class="btn" @click="close">先取消</button>
        <button type="button" class="btn pri" :disabled="busy" @click="submit">
          {{ busy ? '发送中…' : '发给王主管并留痕' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { store, callAction } from '../store.js';
import Icon from './Icon.vue';

const category = ref('卖家价格高于授权上限，机器极好申请特批');
const note = ref('');
const err = ref('');
const busy = ref(false);

function close() {
  store.ui.askBossOpen = false;
  err.value = '';
}

async function submit() {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      '/api/help-requests',
      {
        page_key: window.location.hash || '#/today',
        category: category.value,
        note: note.value,
        conv_id: store.selectedConvId,
      },
      '已上报给王主管！可在「今天」右侧异常栏查看结案与规则沉淀',
    );
    note.value = '';
    close();
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

function onKey(e) {
  if (e.key === 'Escape' && store.ui.askBossOpen) close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.m-mask {
  position: fixed;
  inset: 0;
  z-index: 92;
  background: rgba(8, 12, 22, 0.6);
  display: grid;
  place-items: center;
  padding: 16px;
}
.m-card {
  width: min(540px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--sh-up);
  padding: 22px 24px;
  display: grid;
  gap: 14px;
}
.m-hd {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.m-hd h3 {
  font-size: 20px;
  font-weight: 800;
  margin-top: 6px;
}
.m-ft {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
