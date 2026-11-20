<template>
  <section class="rec-shell" :class="bannerTone">
    <!-- 1. 常驻一行明白条（一眼看清次日 10:00 前昨日对账单有没有漏抓单） -->
    <div class="rec-strip">
      <div class="rs-left">
        <span v-if="summary.signed_off" class="badge-l grn">✅ 昨日采购单已 100% 抓全核平</span>
        <span v-else-if="summary.missing_count > 0" class="badge-l red">
          🚨 昨日对账单查出 {{ summary.missing_count }} 笔漏抓单（{{ fmtYuan(summary.missing_amount_cents) }}）
        </span>
        <span v-else-if="summary.amount_diff_count > 0" class="badge-l amb">
          ⚠️ 昨日对账单有 {{ summary.amount_diff_count }} 笔实付差额待核
        </span>
        <span v-else class="badge-l grn">✓ 昨日账单流水已全对齐（待签字确认）</span>

        <div class="rs-meta">
          <b>🧾 次日 10:00 前 · 昨日财务对账单核对</b>
          <span class="muted">
            （{{ batch?.uploaded_at_label || '陈会计已发昨日账单' }} · 共 {{ summary.total_count }} 笔 {{ fmtYuan(summary.total_statement_cents) }}：
            已抓全 <b>{{ summary.matched_count }}</b> 笔 · 漏抓 <b class="txt-red">{{ summary.missing_count }}</b> 笔 · 差额 <b class="txt-amb">{{ summary.amount_diff_count }}</b> 笔）
          </span>
        </div>
      </div>

      <div class="rs-acts">
        <button
          v-if="summary.missing_count > 0"
          type="button"
          class="btn sm bad"
          :disabled="busy || !unlocked"
          @click="backfillAll"
        >
          ⚡ 一键补抓全部漏单 ({{ summary.missing_count }}笔)
        </button>
        <button type="button" class="btn sm" :class="{ pri: !expanded }" @click="expanded = !expanded">
          {{ expanded ? '收起核对明细 ▲' : '🔍 展开核对订单抓全明细 ▼' }}
        </button>
      </div>
    </div>

    <!-- 2. 展开后的完整双向对账与防漏补抓工作舱 -->
    <div v-if="expanded" class="rec-body">
      <div class="rec-toolbar">
        <div class="rec-pills">
          <button type="button" class="rpill" :class="{ on: tab === 'issues' }" @click="tab = 'issues'">
            🚨 待处理异常 ({{ summary.missing_count + summary.amount_diff_count }})
          </button>
          <button type="button" class="rpill" :class="{ on: tab === 'all' }" @click="tab = 'all'">
            全部昨日账单 ({{ summary.total_count }})
          </button>
          <button type="button" class="rpill" :class="{ on: tab === 'missing' }" @click="tab = 'missing'">
            漏抓采购单 ({{ summary.missing_count }})
          </button>
          <button type="button" class="rpill" :class="{ on: tab === 'matched' }" @click="tab = 'matched'">
            ✅ 已抓全 ({{ summary.matched_count }})
          </button>
          <button type="button" class="rpill" :class="{ on: tab === 'reverse' }" @click="tab = 'reverse'">
            🔄 系统有单·昨日账单未见 ({{ unbilledOrders.length }})
          </button>
        </div>

        <div class="rec-right-tools">
          <span class="tag acc">⚡ 接口已自动同步财务昨日账单</span>
          <Term k="t1_stmt_reconcile">为什么要核昨日账单？</Term>
        </div>
      </div>

      <!-- 反向核查视图：系统登记了付款但昨日账单未见的订单 -->
      <div v-if="tab === 'reverse'" class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>系统采购单</th>
              <th>闲鱼订单号</th>
              <th>登记回执单号</th>
              <th class="num-r">系统登记实付</th>
              <th>双向核对说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="uo in unbilledOrders" :key="uo.po_id">
              <td>
                <a v-if="uo.case_id" :href="`#/case/${uo.case_id}`"><b>{{ uo.title }} ›</b></a>
                <b v-else>{{ uo.title }}</b>
              </td>
              <td class="mono">{{ uo.external_order_no }}</td>
              <td class="mono">{{ uo.payment_receipt_no }}</td>
              <td class="num-r"><b>{{ fmtYuan(uo.paid_cents) }}</b></td>
              <td><span class="tag">{{ uo.hint }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 正向主核查视图：以财务昨日对账单为准核查有没有漏抓采购单 -->
      <div v-else>
        <div v-if="filteredItems.length === 0" class="all-ok-banner">
          🎉 当前筛选下没有异常流水！昨日对账单已全部与系统采购订单核对一致。
        </div>

        <div v-else class="tblwrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>抓单核对状态</th>
                <th>支付宝流水 & 闲鱼单号</th>
                <th>卖家 & 昨日购买商品</th>
                <th class="num-r">财务账单实扣</th>
                <th class="num-r">系统已抓金额</th>
                <th class="row-acts">一键补抓 / 平账处理</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="it in filteredItems"
                :key="it.stmt_item_id"
                :class="{
                  'row-miss': it.match_status === 'missing_order',
                  'row-diff': it.match_status === 'amount_diff',
                }"
              >
                <td>
                  <span
                    class="tag"
                    :class="
                      it.match_status === 'missing_order'
                        ? 'red'
                        : it.match_status === 'amount_diff'
                        ? 'amb'
                        : it.match_status === 'matched'
                        ? 'grn'
                        : ''
                    "
                  >
                    {{ it.status_label }}
                  </span>
                  <div class="muted" style="font-size:11.5px;margin-top:2px">{{ it.tx_time }} · {{ it.account_id }}</div>
                </td>
                <td>
                  <div class="mono"><b>{{ it.alipay_tx_no }}</b></div>
                  <div class="mono muted" style="font-size:12px">闲鱼：{{ it.external_order_no }}</div>
                </td>
                <td>
                  <b>{{ it.item_title }}</b>
                  <div class="muted" style="font-size:12px">卖家：{{ it.counterparty_name }}</div>
                  <div v-if="it.resolution_note" style="font-size:12px;color:var(--grn)">✓ {{ it.resolution_note }}</div>
                </td>
                <td class="num-r">
                  <b>{{ fmtYuan(it.amount_cents) }}</b>
                </td>
                <td class="num-r">
                  <b v-if="it.system_paid_cents != null" :class="{ 'txt-amb': it.match_status === 'amount_diff' }">
                    {{ fmtYuan(it.system_paid_cents) }}
                  </b>
                  <span v-else class="txt-red"><b>未抓到订单</b></span>
                </td>
                <td class="row-acts">
                  <template v-if="it.match_status === 'missing_order'">
                    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                      <button
                        type="button"
                        class="btn sm pri"
                        :disabled="busy || !unlocked"
                        @click="backfillOne(it)"
                      >
                        ⚡ 一键补抓进采购单
                      </button>
                      <button
                        type="button"
                        class="btn sm"
                        :disabled="busy || !unlocked"
                        @click="openIgnoreBox(it.stmt_item_id)"
                      >
                        非采购排除
                      </button>
                    </div>
                    <div v-if="ignoringId === it.stmt_item_id" class="ignore-pop">
                      <input
                        v-model="ignoreNote"
                        class="input"
                        placeholder="写明非采购原因（如：仓库顺丰包材月结费）"
                      />
                      <button type="button" class="btn sm ok" :disabled="busy" @click="confirmIgnore(it.stmt_item_id)">
                        确认排除
                      </button>
                    </div>
                  </template>

                  <template v-else-if="it.match_status === 'amount_diff'">
                    <button
                      type="button"
                      class="btn sm pri"
                      :disabled="busy || !unlocked"
                      @click="syncDiffAmount(it)"
                    >
                      🔧 按账单实扣 {{ fmtYuan(it.amount_cents) }} 核平
                    </button>
                  </template>

                  <template v-else-if="it.matched_case_id">
                    <a :href="`#/case/${it.matched_case_id}`" class="btn sm">
                      查看采购单 ›
                    </a>
                  </template>
                  <span v-else class="muted" style="font-size:12px">已备案排除</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 底部次日 10:00 对账抓全签字打卡栏 -->
      <div class="signoff-bar">
        <div>
          <b>🕙 次日 10:00 订单抓全闭环打卡：</b>
          <span v-if="summary.signed_off" class="txt-grn">
            <b>已由【{{ batch?.signed_off_by }}】于 {{ batch?.signed_off_at }} 确认昨日采购单 100% 抓全核平！</b>
          </span>
          <span v-else class="muted">
            必须把所有「漏抓采购单」补抓入库、所有「实付差额」核平清零后，才能解锁签字确认。
          </span>
        </div>

        <Lock
          v-if="!summary.signed_off"
          :ok="unlocked && summary.all_clear"
          :busy="busy"
          kind="ok"
          :reason="
            !unlocked
              ? '请先完成新手防踩坑练习'
              : `还有 ${summary.missing_count} 笔漏抓订单、${summary.amount_diff_count} 笔金额差额未处理完，不能提前签字！`
          "
          penalty="漏抓采购单不补进系统会导致机器到仓无人认领、账实穿孔！"
          @go="signOffBatch"
        >
          ✅ 确认昨日采购单已 100% 抓全核平
        </Lock>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { store, callAction, isPracticeUnlocked } from '../store.js';
import { fmtYuan } from '../api.js';
import Term from './Term.vue';
import Lock from './Lock.vue';

const props = defineProps({
  defaultOpen: { type: Boolean, default: false },
});

const expanded = ref(props.defaultOpen);
const tab = ref('issues');
const ignoringId = ref('');
const ignoreNote = ref('仓库顺丰包材与胶带月结费');
const busy = ref(false);

watch(
  () => props.defaultOpen,
  (v) => {
    if (v) expanded.value = true;
  },
  { immediate: true }
);

const unlocked = computed(() => isPracticeUnlocked());
const rec = computed(() => store.dashboard.statement_reconciliation || {});
const batch = computed(() => rec.value.batch || null);
const items = computed(() => rec.value.items || []);
const unbilledOrders = computed(() => rec.value.unbilled_orders || []);
const summary = computed(
  () =>
    rec.value.summary || {
      total_count: 0,
      matched_count: 0,
      missing_count: 0,
      amount_diff_count: 0,
      total_statement_cents: 0,
      missing_amount_cents: 0,
      all_clear: true,
      signed_off: false,
    }
);

const bannerTone = computed(() => {
  if (summary.value.missing_count > 0) return 'tone-red';
  if (summary.value.amount_diff_count > 0) return 'tone-amb';
  return 'tone-grn';
});

const filteredItems = computed(() => {
  if (tab.value === 'issues') {
    return items.value.filter((x) => x.match_status === 'missing_order' || x.match_status === 'amount_diff');
  }
  if (tab.value === 'missing') {
    return items.value.filter((x) => x.match_status === 'missing_order');
  }
  if (tab.value === 'matched') {
    return items.value.filter((x) => x.match_status === 'matched');
  }
  return items.value;
});

async function backfillOne(it) {
  busy.value = true;
  try {
    const res = await callAction(
      '/api/reconcile/backfill',
      { stmt_item_id: it.stmt_item_id },
      `⚡ 已将漏单《${it.item_title}》补抓进【今天采购的】并推送赵仓管重点验机！`
    );
    if (res.created_case_ids?.length && summary.value.missing_count === 0 && summary.value.amount_diff_count === 0) {
      tab.value = 'all';
    }
  } finally {
    busy.value = false;
  }
}

async function backfillAll() {
  busy.value = true;
  try {
    const res = await callAction(
      '/api/reconcile/backfill',
      { backfill_all: true },
      `⚡ 已一键补抓全部 ${summary.value.missing_count} 笔漏抓订单进【今天采购的】！`
    );
    expanded.value = true;
    if (res.backfilled_count > 0 && summary.value.amount_diff_count === 0) {
      tab.value = 'all';
    }
  } finally {
    busy.value = false;
  }
}

function openIgnoreBox(id) {
  ignoringId.value = ignoringId.value === id ? '' : id;
}

async function confirmIgnore(stmtId) {
  busy.value = true;
  try {
    await callAction(
      '/api/reconcile/resolve-diff',
      { stmt_item_id: stmtId, action: 'ignore_non_po', note: ignoreNote.value.trim() },
      '已标记为非采购支出排除备查'
    );
    ignoringId.value = '';
  } finally {
    busy.value = false;
  }
}

async function syncDiffAmount(it) {
  busy.value = true;
  try {
    await callAction(
      '/api/reconcile/resolve-diff',
      { stmt_item_id: it.stmt_item_id, action: 'sync_to_statement' },
      `✓ 已按财务账单实扣 ${fmtYuan(it.amount_cents)} 核平订单与资金流水！`
    );
    if (summary.value.missing_count === 0 && summary.value.amount_diff_count === 0) {
      tab.value = 'all';
    }
  } finally {
    busy.value = false;
  }
}

async function signOffBatch() {
  busy.value = true;
  try {
    await callAction('/api/reconcile/signoff', {}, '🎉 昨日财务对账单已 100% 抓全核平签字归档！');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.rec-shell {
  background: var(--panel);
  border: 1.5px solid var(--line);
  border-radius: 20px;
  padding: 14px 18px;
  margin-bottom: 18px;
  box-shadow: var(--sh);
}
.rec-shell.tone-red {
  border-color: var(--red);
  background: linear-gradient(180deg, var(--red-soft), var(--panel) 64px);
}
.rec-shell.tone-amb {
  border-color: var(--amb);
  background: linear-gradient(180deg, var(--amb-soft), var(--panel) 64px);
}
.rec-shell.tone-grn {
  border-color: var(--grn);
}
.rec-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.rs-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1;
}
.rs-meta {
  font-size: 13.5px;
  line-height: 1.45;
}
.rs-acts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.rec-body {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  display: grid;
  gap: 12px;
}
.rec-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rec-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.rpill {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--soft);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink2);
}
.rpill.on {
  background: var(--acc);
  border-color: var(--acc);
  color: #fff;
}
.rec-right-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.import-box {
  background: var(--soft);
  border: 1px dashed var(--acc);
  border-radius: 14px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}
.ib-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.all-ok-banner {
  padding: 18px;
  border-radius: 14px;
  background: var(--grn-soft);
  color: var(--grn-ink);
  text-align: center;
  font-weight: 700;
}
.row-miss {
  background: var(--red-soft);
}
.row-diff {
  background: var(--amb-soft);
}
.ignore-pop {
  margin-top: 6px;
  display: flex;
  gap: 6px;
}
.signoff-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--soft);
  font-size: 13px;
}
.txt-red { color: var(--red); }
.txt-amb { color: var(--amb); }
.txt-grn { color: var(--grn); }
</style>
