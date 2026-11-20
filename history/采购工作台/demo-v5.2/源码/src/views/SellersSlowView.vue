<template>
  <div class="sellers-page">
    <!-- 顶部总览与双栏切换 -->
    <section class="hero-card">
      <div class="hero-left">
        <div class="eyebrow">长期货源沉淀 · 收藏卖家与慢压分池</div>
        <h1>★ 卖家关系库 & ⏳ 慢慢压价长线池</h1>
        <p class="sub">
          收藏绑定<b>卖家稳定标识（seller_id）</b>支持<b>个人私藏 + 一键共享给采购组</b>；慢慢压价绑定<b>单条会话（conv_id）</b>低频巡检，两者独立不串线。
        </p>
      </div>
      <div class="hero-stats">
        <div class="stat-pill">
          <span>已收藏卖家</span>
          <b>{{ favSellers.length }} 位</b>
        </div>
        <div class="stat-pill team">
          <span>全组共享白名单</span>
          <b>{{ teamCount }} 位</b>
        </div>
        <div class="stat-pill slow">
          <span>慢慢压价池会话</span>
          <b>{{ slowConvs.length }} 条</b>
        </div>
      </div>
    </section>

    <!-- 主 Tab 切换 -->
    <div class="tab-strip" role="tablist">
      <button
        type="button"
        class="tab-btn"
        :class="{ on: activeTab === 'favorites' }"
        @click="activeTab = 'favorites'"
      >
        ★ 收藏卖家库（{{ favSellers.length }}）
      </button>
      <button
        type="button"
        class="tab-btn"
        :class="{ on: activeTab === 'slow' }"
        @click="activeTab = 'slow'"
      >
        ⏳ 慢慢压价长线池（{{ slowConvs.length }}）
      </button>
    </div>

    <!-- ================= TAB 1: 收藏卖家库 ================= -->
    <section v-if="activeTab === 'favorites'" class="panel-stack">
      <div class="toolbar">
        <div class="filter-pills">
          <button type="button" class="pill" :class="{ on: scopeFilter === 'all' }" @click="scopeFilter = 'all'">
            全部收藏 ({{ favSellers.length }})
          </button>
          <button type="button" class="pill" :class="{ on: scopeFilter === 'team' }" @click="scopeFilter = 'team'">
            👥 采购组共享 ({{ teamCount }})
          </button>
          <button type="button" class="pill" :class="{ on: scopeFilter === 'personal' }" @click="scopeFilter = 'personal'">
            🔒 我私藏的 ({{ personalCount }})
          </button>
        </div>
        <button type="button" class="btn sm pri" @click="showAddForm = !showAddForm">
          {{ showAddForm ? '收起登记框' : '+ 登记优质卖家' }}
        </button>
      </div>

      <!-- 新增收藏卖家表单 -->
      <div v-if="showAddForm" class="card add-box">
        <div class="card-hd">
          <b>登记新收藏卖家（绑定闲鱼稳定 seller_id）</b>
        </div>
        <div class="form-grid">
          <label>
            <span>卖家稳定 ID</span>
            <input v-model="newSeller.seller_id" class="input" placeholder="如 SELLER-GF-889" />
          </label>
          <label>
            <span>卖家昵称</span>
            <input v-model="newSeller.seller_name" class="input" placeholder="如 深圳镜头老陈" />
          </label>
          <label>
            <span>可见范围</span>
            <select v-model="newSeller.scope" class="input">
              <option value="personal">🔒 个人私藏（仅自己可见）</option>
              <option value="team">👥 共享给采购组（全组白名单）</option>
            </select>
          </label>
          <label class="wide">
            <span>跟进备注</span>
            <input v-model="newSeller.note" class="input" placeholder="如 每周稳定出2~3台索尼镜头，改价痛快可走对公直收" />
          </label>
        </div>
        <div class="tag-picker">
          <span class="muted">快捷打标：</span>
          <button
            v-for="tg in presetTags"
            :key="tg"
            type="button"
            class="tag-chip"
            :class="{ on: newSeller.tags.includes(tg) }"
            @click="toggleNewTag(tg)"
          >
            {{ tg }}
          </button>
        </div>
        <div class="row-actions">
          <button type="button" class="btn pri" @click="createFavoriteSeller">保存进收藏卖家库</button>
        </div>
      </div>

      <!-- 已收藏卖家卡片列表 -->
      <div class="seller-grid">
        <article v-for="s in filteredFavSellers" :key="s.seller_id" class="card seller-card">
          <div class="sc-top">
            <div>
              <div class="sc-title">
                <span class="star-mark">★</span>
                <b>{{ s.seller_name }}</b>
                <code class="sid">{{ s.seller_id }}</code>
              </div>
              <div class="sc-tags">
                <span class="scope-badge" :class="s.scope">
                  {{ s.scope === 'team' ? '👥 采购组共享' : '🔒 个人私藏' }}
                </span>
                <span v-for="tg in s.tags" :key="tg" class="tag-badge">{{ tg }}</span>
              </div>
            </div>
            <div class="sc-btns">
              <button
                type="button"
                class="btn sm"
                :class="{ pri: s.scope === 'personal' }"
                @click="toggleScope(s)"
              >
                {{ s.scope === 'team' ? '转为个人私藏' : '一键共享给采购组' }}
              </button>
              <button type="button" class="btn sm" @click="startEdit(s)">
                {{ editingId === s.seller_id ? '收起编辑' : '改标签/备注' }}
              </button>
              <button type="button" class="btn sm bad" @click="removeFavorite(s)">取消收藏</button>
            </div>
          </div>

          <p class="sc-note">{{ s.note || '暂无备注，点击「改标签/备注」补充跟进要点' }}</p>

          <!-- 内联编辑区 -->
          <div v-if="editingId === s.seller_id" class="edit-drawer">
            <div class="tag-picker">
              <span class="muted">点选标签：</span>
              <button
                v-for="tg in presetTags"
                :key="tg"
                type="button"
                class="tag-chip"
                :class="{ on: editDraft.tags.includes(tg) }"
                @click="toggleEditTag(tg)"
              >
                {{ tg }}
              </button>
            </div>
            <div class="edit-row">
              <input v-model="editDraft.note" class="input" placeholder="输入卖家跟进备注（如出货习惯、心理底线、是否同行）" />
              <button type="button" class="btn sm pri" @click="saveEdit(s)">保存修改</button>
            </div>
          </div>

          <!-- 关联会话列表（验证同卖家多商品独立不串线） -->
          <div class="linked-convs">
            <div class="lc-hd">该卖家名下会话（{{ convsForSeller(s.seller_id).length }} 条 · 独立绑定不串线）</div>
            <div v-if="convsForSeller(s.seller_id).length === 0" class="muted empty-hint">
              当前暂无活跃聊天，后续该卖家新上架商品会自动识别 ★ 收藏标记
            </div>
            <div
              v-for="cv in convsForSeller(s.seller_id)"
              :key="cv.conv_id"
              class="lc-row"
            >
              <div>
                <b>{{ cv.title }}</b>
                <span class="muted" style="margin-left: 8px">
                  卖家挂 ¥{{ yuan(cv.seller_price_cents) }} · 参考 ¥{{ yuan(cv.ref_price_cents) }}
                </span>
                <span v-if="cv.slow_group" class="tag amb" style="margin-left: 6px">⏳ 慢慢压价中</span>
              </div>
              <button type="button" class="btn sm" @click="jumpToConv(cv.conv_id)">去会话陪谈 ›</button>
            </div>
          </div>
        </article>
      </div>

      <!-- 未收藏活跃卖家快捷纳管 -->
      <div v-if="unfavoritedConvs.length > 0" class="card">
        <div class="card-hd">
          <b>活跃会话中尚未收藏的卖家（一键收藏防流失）</b>
        </div>
        <div class="unfav-list">
          <div v-for="cv in unfavoritedConvs" :key="cv.conv_id" class="unfav-row">
            <div>
              <b>{{ cv.seller_name }}</b>
              <code class="sid">{{ cv.seller_id || `SELLER-${cv.conv_id}` }}</code>
              <span class="muted">正在聊：{{ cv.title }}</span>
            </div>
            <div class="sc-btns">
              <button type="button" class="btn sm" @click="quickFavorite(cv, 'personal')">★ 个人私藏</button>
              <button type="button" class="btn sm pri" @click="quickFavorite(cv, 'team')">👥 收藏并共享全组</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ================= TAB 2: 慢慢压价长线池 ================= -->
    <section v-else class="panel-stack">
      <div class="card slow-banner">
        <div>
          <b>⏳ 什么是「慢慢压价」长线池？</b>
          <p class="muted" style="margin: 4px 0 0">
            针对「不急出、工作室备用机、心理价位暂时偏高」的优质真机链接，不死缠烂打拉黑，移入慢压池由<b>后台执行窗 #2</b>按 48 小时低频节奏温和回访，等卖家挂久无人问津时水到渠成捡漏！
          </p>
        </div>
      </div>

      <div class="seller-grid">
        <article v-for="cv in slowConvs" :key="cv.conv_id" class="card seller-card">
          <div class="sc-top">
            <div>
              <div class="sc-title">
                <span class="tag amb">慢慢压价池</span>
                <b>{{ cv.title }}</b>
                <span v-if="cv.is_favorite_seller" class="star-pill">★ 已收藏卖家</span>
              </div>
              <div class="price-line">
                <span>卖家：<b>{{ cv.seller_name }}</b></span>
                <span>当前挂价：<b>¥{{ yuan(cv.seller_price_cents) }}</b></span>
                <span>我方目标价：<b class="ok-txt">¥{{ yuan(cv.target_price_cents) }}</b></span>
                <span>最高上限：<b>¥{{ yuan(cv.ceiling_price_cents) }}</b></span>
              </div>
            </div>
            <div class="sc-btns">
              <button type="button" class="btn sm pri" @click="sendSlowProbe(cv)">
                💬 发送低频温和回访（¥{{ yuan(cv.target_price_cents) }}）
              </button>
              <button type="button" class="btn sm" @click="jumpToConv(cv.conv_id)">打开聊天 ›</button>
              <button type="button" class="btn sm" @click="toggleSlowGroup(cv, false)">移回常规跟进</button>
            </div>
          </div>
          <p class="sc-note">{{ cv.attitude_reason || '卖家暂不急出，持续低频蹲守降价窗口' }}</p>
        </article>
      </div>

      <!-- 候选移入慢慢压价的常规会话 -->
      <div class="card">
        <div class="card-hd">
          <b>常规会话一键转入「慢慢压价」（{{ regularConvs.length }} 条）</b>
        </div>
        <div class="unfav-list">
          <div v-for="cv in regularConvs" :key="cv.conv_id" class="unfav-row">
            <div>
              <b>{{ cv.seller_name }}</b> · {{ cv.title }}
              <span class="muted" style="margin-left: 8px">
                挂 ¥{{ yuan(cv.seller_price_cents) }} / 目标 ¥{{ yuan(cv.target_price_cents) }}
              </span>
            </div>
            <button type="button" class="btn sm" @click="toggleSlowGroup(cv, true)">
              ⏳ 移入慢慢压价池
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { store, callAction, notify } from '../store.js';

const activeTab = ref('favorites');
const scopeFilter = ref('all');
const showAddForm = ref(false);
const editingId = ref('');

const presetTags = ['沟通顺畅', '长期供货', '重点关注', '同行白名单', '苹果主力', '摄影器材', '瑕疵全披露', '换新频繁'];

const newSeller = reactive({
  seller_id: '',
  seller_name: '',
  scope: 'team',
  note: '',
  tags: ['沟通顺畅', '长期供货'],
});

const editDraft = reactive({
  tags: [],
  note: '',
});

const favSellers = computed(() => store.dashboard.favorite_sellers || []);
const teamCount = computed(() => favSellers.value.filter((x) => x.scope === 'team').length);
const personalCount = computed(() => favSellers.value.filter((x) => x.scope === 'personal').length);

const filteredFavSellers = computed(() => {
  if (scopeFilter.value === 'all') return favSellers.value;
  return favSellers.value.filter((x) => x.scope === scopeFilter.value);
});

const allConvs = computed(() => store.dashboard.conversations || []);
const slowConvs = computed(() => allConvs.value.filter((c) => Number(c.slow_group) === 1));
const regularConvs = computed(() => allConvs.value.filter((c) => Number(c.slow_group) !== 1));

const unfavoritedConvs = computed(() => {
  const favSet = new Set(favSellers.value.map((f) => f.seller_id));
  const seen = new Set();
  return allConvs.value.filter((c) => {
    const sid = c.seller_id || `SELLER-${c.conv_id}`;
    if (favSet.has(sid) || seen.has(sid)) return false;
    seen.add(sid);
    return true;
  });
});

function yuan(cents) {
  return Math.round(Number(cents || 0) / 100);
}

function convsForSeller(sellerId) {
  return allConvs.value.filter((c) => c.seller_id === sellerId);
}

function toggleNewTag(tg) {
  const idx = newSeller.tags.indexOf(tg);
  if (idx >= 0) newSeller.tags.splice(idx, 1);
  else newSeller.tags.push(tg);
}

function startEdit(s) {
  if (editingId.value === s.seller_id) {
    editingId.value = '';
    return;
  }
  editingId.value = s.seller_id;
  editDraft.tags = [...(s.tags || [])];
  editDraft.note = s.note || '';
}

function toggleEditTag(tg) {
  const idx = editDraft.tags.indexOf(tg);
  if (idx >= 0) editDraft.tags.splice(idx, 1);
  else editDraft.tags.push(tg);
}

async function saveEdit(s) {
  await callAction(
    '/api/sellers/favorite',
    {
      seller_id: s.seller_id,
      seller_name: s.seller_name,
      scope: s.scope,
      tags: editDraft.tags,
      note: editDraft.note,
    },
    `已更新卖家「${s.seller_name}」标签与备注`
  );
  editingId.value = '';
}

async function createFavoriteSeller() {
  if (!newSeller.seller_id.trim() || !newSeller.seller_name.trim()) {
    notify('请填写卖家稳定 ID 和卖家昵称', 'err');
    return;
  }
  await callAction(
    '/api/sellers/favorite',
    {
      seller_id: newSeller.seller_id.trim(),
      seller_name: newSeller.seller_name.trim(),
      scope: newSeller.scope,
      tags: newSeller.tags,
      note: newSeller.note.trim(),
    },
    `已收藏卖家「${newSeller.seller_name}」`
  );
  newSeller.seller_id = '';
  newSeller.seller_name = '';
  newSeller.note = '';
  showAddForm.value = false;
}

async function toggleScope(s) {
  const nextScope = s.scope === 'team' ? 'personal' : 'team';
  await callAction(
    '/api/sellers/favorite',
    {
      seller_id: s.seller_id,
      seller_name: s.seller_name,
      scope: nextScope,
      tags: s.tags,
      note: s.note,
    },
    nextScope === 'team' ? `已将「${s.seller_name}」共享给采购组全员` : `已将「${s.seller_name}」转为个人私藏`
  );
}

async function removeFavorite(s) {
  await callAction('/api/sellers/favorite', { seller_id: s.seller_id, remove: true }, `已取消收藏「${s.seller_name}」`);
}

async function quickFavorite(cv, scope) {
  const sid = cv.seller_id || `SELLER-${cv.conv_id}`;
  await callAction(
    '/api/sellers/favorite',
    {
      seller_id: sid,
      seller_name: cv.seller_name,
      scope,
      tags: scope === 'team' ? ['沟通顺畅', '长期供货'] : ['重点关注'],
      note: `从会话《${cv.title}》一键收藏`,
    },
    `已收藏卖家「${cv.seller_name}」`
  );
}

async function toggleSlowGroup(cv, slow) {
  await callAction(
    `/api/conversations/${cv.conv_id}/group`,
    { slow_group: slow },
    slow ? `已移入慢慢压价长线池：${cv.title}` : `已移回常规实时跟进：${cv.title}`
  );
}

async function sendSlowProbe(cv) {
  const targetY = yuan(cv.target_price_cents);
  await callAction(
    `/api/conversations/${cv.conv_id}/send`,
    {
      sender: 'buyer_human',
      quote_cents: cv.target_price_cents,
      text: `老板这台机器还在的话，${targetY} 元包顺丰现款秒结考虑出吗？到货当天验完秒点收货不墨迹🤝`,
    },
    `已向「${cv.seller_name}」发出慢压回访报价 ¥${targetY}`
  );
}

function jumpToConv(convId) {
  store.selectedConvId = convId;
  localStorage.setItem('pw_conv_id', convId);
  window.location.hash = '#/im-sandbox';
}
</script>

<style scoped>
.sellers-page {
  display: grid;
  gap: 16px;
}
.hero-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 20px 22px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.eyebrow {
  font-size: 12px;
  font-weight: 700;
  color: var(--acc);
  margin-bottom: 4px;
}
.hero-left h1 {
  font-size: 20px;
  margin: 0 0 6px;
}
.sub {
  margin: 0;
  font-size: 13.5px;
  color: var(--mute);
  max-width: 680px;
}
.hero-stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.stat-pill {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  min-width: 112px;
  display: grid;
  gap: 2px;
}
.stat-pill span {
  font-size: 12px;
  color: var(--mute);
}
.stat-pill b {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.stat-pill.team b {
  color: var(--acc);
}
.stat-pill.slow b {
  color: #b45309;
}
.tab-strip {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tab-btn {
  padding: 9px 16px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  font-weight: 700;
  font-size: 13.5px;
  cursor: pointer;
}
.tab-btn.on {
  background: var(--acc);
  color: #fff;
  border-color: var(--acc);
}
.panel-stack {
  display: grid;
  gap: 14px;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.filter-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pill {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.pill.on {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc);
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px 18px;
}
.card-hd {
  margin-bottom: 12px;
  font-size: 14.5px;
}
.add-box {
  display: grid;
  gap: 12px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.form-grid label {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  font-weight: 600;
}
.form-grid label.wide {
  grid-column: 1 / -1;
}
.tag-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tag-chip {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--soft);
  color: var(--ink);
  font-size: 12.5px;
  cursor: pointer;
}
.tag-chip.on {
  background: var(--acc);
  color: #fff;
  border-color: var(--acc);
}
.seller-grid {
  display: grid;
  gap: 12px;
}
.seller-card {
  display: grid;
  gap: 10px;
}
.sc-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.sc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 15.5px;
}
.star-mark {
  color: #f59e0b;
  font-size: 17px;
}
.star-pill {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-weight: 700;
}
.sid {
  font-size: 11.5px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--soft);
  color: var(--mute);
}
.sc-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.scope-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
}
.scope-badge.team {
  background: #dbeafe;
  color: #1d4ed8;
}
.scope-badge.personal {
  background: #f3f4f6;
  color: #374151;
}
.tag-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--soft);
  color: var(--ink);
}
.sc-btns {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sc-note {
  margin: 0;
  font-size: 13.5px;
  color: var(--ink);
  background: var(--soft);
  padding: 9px 12px;
  border-radius: 10px;
}
.edit-drawer {
  border-top: 1px dashed var(--line);
  padding-top: 10px;
  display: grid;
  gap: 8px;
}
.edit-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-row .input {
  flex: 1;
  min-width: 220px;
}
.linked-convs {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  display: grid;
  gap: 6px;
}
.lc-hd {
  font-size: 12px;
  font-weight: 700;
  color: var(--mute);
}
.lc-row,
.unfav-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--soft);
  font-size: 13.5px;
}
.unfav-list {
  display: grid;
  gap: 8px;
}
.price-line {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--mute);
  margin-top: 6px;
}
.ok-txt {
  color: #15803d;
}
.empty-hint {
  font-size: 13px;
}
</style>
