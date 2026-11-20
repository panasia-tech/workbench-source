<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ greeting }}，{{ role.name }}</h1>
        <p class="page-sub">红的先办，黄的有空看，绿的不用管。点任意一行的「去跟着做」就会带你走到那一步。</p>
      </div>
      <div class="page-acts">
        <a href="#/cases?bucket=today" class="btn">今天采购的 ({{ bucketCounts.today }})</a>
        <a href="#/cases?bucket=issue" class="btn bad">二次议价 · 问题订单 ({{ bucketCounts.issue }})</a>
        <a href="#/cases?bucket=completed" class="btn">已经完结的 ({{ bucketCounts.completed }})</a>
      </div>
    </div>

    <!-- 1. 三张明白卡：现在要办几件、我的提成赚了多少、全组买货预算还剩多少 -->
    <div class="sum-grid" data-tour="today-summary">
      <div class="card sum-card">
        <div class="sc-top">
          <span>我现在要办的事</span>
          <Q k="today" />
        </div>
        <div class="sc-main">
          <b class="big-num" :class="{ 'txt-red': redTasks.length > 0 }">{{ redTasks.length }} <small>件急活</small></b>
          <span class="muted">另有 {{ ambTasks.length }} 件跟进中 · {{ bucketCounts.completed }} 单已完结</span>
        </div>
        <div class="sc-pills">
          <a href="#/cases?bucket=issue" class="tag red">二次议价 {{ bucketCounts.issue }} 单</a>
          <a
            v-if="stmtSummary.missing_count + stmtSummary.amount_diff_count > 0"
            href="#/cases?reconcile=1"
            class="tag red"
          >
            🧾 昨日账单漏抓 {{ stmtSummary.missing_count }} 笔
          </a>
          <a href="#/cases?bucket=today" class="tag acc">今天采购 {{ bucketCounts.today }} 单</a>
          <a href="#/im-sandbox" class="tag amb">闲鱼待回 {{ manualConvs }} 人</a>
        </div>
      </div>

      <div class="card sum-card">
        <div class="sc-top">
          <span>个人今日收益目标（两段各 10%）</span>
          <Term k="comm_10_20">零重算公式</Term>
        </div>
        <div class="sc-main">
          <b class="big-num txt-grn">
            ¥{{ ((earnings.today_expected_cents || 0) / 100).toFixed(0) }}
            <small>/ 今日目标 {{ fmtYuan(earnings.daily_target_cents || 100000) }}（还差 ¥{{ ((earnings.remaining_to_target_cents || 0) / 100).toFixed(0) }}）</small>
          </b>
          <div class="bar" style="margin: 4px 0">
            <i :style="{ width: (earnings.progress_pct || 0) + '%', background: 'var(--grn)' }" />
          </div>
        </div>
        <div class="sc-pills num">
          <span class="tag amb">预计 ¥{{ ((earnings.today_expected_cents || 0) / 100).toFixed(0) }}</span>
          <span class="tag acc">已确认 ¥{{ ((earnings.confirmed_cents || 0) / 100).toFixed(0) }}</span>
          <span class="tag grn">已发放 ¥{{ ((earnings.paid_cents || 0) / 100).toFixed(0) }}</span>
        </div>
        <div class="sc-foot muted">
          买前差额 <b>×10%</b> + 到货实际退回差价 <b>×10%</b>（三栏独立不混加）
        </div>
      </div>

      <div class="card sum-card" data-tour="today-quota">
        <div class="sc-top">
          <span>采购组本月买货预算</span>
          <Term k="quota_pool">说明</Term>
        </div>
        <div class="sc-main">
          <b class="big-num">{{ fmtYuan(pool?.available_cents || 0) }} <small>还能买</small></b>
          <span class="muted">总预算 {{ fmtYuan(pool?.total_cents || 0) }} · 谈价预留 {{ fmtYuan(pool?.reserved_cents || 0) }}</span>
        </div>
        <div class="bar" style="margin-top: 6px">
          <i :style="{ width: spentPct + '%', background: 'var(--grn)' }" title="已付款" />
          <i :style="{ width: resPct + '%', background: 'var(--amb)' }" title="谈价预留中" />
        </div>
      </div>
    </div>

    <!-- 2a. 次日 10:00 前昨日财务对账单漏抓采购单提醒（一键直达核对补抓） -->
    <div
      v-if="!stmtSummary.signed_off && (stmtSummary.missing_count > 0 || stmtSummary.amount_diff_count > 0)"
      class="stmt-strip"
    >
      <div class="us-left">
        <span class="badge-l amb">🕙 次日 10:00 前 · 昨日对账单核对</span>
        <div>
          <b>陈会计已发昨日对账单：查出 {{ stmtSummary.missing_count }} 笔漏抓采购单（{{ fmtYuan(stmtSummary.missing_amount_cents) }}）· {{ stmtSummary.amount_diff_count }} 笔实付差额</b>
          <p>请立即核对订单是否抓全并一键补抓，同时严控各闲鱼号退款率 &amp; 纠纷率 ≤ 5%（非必要绝不扯皮/不点小二介入）！</p>
        </div>
      </div>
      <a href="#/cases?reconcile=1" class="btn pri">
        去核对并一键补抓 ›
      </a>
    </div>

    <!-- 2b. 到货二次议价利润单置顶急办提醒（10分钟内锁退货防到手刀 + 9步陪谈） -->
    <div v-if="urgentIssueCase" class="urgent-strip">
      <div class="us-left">
        <span class="badge-l red">💰 核心利润锚点 · 二次议价急办</span>
        <div>
          <b>{{ urgentIssueCase.title }}</b>
          <p>{{ urgentIssueCase.issues?.[0]?.text || urgentIssueCase.warehouse_check_note }}</p>
        </div>
      </div>
      <a :href="`#/case/${urgentIssueCase.case_id}`" class="btn pri">
        去 9 步陪跑处理 ›
      </a>
    </div>

    <!-- 3. 待办排队列表（完全对齐销售工作台 Today 列表：一排一事，一键直达当前步） -->
    <section class="card" style="margin-top: 18px" data-tour="today-queue">
      <div class="list-hd">
        <h3>
          现在排队要办的订单
          <small>已按紧急度排好：先做红色「现在要办」，再看黄色「跟进中」</small>
        </h3>
        <div class="seg-mini">
          <button type="button" class="btn sm" :class="{ pri: filterMode === 'action' }" @click="filterMode = 'action'">
            只看要办的 ({{ actionCases.length }})
          </button>
          <button type="button" class="btn sm" :class="{ pri: filterMode === 'all' }" @click="filterMode = 'all'">
            全部订单 ({{ store.dashboard.cases.length }})
          </button>
        </div>
      </div>

      <div v-if="shownCases.length === 0" class="empty-ok">
        🎉 太棒了！你手头要办的红灯急活已经全部清零！可以去「闲鱼聊天」看看有没有新消息。
      </div>

      <div v-else class="task-list">
        <a
          v-for="(c, idx) in shownCases"
          :key="c.case_id"
          :href="`#/case/${c.case_id}`"
          class="trow"
          :class="c.lvl"
        >
          <div class="tr-thumb">
            <img v-if="c.cover_url" :src="c.cover_url" :alt="c.title" />
            <div v-else class="tr-noimg">待补图</div>
          </div>

          <div class="tr-body">
            <div class="tr-tags">
              <span class="tag" :class="c.lvl">
                <i class="dot" :class="c.lvl" /> {{ LV[c.lvl].text }}
              </span>
              <span class="tag" :class="c.order_bucket === 'issue' ? 'red' : c.order_bucket === 'completed' ? 'grn' : 'acc'">
                {{ c.bucket_label }}
              </span>
              <span
                v-if="c.prebuy_eval?.potential_badge && c.order_bucket === 'today'"
                class="tag"
                :class="c.prebuy_eval.can_secondary_bargain ? 'red' : 'amb'"
              >
                {{ c.prebuy_eval.potential_badge }}
              </span>
              <span class="tag">{{ c.source_type }}</span>
              <span class="muted" style="font-size: 12.5px">卖家：{{ c.seller_name }}</span>
            </div>

            <div class="tr-title">{{ c.title }}</div>

            <div class="tr-reason">
              {{ c.issues?.[0]?.text || c.step_progress?.summary }}
            </div>
          </div>

          <div class="tr-right">
            <div class="tr-price num">
              <span>{{ c.prices?.has_paid ? '已付' : c.prices?.has_agreed ? '谈妥' : '卖家挂价' }}</span>
              <b>{{ fmtYuan(c.prices?.seller_or_agreed_cents) }}</b>
              <small v-if="c.prices?.est_comm_cents > 0" class="comm-pill">
                预计提成 {{ fmtYuan(c.prices.est_comm_cents) }}
              </small>
            </div>

            <span class="btn sm" :class="c.lvl === 'red' ? 'pri' : ''" :data-tour="idx === 0 ? 'today-go' : null">
              {{ c.all_done ? '查看存档 ›' : '去跟着做 ›' }}
            </span>
          </div>
        </a>
      </div>
    </section>

    <!-- 4. 每日时间红线与防红标铁律温馨小贴士（折叠精简一行，绝不铺满屏） -->
    <div class="tips-bar muted">
      <span>📌 四条死红线：<b>次日 10:00 前</b>核完财务昨日对账单确保采购订单 100% 抓全 · <b>账号退款率与纠纷率严控 ≤ 5%</b>（非必要绝不扯皮/不点小二介入防红标）· <b>派送/发现不符 10 分钟内</b>锁退货权 · <b>今晚 22:00 前</b>问题单清零。</span>
      <a href="#/manual" style="white-space: nowrap">看完整说明书 ›</a>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { store, LV, currentRole } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from '../components/Q.vue';
import Term from '../components/Term.vue';

const filterMode = ref('action');
const role = computed(() => currentRole());

const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
});

const pool = computed(() => store.dashboard.quota_pool);
const spentPct = computed(() => {
  if (!pool.value?.total_cents) return 0;
  return Math.min(100, Math.round((pool.value.spent_cents / pool.value.total_cents) * 100));
});
const resPct = computed(() => {
  if (!pool.value?.total_cents) return 0;
  return Math.min(100 - spentPct.value, Math.round((pool.value.reserved_cents / pool.value.total_cents) * 100));
});

const bucketCounts = computed(() => {
  const list = store.dashboard.cases || [];
  return {
    today: list.filter((c) => c.order_bucket === 'today').length,
    issue: list.filter((c) => c.order_bucket === 'issue').length,
    completed: list.filter((c) => c.order_bucket === 'completed').length,
  };
});

const redTasks = computed(() => (store.dashboard.cases || []).filter((c) => c.lvl === 'red'));
const ambTasks = computed(() => (store.dashboard.cases || []).filter((c) => c.lvl === 'amb'));
const actionCases = computed(() => (store.dashboard.cases || []).filter((c) => c.lvl !== 'grn'));
const shownCases = computed(() => (filterMode.value === 'all' ? store.dashboard.cases : actionCases.value));

const urgentIssueCase = computed(() =>
  (store.dashboard.cases || []).find((c) => c.order_bucket === 'issue' && c.lvl === 'red')
);

const manualConvs = computed(() =>
  (store.dashboard.conversations || []).filter((c) => c.needs_manual || c.unread_count > 0).length
);

const stmtSummary = computed(
  () =>
    store.dashboard.statement_reconciliation?.summary || {
      missing_count: 0,
      amount_diff_count: 0,
      missing_amount_cents: 0,
      signed_off: false,
    }
);

const earnings = computed(() =>
  store.dashboard.daily_earnings || {
    daily_target_cents: 100000,
    today_expected_cents: 0,
    remaining_to_target_cents: 100000,
    progress_pct: 0,
    confirmed_cents: 0,
    paid_cents: 0,
  }
);
</script>

<style scoped>
.sum-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.sum-card {
  display: grid;
  gap: 10px;
  padding: 18px 22px;
}
.sc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--mute);
}
.sc-main {
  display: grid;
  gap: 2px;
}
.big-num {
  font-size: 28px;
  font-weight: 900;
  letter-spacing: -0.02em;
}
.big-num small {
  font-size: 14px;
  font-weight: 700;
  color: var(--mute);
}
.txt-red { color: var(--red); }
.txt-grn { color: var(--grn); }
.sc-pills {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sc-pills a:hover { text-decoration: none; filter: brightness(0.96); }
.sc-foot { font-size: 12.5px; }

.urgent-strip,
.stmt-strip {
  margin-top: 16px;
  padding: 16px 20px;
  border-radius: 20px;
  background: var(--red-soft);
  border: 1.5px solid var(--red);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.stmt-strip {
  background: var(--amb-soft);
  border-color: var(--amb);
}
.stmt-strip .us-left p {
  color: var(--amb-ink);
}
.us-left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 240px;
}
.us-left b {
  font-size: 16px;
  display: block;
}
.us-left p {
  font-size: 13.5px;
  color: var(--red-ink);
  margin-top: 2px;
}

.list-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.seg-mini {
  display: flex;
  gap: 6px;
}
.empty-ok {
  padding: 28px;
  text-align: center;
  border-radius: 16px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-weight: 700;
}
.task-list {
  display: grid;
  gap: 10px;
}
.trow {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 18px;
  background: var(--soft);
  border: 1.5px solid var(--line);
  color: var(--ink);
  transition: border-color .14s, transform .08s, background .14s;
}
.trow:hover {
  border-color: var(--acc);
  background: var(--panel);
  text-decoration: none;
}
.trow.red {
  border-left: 6px solid var(--red);
}
.trow.amb {
  border-left: 6px solid var(--amb);
}
.trow.grn {
  border-left: 6px solid var(--grn);
}
.tr-thumb {
  width: 68px;
  height: 68px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--line);
}
.tr-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tr-noimg {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--amb-ink);
  background: var(--amb-soft);
}
.tr-body {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.tr-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.tr-title {
  font-size: 16px;
  font-weight: 800;
  line-height: 1.3;
}
.tr-reason {
  font-size: 13.5px;
  color: var(--ink2);
  line-height: 1.45;
}
.tr-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.tr-price {
  text-align: right;
}
.tr-price span {
  display: block;
  font-size: 11.5px;
  color: var(--mute);
}
.tr-price b {
  display: block;
  font-size: 19px;
  font-weight: 900;
}
.comm-pill {
  display: inline-block;
  margin-top: 2px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  font-size: 11.5px;
  font-weight: 700;
}

.tips-bar {
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

@media (max-width: 980px) {
  .sum-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .trow {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 12px;
  }
  .tr-thumb { width: 56px; height: 56px; }
  .tr-right {
    grid-column: 1 / -1;
    justify-content: space-between;
    padding-top: 8px;
    border-top: 1px dashed var(--line);
  }
  .tr-price { text-align: left; }
}
</style>
