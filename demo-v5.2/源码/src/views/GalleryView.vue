<template>
  <div class="gal">
    <div class="page-head">
      <div>
        <h1>采购订单</h1>
        <p class="page-sub">围绕「二次议价利润锚点」拆成三大类：买前判空间给仓管打标、到货 9 步手把手二次议价、钱货两清完结入库。</p>
      </div>
      <div class="page-acts">
        <Q k="cases" label="分类说明" />
      </div>
    </div>

    <!-- 0. 次日 10:00 前 · 财务昨日对账单 × 采购订单抓全核对台（常驻一行明白条 + 可展开补抓明细） -->
    <StatementReconcilePanel :default-open="initReconcile" />

    <!-- 0b. 闲鱼账号退款率 ≤5% & 纠纷介入率 ≤5% 防红标监控盾（非必要绝不扯皮/不点小二介入） -->
    <AccountRiskShieldBar />

    <!-- 1. 三大核心订单分类大按钮（老板点名要求的清晰三分类） -->
    <div class="bucket-bar" data-tour="gal-buckets">
      <button
        type="button"
        class="bucket-tab"
        :class="{ on: bucket === 'today' }"
        @click="pickBucket('today')"
      >
        <div>
          <span class="bt-title">🛒 今天采购的</span>
          <span class="bt-sub">买前 6 步：锁快照 · 判二次议价给仓管打标（别追问！）· 核改价付款</span>
        </div>
        <span class="bt-cnt">{{ counts.today }}</span>
      </button>

      <button
        type="button"
        class="bucket-tab issue-tab"
        :class="{ on: bucket === 'issue' }"
        @click="pickBucket('issue')"
      >
        <div>
          <span class="bt-title">💰 二次议价 · 问题订单</span>
          <span class="bt-sub">核心利润锚点 · 双轨9步陪跑（顺丰10m拒签/已签收锁退货 + 12奇兵）到货差价×10%</span>
        </div>
        <span class="bt-cnt">{{ counts.issue }}</span>
      </button>

      <button
        type="button"
        class="bucket-tab done-tab"
        :class="{ on: bucket === 'completed' }"
        @click="pickBucket('completed')"
      >
        <div>
          <span class="bt-title">✅ 已经完结的</span>
          <span class="bt-sub">无差异入库拿买前10% · 二次议价落袋沉淀ERP叠加到货退差10%提成</span>
        </div>
        <span class="bt-cnt">{{ counts.completed }}</span>
      </button>
    </div>

    <!-- 2. 极简筛选栏 -->
    <div class="filter-bar" data-tour="gal-filters">
      <div class="fb-left">
        <button
          type="button"
          class="btn sm"
          :class="{ bad: onlyRed }"
          @click="onlyRed = !onlyRed"
        >
          {{ onlyRed ? '✓ 只看现在要办的红灯单' : '只看现在要办的红灯单' }}
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ pri: bucket === 'all' }"
          @click="pickBucket('all')"
        >
          看全部 ({{ (store.dashboard.cases || []).length }})
        </button>
      </div>

      <div class="fb-search">
        <Icon name="search" size="16" />
        <input
          v-model="kw"
          type="search"
          placeholder="搜商品名、卖家昵称、老帖捡漏、850…"
          aria-label="搜索采购订单"
        />
      </div>
    </div>

    <!-- 3. 订单卡片网格 -->
    <div v-if="filtered.length === 0" class="card empty-box">
      <p>当前筛选下没有匹配的订单。</p>
      <button type="button" class="btn sm pri" @click="resetFilter">显示本分类全部订单</button>
    </div>

    <div v-else class="cgrid">
      <a
        v-for="(c, idx) in filtered"
        :key="c.case_id"
        :href="`#/case/${c.case_id}`"
        class="ccard"
        :class="c.lvl"
        :data-tour="idx === 0 ? 'gal-card' : null"
      >
        <div class="cc-top">
          <div class="cc-img">
            <img v-if="c.cover_url" :src="c.cover_url" :alt="c.title" />
            <div v-else class="cc-noimg">
              <b>📷</b>
              <span>待补实拍图</span>
            </div>
          </div>

          <div class="cc-meta">
            <div class="cc-badges">
              <span class="tag" :class="c.lvl">
                <i class="dot" :class="c.lvl" /> {{ LV[c.lvl].text }}
              </span>
              <span class="tag">{{ c.source_type }}</span>
              <span
                v-if="c.prebuy_eval?.potential_badge"
                class="tag"
                :class="c.prebuy_eval.can_secondary_bargain ? 'red' : 'amb'"
              >
                {{ c.prebuy_eval.potential_badge }}
              </span>
            </div>
            <h3 class="cc-title">{{ c.title }}</h3>
            <p class="muted" style="font-size: 12.5px">
              卖家：{{ c.seller_name }} · {{ c.condition_grade }}
            </p>
          </div>
        </div>

        <!-- 清晰展示当前停在第几步 + 迷你圆点进度 -->
        <div class="cc-step">
          <div class="ccs-row">
            <b>{{ c.step_progress?.summary }}</b>
            <span class="ccs-dots">
              <i
                v-for="s in (c.step_progress?.steps || [])"
                :key="s.n"
                class="sdot"
                :class="s.state"
                :title="`${s.n}. ${s.t}`"
              />
            </span>
          </div>
        </div>

        <!-- 三个明白数字 -->
        <div class="cc-nums num">
          <div>
            <span>{{ c.prices?.has_paid ? '实付金额' : c.prices?.has_agreed ? '谈妥价' : '卖家挂价' }}</span>
            <b>{{ fmtYuan(c.prices?.seller_or_agreed_cents) }}</b>
          </div>
          <div>
            <span>{{ c.order_bucket === 'issue' && c.bargain_plan ? '建议目标退差' : '公司参考价' }}</span>
            <b>
              {{
                c.order_bucket === 'issue' && c.bargain_plan
                  ? fmtYuan(c.bargain_plan.target_b_cents)
                  : fmtYuan(c.prices?.ref_price_cents)
              }}
            </b>
          </div>
          <div>
            <span>{{ c.all_done ? '已发提成' : '预计提成' }}</span>
            <b class="grn-num">{{ fmtYuan(c.prices?.est_comm_cents) }}</b>
          </div>
        </div>

        <!-- 当前一句话行动提示 -->
        <div class="cc-action" :class="c.lvl">
          <span>{{ c.issues?.[0]?.text || c.review_note || '已全部办妥入库归档' }}</span>
          <b class="go-txt">{{ c.all_done ? '看详情 ›' : '进入一步步操作 ›' }}</b>
        </div>
      </a>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, LV } from '../store.js';
import { fmtYuan } from '../api.js';
import Icon from '../components/Icon.vue';
import Q from '../components/Q.vue';
import StatementReconcilePanel from '../components/StatementReconcilePanel.vue';
import AccountRiskShieldBar from '../components/AccountRiskShieldBar.vue';

const props = defineProps({
  initBucket: { type: String, default: '' },
  initReconcile: { type: Boolean, default: false },
});

const bucket = ref(props.initBucket || 'today');
const onlyRed = ref(false);
const kw = ref('');

watch(
  () => props.initBucket,
  (v) => {
    if (v && ['today', 'issue', 'completed', 'all'].includes(v)) {
      bucket.value = v;
    }
  },
  { immediate: true }
);

function pickBucket(b) {
  bucket.value = b;
  onlyRed.value = false;
}

function resetFilter() {
  onlyRed.value = false;
  kw.value = '';
}

const counts = computed(() => {
  const list = store.dashboard.cases || [];
  return {
    today: list.filter((c) => c.order_bucket === 'today').length,
    issue: list.filter((c) => c.order_bucket === 'issue').length,
    completed: list.filter((c) => c.order_bucket === 'completed').length,
  };
});

const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase();
  return (store.dashboard.cases || []).filter((c) => {
    if (bucket.value !== 'all' && c.order_bucket !== bucket.value) return false;
    if (onlyRed.value && c.lvl !== 'red') return false;
    if (q) {
      const hay = `${c.title} ${c.seller_name} ${c.source_type} ${c.condition_grade} ${c.warehouse_check_note}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});
</script>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}
.fb-left {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.fb-search {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  min-width: min(320px, 100%);
  flex: 1;
  max-width: 420px;
}
.fb-search input {
  border: 0;
  background: none;
  outline: none;
  width: 100%;
  font-size: 14px;
}

.empty-box {
  text-align: center;
  padding: 36px 20px;
  display: grid;
  justify-items: center;
  gap: 12px;
}

.cgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 18px;
}
.ccard {
  background: var(--panel);
  border: 1.5px solid var(--line);
  border-radius: 22px;
  box-shadow: var(--sh);
  padding: 18px 20px;
  color: var(--ink);
  display: grid;
  gap: 13px;
  transition: transform .12s, border-color .14s, box-shadow .14s;
}
.ccard:hover {
  border-color: var(--acc);
  box-shadow: var(--sh-up);
  transform: translateY(-2px);
  text-decoration: none;
}
.ccard.red {
  border-top: 5px solid var(--red);
}
.ccard.amb {
  border-top: 5px solid var(--amb);
}
.ccard.grn {
  border-top: 5px solid var(--grn);
}

.cc-top {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.cc-img {
  width: 84px;
  height: 84px;
  border-radius: 16px;
  overflow: hidden;
  background: var(--soft);
  border: 1px solid var(--line);
}
.cc-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cc-noimg {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  padding: 4px;
}
.cc-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.cc-title {
  font-size: 16px;
  font-weight: 800;
  line-height: 1.3;
  margin-bottom: 4px;
}

.cc-step {
  background: var(--soft);
  padding: 9px 12px;
  border-radius: 12px;
}
.ccs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.ccs-dots {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.sdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--line);
}
.sdot.done { background: var(--grn); }
.sdot.cur { background: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); }

.cc-nums {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 8px 0 4px;
}
.cc-nums > div {
  background: var(--soft);
  padding: 8px 10px;
  border-radius: 12px;
}
.cc-nums span {
  display: block;
  font-size: 11.5px;
  color: var(--mute);
}
.cc-nums b {
  display: block;
  font-size: 16.5px;
  font-weight: 800;
  margin-top: 2px;
}
.grn-num { color: var(--grn); }

.cc-action {
  padding: 11px 13px;
  border-radius: 13px;
  font-size: 13px;
  line-height: 1.45;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--soft);
}
.cc-action.red {
  background: var(--red-soft);
  color: var(--red-ink);
}
.cc-action.amb {
  background: var(--amb-soft);
  color: var(--amb-ink);
}
.cc-action.grn {
  background: var(--grn-soft);
  color: var(--grn-ink);
}
.go-txt {
  white-space: nowrap;
  color: var(--acc);
  font-size: 13px;
}

@media (max-width: 500px) {
  .cgrid { grid-template-columns: minmax(0, 1fr); }
  .cc-action { flex-direction: column; align-items: flex-start; }
}
</style>
