<template>
  <div
    class="cs-embed-root"
    :class="{ 'is-embedded': embedded }"
    :data-cs-theme="store.ui.darkMode ? 'dark' : 'light'"
    :data-cs-font="store.ui.largeFont ? 'large' : 'normal'"
  >
  <div class="folded-app" :class="{ embedded }" @click="closePopMenus">
    <!-- ==================== 顶部 54px 清爽顶栏：名字状态 + 平铺核心绩效 + 折叠工具舱 ==================== -->
    <header class="top-header">
      <div class="brand-area">
        <div class="brand-icon">客</div>
        <span class="brand-title">外部客服工作台</span>
        <button
          type="button"
          class="duty-pill"
          :class="{ off: !store.dutyOnline, internal: isInternalOrSupervisor }"
          title="点击切换在岗接待 / 小休离席状态"
          @click.stop="toggleDutyStatus"
        >
          <span>{{ store.dutyOnline ? '●' : '☕' }}</span>
          <b>{{ currentRole.name }}</b>
          <small>· {{ store.dutyOnline ? '在岗' : '小休' }}</small>
        </button>
        <button
          v-if="newbieLocked"
          type="button"
          class="newbie-pill"
          @click="store.ui.practiceOpenKey = practiceStatus.nextKey"
        >
          🎓 3关待解锁({{ practiceStatus.passedCount }}/3)
        </button>
        <Q k="chat" />
      </div>

      <!-- 核心绩效指标平铺展示（一眼可见，点“全维考核”抽屉展开 14 项明细） -->
      <div class="kpi-inline-bar" data-tour="top-kpi">
        <span class="kpi-item">接待 <b>{{ myKpi.todayUv }}人</b></span>
        <span class="kpi-item">首响 <b class="good">{{ myKpi.firstReplyMedianSec }}s</b></span>
        <span class="kpi-item">
          3分率 <b :class="myKpi.threeMinRate >= 96 ? 'good' : 'bad'">{{ myKpi.threeMinRate }}%</b>
        </span>
        <span class="kpi-item">保修 <b>{{ myKpi.warrantyActiveCount }}单</b></span>
        <span class="kpi-item">满意 <b class="good">{{ myKpi.satisfactionRate }}%</b></span>
        <button type="button" class="kpi-more-btn" @click="store.ui.kpiDrawerOpen = true">
          全维考核 ▾
        </button>
      </div>

      <!-- 右侧折叠功能入口（不堆满屏幕，点开即得） -->
      <div class="header-actions">
        <button type="button" class="btn sm soft" @click="store.ui.tutorialDrawerOpen = true">
          📚 教程台账
        </button>
        <button type="button" class="btn sm soft" @click="store.ui.autoRuleModalOpen = true">
          🖼 自动发图({{ enabledRuleCount }})
        </button>
        <button type="button" class="btn sm" @click="store.ui.autoShipDrawerOpen = true">
          📦 自动发货池({{ activeAutoShipCount }})
        </button>
        <button v-if="!embedded" type="button" class="btn sm" @click="toggleSkin">
          {{ store.ui.darkMode ? '☀️ 浅色皮肤' : '🌙 Claude 黑色皮肤' }}
        </button>

        <!-- 更多与四角色视角切换折叠菜单 -->
        <div class="more-wrap" @click.stop>
          <button
            type="button"
            class="btn sm"
            :class="{ soft: store.ui.moreMenuOpen }"
            @click="store.ui.moreMenuOpen = !store.ui.moreMenuOpen"
          >
            ⚙ 视角与更多 ▾
          </button>

          <div v-if="store.ui.moreMenuOpen" class="more-dropdown">
            <div class="md-sec-title">
              {{ lockedOutsource ? '外包坐席账号状态（已隔离内部销售数据）' : '切换角色视角（验证 RBAC 脱敏与协同闭环）' }}
            </div>
            <button
              v-for="r in visibleRoles"
              :key="r.id"
              type="button"
              class="md-role-item"
              :class="{ active: store.actorId === r.id }"
              @click="onPickRole(r.id)"
            >
              <div>
                <b>{{ r.name }} · {{ r.roleLabel }}</b>
                <p>{{ r.desc }}</p>
              </div>
              <span v-if="store.actorId === r.id" class="tag acc">当前</span>
            </button>

            <template v-if="lockedOutsource">
              <div class="md-divider" />
              <div class="md-sec-title">演示环境切回完整销售工作台</div>
              <div class="md-grid-btns">
                <button type="button" class="md-btn" @click="emitSwitchSales('chenxm')">
                  ↩ 切回陈小满（内部销售）
                </button>
                <button type="button" class="md-btn" @click="emitSwitchSales('admin')">
                  ↩ 切回销售主管（全功能）
                </button>
              </div>
            </template>

            <div class="md-divider" />
            <div class="md-sec-title">零培训沙盒 · 职责红线 · 偏好设置</div>
            <div class="md-grid-btns">
              <button type="button" class="md-btn" @click="openNewbieSandbox">
                🎓 新人3关演练 ({{ practiceStatus.passedCount }}/3)
              </button>
              <button type="button" class="md-btn" @click="startSpotlightTour">
                ✨ 60秒界面聚光灯导览
              </button>
              <button type="button" class="md-btn" @click="openTutorialDrawer">
                📚 客服独立教程与视频台账
              </button>
              <button type="button" class="md-btn" @click="openManualDrawer">
                📖 职责红线与审计日志
              </button>
              <button type="button" class="md-btn" @click="store.ui.largeFont = !store.ui.largeFont">
                🔤 {{ store.ui.largeFont ? '切回标准字号' : '开启大字模式' }}
              </button>
              <button type="button" class="md-btn" @click="toggleSkin">
                {{ store.ui.darkMode ? '☀️ 切回 Stitch 浅色皮肤' : '🌙 切换 Claude 黑色皮肤' }}
              </button>
              <button type="button" class="md-btn warn" @click="resetDemo">
                ↻ 重置全部演示数据
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <!-- ==================== 主工作区：左中右三栏（保持微信/千牛式干净直觉） ==================== -->
    <div class="main-columns">
      <!-- 1. 左栏：售前 / 售后 / 问题订单 三分类 + 可折叠高级筛选 -->
      <aside class="col-left" data-tour="left-inbox">
        <div class="three-tabs">
          <button
            type="button"
            class="tab-btn"
            :class="{ active: store.ui.activeTab === 'pre_sale' }"
            @click="switchTab('pre_sale')"
          >
            售前 <em>{{ tabCounts.pre_sale }}</em>
          </button>
          <button
            type="button"
            class="tab-btn"
            :class="{ active: store.ui.activeTab === 'after_sale' }"
            @click="switchTab('after_sale')"
          >
            售后 <em>{{ tabCounts.after_sale }}</em>
          </button>
          <button
            type="button"
            class="tab-btn"
            :class="{ active: store.ui.activeTab === 'issue' }"
            @click="switchTab('issue')"
          >
            问题订单 <em class="warn">{{ tabCounts.issue }}</em>
          </button>
        </div>

        <div class="search-bar-row">
          <input v-model="store.ui.search" type="search" placeholder="搜买家昵称 / 订单号 / 店铺..." />
          <button
            type="button"
            class="filter-toggle"
            :class="{ on: store.ui.filterOpen || store.ui.platformFilter !== 'all' || store.ui.urgentOnly }"
            @click="store.ui.filterOpen = !store.ui.filterOpen"
          >
            筛选 {{ store.ui.filterOpen ? '▴' : '▾' }}
          </button>
        </div>

        <!-- 折叠：5大平台筛选与催回过滤（默认收起不占眼） -->
        <div v-if="store.ui.filterOpen" class="folded-filters">
          <div class="ff-plats">
            <button
              v-for="pf in PLATFORM_OPTIONS"
              :key="pf.k"
              type="button"
              class="ff-chip"
              :class="{ on: store.ui.platformFilter === pf.k }"
              @click="store.ui.platformFilter = pf.k"
            >
              {{ pf.label }}
            </button>
          </div>
          <label class="ff-urgent">
            <input v-model="store.ui.urgentOnly" type="checkbox" />
            <span>⚡ 仅看催回倒计时 / 50s机器人兜底待人工真回</span>
          </label>
        </div>

        <!-- 会话列表 -->
        <div class="session-list">
          <button
            v-for="c in filteredConversations"
            :key="c.id"
            type="button"
            class="session-row"
            :class="{ on: c.id === currentConv?.id }"
            @click="selectSession(c.id)"
          >
            <div class="sr-top">
              <span class="plat" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
              <b class="sr-name">{{ c.buyerNick }}</b>
              <span
                v-if="typeof c.slaRemainSec === 'number' && c.slaRemainSec > 0"
                class="sla-pill"
                :class="{ danger: c.slaRemainSec <= 90 }"
              >
                ⏱ {{ formatSec(c.slaRemainSec) }}
              </span>
              <span v-else class="sr-time">{{ c.time }}</span>
            </div>

            <div class="sr-msg">{{ lastMessageText(c) }}</div>

            <div class="sr-foot">
              <span class="sr-shop">{{ c.shopName }}</span>
              <span
                class="mini-status"
                :class="{
                  ok: c.warrantyActivated || c.refundReasonOk || c.stepState === 'SHIPPED_AUTO',
                  warn:
                    c.category === 'issue' ||
                    c.autoRepliedOnly ||
                    c.stepState === 'WAIT_PICK_SEND' ||
                    c.stepState === 'INTERCEPTED_409',
                }"
              >
                {{ c.statusBadge }}
              </span>
            </div>
          </button>

          <div v-if="!filteredConversations.length" class="empty-tip">
            当前筛选条件下暂无会话
            <button
              v-if="store.ui.platformFilter !== 'all' || store.ui.urgentOnly || store.ui.search"
              type="button"
              class="link-reset"
              @click="clearFilters"
            >
              清空筛选条件
            </button>
          </div>
        </div>
      </aside>

      <!-- 2. 中栏：清爽聊天窗（含置顶承诺、幕后锦囊、链接体检、实拍视频与场景卡片） -->
      <main v-if="currentConv" class="col-center" data-tour="center-chat">
        <header class="chat-top">
          <div class="ct-left">
            <b class="ct-buyer">{{ currentConv.buyerNick }}</b>
            <span class="plat" :class="'plat-' + currentConv.platform">
              {{ currentConv.platformLabel }} · {{ currentConv.shopName }}
            </span>
            <span v-if="currentConv.orderNo" class="order-pill">
              {{ currentConv.orderNo }} · ¥{{ currentConv.paidAmount }}
            </span>
            <span v-for="tg in currentConv.buyerTags" :key="tg" class="buyer-tag">{{ tg }}</span>
          </div>

          <div class="ct-right">
            <span v-if="currentConv.owner?.type === 'internal'" class="tag red">
              🔒 {{ currentConv.owner.name }}接管中
            </span>
            <span v-else-if="currentConv.warrantyActivated" class="activated-pill">
              ✅ 保修已激活（富阳法院管辖生效）
            </span>
          </div>
        </header>

        <!-- 置顶承诺条（内部交还承诺或开票/赠线约定，防外包漏看扯皮） -->
        <div v-if="currentConv.commitments?.length" class="pinned-bar commit">
          <span>📌 <b>已答应买家的承诺（跟进必读）：</b>{{ currentConv.commitments.join(' ； ') }}</span>
        </div>

        <!-- 幕后黄色锦囊条（内部销售发给外包坐席的暗语指导，买家不可见） -->
        <div v-if="currentConv.internalNotes?.length" class="pinned-bar coach">
          <div>
            💡 <b>{{ currentConv.internalNotes[currentConv.internalNotes.length - 1].who }}（买家不可见）：</b>
            {{ currentConv.internalNotes[currentConv.internalNotes.length - 1].text }}
          </div>
        </div>

        <!-- 聊天消息流 -->
        <div ref="chatScrollEl" class="chat-body">
          <div v-for="m in currentConv.messages" :key="m.id" class="msg-line" :class="m.dir">
            <div v-if="m.dir === 'sys'" class="sys-note">{{ m.text }}</div>

            <div v-else class="bubble-group">
              <div class="bg-meta">
                <span>{{ m.who }}</span>
                <span v-if="m.autoTag" class="auto-pill">{{ m.autoTag }}</span>
                <span>{{ m.time }}</span>
              </div>

              <div class="bubble-box">
                <div class="bb-text">{{ m.text }}</div>

                <!-- 买家或客服消息内的 URL 链接自动体检徽章 -->
                <div v-if="inspectLinksInText(m.text, currentConv).length" class="link-audit-stack">
                  <div
                    v-for="(lk, lki) in inspectLinksInText(m.text, currentConv)"
                    :key="lki"
                    class="link-audit-pill"
                    :class="lk.tone"
                  >
                    {{ lk.label }}
                  </div>
                </div>

                <!-- 随消息发出的 WMS 一件一拍照片与 1080p60 通电视频 -->
                <div v-if="m.mediaSkuCode && getVisibleSku(m.mediaSkuCode)" class="real-media-box">
                  <div class="rm-imgs">
                    <img
                      v-for="ph in getVisibleSku(m.mediaSkuCode).photos"
                      :key="ph.id"
                      :src="ph.url"
                      :alt="ph.label"
                      @click="zoomImg(ph.url, `${m.mediaSkuCode} · ${ph.label}`)"
                    />
                  </div>
                  <button
                    v-if="getVisibleSku(m.mediaSkuCode).videoReady"
                    type="button"
                    class="rm-vid-btn"
                    @click="store.ui.videoModalSku = getVisibleSku(m.mediaSkuCode)"
                  >
                    ▶ 播放本机通电实拍视频（{{ getVisibleSku(m.mediaSkuCode).video.duration }} ·
                    {{ getVisibleSku(m.mediaSkuCode).video.resolution }}）
                  </button>
                </div>

                <!-- 场景自动/手动发出的高清图片卡（保修激活卡 / 退款3步手机UI图） -->
                <div v-if="m.cardImage" class="scene-card-img-wrap">
                  <img
                    :src="m.cardImage"
                    :alt="m.cardTitle"
                    class="scene-card-img"
                    @click="zoomImg(m.cardImage, m.cardTitle)"
                  />
                  <div class="zoom-hint">🔍 点击图片放大查看高清大图</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部输入与防封号外发守卫区 -->
        <footer class="chat-composer" @click.stop>
          <div class="quick-strip">
            <button
              v-for="(qr, idx) in QUICK_REPLIES"
              :key="idx"
              type="button"
              class="q-chip"
              :title="qr.text"
              @click="draft = qr.text"
            >
              {{ qr.label }}
            </button>

            <div style="margin-left: auto; position: relative">
              <button
                type="button"
                class="q-chip highlight"
                @click="cardMenuOpen = !cardMenuOpen"
              >
                🖼 手动发场景图 ▾
              </button>
              <div v-if="cardMenuOpen" class="card-pop-menu">
                <button
                  v-for="r in store.data.autoRules"
                  :key="r.id"
                  type="button"
                  class="cpm-item"
                  @click="manualSendCard(r.id)"
                >
                  发送：{{ r.sceneName }}
                </button>
              </div>
            </div>
          </div>

          <!-- 实时外发守卫红字拦截原因（输入手机号/微信号/单字“1”立即提示） -->
          <div v-if="!liveGuard.ok" class="guard-live-alert">
            <div>🛡️ <b>外发守卫实时拦截：</b>{{ liveGuard.reason }}</div>
            <div style="opacity: 0.88">💡 {{ liveGuard.penalty }}</div>
          </div>
          <div v-else-if="composerLockedReason" class="guard-live-alert lock">
            <div>🔒 <b>当前输入已锁定：</b>{{ composerLockedReason }}</div>
            <button
              v-if="newbieLocked"
              type="button"
              class="btn sm pri"
              @click="store.ui.practiceOpenKey = practiceStatus.nextKey"
            >
              🎓 立即去做 3 关练习解锁 ›
            </button>
          </div>

          <div class="input-row">
            <textarea
              v-model="draft"
              rows="2"
              :disabled="Boolean(composerLockedReason)"
              :placeholder="
                composerLockedReason
                  ? composerLockedReason
                  : '输入回复内容，按 Enter 发送（自动拦截微信号/手机号/单字刷尾响）...'
              "
              @keydown.enter.exact.prevent="onSend"
            />
            <button
              type="button"
              class="btn pri send-btn"
              :disabled="!canSendText"
              @click="onSend"
            >
              发送
            </button>
          </div>
        </footer>
      </main>

      <!-- 3. 右栏：表层 2 张极简卡 + 3 个渐进折叠面板（保留 100% 深度能力） -->
      <RightFoldedCopilot
        :conv="currentConv"
        :picked-sku="pickedSku"
        :same-model-list="sameModelList"
        @update:picked-sku-code="pickedSkuCode = $event"
      />
    </div>

    <!-- 全局折叠抽屉与弹窗（考核大盘 / 自动发货看板 / 自动发图配置 / 手册审计 / 独立教程台账 / 十要素帮助 / 视频灯箱 / 导览与练兵） -->
    <WorkspaceDrawers />
    <CsTutorialDrawer />
    <HelpDrawer />
    <VideoPlayerModal />
    <OnboardingOverlays />

    <div v-if="store.toast" class="toast">{{ store.toast }}</div>
  </div>
  </div>
</template>

<script setup>
import './styles/cs-scoped.css';
import { computed, nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps({
  embedded: { type: Boolean, default: false },
  initialActor: { type: String, default: '' },
  lockedOutsource: { type: Boolean, default: false },
});
const emit = defineEmits(['switchSalesAcct']);
import {
  store,
  currentRole,
  activeAgentKpi as myKpi,
  isOutsourceRole,
  isInternalOrSupervisor,
  newbieLocked,
  practiceStatus,
  tabCounts,
  autoShipLanes,
  getVisibleSku,
  getSameSpuSkus,
  formatSec,
  initStore,
  switchActor,
  toggleDutyStatus,
  resetDemo,
  checkOutboundGuard,
  inspectLinksInText,
  sendChatMessage,
  sendRuleCardImage,
} from './store.js';
import { ROLES, QUICK_REPLIES } from './data/seed.js';
import { ui as salesUi, setSkin, toggleSkin } from '../ui.js';

watch(
  () => salesUi.skin,
  (s) => {
    const wantDark = s === 'dark';
    if (store.ui.darkMode !== wantDark) store.ui.darkMode = wantDark;
  },
  { immediate: true },
);
watch(
  () => store.ui.darkMode,
  (d) => {
    if ((salesUi.skin === 'dark') !== d) setSkin(d ? 'dark' : 'light');
  },
);
import RightFoldedCopilot from './components/RightFoldedCopilot.vue';
import WorkspaceDrawers from './components/WorkspaceDrawers.vue';
import CsTutorialDrawer from './components/CsTutorialDrawer.vue';
import HelpDrawer from './components/HelpDrawer.vue';
import VideoPlayerModal from './components/VideoPlayerModal.vue';
import OnboardingOverlays from './components/OnboardingOverlays.vue';
import Q from './components/Q.vue';

const PLATFORM_OPTIONS = [
  { k: 'all', label: '全部平台' },
  { k: 'xianyu', label: '闲鱼' },
  { k: 'pdd', label: '拼多多' },
  { k: 'taobao', label: '淘宝千牛' },
  { k: 'douyin', label: '抖店飞鸽' },
  { k: 'jd', label: '京东咚咚' },
];

const draft = ref('');
const cardMenuOpen = ref(false);
const pickedSkuCode = ref('');
const chatScrollEl = ref(null);

const visibleRoles = computed(() =>
  props.lockedOutsource
    ? ROLES.filter((r) => r.id === 'outsource_lu' || r.id === 'newbie')
    : ROLES,
);

function onPickRole(roleId) {
  if (props.lockedOutsource) {
    store.ui.moreMenuOpen = false;
    emit('switchSalesAcct', roleId === 'newbie' ? 'cs_newbie' : 'outsource_lu');
    return;
  }
  switchActor(roleId);
}

function emitSwitchSales(username) {
  store.ui.moreMenuOpen = false;
  emit('switchSalesAcct', username);
}

const enabledRuleCount = computed(() => store.data.autoRules.filter((r) => r.enabled).length);
const activeAutoShipCount = computed(
  () =>
    autoShipLanes.value.waitPick.length +
    autoShipLanes.value.counting.length +
    autoShipLanes.value.paused.length,
);

const filteredConversations = computed(() => {
  const q = store.ui.search.trim().toLowerCase();
  const list = store.data.conversations.filter((c) => {
    if (c.category !== store.ui.activeTab) return false;
    if (store.ui.platformFilter !== 'all' && c.platform !== store.ui.platformFilter) return false;
    if (store.ui.urgentOnly) {
      const isUrgent =
        (typeof c.slaRemainSec === 'number' && c.slaRemainSec > 0) ||
        c.autoRepliedOnly ||
        c.category === 'issue';
      if (!isUrgent) return false;
    }
    if (!q) return true;
    return [c.buyerNick, c.orderNo, c.shopName, c.platformLabel, c.skuCode]
      .filter(Boolean)
      .some((x) => String(x).toLowerCase().includes(q));
  });

  // 红黄绿智能排序：有疑问熔断/50s待真回/SLA紧急的优先排在上面
  return [...list].sort((a, b) => {
    const score = (x) => {
      if (x.stepState === 'ISSUE_BUYER_QUESTION') return 100;
      if (x.autoRepliedOnly) return 90;
      if (typeof x.slaRemainSec === 'number' && x.slaRemainSec > 0) return 80 - Math.min(70, x.slaRemainSec / 5);
      return 10;
    };
    return score(b) - score(a);
  });
});

const currentConv = computed(
  () =>
    store.data.conversations.find((c) => c.id === store.ui.selectedConvId) ||
    filteredConversations.value[0] ||
    store.data.conversations[0],
);

const sameModelList = computed(() =>
  currentConv.value?.spuCode ? getSameSpuSkus(currentConv.value.spuCode) : [],
);

watch(
  [() => currentConv.value?.id, () => currentConv.value?.skuCode, () => store.actorId],
  () => {
    const validCodes = sameModelList.value.map((s) => s.skuCode);
    if (currentConv.value?.skuCode) {
      pickedSkuCode.value = currentConv.value.skuCode;
    } else if (!validCodes.includes(pickedSkuCode.value)) {
      pickedSkuCode.value = sameModelList.value.find((s) => s.allGatesOk)?.skuCode || sameModelList.value[0]?.skuCode || '';
    }
    cardMenuOpen.value = false;
  },
  { immediate: true },
);

const pickedSku = computed(() =>
  getVisibleSku(pickedSkuCode.value || currentConv.value?.skuCode),
);

const liveGuard = computed(() => checkOutboundGuard(draft.value));

const composerLockedReason = computed(() => {
  if (newbieLocked.value) {
    return `首日新人防呆锁：请先完成 3 关 60 秒情景练习（已过 ${practiceStatus.value.passedCount}/3 关）`;
  }
  if (currentConv.value?.owner?.type === 'internal' && isOutsourceRole.value) {
    return `会话正由内部专员【${currentConv.value.owner.name}】排他接管中，等待交还后再回复`;
  }
  return '';
});

const canSendText = computed(
  () => Boolean(draft.value.trim()) && liveGuard.value.ok && !composerLockedReason.value,
);

function closePopMenus() {
  store.ui.moreMenuOpen = false;
  cardMenuOpen.value = false;
}

function switchTab(tab) {
  store.ui.activeTab = tab;
  const first = store.data.conversations.find((c) => c.category === tab);
  if (first) store.ui.selectedConvId = first.id;
}

function selectSession(id) {
  store.ui.selectedConvId = id;
}

function clearFilters() {
  store.ui.platformFilter = 'all';
  store.ui.urgentOnly = false;
  store.ui.search = '';
}

function lastMessageText(c) {
  const last = c.messages[c.messages.length - 1];
  return last ? last.text : '';
}

function zoomImg(url, title) {
  store.ui.photoPreviewUrl = url;
  store.ui.photoPreviewTitle = title;
}

function openNewbieSandbox() {
  store.ui.moreMenuOpen = false;
  store.ui.practiceOpenKey = practiceStatus.value.nextKey;
}

function startSpotlightTour() {
  store.ui.moreMenuOpen = false;
  store.ui.tourStep = 0;
}

function openManualDrawer() {
  store.ui.moreMenuOpen = false;
  store.ui.manualDrawerOpen = true;
}

function openTutorialDrawer() {
  store.ui.moreMenuOpen = false;
  store.ui.tutorialDrawerOpen = true;
}

async function onSend() {
  if (!currentConv.value || !draft.value.trim()) return;
  const ok = await sendChatMessage(currentConv.value.id, draft.value);
  if (ok) draft.value = '';
}

async function manualSendCard(ruleId) {
  cardMenuOpen.value = false;
  if (!currentConv.value) return;
  await sendRuleCardImage(currentConv.value.id, ruleId, false);
}

watch(
  () => currentConv.value?.messages?.length,
  async () => {
    await nextTick();
    if (chatScrollEl.value) {
      chatScrollEl.value.scrollTop = chatScrollEl.value.scrollHeight;
    }
  },
);

watch(
  () => props.initialActor,
  (actor) => {
    if (actor && actor !== store.actorId) {
      switchActor(actor);
    }
  },
);

onMounted(async () => {
  await initStore();
  if (props.initialActor && props.initialActor !== store.actorId) {
    await switchActor(props.initialActor);
  }
});
</script>

<style scoped>
.folded-app {
  display: grid;
  grid-template-rows: 52px minmax(0, 1fr);
  width: 100%;
  min-width: 1200px;
  max-width: 100vw;
  height: 100vh;
  overflow: hidden;
}
.folded-app.embedded {
  height: 100%;
  min-width: 978px;
  max-width: 100%;
}

/* ==================== 顶部栏 ==================== */
.top-header {
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 0 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.brand-area {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  flex-shrink: 0;
}
.brand-icon {
  width: 31px;
  height: 31px;
  border-radius: 9px;
  background: var(--pri);
  color: #fff;
  font-weight: 800;
  font-size: 14.5px;
  display: grid;
  place-items: center;
}
.brand-title {
  font-size: 15px;
  font-weight: 800;
}

.duty-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-size: 12px;
  white-space: nowrap;
}
.duty-pill small {
  font-size: 11.5px;
  opacity: 0.9;
}
.duty-pill.off {
  background: var(--amb-soft);
  color: var(--amb-ink);
}
.duty-pill.internal {
  background: var(--pri-soft);
  color: var(--pri);
}

.newbie-pill {
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  border: 1px solid rgba(255, 125, 0, 0.35);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

/* 顶部平铺核心绩效条 */
.kpi-inline-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  padding: 4px 12px;
  border-radius: 999px;
  white-space: nowrap;
  flex-shrink: 0;
}
.kpi-item {
  font-size: 12px;
  color: var(--ink2);
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}
.kpi-item b {
  font-size: 13.5px;
  font-weight: 800;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.kpi-item b.good {
  color: var(--grn-ink);
}
.kpi-item b.bad {
  color: var(--red-ink);
}
.kpi-more-btn {
  font-size: 12px;
  font-weight: 700;
  color: var(--pri);
  padding-left: 8px;
  border-left: 1px solid var(--line);
}
.kpi-more-btn:hover {
  text-decoration: underline;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 更多与视角折叠菜单 */
.more-wrap {
  position: relative;
}
.more-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 95;
  width: 356px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
  box-shadow: var(--sh-pop);
  display: grid;
  gap: 6px;
  white-space: normal;
}
.md-sec-title {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--mute);
  padding: 2px 4px;
}
.md-role-item {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: var(--panel-alt);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.md-role-item:hover {
  border-color: var(--pri);
}
.md-role-item.active {
  background: var(--pri-soft);
  border-color: rgba(22, 119, 255, 0.35);
}
.md-role-item b {
  font-size: 12.5px;
}
.md-role-item p {
  font-size: 11px;
  color: var(--ink2);
  margin-top: 2px;
  line-height: 1.35;
}
.md-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 0;
}
.md-grid-btns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.md-btn {
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
}
.md-btn:hover {
  background: var(--soft);
}
.md-btn.warn {
  color: var(--red-ink);
}

/* ==================== 主体左中右三栏 ==================== */
.main-columns {
  display: grid;
  grid-template-columns: clamp(248px, 21vw, 290px) minmax(0, 1fr) clamp(315px, 26vw, 368px);
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.folded-app.embedded .main-columns {
  grid-template-columns: clamp(224px, 19vw, 272px) minmax(300px, 1fr) clamp(292px, 24vw, 348px);
}
@media (max-width: 1380px) {
  .kpi-inline-bar {
    gap: 7px;
    padding: 4px 9px;
  }
  .brand-title {
    font-size: 13.5px;
  }
}

/* ==================== 左栏 ==================== */
.col-left {
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.three-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 10px 10px 6px;
  gap: 6px;
}
.tab-btn {
  height: 35px;
  border-radius: 9px;
  background: var(--soft);
  color: var(--ink2);
  font-size: 12.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.tab-btn.active {
  background: var(--pri);
  color: #fff;
}
.tab-btn em {
  font-style: normal;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
}
.tab-btn.active em {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}
.tab-btn em.warn {
  background: var(--red);
  color: #fff;
}

.search-bar-row {
  padding: 4px 10px 9px;
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 6px;
}
.search-bar-row input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12.5px;
}
.filter-toggle {
  height: 32px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink2);
  white-space: nowrap;
}
.filter-toggle.on {
  border-color: var(--pri);
  background: var(--pri-soft);
  color: var(--pri);
}

.folded-filters {
  padding: 8px 10px;
  background: var(--panel-alt);
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 7px;
}
.ff-plats {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.ff-chip {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 11.5px;
  font-weight: 600;
}
.ff-chip.on {
  background: var(--pri);
  border-color: var(--pri);
  color: #fff;
}
.ff-urgent {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ink2);
  cursor: pointer;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.session-row {
  text-align: left;
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: var(--panel);
  display: grid;
  gap: 5px;
  transition: background 0.12s;
}
.session-row:hover {
  background: var(--panel-alt);
}
.session-row.on {
  background: var(--pri-soft);
  border-color: rgba(22, 119, 255, 0.32);
}

.sr-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sr-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sr-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--mute);
  white-space: nowrap;
  flex-shrink: 0;
}
.sla-pill {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  flex-shrink: 0;
}
.sla-pill.danger {
  background: var(--red-soft);
  color: var(--red-ink);
}

.sr-msg {
  font-size: 12px;
  color: var(--ink2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sr-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}
.sr-shop {
  color: var(--mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-status {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--ink2);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.mini-status.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.mini-status.warn {
  background: var(--red-soft);
  color: var(--red-ink);
}

.empty-tip {
  text-align: center;
  padding: 36px 12px;
  color: var(--mute);
  font-size: 12.5px;
  display: grid;
  gap: 8px;
}
.link-reset {
  color: var(--pri);
  font-weight: 700;
  font-size: 12px;
}

/* ==================== 中栏：清爽聊天窗 ==================== */
.col-center {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.chat-top {
  min-height: 50px;
  padding: 8px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ct-left {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.ct-buyer {
  font-size: 15px;
}
.order-pill {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--pri-soft);
  color: var(--pri);
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.buyer-tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--ink2);
  font-size: 11px;
  white-space: nowrap;
}
.activated-pill {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}

.pinned-bar {
  padding: 7px 16px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.pinned-bar.commit {
  background: var(--pri-soft);
  color: var(--pri);
}
.pinned-bar.coach {
  background: var(--amb-soft);
  color: var(--amb-ink);
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.msg-line {
  display: flex;
  flex-direction: column;
}
.msg-line.in {
  align-items: flex-start;
}
.msg-line.out {
  align-items: flex-end;
}
.msg-line.sys {
  align-items: center;
}

.sys-note {
  padding: 4px 13px;
  border-radius: 999px;
  background: rgba(128, 138, 157, 0.12);
  color: var(--ink2);
  font-size: 11.5px;
  max-width: 88%;
  text-align: center;
}

.bubble-group {
  max-width: 80%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msg-line.out .bubble-group {
  align-items: flex-end;
}

.bg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--mute);
}
.auto-pill {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-weight: 700;
}

.bubble-box {
  padding: 11px 14px;
  border-radius: 13px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 13.5px;
  line-height: 1.55;
  display: grid;
  gap: 9px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}
.msg-line.out .bubble-box {
  background: var(--out-bubble);
  border-color: var(--out-border);
}
.bb-text {
  word-break: break-word;
}

.link-audit-stack {
  display: grid;
  gap: 5px;
}
.link-audit-pill {
  padding: 5px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 700;
}
.link-audit-pill.red {
  background: var(--red-soft);
  color: var(--red-ink);
}
.link-audit-pill.amb {
  background: var(--amb-soft);
  color: var(--amb-ink);
}
.link-audit-pill.grn {
  background: var(--grn-soft);
  color: var(--grn-ink);
}

.real-media-box {
  display: grid;
  gap: 8px;
}
.rm-imgs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rm-imgs img {
  width: 148px;
  height: 92px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--line);
  cursor: zoom-in;
}
.rm-vid-btn {
  padding: 8px 12px;
  border-radius: 8px;
  background: #0f172a;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  text-align: left;
  width: fit-content;
}

.scene-card-img-wrap {
  display: grid;
  gap: 4px;
}
.scene-card-img {
  max-width: 420px;
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--line);
  cursor: zoom-in;
  background: #fff;
}
.zoom-hint {
  font-size: 11px;
  color: var(--mute);
}

/* 底部输入区 */
.chat-composer {
  background: var(--panel);
  border-top: 1px solid var(--line);
  padding: 9px 14px 12px;
  display: grid;
  gap: 8px;
}
.quick-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.q-chip {
  padding: 4px 9px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--ink2);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.q-chip:hover {
  background: var(--pri-soft);
  color: var(--pri);
}
.q-chip.highlight {
  background: var(--pri-soft);
  color: var(--pri);
  font-weight: 700;
}

.card-pop-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 40;
  width: 280px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 6px;
  box-shadow: var(--sh-pop);
  display: grid;
  gap: 4px;
}
.cpm-item {
  text-align: left;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
}
.cpm-item:hover {
  background: var(--pri-soft);
  color: var(--pri);
}

.guard-live-alert {
  padding: 7px 11px;
  border-radius: 8px;
  background: var(--red-soft);
  color: var(--red-ink);
  font-size: 12px;
  line-height: 1.45;
}
.guard-live-alert.lock {
  background: var(--amb-soft);
  color: var(--amb-ink);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.input-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.input-row textarea {
  flex: 1;
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 13px;
  resize: none;
  outline: none;
}
.input-row textarea:focus {
  border-color: var(--pri);
  background: var(--panel);
}
.send-btn {
  height: auto;
  padding: 0 22px;
  font-size: 13.5px;
}
</style>
