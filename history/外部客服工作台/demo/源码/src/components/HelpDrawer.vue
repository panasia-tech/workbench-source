<template>
  <div v-if="H" class="drawer-mask" role="dialog" aria-modal="true" @click.self="close">
    <aside class="drawer-panel">
      <header class="drawer-head">
        <div>
          <span class="tag acc">手边十要素锦囊 · 零培训上岗</span>
          <h2>{{ H.title }}</h2>
        </div>
        <button type="button" class="btn sm" @click="close">
          <Icon name="close" size="15" /> 关闭
        </button>
      </header>

      <div class="drawer-body">
        <dl class="kv-grid">
          <dt>什么时候用</dt>
          <dd>{{ H.when }}</dd>
          <dt>谁来做</dt>
          <dd><b>{{ H.who }}</b></dd>
          <dt>成功标准</dt>
          <dd style="color: var(--grn-ink); font-weight: 700">{{ H.success }}</dd>
          <dt>停止升级条件</dt>
          <dd style="color: var(--red-ink); font-weight: 700">{{ H.stop }}</dd>
        </dl>

        <section class="sec">
          <h3>一步一步照着点</h3>
          <ol class="step-ol">
            <li v-for="(s, i) in H.steps" :key="i">{{ s }}</li>
          </ol>
        </section>

        <section v-if="H.terms?.length" class="sec">
          <h3>业务名词大白话（点击查看解释）</h3>
          <div class="term-wrap">
            <button
              v-for="t in H.terms"
              :key="t"
              type="button"
              class="term-chip"
              :class="{ on: selectedTerm === t }"
              @click="selectedTerm = selectedTerm === t ? '' : t"
            >
              📖 {{ t }}
            </button>
          </div>
          <div v-if="selectedTerm && TERMS[selectedTerm]" class="term-explain">
            <b>{{ selectedTerm }}：</b>{{ TERMS[selectedTerm] }}
          </div>
        </section>

        <section v-if="H.guards?.length" class="sec">
          <h3>7字段防呆保护矩阵（系统怎么帮你防出错）</h3>
          <div v-for="(g, idx) in H.guards" :key="idx" class="guard-card">
            <div><span>前置场景：</span>{{ g.pre }}</div>
            <div><span>易犯错误：</span>{{ g.mistake }}</div>
            <div><span>系统拦截：</span><b>{{ g.block }}</b></div>
            <div><span>操作指引：</span>{{ g.tip }}</div>
            <div><span>恢复方式：</span>{{ g.recover }}</div>
            <div><span>责任角色：</span>{{ g.owner }} ｜ <span>留存凭证：</span>{{ g.evidence }}</div>
          </div>
        </section>

        <section v-if="H.kpi" class="sec">
          <h3>关联考核指标与五防口径</h3>
          <div class="guard-card">
            <div><span>关联指标：</span><b>{{ H.kpi.metric }}</b></div>
            <div><span>计算口径：</span>{{ H.kpi.formula }}</div>
            <div><span>样本范围：</span>{{ H.kpi.sample }}</div>
            <div><span>可见权限：</span>{{ H.kpi.viewer }}</div>
          </div>
        </section>

        <section class="sec">
          <h3>操作短视频与制度出处</h3>
          <div class="empty-video">
            🎬 本节点 45 秒操作短视频状态：<b>待录</b>（遵循数据诚实原则，未录制绝不编造假链接）
          </div>
          <div v-if="H.wiki?.length" class="wiki-stack">
            <div v-for="wk in H.wiki" :key="wk" class="wiki-row">
              <span>{{ WIKI_LINKS[wk]?.t }}</span>
              <a v-if="WIKI_LINKS[wk]?.u" :href="WIKI_LINKS[wk].u" target="_blank" rel="noreferrer">打开钉钉文档 ↗</a>
              <span v-else class="tag amb">{{ WIKI_LINKS[wk]?.ver || '内部制度' }}</span>
            </div>
          </div>
        </section>
      </div>

      <footer class="drawer-foot">
        <button type="button" class="btn sm pri" @click="startTour">✨ 开启页面聚光灯导览</button>
        <button type="button" class="btn sm" @click="goManual">打开完整手册总表 ›</button>
        <button type="button" class="btn sm" @click="resetPractice">重置当前角色新手练习进度</button>
      </footer>
    </aside>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, resetPracticeForCurrentActor } from '../store.js';
import { HELP, TERMS, WIKI_LINKS } from '../data/helpAndRules.js';
import Icon from './Icon.vue';

const selectedTerm = ref('');
const H = computed(() => (store.ui.helpKey ? HELP[store.ui.helpKey] || HELP.chat : null));

watch(
  () => store.ui.helpKey,
  () => {
    selectedTerm.value = '';
  },
);

function close() {
  store.ui.helpKey = null;
}
function startTour() {
  close();
  store.ui.route = 'chat';
  store.ui.tourStep = 0;
}
function goManual() {
  close();
  store.ui.route = 'manual';
}
async function resetPractice() {
  await resetPracticeForCurrentActor();
  close();
}
</script>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  justify-content: flex-end;
}
.drawer-panel {
  width: 560px;
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}
.drawer-head {
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.drawer-head h2 {
  font-size: 18px;
  margin-top: 6px;
}
.drawer-body {
  overflow-y: auto;
  padding: 18px 22px;
  display: grid;
  gap: 16px;
  align-content: start;
}
.kv-grid {
  margin: 0;
  padding: 13px 15px;
  border-radius: 13px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  display: grid;
  grid-template-columns: 102px 1fr;
  gap: 7px 10px;
  font-size: 13px;
}
.kv-grid dt {
  color: var(--mute);
  font-weight: 700;
}
.kv-grid dd {
  margin: 0;
}
.sec h3 {
  font-size: 14px;
  font-weight: 800;
  margin-bottom: 8px;
}
.step-ol {
  margin: 0;
  padding-left: 19px;
  display: grid;
  gap: 6px;
  font-size: 13.5px;
}
.term-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.term-chip {
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--soft);
  border: 1px solid var(--line);
  font-size: 12.5px;
  font-weight: 700;
}
.term-chip.on {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc);
}
.term-explain {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--acc-soft);
  font-size: 12.5px;
}
.guard-card {
  background: var(--panel-alt);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 11px 13px;
  font-size: 12.5px;
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
}
.guard-card span {
  color: var(--mute);
  font-weight: 700;
}
.empty-video {
  padding: 10px 13px;
  border-radius: 10px;
  border: 1px dashed var(--line);
  font-size: 12.5px;
  color: var(--mute);
  margin-bottom: 8px;
}
.wiki-stack {
  display: grid;
  gap: 6px;
}
.wiki-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--panel-alt);
  font-size: 12.5px;
}
.drawer-foot {
  padding: 13px 22px;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
