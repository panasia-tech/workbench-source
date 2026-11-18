<template>
  <div
    v-if="item"
    class="tm-mask"
    role="dialog"
    aria-modal="true"
    aria-labelledby="term-modal-title"
    @click.self="closeTerm"
  >
    <div class="tm-card">
      <div class="tm-hd">
        <div>
          <span class="tag acc">专业词大白话</span>
          <h3 id="term-modal-title">{{ item.t }}</h3>
        </div>
        <button ref="closeBtn" type="button" class="btn sm" aria-label="关闭名词解释" @click="closeTerm">
          <Icon name="close" size="16" /> 关闭
        </button>
      </div>

      <div class="tm-sec">
        <span class="lbl">一句话人话解释</span>
        <p>{{ item.plain }}</p>
      </div>

      <div v-if="item.example" class="tm-sec ok">
        <span class="lbl">真实正面例子</span>
        <p>{{ item.example }}</p>
      </div>

      <div v-if="item.mistake" class="tm-sec bad">
        <span class="lbl">最容易踩的赔钱坑</span>
        <p>{{ item.mistake }}</p>
      </div>

      <div class="tm-ft">
        <a :href="`#/manual?t=${store.ui.termKey}`" class="btn sm" @click="closeTerm">去说明书查全部词典 ›</a>
        <button type="button" class="btn pri sm" @click="closeTerm">看懂了</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store, closeTerm } from '../store.js';
import { GLOSSARY } from '../onboarding/glossary.js';
import Icon from './Icon.vue';

const closeBtn = ref(null);
const item = computed(() => (store.ui.termKey ? GLOSSARY[store.ui.termKey] || null : null));

function onKey(e) {
  if (e.key === 'Escape' && store.ui.termKey) {
    e.stopPropagation();
    closeTerm();
  }
}

watch(
  () => store.ui.termKey,
  async (v) => {
    if (v) {
      await nextTick();
      closeBtn.value?.focus();
    }
  },
);

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.tm-mask {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: rgba(8, 12, 22, 0.62);
  display: grid;
  place-items: center;
  padding: 16px;
}
.tm-card {
  width: min(520px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--sh-up);
  padding: 22px 24px;
  display: grid;
  gap: 14px;
}
.tm-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.tm-hd h3 {
  font-size: 21px;
  font-weight: 800;
  margin-top: 6px;
}
.tm-sec {
  background: var(--soft);
  border-radius: 14px;
  padding: 12px 14px;
}
.tm-sec.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.tm-sec.bad {
  background: var(--red-soft);
  color: var(--red-ink);
}
.tm-sec .lbl {
  display: block;
  font-size: 12px;
  font-weight: 800;
  opacity: 0.85;
  margin-bottom: 4px;
}
.tm-sec p {
  font-size: 14.5px;
  line-height: 1.55;
}
.tm-ft {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
