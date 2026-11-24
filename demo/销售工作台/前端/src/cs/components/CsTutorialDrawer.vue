<template>
  <div
    v-if="store.ui.tutorialDrawerOpen"
    class="drawer-backdrop"
    role="dialog"
    aria-modal="true"
    @click.self="store.ui.tutorialDrawerOpen = false"
  >
    <div class="wide-drawer">
      <header class="wd-head">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span class="tag acc">客服独立台账视图 · 并入销售单应用发布</span>
            <span class="tag grn">{{ data.roleLabel || '外部客服视角' }}</span>
            <span class="tag">{{ data.version }}</span>
          </div>
          <h2>📚 外部客服专属「教程与视频台账」</h2>
        </div>
        <div style="display: flex; align-items: center; gap: 8px">
          <a v-if="data.indexUrl" :href="data.indexUrl" target="_blank" rel="noreferrer" class="btn sm soft">
            Wiki 节点索引 ↗
          </a>
          <a v-if="data.employeePdfUrl" :href="data.employeePdfUrl" target="_blank" rel="noreferrer" class="btn sm soft">
            员工小动物 PDF ↗
          </a>
          <button type="button" class="btn sm" @click="load(true)">
            <Icon name="refresh" size="14" /> 刷新
          </button>
          <button type="button" class="btn sm" @click="store.ui.tutorialDrawerOpen = false">
            <Icon name="close" size="15" /> 收起
          </button>
        </div>
      </header>

      <div class="wd-body">
        <div class="rbac-banner">
          <span>
            🔒 <b>岗位可见范围隔离：</b>当前仅展示「公司共用开场」+「外部客服 4 项核心节点」（共 {{ nodes.length }} 条），已从服务端物理过滤所有内部销售选品、洗价成本与主管专属节点。
          </span>
        </div>

        <div v-if="err" class="rbac-banner" style="background: var(--red-soft); color: var(--red-ink)">
          {{ err }}
        </div>

        <div class="cs-ledger-grid">
          <article v-for="n in nodes" :key="n.node_id" class="cs-node-card">
            <header class="cnc-head">
              <div>
                <div class="cnc-badges">
                  <code>{{ n.node_id }}</code>
                  <span class="tag sm" :class="n.scope === 'shared' ? 'acc' : 'amb'">
                    {{ n.scope === 'shared' ? '公司共用开场' : '外部客服独立节点' }}
                  </span>
                  <span class="tag sm" :class="n.coverage_status === '可用' ? 'grn' : 'amb'">
                    {{ n.coverage_status }}
                  </span>
                </div>
                <h3>{{ n.title }}</h3>
              </div>
              <div class="cnc-links">
                <a v-if="n.video_wiki_url" :href="n.video_wiki_url" target="_blank" rel="noreferrer" class="btn sm pri">
                  ▶ 通用视频（{{ n.timecode }}）↗
                </a>
                <a v-if="n.manual_fallback_video" :href="n.manual_fallback_video" target="_blank" rel="noreferrer" class="btn sm soft">
                  🎬 客服 V3 专项片 ↗
                </a>
                <a v-if="n.wiki_url" :href="n.wiki_url" target="_blank" rel="noreferrer" class="btn sm">
                  📖 怎么做（Wiki）↗
                </a>
                <a v-if="n.h5_url" :href="n.h5_url" target="_blank" rel="noreferrer" class="btn sm">
                  📄 双视角 H5 ↗
                </a>
              </div>
            </header>

            <div class="cnc-meta">
              <span><b>负责主管：</b>{{ n.owner }}</span>
              <span><b>适用版本：</b>{{ n.applicable_version }}</span>
              <span><b>视频状态：</b>{{ n.video_source_status }}</span>
            </div>

            <div class="cnc-cols">
              <div class="cnc-box">
                <div class="cnc-box-title">
                  <b>日常 Codex · Skill 协作</b>
                  <span class="tag sm grn">{{ n.skill_status }} · {{ n.skill_name }}</span>
                </div>
                <p><b>怎么交代 Codex：</b>{{ n.codex_prompt_hint }}</p>
                <p><b>预期完成证据：</b>{{ n.expected_evidence }}</p>
              </div>
              <div class="cnc-box warn">
                <div class="cnc-box-title">
                  <b>停手条件与人工兜底</b>
                  <span class="tag sm acc">{{ n.fallback_status }}</span>
                </div>
                <p><b>何时停手转交：</b>{{ n.manual_trigger }}</p>
                <p v-if="n.gap_reason"><b>当前缺口提示：</b>{{ n.gap_reason }}</p>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px">
                  <button
                    v-if="n.help_keys?.length"
                    type="button"
                    class="btn sm"
                    @click="openHelpFromNode(n)"
                  >
                    打开手边「？」十要素卡片
                  </button>
                  <a v-if="n.manual_fallback_doc" :href="n.manual_fallback_doc" target="_blank" rel="noreferrer" class="btn sm">
                    查看规则正文 ↗
                  </a>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';
import { store } from '../store.js';
import Icon from './Icon.vue';

const nodes = ref([]);
const err = ref('');
const data = reactive({
  roleLabel: '',
  version: 'V6-20261124-merged-cs',
  indexUrl: '',
  employeePdfUrl: '',
});

const CS_HELP_MAP = {
  'CS-REALSHOT-01': 'chat',
  'CS-WARRANTY-02': 'warranty_card',
  'CS-REFUND-409-03': 'auto_refund',
  'CS-GUARD-KPI-04': 'kpi',
  'SALES-SHARED-00': 'chat',
};

function resolveQueryActor() {
  if (store.actorId === 'supervisor') return 'admin';
  if (store.actorId === 'internal_chen') return 'chenxm';
  if (store.actorId === 'newbie') return 'cs_newbie';
  return 'outsource_lu';
}

async function load(manual = false) {
  err.value = '';
  try {
    const r = await fetch(`/api/tutorials/ledger?actor=${encodeURIComponent(resolveQueryActor())}&scope=cs`);
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    nodes.value = d.nodes || [];
    data.roleLabel = d.roleLabel || '';
    data.version = d.version || data.version;
    data.indexUrl = d.indexUrl || '';
    data.employeePdfUrl = d.employeePdfUrl || '';
    if (manual) {
      store.toast = '已刷新客服独立教程台账';
    }
  } catch (e) {
    err.value = String(e.message || e);
  }
}

function openHelpFromNode(n) {
  store.ui.tutorialDrawerOpen = false;
  store.ui.helpKey = CS_HELP_MAP[n.node_id] || 'chat';
}

watch(
  () => [store.ui.tutorialDrawerOpen, store.actorId],
  ([open]) => {
    if (open) load(false);
  },
);
</script>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: rgba(15, 23, 42, 0.48);
  display: grid;
  place-items: center;
  padding: 20px;
}
.wide-drawer {
  width: min(1160px, 95vw);
  max-height: 90vh;
  background: var(--panel);
  color: var(--ink);
  border-radius: 16px;
  border: 1px solid var(--line);
  box-shadow: var(--sh-pop);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}
.wd-head {
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.wd-head h2 {
  font-size: 19px;
  margin-top: 6px;
}
.wd-body {
  padding: 16px 20px 24px;
  overflow-y: auto;
  display: grid;
  gap: 14px;
  align-content: start;
}
.rbac-banner {
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--pri-soft);
  color: var(--pri);
  font-size: 12.5px;
  line-height: 1.5;
}
.cs-ledger-grid {
  display: grid;
  gap: 12px;
}
.cs-node-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-alt);
  padding: 14px 16px;
  display: grid;
  gap: 10px;
}
.cnc-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.cnc-head h3 {
  font-size: 15.5px;
  margin-top: 5px;
}
.cnc-badges {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.cnc-links {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cnc-meta {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ink2);
}
.cnc-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.cnc-box {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  display: grid;
  gap: 5px;
}
.cnc-box.warn {
  border-left: 3px solid var(--amb);
}
.cnc-box-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
