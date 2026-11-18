<template>
  <div v-if="h" class="drawer-mask" @click.self="close">
    <aside class="drawer" role="dialog" aria-label="怎么用说明">
      <div class="top">
        <h2>{{ h.title }}</h2>
        <button class="x" @click="close" aria-label="关闭"><Icon name="close" /></button>
      </div>
      <p class="lead">{{ h.when }}</p>
      <dl class="kv">
        <dt>谁来做</dt><dd>{{ h.who }}</dd>
        <dt>成功标准</dt><dd>{{ h.success }}</dd>
        <dt>停止 / 交谁</dt><dd>{{ h.stop }}</dd>
      </dl>

      <div v-if="(h.terms || []).length" class="terms">
        <h4>这里出现的名词</h4>
        <div v-for="k in h.terms" :key="k" class="tm">
          <b>{{ k }}</b>
          <span>{{ GLOSSARY[k] }}</span>
        </div>
      </div>

      <h4>按顺序做</h4>
      <ol class="steps">
        <li v-for="(s, i) in h.steps" :key="i">{{ s }}</li>
      </ol>

      <h4>这里防什么（防呆矩阵）</h4>
      <div class="guards">
        <div v-for="(g, i) in h.guards" :key="i" class="g">
          <p><span class="tag amb">前置</span>{{ g.pre }}</p>
          <p><span class="tag red">可能点错</span>{{ g.mistake }}</p>
          <p><span class="tag grn">系统怎么拦</span>{{ g.block }}</p>
          <p class="sm">给你的话：{{ g.tip }}</p>
          <p class="sm">恢复：{{ g.recover }}　接手：{{ g.owner }}　证据：{{ g.evidence }}</p>
        </div>
      </div>

      <h4>实操演示小视频</h4>
      <div class="vid">
        <button v-if="h.video" class="btn pri" @click="playVideo(h.video)">
          <Icon name="play" />看这一步的小视频
        </button>
        <button class="btn" @click="toManual">打开完整作业说明书 ›</button>
      </div>

      <h4>公司制度（钉钉 Wiki）与绩效口径</h4>
      <div class="wk">
        <span class="tag">{{ h.wiki || '仓管员工手册 v2.0（已内置于说明书）' }}</span>
        <span class="tag">禅道 14 卡规则真源（见缺口闭环看板）</span>
      </div>
      <p v-if="h.kpi" class="muted" style="font-size:12.5px;margin-top:8px"><b>关联 KPI 口径：</b>{{ h.kpi }}</p>

      <div v-if="h.tour" class="tour">
        <button class="btn pri" @click="startTour">开始本页导览</button>
        <p class="muted">逐步高亮页面上真实的控件，只说明、不替你点高影响动作。</p>
      </div>

      <div class="tour">
        <button class="btn" @click="resetLearn">一键重新新手指导（只重置学习进度）</button>
        <p class="muted">真实任务、在库商品、验货单、异常单、盘点台账都不会动。</p>
      </div>
    </aside>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { store, HELP_DICT, GLOSSARY, go, resetPracticeProgress } from '../store/warehouseStore.js'

const h = computed(() => (store.helpKey ? HELP_DICT[store.helpKey] : null))
const close = () => { store.helpKey = '' }

function playVideo(title) {
  store.videoModal = { title, note: '本机演示环境内置实操关键帧示意图；正式网盘视频上传后可直接绑定播放地址。' }
}

function toManual() {
  close()
  go('manual')
}

function startTour() {
  const page = h.value?.tour
  close()
  if (page) store.tour = { page, i: 0 }
}

function resetLearn() {
  resetPracticeProgress()
  close()
  go('learn')
}
</script>
<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, .45);
  z-index: 80;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(560px, 100%);
  height: 100%;
  background: var(--panel);
  overflow-y: auto;
  padding: 24px 26px 40px;
  box-shadow: var(--sh-up);
}
.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.top h2 { font-size: 22px; letter-spacing: -.01em; }
.x { width: 34px; height: 34px; border-radius: 50%; background: var(--soft); display: grid; place-items: center; }
.lead { font-size: 14.5px; margin: 10px 0 14px; color: var(--ink2); line-height: 1.55; }
h4 { margin: 20px 0 9px; font-size: 14.5px; font-weight: 700; }
.steps { margin: 0; padding-left: 20px; display: grid; gap: 7px; font-size: 13.5px; line-height: 1.55; }
.guards { display: grid; gap: 10px; }
.g { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.g p { margin: 4px 0; font-size: 13px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.g .sm { font-size: 12px; color: var(--mute); }
.vid, .wk { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tour { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 6px; justify-items: start; }
.tour p { font-size: 12.5px; }
.terms { margin-top: 12px; }
.tm { display: grid; grid-template-columns: 96px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; }
.tm b { color: var(--acc); }
.tm span { color: var(--ink2); line-height: 1.5; }
</style>
