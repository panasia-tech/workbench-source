<template>
  <router-view v-if="isLoginRoute" />

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-title">泛亚采购 × 闲鱼监控</div>
        <div class="sidebar-brand-sub">v6.0 全栈融合正式版 · WAL SQLite</div>
      </div>

      <div class="nav-group">
        <div class="nav-group-label">工作台主干</div>
        <router-link to="/" class="nav-item">
          <span>🏠 今日工作台 & 对账</span>
          <span class="nav-badge red" v-if="pendingReconcileCount > 0">{{ pendingReconcileCount }}</span>
        </router-link>
        <router-link to="/monitor" class="nav-item">
          <span>🔍 闲鱼监控融合中心</span>
          <span class="nav-badge">{{ store.hitsCount }}</span>
        </router-link>
        <router-link to="/im" class="nav-item">
          <span>💬 合规议价 IM 与快照</span>
        </router-link>
        <router-link to="/cases" class="nav-item">
          <span>📦 采购单 & 二次议价</span>
          <span class="nav-badge red" v-if="store.counts.issue > 0">{{ store.counts.issue }}</span>
        </router-link>
      </div>

      <div class="nav-group">
        <div class="nav-group-label">护航风控与财务</div>
        <router-link to="/accounts" class="nav-item">
          <span>🛡 5%红标池 & 1+3专窗</span>
        </router-link>
        <router-link to="/sellers" class="nav-item">
          <span>⭐ 收藏卖家 & 黑名单</span>
        </router-link>
        <router-link to="/pricebook" class="nav-item">
          <span>📏 四维行情参考表</span>
        </router-link>
        <router-link to="/finance" class="nav-item">
          <span>💰 财务对账 & 两段10%</span>
        </router-link>
      </div>

      <div class="nav-group">
        <div class="nav-group-label">防呆与实战培训</div>
        <router-link to="/tutorials" class="nav-item">
          <span>🎬 视频教程 & 3关考试</span>
          <span class="nav-badge" :class="!store.staff?.practice_unlocked ? 'red' : ''">
            {{ store.staff?.practice_passed_gates?.length || 0 }}/3
          </span>
        </router-link>
      </div>

      <div style="margin-top: auto; padding: 14px 16px; border-top: 1px solid #1e293b;" v-if="store.staff">
        <div style="font-size: 13px; font-weight: 700; color: #fff;">{{ store.staff.name }}</div>
        <div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px;">{{ store.staff.role_label }} · {{ store.staff.username }}</div>
        <button class="btn btn-sm" style="width: 100%; background: #1e293b; color: #cbd5e1; border-color: #334155;" @click="doLogout">
          退出当前账号
        </button>
      </div>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <div class="topbar-left">
          <div class="topbar-title">{{ currentTitle }}</div>
          <span
            v-if="nearRedlineAccount"
            class="tag amb"
            style="cursor: pointer;"
            @click="router.push('/accounts')"
          >
            ⚠ {{ nearRedlineAccount.account_name }} 退款率 {{ nearRedlineAccount.refund_rate_pct }}%（严禁超5%红标）
          </span>
        </div>

        <div class="topbar-actions">
          <button class="btn btn-sm btn-primary" @click="openVideoTutorial('ch1', 0)">🎬 内置视频教程</button>
          <button class="btn btn-sm" @click="startPageTour(currentTourKey)">🧭 本页聚光灯引导</button>
          <button class="btn btn-sm" @click="openHelpDrawer(currentHelpKey)">❓ 本页防呆与16条红线</button>
        </div>
      </header>

      <div class="content-area">
        <!-- 未通关新手 403 硬保护提示条 -->
        <div v-if="store.staff && store.staff.role === 'PURCHASER' && !store.staff.practice_unlocked" class="banner red">
          <div>
            <strong>🛡 新员工防踩坑锁定中（{{ store.staff.name }} · 已通关 {{ store.staff.practice_passed_gates.length }}/3）：</strong>
            您的真实业务修改接口（建监控/转单/发消息/补抓对账）暂时受 403 保护，请先花 1 分钟完成 3 道实战题即可全部解锁！
          </div>
          <router-link to="/tutorials" class="btn btn-sm btn-danger">立即去 3 关通关 →</router-link>
        </div>

        <router-view />
      </div>
    </div>

    <VideoTutorialModal />
    <TourOverlay />
    <HelpDrawer />
    <SnapshotLightbox />

    <div class="toast-stack">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  store,
  logout,
  restoreSession,
  openVideoTutorial,
  startPageTour,
  openHelpDrawer,
} from './store/store.js';
import VideoTutorialModal from './components/VideoTutorialModal.vue';
import TourOverlay from './components/TourOverlay.vue';
import HelpDrawer from './components/HelpDrawer.vue';
import SnapshotLightbox from './components/SnapshotLightbox.vue';

const route = useRoute();
const router = useRouter();

const isLoginRoute = computed(() => route.path === '/login');
const currentTitle = computed(() => route.meta?.title || '泛亚采购工作台');
const currentHelpKey = computed(() => route.meta?.helpKey || 'home');
const currentTourKey = computed(() => route.meta?.tourKey || 'home');
const pendingReconcileCount = computed(() => store.reconcileSummary?.unresolved_count || 0);
const nearRedlineAccount = computed(() =>
  (store.accounts || []).find((a) => a.risk_level === 'amb' || a.risk_level === 'red')
);

function doLogout() {
  logout();
  router.push('/login');
}

onMounted(async () => {
  await restoreSession();
});
</script>
