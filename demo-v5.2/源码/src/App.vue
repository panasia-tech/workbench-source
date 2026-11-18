<template>
  <div class="shell">
    <!-- 1. 左侧极简导航栏（只放员工每天真正在用的 5 个主入口 + 更多，绝不堆满后台菜单） -->
    <nav class="dock" aria-label="采购工作台主导航">
      <a href="#/today" class="brand-mark" title="采购工作台 · 回今天">采</a>

      <a
        v-for="item in primaryNav"
        :key="item.k"
        :href="item.href"
        class="di"
        :class="{ on: isNavActive(item.k) }"
      >
        <span class="di-ic">
          <Icon :name="item.icon" size="21" />
          <i v-if="item.badge > 0" class="n">{{ item.badge }}</i>
        </span>
        <span class="lb">{{ item.label }}</span>
      </a>

      <div class="dock-sep" />

      <a
        v-for="item in helpNav"
        :key="item.k"
        :href="item.href"
        class="di"
        :class="{ on: isNavActive(item.k) }"
      >
        <span class="di-ic">
          <Icon :name="item.icon" size="20" />
          <i v-if="item.badge > 0" class="n">{{ item.badge }}</i>
        </span>
        <span class="lb">{{ item.label }}</span>
      </a>

      <button
        type="button"
        class="di"
        :class="{ on: isMoreRoute }"
        title="全局搜订单 · 系统健康检查 · 界面设置 (⌘K)"
        @click="openFinder"
      >
        <span class="di-ic">
          <Icon name="search" size="19" />
        </span>
        <span class="lb">搜单</span>
      </button>

      <div class="dock-foot">
        <button
          type="button"
          class="acct-pill"
          title="切换当前角色（体验采购员/仓管/会计/主管配合）"
          @click="roleMenuOpen = !roleMenuOpen"
        >
          <span class="acct-av">{{ (role.name || '采').slice(0, 1) }}</span>
          <span>{{ role.name }}</span>
        </button>
      </div>
    </nav>

    <!-- 2. 右侧主工作区 -->
    <div class="workspace">
      <header class="topbar">
        <div class="trail">
          <span class="desktop-only">采购工作台 /</span>
          <b>{{ routeTitle }}</b>
        </div>

        <div class="toptools">
          <!-- 切换岗位角色（方便老板一键检验：采购谈价、仓管验机、会计核账、新员工防错锁） -->
          <div style="position: relative">
            <button type="button" class="btn sm" @click="roleMenuOpen = !roleMenuOpen">
              👤 {{ role.name }} · {{ role.role_label }} ▾
            </button>
            <div v-if="roleMenuOpen" class="pop-menu" role="menu">
              <div class="sec-lbl">切换岗位视角（体验分工配合）</div>
              <button
                v-for="r in store.dashboard.roles"
                :key="r.id"
                type="button"
                class="pop-item"
                :class="{ active: r.id === store.actorId }"
                @click="pickRole(r.id)"
              >
                <span><b>{{ r.name }}</b> · {{ r.role_label }}</span>
                <span v-if="r.id === 'newbie'" class="tag amb">新员工保护</span>
                <span v-else-if="r.id === store.actorId">✓</span>
              </button>
            </div>
          </div>

          <button type="button" class="btn sm" @click="store.ui.askBossOpen = true">
            🆘 问主管
          </button>

          <button
            v-if="hasPageTour"
            type="button"
            class="btn sm desktop-only"
            @click="startCurrentTour"
          >
            ✨ 带我走一遍
          </button>

          <button
            type="button"
            class="btn sm desktop-only"
            :class="{ pri: store.ui.fontLarge }"
            @click="toggleFontLarge"
          >
            大字
          </button>

          <button
            type="button"
            class="btn sm desktop-only"
            :title="store.ui.theme === 'dark' ? '切换明亮模式' : '切换夜间模式'"
            @click="toggleTheme"
          >
            <Icon name="sun" size="15" />
            {{ store.ui.theme === 'dark' ? '明亮' : '夜间' }}
          </button>

          <template v-if="!confirmDemoReset">
            <button type="button" class="btn sm desktop-only" title="把演示订单恢复到初始状态再测一遍" @click="confirmDemoReset = true">
              <Icon name="refresh" size="14" /> 恢复初始数据
            </button>
          </template>
          <template v-else>
            <button type="button" class="btn sm bad" @click="doResetDemo">确认恢复</button>
            <button type="button" class="btn sm" @click="confirmDemoReset = false">取消</button>
          </template>

          <span data-tour="today-help">
            <Q :k="pageHelpKey" label="怎么用" />
          </span>
        </div>
      </header>

      <!-- 新员工未通关 3 关防踩坑小练习时的温和引导条 -->
      <div v-if="!unlocked" class="gatebar" role="status">
        <span>
          🔒 新员工保护中：<b>{{ role.name }}</b> 已完成 <b>{{ doneCount }} / 3</b> 个防踩坑小练习，做完立即解锁全部采购单操作按钮。
        </span>
        <button type="button" class="btn sm pri" @click="store.ui.practice = 'chat_guard'">
          花 2 分钟点完练习 ›
        </button>
        <a href="#/learn" class="btn sm">看练习列表</a>
      </div>

      <div v-if="store.error" class="errbar" role="alert">
        <span>{{ store.error }}</span>
        <button type="button" class="btn sm" @click="refreshDashboard">重新加载</button>
      </div>

      <!-- 主页面内容 -->
      <main id="main-content" ref="mainEl" class="main">
        <CaseDetailView
          v-if="route.name === 'case-detail'"
          :case-id="route.caseId"
          :init-step="route.step"
        />
        <GalleryView
          v-else-if="route.name === 'cases'"
          :init-bucket="route.bucket"
          :init-reconcile="route.reconcile"
        />
        <ImSandboxView v-else-if="route.name === 'im-sandbox'" />
        <SellersSlowView v-else-if="route.name === 'sellers'" />
        <PricebookView v-else-if="route.name === 'pricebook'" />
        <FinanceView v-else-if="route.name === 'ledger'" />
        <RpaWindowsView v-else-if="route.name === 'rpa'" />
        <ReadinessView v-else-if="route.name === 'readiness'" />
        <TrainingView v-else-if="route.name === 'learn'" />
        <ManualView
          v-else-if="route.name === 'manual'"
          :focus-help="route.helpKey"
          :focus-term="route.termKey"
        />
        <TodayView v-else />
      </main>
    </div>

    <!-- 3. 手机端底部 5 格大按钮导航（≤820px 自动显示） -->
    <nav class="mbdock" aria-label="手机底部导航">
      <a href="#/today" class="mdi" :class="{ on: route.name === 'today' }">
        <span class="mic">
          <Icon name="today" size="19" />
          <i v-if="redCaseCount > 0" class="mn">{{ redCaseCount }}</i>
        </span>
        <span>今天</span>
      </a>
      <a href="#/cases" class="mdi" :class="{ on: route.name === 'cases' || route.name === 'case-detail' }">
        <span class="mic">
          <Icon name="grid" size="19" />
          <i v-if="issueBucketCount > 0" class="mn">{{ issueBucketCount }}</i>
        </span>
        <span>采购订单</span>
      </a>
      <a href="#/im-sandbox" class="mdi" :class="{ on: route.name === 'im-sandbox' }">
        <span class="mic">
          <Icon name="chat" size="19" />
          <i v-if="manualConvCount > 0" class="mn">{{ manualConvCount }}</i>
        </span>
        <span>闲鱼聊天</span>
      </a>
      <a href="#/learn" class="mdi" :class="{ on: route.name === 'learn' }">
        <span class="mic">
          <Icon name="learn" size="19" />
          <i v-if="learnBadge > 0" class="mn">{{ learnBadge }}</i>
        </span>
        <span>学</span>
      </a>
      <button type="button" class="mdi" :class="{ on: isMoreRoute }" @click="openFinder">
        <span class="mic"><Icon name="search" size="19" /></span>
        <span>更多</span>
      </button>
    </nav>

    <!-- 4. 「更多」与全局搜索面板 -->
    <dialog ref="finderRef" class="finder-dialog" aria-label="更多工具与搜订单" @click.self="closeFinder">
      <div class="fd-inner">
        <div class="fd-hd">
          <b>更多工具 · 搜采购订单 · 界面设置</b>
          <button type="button" class="btn sm" @click="closeFinder"><Icon name="close" size="16" /> 关闭</button>
        </div>

        <input
          ref="finderInputRef"
          v-model="finderKw"
          type="search"
          class="input"
          placeholder="搜商品名称、卖家昵称、退差价、850、提成、价格表…"
        />

        <div class="fd-prefs">
          <button type="button" class="btn sm" @click="toggleTheme">
            切换{{ store.ui.theme === 'dark' ? '明亮' : '夜间' }}模式
          </button>
          <button type="button" class="btn sm" :class="{ pri: store.ui.fontLarge }" @click="toggleFontLarge">
            {{ store.ui.fontLarge ? '✓ 大字模式已开' : '开启大字模式' }}
          </button>
          <button type="button" class="btn sm" @click="closeFinder(); store.ui.devReqOpen = true">
            哪里不好用？提建议
          </button>
        </div>

        <div class="fd-list">
          <div class="fd-lbl">更多辅助页面</div>
          <a
            v-for="nav in moreNavItems"
            :key="nav.k"
            :href="nav.href"
            class="fd-item"
            @click="closeFinder"
          >
            <span><Icon :name="nav.icon" size="17" /> <b>{{ nav.label }}</b> — {{ nav.desc }}</span>
            <span>›</span>
          </a>

          <div class="fd-lbl">快速跳到采购订单（{{ matchedCases.length }} 笔）</div>
          <a
            v-for="c in matchedCases"
            :key="c.case_id"
            :href="`#/case/${c.case_id}`"
            class="fd-item"
            @click="closeFinder"
          >
            <span>
              <span class="tag" :class="c.lvl" style="margin-right: 6px">{{ c.bucket_label || LV[c.lvl].text }}</span>
              <b>{{ c.title }}</b>
            </span>
            <span class="muted">{{ c.step_progress?.summary || '' }} ›</span>
          </a>
        </div>
      </div>
    </dialog>

    <!-- 5. 问号教程抽屉、名词白话卡、新手练习窗、问主管窗、步进导览 -->
    <HelpDrawer />
    <TermModal />
    <PracticeModal />
    <AskBossModal />
    <DevReqModal />
    <TourOverlay />

    <!-- 6. 底部轻提示 -->
    <div v-if="store.toast" class="toast" :class="{ err: store.toast.kind === 'err' }" role="status" aria-live="polite">
      {{ store.toast.text }}
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  store,
  LV,
  applyUiPrefs,
  setTheme,
  toggleFontLarge,
  currentRole,
  setActor,
  isPracticeUnlocked,
  practiceDoneCount,
  refreshDashboard,
  callAction,
  notify,
} from './store.js';
import { TOURS, tourPos } from './onboarding/tourSteps.js';

import Icon from './components/Icon.vue';
import Q from './components/Q.vue';
import HelpDrawer from './components/HelpDrawer.vue';
import TermModal from './components/TermModal.vue';
import PracticeModal from './components/PracticeModal.vue';
import AskBossModal from './components/AskBossModal.vue';
import DevReqModal from './components/DevReqModal.vue';
import TourOverlay from './components/TourOverlay.vue';

import TodayView from './views/TodayView.vue';
import GalleryView from './views/GalleryView.vue';
import CaseDetailView from './views/CaseDetailView.vue';
import ImSandboxView from './views/ImSandboxView.vue';
import SellersSlowView from './views/SellersSlowView.vue';
import PricebookView from './views/PricebookView.vue';
import FinanceView from './views/FinanceView.vue';
import RpaWindowsView from './views/RpaWindowsView.vue';
import ReadinessView from './views/ReadinessView.vue';
import TrainingView from './views/TrainingView.vue';
import ManualView from './views/ManualView.vue';

const hashStr = ref(window.location.hash || '#/today');
const roleMenuOpen = ref(false);
const confirmDemoReset = ref(false);
const mainEl = ref(null);
const finderRef = ref(null);
const finderInputRef = ref(null);
const finderKw = ref('');

function parseHash(raw) {
  const clean = (raw || '#/today').replace(/^#/, '');
  const [pathPart, qsPart = ''] = clean.split('?');
  const params = new URLSearchParams(qsPart);

  if (pathPart.startsWith('/conversations') || pathPart.startsWith('/im')) return { name: 'im-sandbox' };
  if (pathPart.startsWith('/sellers') || pathPart.startsWith('/slow')) return { name: 'sellers' };
  if (pathPart.startsWith('/discovery')) return { name: 'rpa' };
  if (pathPart.startsWith('/orders')) return { name: 'cases', bucket: 'today' };
  if (pathPart.startsWith('/aftersales')) return { name: 'cases', bucket: 'issue' };
  if (pathPart.startsWith('/finance') || pathPart.startsWith('/ledger')) return { name: 'ledger' };
  if (pathPart.startsWith('/training') || pathPart.startsWith('/learn')) return { name: 'learn' };

  if (pathPart.startsWith('/case/')) {
    const caseId = decodeURIComponent(pathPart.slice('/case/'.length));
    const step = params.get('step') ? Number(params.get('step')) : null;
    return { name: 'case-detail', caseId, step };
  }
  if (pathPart.startsWith('/cases')) {
    return { name: 'cases', bucket: params.get('bucket') || '', reconcile: params.get('reconcile') === '1' };
  }
  if (pathPart.startsWith('/pricebook')) return { name: 'pricebook' };
  if (pathPart.startsWith('/rpa') || pathPart.startsWith('/windows')) return { name: 'rpa' };
  if (pathPart.startsWith('/readiness')) return { name: 'readiness' };
  if (pathPart.startsWith('/manual')) {
    return { name: 'manual', helpKey: params.get('k') || '', termKey: params.get('t') || '' };
  }
  return { name: 'today' };
}

const route = computed(() => parseHash(hashStr.value));
const role = computed(() => currentRole());
const unlocked = computed(() => isPracticeUnlocked());
const doneCount = computed(() => practiceDoneCount());

const redCaseCount = computed(() => store.dashboard.cases.filter((c) => c.lvl === 'red').length);
const stmtDiffCount = computed(() => {
  const s = store.dashboard.statement_reconciliation?.summary;
  return s ? Number(s.missing_count || 0) + Number(s.amount_diff_count || 0) : 0;
});
const issueBucketCount = computed(() => store.dashboard.cases.filter((c) => c.order_bucket === 'issue').length + stmtDiffCount.value);
const manualConvCount = computed(() => store.dashboard.conversations.filter((c) => c.needs_manual || c.unread_count > 0).length);
const pendingFinanceCount = computed(() => store.dashboard.finance_ledger.filter((x) => x.status !== 'verified').length + stmtDiffCount.value);
const queuedJobCount = computed(() => (store.dashboard.executor_jobs || []).filter((j) => j.status === 'queued' || j.status === 'triggered_10m_sla').length);
const slowPoolCount = computed(() => (store.dashboard.conversations || []).filter((c) => Number(c.slow_group) === 1).length);
const learnBadge = computed(() => (role.value.role === 'purchaser' ? Math.max(0, 3 - doneCount.value) : 0));

const primaryNav = computed(() => [
  { k: 'today', label: '今天', href: '#/today', icon: 'today', badge: redCaseCount.value },
  { k: 'im-sandbox', label: '会话陪谈', href: '#/im-sandbox', icon: 'chat', badge: manualConvCount.value },
  { k: 'rpa', label: '寻源专窗', href: '#/rpa', icon: 'box', badge: queuedJobCount.value },
  { k: 'cases', label: '采购订单', href: '#/cases', icon: 'grid', badge: issueBucketCount.value },
  { k: 'sellers', label: '卖家慢压', href: '#/sellers', icon: 'star', badge: slowPoolCount.value },
  { k: 'pricebook', label: '行情参考', href: '#/pricebook', icon: 'order', badge: 0 },
  { k: 'ledger', label: '对账收益', href: '#/ledger', icon: 'ledger', badge: pendingFinanceCount.value },
]);

const helpNav = computed(() => [
  { k: 'learn', label: '学', href: '#/learn', icon: 'learn', badge: learnBadge.value },
  { k: 'manual', label: '说明书', href: '#/manual', icon: 'book', badge: 0 },
]);

const moreNavItems = computed(() => {
  const kw = finderKw.value.trim().toLowerCase();
  const base = [
    { k: 'sellers', label: '卖家关系库与慢慢压价池', href: '#/sellers', icon: 'star', desc: '收藏卖家（个人私藏/采购组共享）+ 慢慢压价长线池低频巡检' },
    { k: 'rpa', label: '寻源监听与 1前台+3后台专窗队列', href: '#/rpa', icon: 'box', desc: '监听链接幂等去重、后台窗#1首报/#2回复/#3顺丰派送盯梢触发仓管10m验货' },
    { k: 'ledger', label: '对账与个人收益看板（两段各10%）', href: '#/ledger', icon: 'ledger', desc: '整单全退走支付宝对公次日10:00审批、今日¥1,000目标进度、两段10%独立核算' },
    { k: 'pricebook', label: '行情与参考中心（核价·定损·选招表）', href: '#/pricebook', icon: 'order', desc: '买前三档上限与历史版本、五大品类P3/P4定损标准、卖家原话×12大心理博弈选招表' },
    { k: 'manual', label: '完整图文手册（12大心理博弈+双轨SOP）', href: '#/manual', icon: 'book', desc: 'P1–P6行为心理学×G1–G6动态博弈矩阵、双轨二次议价与整单退T+1全流程手册' },
    { k: 'readiness', label: '系统健康检查（主管/管理）', href: '#/readiness', icon: 'spark', desc: '查看全流程防错开关与业务规则核验状态' },
  ];
  if (!kw) return base;
  return base.filter((x) => `${x.label} ${x.desc}`.toLowerCase().includes(kw));
});

const matchedCases = computed(() => {
  const kw = finderKw.value.trim().toLowerCase();
  const list = store.dashboard.cases || [];
  if (!kw) return list.slice(0, 8);
  return list.filter((c) =>
    `${c.title} ${c.seller_name} ${c.model_code} ${c.bucket_label} ${c.source_type}`.toLowerCase().includes(kw)
  );
});

const isMoreRoute = computed(() => ['readiness'].includes(route.value.name));

function isNavActive(k) {
  if (k === 'cases' && (route.value.name === 'cases' || route.value.name === 'case-detail')) return true;
  return route.value.name === k;
}

const routeTitle = computed(() => {
  const n = route.value.name;
  if (n === 'today') return '今天要办的事 & 个人单日收益进度';
  if (n === 'cases') return '采购订单（今天采购的 · 二次议价问题订单 · 已经完结的）';
  if (n === 'case-detail') {
    const c = store.dashboard.cases.find((x) => x.case_id === route.value.caseId);
    return c ? `${c.bucket_label || '采购订单'} / ${c.title}` : '订单一步步操作';
  }
  if (n === 'im-sandbox') return '会话陪谈台（多图快照大图 · 逐轮报价折线图 · 四 Dock 协同）';
  if (n === 'sellers') return '卖家关系库（个人/团队共享） & 慢慢压价长线池';
  if (n === 'learn') return '新手 3 关防踩坑练习';
  if (n === 'manual') return '采购说明书与公司总手册（v5.0）';
  if (n === 'pricebook') return '行情与参考中心（价格版本 · 定损标准 · 12大心理博弈选招）';
  if (n === 'ledger') return '对账审批（支付宝对公T+1） & 个人收益看板（两段各10%）';
  if (n === 'rpa') return '寻源监听去重 & 1前台+3后台专窗任务队列';
  if (n === 'readiness') return '系统健康检查';
  return '采购工作台';
});

const pageHelpKey = computed(() => {
  const n = route.value.name;
  if (n === 'today') return 'today';
  if (n === 'cases') return 'cases';
  if (n === 'case-detail') return 'case-detail';
  if (n === 'im-sandbox') return 'im';
  if (n === 'sellers') return 'im';
  if (n === 'learn') return 'learn';
  if (n === 'pricebook') return 'pricebook';
  if (n === 'ledger') return 'finance';
  if (n === 'rpa') return 'windows';
  return 'today';
});

const hasPageTour = computed(() => Boolean(TOURS[route.value.name]));

function startCurrentTour() {
  const p = route.value.name;
  if (TOURS[p]) {
    store.ui.tour = { page: p, i: tourPos(p) };
  }
}

function pickRole(id) {
  setActor(id);
  roleMenuOpen.value = false;
  const r = store.dashboard.roles.find((x) => x.id === id);
  notify(`已切换为：${r ? `${r.name}（${r.role_label}）` : id}`);
}

function toggleTheme() {
  setTheme(store.ui.theme === 'dark' ? 'light' : 'dark');
}

async function doResetDemo() {
  confirmDemoReset.value = false;
  await callAction('/api/demo/reset', {}, '已恢复初始演示订单数据');
}

function openFinder() {
  finderKw.value = '';
  if (finderRef.value && !finderRef.value.open) {
    finderRef.value.showModal();
    setTimeout(() => finderInputRef.value?.focus(), 40);
  }
}

function closeFinder() {
  if (finderRef.value?.open) finderRef.value.close();
}

function onHashChange() {
  hashStr.value = window.location.hash || '#/today';
  roleMenuOpen.value = false;
  nextTick(() => {
    if (mainEl.value) mainEl.value.scrollTop = 0;
  });
}

function onGlobalKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openFinder();
  }
}

watch(() => route.value.name, () => {
  roleMenuOpen.value = false;
});

onMounted(async () => {
  applyUiPrefs();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onGlobalKey);
  await refreshDashboard();
});

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('keydown', onGlobalKey);
});
</script>

<style scoped>
.fd-inner {
  padding: 20px;
  display: grid;
  gap: 12px;
}
.fd-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 16px;
}
.fd-prefs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.fd-list {
  display: grid;
  gap: 6px;
  max-height: 52dvh;
  overflow-y: auto;
}
.fd-lbl {
  font-size: 12px;
  font-weight: 700;
  color: var(--mute);
  margin-top: 6px;
}
.fd-item {
  min-height: 44px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--soft);
  color: var(--ink);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13.5px;
}
.fd-item:hover {
  background: var(--acc-soft);
  text-decoration: none;
}
</style>
