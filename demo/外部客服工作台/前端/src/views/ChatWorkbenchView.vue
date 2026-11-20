<template>
  <div class="im-tri-grid">
    <!-- ==================== 左栏：多平台智能优先级收件箱 ==================== -->
    <section class="pane-col left-inbox" data-tour="left-inbox">
      <div class="inbox-header">
        <div class="search-box">
          <input
            v-model="store.ui.searchQuery"
            type="search"
            placeholder="搜买家昵称 / 订单号 / 货号 / 店铺..."
          />
        </div>
        <div class="filter-pills">
          <button
            v-for="f in filters"
            :key="f.k"
            type="button"
            class="fp-btn"
            :class="{ on: store.ui.inboxFilter === f.k }"
            @click="store.ui.inboxFilter = f.k"
          >
            {{ f.label }}
            <em v-if="f.count > 0" :class="f.tone">{{ f.count }}</em>
          </button>
        </div>
      </div>

      <div class="scroll-y conv-list">
        <div v-if="!sortedConversations.length" class="empty-inbox">
          <b>🎉 当前筛选下没有待处理会话</b>
          <p>点上方「全部会话」可回看已自动推仓或内部已接管的记录。</p>
          <button type="button" class="btn sm" @click="resetFilters">查看全部会话</button>
        </div>

        <button
          v-for="c in sortedConversations"
          :key="c.id"
          type="button"
          class="conv-item"
          :class="{
            active: c.id === selectedConv?.id,
            'row-red': c.priority === 'red',
            'row-amb': c.priority === 'amb',
          }"
          @click="selectConv(c.id)"
        >
          <div class="ci-top">
            <span class="plat-badge" :class="'plat-' + c.platform">{{ c.platformLabel }}</span>
            <b class="ci-buyer">{{ c.buyerNick }}</b>
            <span v-if="c.slaRemainSec !== null" class="sla-timer" :class="{ urgent: c.slaRemainSec < 100 }">
              ⏱ 剩 {{ fmtSla(c.slaRemainSec) }}
            </span>
            <span v-else class="ci-time">{{ lastMsg(c).time?.slice(0, 5) }}</span>
          </div>

          <div class="ci-shop">
            <span>{{ c.shopName }}</span>
            <span v-if="c.orderNo" class="tag acc">已付 ¥{{ c.paidAmount }}</span>
          </div>

          <div class="ci-preview">{{ lastMsg(c).text }}</div>

          <div class="ci-badges">
            <span v-if="c.workflowStep === 'AUTO_PAUSED_BY_BUYER'" class="tag red">
              ⚡ 疑问熔断·待介入
            </span>
            <span v-else-if="c.workflowStep === 'PAID_WAIT_PICK_SKU'" class="tag red">
              🔴 待挑WMS真机发实拍
            </span>
            <span v-else-if="c.workflowStep === 'LINK_ANOMALY_BLOCKED'" class="tag red">
              🛑 链接对不上货
            </span>
            <span v-else-if="c.workflowStep === 'WMS_MEDIA_MISSING'" class="tag red">
              📸 缺仓管通电视频
            </span>
            <span v-else-if="c.autoRepliedOnly" class="tag amb">
              🤖 50s兜底·待人工真回
            </span>
            <span v-else-if="c.workflowStep === 'AUTO_OBSERVING'" class="tag grn">
              ⏱ 静默自动发货观察中
            </span>
            <span v-else-if="c.workflowStep === 'PUSHED_TO_WMS_WAVE'" class="tag grn">
              🏃 已推仓波次拣货
            </span>
            <span v-else-if="c.owner.type === 'internal'" class="tag acc">
              🔒 内部专员接管中
            </span>
          </div>
        </button>
      </div>
    </section>

    <!-- ==================== 中栏：C端清爽聊天视窗 + 防呆输入舱 ==================== -->
    <section v-if="selectedConv" class="pane-col center-chat" data-tour="center-chat">
      <!-- 会话头部 -->
      <header class="chat-head">
        <div class="ch-main">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <span class="plat-badge" :class="'plat-' + selectedConv.platform">
              {{ selectedConv.platformLabel }} · {{ selectedConv.shopName }}
            </span>
            <h3 style="white-space: nowrap">{{ selectedConv.buyerNick }}</h3>
            <span v-for="tg in selectedConv.buyerTags" :key="tg" class="tag">{{ tg }}</span>
          </div>
          <div class="ch-sub">
            <span>当前接待所有者：<b>{{ selectedConv.owner.name }}</b></span>
            <span v-if="selectedConv.boundSkuCode">｜ 关联 WMS 单品：<b class="mono">{{ selectedConv.boundSkuCode }}</b></span>
            <span v-if="selectedConv.platform === 'xianyu'" class="muted">｜ 闲鱼群控防风控：同店操作间隔 ≥30s 自动排队</span>
          </div>
        </div>
        <Q k="chat" label="接待怎么用" />
      </header>

      <!-- 置顶黄条：已答应买家的事（内部交还或历史承诺，外包必须照办！） -->
      <div v-if="selectedConv.commitments?.length" class="promise-pin-bar">
        <span>📌 <b>已答应买家的事（后续必须照办）：</b>{{ selectedConv.commitments.join(' ； ') }}</span>
      </div>

      <!-- 置顶锁条：内部销售已接管时防撞单提醒 -->
      <div v-if="selectedConv.owner.type === 'internal' && isOutsourceRole" class="lock-owner-bar">
        🔒 当前会话由 <b>{{ selectedConv.owner.name }}</b> 持锁处理中，你的输入框已自动暂停，避免两个人同时回复买家闹乌龙。
      </div>

      <!-- 聊天消息流 -->
      <div ref="msgScrollEl" class="scroll-y msg-stream">
        <div
          v-for="m in selectedConv.messages"
          :key="m.id"
          class="msg-row"
          :class="[m.dir, m.alert ? 'sys-alert' : '']"
        >
          <!-- 系统事件气泡 -->
          <div v-if="m.dir === 'sys'" class="sys-pill" :class="{ alert: m.alert }">
            <b>[{{ m.time }} · {{ m.who }}]</b> {{ m.text }}
          </div>

          <!-- 买家 / 客服对话气泡 -->
          <div v-else class="chat-bubble-wrap">
            <div class="cb-meta">
              <b>{{ m.who }}</b>
              <span v-if="m.tag" class="tag" :class="m.isAutoFallback ? 'amb' : 'acc'">{{ m.tag }}</span>
              <span class="muted">{{ m.time }}</span>
            </div>

            <div class="chat-bubble" :class="{ fallback: m.isAutoFallback }">
              <div class="cb-text">{{ m.text }}</div>

              <!-- 气泡内附带的一件一拍实拍照片与高拍仪视频卡 -->
              <div v-if="m.mediaSkuCode && getVisibleSku(m.mediaSkuCode)" class="bubble-media-pack">
                <div class="bmp-photos">
                  <img
                    v-for="ph in getVisibleSku(m.mediaSkuCode).photos"
                    :key="ph.id"
                    :src="ph.url"
                    :alt="ph.label"
                    @click="previewPhoto(ph.url, ph.label)"
                  />
                </div>
                <button
                  v-if="m.hasVideoCard && getVisibleSku(m.mediaSkuCode).video"
                  type="button"
                  class="bmp-video-btn"
                  @click="openVideo(getVisibleSku(m.mediaSkuCode))"
                >
                  <Icon name="play" size="15" />
                  <span>播放随单发出的仓管通电实拍视频（{{ getVisibleSku(m.mediaSkuCode).video.duration }} · 含SN核验）</span>
                </button>
              </div>

              <!-- 买家发来链接的自动安全体检胶囊 -->
              <div
                v-for="(lk, lIdx) in inspectLinksInText(m.text, selectedConv)"
                :key="lIdx"
                class="link-audit-box"
                :class="lk.safe ? 'ok' : 'bad'"
              >
                <div><b>{{ lk.badge }}</b></div>
                <div style="font-size: 11.5px; opacity: 0.9">{{ lk.detail }}</div>
              </div>
            </div>

            <div v-if="m.dir === 'out'" class="cb-delivery">
              <span v-if="m.status === 'sent_throttled_ok'">✓ 已经群控队列送达买家（30s防风控校验通过）</span>
              <span v-else>✓ 已送达买家端</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部 C 端快捷话术胶囊 + 实时外发防封号守卫输入框 -->
      <footer class="composer-box">
        <!-- 场景快捷话术一键填入 -->
        <div class="quick-bar">
          <span class="qb-lbl">⚡ 快捷话术：</span>
          <button
            v-for="(qr, qi) in QUICK_REPLIES"
            :key="qi"
            type="button"
            class="qr-chip"
            @click="applyQuickReply(qr.text)"
          >
            {{ qr.label }}
          </button>
        </div>

        <textarea
          v-model="draftText"
          rows="3"
          class="composer-input"
          :disabled="selectedConv.owner.type === 'internal' && isOutsourceRole"
          placeholder="输入回复买家的消息（按 Enter 发送，Shift+Enter 换行；外发守卫已开启：自动拦截微信号/手机号/单字刷屏）..."
          @keydown.enter.exact.prevent="handleSendText"
        />

        <!-- 实时外发守卫拦截提示 -->
        <div v-if="!draftGuard.ok" class="guard-live-warn">
          🛑 <b>外发守卫已实时拦截：</b>{{ draftGuard.reason }}（{{ draftGuard.penalty }}）
        </div>

        <div class="composer-foot">
          <label class="attach-check">
            <input
              v-model="attachRealShot"
              type="checkbox"
              :disabled="!canAttachCurrentRealShot"
            />
            <span>同时附带本机实拍图与通电视频卡片</span>
          </label>

          <div style="display: flex; align-items: center; gap: 8px">
            <button
              type="button"
              class="btn sm"
              title="测试输入违禁微信号看守卫如何自动拦住"
              @click="fillTestForbiddenText"
            >
              🧪 测试违禁词拦截
            </button>
            <Lock
              :ok="canSendReply.ok"
              :reason="canSendReply.reason"
              :fix-text="!practiceProgress.unlocked ? '去2分钟练兵解锁' : ''"
              kind="pri"
              @go="handleSendText"
              @fix="store.ui.practiceOpenKey = 'link_media'"
            >
              <Icon name="send" size="15" /> 发送回复
            </Lock>
          </div>
        </div>
      </footer>
    </section>

    <!-- ==================== 右栏：步骤引导小卡片 + WMS 一件一拍挑货与协同 ==================== -->
    <RightCopilotPane :conv="selectedConv" />
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import {
  store,
  isOutsourceRole,
  practiceProgress,
  getVisibleSku,
  checkOutboundGuard,
  inspectLinksInText,
  sendChatMessage,
} from '../store.js';
import { QUICK_REPLIES } from '../data/helpAndRules.js';
import Icon from '../components/Icon.vue';
import Lock from '../components/Lock.vue';
import Q from '../components/Q.vue';
import RightCopilotPane from '../components/RightCopilotPane.vue';

const draftText = ref('');
const attachRealShot = ref(false);
const msgScrollEl = ref(null);

const priorityRank = { red: 0, amb: 1, grn: 2 };

const filters = computed(() => {
  const all = store.data.conversations;
  return [
    {
      k: 'all',
      label: '全部会话',
      count: all.filter((c) => c.priority === 'red').length,
      tone: 'red',
    },
    {
      k: 'red',
      label: '急需处理',
      count: all.filter((c) => c.priority === 'red' || c.waitingManualReply).length,
      tone: 'red',
    },
    {
      k: 'autoship',
      label: '发货前置/观察',
      count: all.filter((c) =>
        ['PAID_WAIT_PICK_SKU', 'AUTO_OBSERVING', 'AUTO_PAUSED_BY_BUYER'].includes(c.workflowStep),
      ).length,
      tone: 'amb',
    },
    {
      k: 'collab',
      label: '跨台协同/接管',
      count: all.filter((c) => c.collabTicket || c.owner.type === 'internal').length,
      tone: 'acc',
    },
  ];
});

const sortedConversations = computed(() => {
  const q = (store.ui.searchQuery || '').trim().toLowerCase();
  const f = store.ui.inboxFilter;
  return [...store.data.conversations]
    .filter((c) => {
      if (f === 'red' && !(c.priority === 'red' || c.waitingManualReply)) return false;
      if (
        f === 'autoship' &&
        !['PAID_WAIT_PICK_SKU', 'AUTO_OBSERVING', 'AUTO_PAUSED_BY_BUYER', 'PUSHED_TO_WMS_WAVE'].includes(
          c.workflowStep,
        )
      ) {
        return false;
      }
      if (f === 'collab' && !(c.collabTicket || c.owner.type === 'internal')) return false;
      if (!q) return true;
      return [c.buyerNick, c.shopName, c.orderNo, c.boundSkuCode, c.platformLabel]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => {
      const pa = priorityRank[a.priority] ?? 2;
      const pb = priorityRank[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return (a.slaRemainSec ?? 9999) - (b.slaRemainSec ?? 9999);
    });
});

const selectedConv = computed(
  () =>
    store.data.conversations.find((c) => c.id === store.ui.selectedConvId) ||
    sortedConversations.value[0] ||
    store.data.conversations[0],
);

const canAttachCurrentRealShot = computed(() => {
  const s = getVisibleSku(selectedConv.value?.boundSkuCode);
  return Boolean(s && s.gates?.videoOk && s.gates?.photoOk);
});

const draftGuard = computed(() => checkOutboundGuard(draftText.value));

const canSendReply = computed(() => {
  if (!practiceProgress.value.unlocked) {
    return { ok: false, reason: '请先做完 3 个 60 秒新手练习解锁发送权限' };
  }
  if (selectedConv.value?.owner.type === 'internal' && isOutsourceRole.value) {
    return { ok: false, reason: `${selectedConv.value.owner.name} 已接管会话，外包暂停发送防重发` };
  }
  if (!draftGuard.value.ok) {
    return { ok: false, reason: draftGuard.value.reason };
  }
  if (!draftText.value.trim() && !attachRealShot.value) {
    return { ok: false, reason: '' };
  }
  return { ok: true, reason: '' };
});

function lastMsg(c) {
  return c.messages[c.messages.length - 1] || { text: '', time: '' };
}

function fmtSla(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function selectConv(id) {
  store.ui.selectedConvId = id;
  store.error = '';
  attachRealShot.value = false;
}

function resetFilters() {
  store.ui.inboxFilter = 'all';
  store.ui.searchQuery = '';
}

function applyQuickReply(text) {
  draftText.value = text;
}

function fillTestForbiddenText() {
  draftText.value = `亲，平台手续费贵，加我微信 ${'199' + '0'.repeat(8)} 我发网盘视频给你私下转！`;
}

function openVideo(sku) {
  store.ui.videoModalSku = sku;
}

function previewPhoto(url, title) {
  store.ui.photoPreviewUrl = url;
  store.ui.photoPreviewTitle = title;
}

async function handleSendText() {
  if (!canSendReply.value.ok || !selectedConv.value) return;
  const ok = await sendChatMessage(selectedConv.value.id, {
    text: draftText.value,
    withRealShot: attachRealShot.value,
    skuCode: selectedConv.value.boundSkuCode,
  });
  if (ok) {
    draftText.value = '';
    attachRealShot.value = false;
    await nextTick();
    if (msgScrollEl.value) {
      msgScrollEl.value.scrollTop = msgScrollEl.value.scrollHeight;
    }
  }
}

watch(
  () => selectedConv.value?.messages?.length,
  async () => {
    await nextTick();
    if (msgScrollEl.value) {
      msgScrollEl.value.scrollTop = msgScrollEl.value.scrollHeight;
    }
  },
);
</script>

<style scoped>
/* 左栏收件箱 */
.inbox-header {
  padding: 12px;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 9px;
}
.search-box input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
  font-size: 12.5px;
}
.filter-pills {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 5px;
}
.fp-btn {
  height: 30px;
  padding: 0 7px;
  border-radius: 8px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  font-size: 11px;
  font-weight: 700;
  color: var(--ink2);
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.fp-btn.on {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc);
}
.fp-btn em {
  font-style: normal;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 800;
}
.fp-btn em.red {
  background: var(--red);
  color: #fff;
}
.fp-btn em.amb {
  background: var(--amb);
  color: #fff;
}
.fp-btn em.acc {
  background: var(--acc);
  color: #fff;
}

.conv-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conv-item {
  width: 100%;
  text-align: left;
  padding: 11px 12px;
  border-radius: 13px;
  border: 1.5px solid var(--line);
  background: var(--panel);
  display: grid;
  gap: 5px;
  transition: all 0.12s;
}
.conv-item:hover {
  background: var(--panel-alt);
}
.conv-item.row-red {
  border-left: 4px solid var(--red);
}
.conv-item.row-amb {
  border-left: 4px solid var(--amb);
}
.conv-item.active {
  border-color: var(--acc);
  background: var(--acc-soft);
  box-shadow: 0 4px 14px rgba(41, 82, 255, 0.12);
}
.ci-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ci-buyer {
  font-size: 13.5px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sla-timer {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 11px;
  font-weight: 800;
  font-family: monospace;
  white-space: nowrap;
  flex-shrink: 0;
}
.sla-timer.urgent {
  background: var(--red);
  color: #fff;
}
.ci-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--mute);
}
.ci-shop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--mute);
}
.ci-preview {
  font-size: 12px;
  color: var(--ink2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ci-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.empty-inbox {
  padding: 36px 18px;
  text-align: center;
  display: grid;
  gap: 8px;
  justify-items: center;
  font-size: 13px;
  color: var(--mute);
}

/* 中栏聊天窗 */
.chat-head {
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ch-main h3 {
  font-size: 15.5px;
  font-weight: 900;
}
.ch-sub {
  font-size: 12px;
  color: var(--mute);
  margin-top: 4px;
}
.promise-pin-bar {
  padding: 8px 18px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  border-bottom: 1px solid rgba(217, 119, 6, 0.25);
  font-size: 12.5px;
}
.lock-owner-bar {
  padding: 8px 18px;
  background: var(--acc-soft);
  color: var(--acc);
  border-bottom: 1px solid rgba(41, 82, 255, 0.25);
  font-size: 12.5px;
  font-weight: 700;
}

.msg-stream {
  padding: 16px 20px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.msg-row {
  display: flex;
  flex-direction: column;
}
.msg-row.in {
  align-items: flex-start;
}
.msg-row.out {
  align-items: flex-end;
}
.msg-row.sys {
  align-items: center;
}

.sys-pill {
  max-width: 88%;
  padding: 7px 13px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--ink2);
  font-size: 12px;
  line-height: 1.45;
  text-align: center;
}
.sys-pill.alert {
  background: var(--red-soft);
  border-color: var(--red);
  color: var(--red-ink);
  font-weight: 700;
}

.chat-bubble-wrap {
  max-width: 80%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msg-row.out .chat-bubble-wrap {
  align-items: flex-end;
}
.cb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}
.chat-bubble {
  padding: 11px 14px;
  border-radius: 15px;
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: var(--sh);
  font-size: 13.5px;
  line-height: 1.52;
  display: grid;
  gap: 9px;
}
.msg-row.out .chat-bubble {
  background: var(--acc-soft);
  border-color: rgba(41, 82, 255, 0.28);
}
.chat-bubble.fallback {
  background: var(--panel-alt);
  border-style: dashed;
}

.bubble-media-pack {
  display: grid;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(15, 23, 42, 0.08);
}
.bmp-photos {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.bmp-photos img {
  width: 132px;
  height: 84px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--line);
  cursor: pointer;
}
.bmp-video-btn {
  padding: 8px 12px;
  border-radius: 10px;
  background: #0f172a;
  color: #38bdf8;
  font-size: 12px;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.link-audit-box {
  padding: 8px 11px;
  border-radius: 10px;
  font-size: 12px;
  display: grid;
  gap: 2px;
}
.link-audit-box.ok {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.link-audit-box.bad {
  background: var(--red-soft);
  color: var(--red-ink);
  border: 1px solid var(--red);
}

.cb-delivery {
  font-size: 11px;
  color: var(--grn-ink);
  font-weight: 600;
}

/* 底部输入舱 */
.composer-box {
  background: var(--panel);
  border-top: 1px solid var(--line);
  padding: 10px 16px 12px;
  display: grid;
  gap: 8px;
}
.quick-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.qb-lbl {
  font-size: 11.5px;
  font-weight: 800;
  color: var(--mute);
  white-space: nowrap;
}
.qr-chip {
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--panel-alt);
  border: 1px solid var(--line);
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.qr-chip:hover {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc);
}
.composer-input {
  width: 100%;
  resize: none;
  padding: 10px 12px;
  border-radius: 11px;
  border: 1.5px solid var(--line);
  background: var(--panel-alt);
  font-size: 13.5px;
}
.composer-input:focus {
  background: var(--panel);
  border-color: var(--acc);
  outline: none;
}
.guard-live-warn {
  padding: 8px 12px;
  border-radius: 9px;
  background: var(--red-soft);
  color: var(--red-ink);
  border: 1px solid var(--red);
  font-size: 12.5px;
}
.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.attach-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink2);
  cursor: pointer;
}
</style>
