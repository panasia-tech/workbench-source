<template>
  <div
    v-if="store.ui.devReqOpen"
    class="m-mask"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dev-req-title"
    @click.self="close"
  >
    <div class="m-card">
      <div class="m-hd">
        <div>
          <span class="tag acc">谁提需求谁验收</span>
          <h3 id="dev-req-title">提给开发 / 报无障碍问题</h3>
        </div>
        <button type="button" class="btn sm" @click="close"><Icon name="close" size="16" /> 关闭</button>
      </div>

      <p class="muted" style="font-size: 13.5px">
        按钮太小不好点、颜色看不清、手机挤歪了、或者希望加一条自动防呆，都直接填在这里。开发改完后<strong>必须由你本人点「已验收」才算关单</strong>。
      </p>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
        <label class="field">
          <span>反馈类别<b class="req">*</b></span>
          <select v-model="kind" class="select">
            <option value="防呆改进">防呆与流程改进</option>
            <option value="无障碍">字体 / 对比度 / 手机无障碍</option>
            <option value="界面缺陷">按钮报错或显示缺陷</option>
          </select>
        </label>
        <label class="field">
          <span>所在页面</span>
          <input v-model="pageKey" class="input" placeholder="如 采购订单 / 到货谈退差" />
        </label>
      </div>

      <label class="field">
        <span>一句话标题（至少 3 个字）<b class="req">*</b></span>
        <input v-model="title" class="input" placeholder="例如：核改价输入框希望支持回车直接提交" />
      </label>

      <label class="field">
        <span>具体怎么不好用、希望改成什么样（至少 4 个字）<b class="req">*</b></span>
        <textarea
          v-model="detail"
          class="textarea"
          placeholder="写清现在点了是什么反应，希望改成什么样才顺手…"
        />
      </label>

      <div v-if="err" class="errbox">{{ err }}</div>

      <div class="m-ft">
        <button type="button" class="btn" @click="close">取消</button>
        <button type="button" class="btn pri" :disabled="busy" @click="submit">
          {{ busy ? '提交中…' : '提交工单（改完由我验收）' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store, callAction } from '../store.js';
import Icon from './Icon.vue';

const kind = ref('防呆改进');
const pageKey = ref('');
const title = ref('');
const detail = ref('');
const err = ref('');
const busy = ref(false);

watch(
  () => store.ui.devReqOpen,
  (v) => {
    if (v) {
      pageKey.value = store.ui.devReqDefaultPage || window.location.hash || '#/today';
      err.value = '';
    }
  },
);

function close() {
  store.ui.devReqOpen = false;
  err.value = '';
}

async function submit() {
  err.value = '';
  busy.value = true;
  try {
    await callAction(
      '/api/dev-requests',
      {
        kind: kind.value,
        page_key: pageKey.value,
        title: title.value,
        detail: detail.value,
      },
      '已提交开发/无障碍反馈！可在「今天」右侧跟踪并亲自验收',
    );
    title.value = '';
    detail.value = '';
    close();
  } catch (e) {
    err.value = e.message;
  } finally {
    busy.value = false;
  }
}

function onKey(e) {
  if (e.key === 'Escape' && store.ui.devReqOpen) close();
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
  width: min(560px, 100%);
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
