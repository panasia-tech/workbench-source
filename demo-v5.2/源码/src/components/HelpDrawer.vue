<template>
  <div
    v-if="H"
    class="hd-mask"
    role="dialog"
    aria-modal="true"
    aria-labelledby="help-drawer-title"
    @click.self="closeHelp"
  >
    <aside class="hd-panel">
      <header class="hd-top">
        <div>
          <span class="tag acc">操作引导 · 防呆 · 制度 · KPI</span>
          <h2 id="help-drawer-title">{{ H.title }}</h2>
        </div>
        <button ref="closeBtn" type="button" class="btn sm" aria-label="关闭帮助抽屉" @click="closeHelp">
          <Icon name="close" size="16" /> 关闭
        </button>
      </header>

      <div class="hd-body">
        <!-- 1. 什么时候用 / 谁来做 / 做完长什么样 / 什么时候停下问人 -->
        <dl class="hd-kv">
          <dt>什么时候用</dt>
          <dd>{{ H.when }}</dd>
          <dt>谁来做</dt>
          <dd><b>{{ H.who }}</b></dd>
          <dt>做完长什么样</dt>
          <dd class="ok-txt">{{ H.success }}</dd>
          <dt>什么时候停下问人</dt>
          <dd class="stop-txt">{{ H.stop }}</dd>
        </dl>

        <!-- 2. 一步一步怎么做 -->
        <section class="hd-sec">
          <h3>一步一步怎么做</h3>
          <ol class="hd-steps">
            <li v-for="(s, idx) in H.steps" :key="idx">{{ s }}</li>
          </ol>
        </section>

        <!-- 3. 涉及专业词（点开大白话解释） -->
        <section v-if="H.terms?.length" class="hd-sec">
          <h3>点开看大白话名词解释</h3>
          <div class="hd-terms">
            <Term v-for="tk in H.terms" :key="tk" :k="tk" />
          </div>
        </section>

        <!-- 4. 防错保护说明 -->
        <section v-if="H.guards?.length" class="hd-sec">
          <h3>工作台怎么帮你防出错</h3>
          <div v-for="(g, gi) in H.guards" :key="gi" class="guard-box">
            <div><span>前置要求：</span>{{ g.pre }}</div>
            <div><span>容易犯的错：</span>{{ g.mistake }}</div>
            <div><span>怎么帮你拦：</span><b>{{ g.block }}</b></div>
            <div><span>下一步怎么点：</span>{{ g.tip }}</div>
            <div><span>点错了怎么办：</span>{{ g.recover }}</div>
            <div><span>谁来做：</span>{{ g.owner }}</div>
            <div><span>留什么凭证：</span>{{ g.evidence }}</div>
          </div>
        </section>

        <!-- 5. 提成与考核说明 -->
        <section v-if="H.kpi" class="hd-sec">
          <h3>提成怎么算（公开透明）</h3>
          <div class="kpi-box">
            <div><span>提成项目：</span><b>{{ H.kpi.metric }}</b></div>
            <div><span>计算方法：</span>{{ H.kpi.formula }}</div>
            <div><span>发放说明：</span>{{ H.kpi.sample }}</div>
            <div><span>谁能看到：</span>{{ H.kpi.viewer }}</div>
          </div>
        </section>

        <!-- 6. 演示短视频 -->
        <section class="hd-sec">
          <h3>操作短视频（30–90 秒）</h3>
          <div v-if="H.video" class="vid-box">
            <a :href="H.video" target="_blank" rel="noopener noreferrer" class="btn sm pri">
              <Icon name="play" size="14" /> 播放操作视频
            </a>
          </div>
          <div v-else class="vid-empty">
            <Icon name="play" size="16" />
            <span>这一步的短视频还没录：先照着上面的白话步骤一步步点就能过。</span>
          </div>
        </section>

        <!-- 7. 公司钉钉与飞书手册链接 -->
        <section v-if="H.wiki?.length" class="hd-sec">
          <h3>点开看公司钉钉 / 飞书原版手册</h3>
          <ul class="wiki-list">
            <li v-for="wk in H.wiki" :key="wk">
              <template v-if="WIKI[wk]?.u">
                <a :href="WIKI[wk].u" target="_blank" rel="noopener noreferrer">
                  {{ WIKI[wk].t }} ↗
                </a>
                <span class="tag">{{ WIKI[wk].ver || '现行手册' }}</span>
              </template>
              <template v-else-if="WIKI[wk]">
                <span class="muted">{{ WIKI[wk].t }}</span>
                <span class="tag amb">待补链接</span>
              </template>
            </li>
          </ul>
        </section>
      </div>

      <footer class="hd-foot">
        <div class="hd-foot-row">
          <a :href="`#/manual?k=${activeKey}`" class="btn sm" @click="closeHelp">
            <Icon name="book" size="15" /> 打开完整说明书 ›
          </a>
          <button v-if="mappedTour" type="button" class="btn sm pri" @click="startMappedTour">
            {{ savedPos > 0 ? `继续本页导览（第 ${savedPos + 1} 步）` : '开始本页步进导览' }}
          </button>
          <button type="button" class="btn sm" @click="askBoss">遇到没见过的情况</button>
        </div>

        <div class="hd-reset-row">
          <template v-if="!confirmReset">
            <button type="button" class="reset-link" @click="confirmReset = true">
              一键重新新手指导（只重置学习进度，不动真单）
            </button>
          </template>
          <template v-else>
            <span class="muted" style="font-size: 12.5px">确认把当前角色练习进度清零重来？</span>
            <button type="button" class="btn sm bad" @click="doResetOnboarding">确认重置学习进度</button>
            <button type="button" class="btn sm" @click="confirmReset = false">取消</button>
          </template>
        </div>
      </footer>
    </aside>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store, closeHelp, callAction } from '../store.js';
import { HELP } from '../onboarding/helpData.js';
import { WIKI } from '../onboarding/wiki.js';
import { TOUR_OF_HELP, tourPos } from '../onboarding/tourSteps.js';
import Icon from './Icon.vue';
import Term from './Term.vue';

const closeBtn = ref(null);
const confirmReset = ref(false);

const activeKey = computed(() => (store.ui.helpKey && HELP[store.ui.helpKey] ? store.ui.helpKey : store.ui.helpKey ? 'today' : null));
const H = computed(() => (activeKey.value ? HELP[activeKey.value] : null));
const mappedTour = computed(() => (activeKey.value ? TOUR_OF_HELP[activeKey.value] || null : null));
const savedPos = computed(() => (mappedTour.value ? tourPos(mappedTour.value) : 0));

function startMappedTour() {
  const page = mappedTour.value;
  if (!page) return;
  const i = tourPos(page);
  closeHelp();
  store.ui.tour = { page, i };
}

function askBoss() {
  closeHelp();
  store.ui.askBossOpen = true;
}

async function doResetOnboarding() {
  await callAction('/api/onboarding/practice', { reset: true }, '已重置当前角色新手指导进度，真单操作已重新上锁体验');
  confirmReset.value = false;
  closeHelp();
}

function onKey(e) {
  if (e.key === 'Escape' && store.ui.helpKey && !store.ui.termKey) {
    e.stopPropagation();
    closeHelp();
  }
}

watch(
  () => store.ui.helpKey,
  async (v) => {
    confirmReset.value = false;
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
.hd-mask {
  position: fixed;
  inset: 0;
  z-index: 85;
  background: rgba(8, 12, 22, 0.56);
  display: flex;
  justify-content: flex-end;
}
.hd-panel {
  width: min(560px, 100vw);
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--sh-up);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}
.hd-top {
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.hd-top h2 {
  font-size: 19px;
  font-weight: 800;
  margin-top: 6px;
  line-height: 1.3;
}
.hd-body {
  overflow-y: auto;
  padding: 18px 22px;
  display: grid;
  gap: 18px;
  align-content: start;
}
.hd-kv {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px 12px;
  background: var(--soft);
  padding: 14px 16px;
  border-radius: 16px;
  font-size: 13.5px;
  margin: 0;
}
.hd-kv dt {
  color: var(--mute);
  font-weight: 700;
}
.hd-kv dd {
  margin: 0;
}
.ok-txt {
  color: var(--grn-ink);
  font-weight: 600;
}
.stop-txt {
  color: var(--red-ink);
  font-weight: 600;
}
.hd-sec h3 {
  font-size: 14.5px;
  font-weight: 800;
  margin-bottom: 8px;
}
.hd-steps {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
  font-size: 14px;
}
.hd-terms {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
}
.guard-box,
.kpi-box {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px 14px;
  display: grid;
  gap: 5px;
  font-size: 13.5px;
}
.guard-box span,
.kpi-box span {
  color: var(--mute);
  font-weight: 700;
}
.vid-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: 12px;
  border: 1px dashed var(--line);
  color: var(--mute);
  font-size: 13px;
}
.wiki-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.wiki-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--soft);
  border-radius: 11px;
  font-size: 13.5px;
}
.hd-foot {
  padding: 14px 22px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  display: grid;
  gap: 10px;
}
.hd-foot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.hd-reset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.reset-link {
  min-height: 36px;
  font-size: 12.5px;
  color: var(--mute);
  text-decoration: underline;
}
.reset-link:hover {
  color: var(--ink);
}
</style>
