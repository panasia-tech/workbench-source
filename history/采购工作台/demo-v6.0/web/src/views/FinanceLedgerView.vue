<template>
  <div v-if="fin">
    <div class="tabs" data-tour="fin-tabs">
      <button class="tab-btn" :class="{ active: tab === 'reconcile' }" @click="tab = 'reconcile'">📊 次日 10:00 昨日对账单</button>
      <button class="tab-btn" :class="{ active: tab === 'alipay' }" @click="tab = 'alipay'">💳 T+1 支付宝对公待批 ({{ pendingRegsCount }})</button>
      <button class="tab-btn" :class="{ active: tab === 'comm' }" @click="tab = 'comm'">💰 两段各 10% 提成独立核发</button>
      <button class="tab-btn" :class="{ active: tab === 'ledger' }" @click="tab = 'ledger'">📑 资金收支审计明细</button>
    </div>

    <div v-if="tab === 'reconcile'">
      <StatementReconcileBar @updated="load" />
    </div>

    <div v-if="tab === 'alipay'" class="card">
      <div class="card-header">
        <h3 class="card-title">💳 次日 10:00 (T+1) 支付宝对公直转审批台（仅 FINANCE / ADMIN 核销）</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>登记号 / 关联订单</th>
              <th>对公收款人</th>
              <th>收款实名支付宝</th>
              <th>实留转款额</th>
              <th>状态 / 回执凭证</th>
              <th>会计审批</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in fin.corp_alipay_regs" :key="r.reg_id">
              <td><strong>{{ r.reg_id }}</strong><div class="muted">{{ r.case_id }} / {{ r.ticket_id }}</div></td>
              <td>{{ r.payee_real_name }}</td>
              <td class="num">{{ r.payee_alipay_account }}</td>
              <td class="num"><strong>{{ fmtYuan(r.amount_cents) }}</strong></td>
              <td>
                <span class="tag" :class="r.status === 'approved_paid' ? 'grn' : 'amb'">{{ r.status }}</span>
                <div class="muted" v-if="r.receipt_no">{{ r.receipt_no }}</div>
              </td>
              <td>
                <div v-if="r.status === 'pending_finance'" style="display: flex; gap: 6px;">
                  <input v-model="receipts[r.reg_id]" class="input" style="width: 170px;" placeholder="流水回执号（禁填0）" />
                  <button class="btn btn-sm btn-primary" @click="approveReg(r.reg_id)">核销放款</button>
                </div>
                <span v-else class="muted">已由 {{ r.approved_by }} 核清</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="tab === 'comm'" class="card">
      <div class="banner grn" style="margin-bottom: 12px;">
        <strong>⚖ 两段独立 10% 绝对隔离原则：买前省额 (M-P)×10% 与 到货省额 R×10% 分行独立核算，严禁把 R 代回买前重算！</strong>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>订单号 / 归属人</th>
              <th>计提阶段（严格隔离）</th>
              <th>省钱基数 (M-P 或 R)</th>
              <th>10% 预计 / 确认提成</th>
              <th>状态与算法说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in fin.commissions" :key="c.comm_id">
              <td><strong>{{ c.case_id }}</strong> · {{ c.staff_id }}</td>
              <td>
                <span class="tag" :class="c.policy_mode === 'pre_buy_10_pct' ? 'blue' : 'amb'">
                  {{ c.policy_mode === 'pre_buy_10_pct' ? '第一段 · 买前省额 10%' : '第二段 · 到货二次议价 10%' }}
                </span>
              </td>
              <td class="num"><strong>{{ fmtYuan(c.base_saved_cents) }}</strong></td>
              <td class="num"><strong>{{ c.confirmed_cents ? fmtYuan(c.confirmed_cents) : fmtYuan(c.estimated_cents) }}</strong></td>
              <td>
                <span class="tag" :class="c.status === 'paid' || c.status === 'confirmed' ? 'grn' : 'amb'">{{ c.status }}</span>
                <div class="muted" style="margin-top: 2px;">{{ c.note }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="tab === 'ledger'" class="card">
      <h3 class="card-title" style="margin-bottom: 10px;">📑 全链路资金收支审计账本</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>流水 ID</th><th>订单</th><th>科目</th><th>方向</th><th>金额</th><th>凭证/核销人</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in fin.ledger" :key="l.ledger_id">
              <td class="num">{{ l.ledger_id }}</td>
              <td>{{ l.case_id }}</td>
              <td>{{ l.title }}</td>
              <td><span class="tag" :class="l.direction === 'inflow' ? 'grn' : 'slate'">{{ l.direction === 'inflow' ? '入账/退回' : '出款' }}</span></td>
              <td class="num"><strong>{{ fmtYuan(l.amount_cents) }}</strong></td>
              <td>{{ l.receipt_no || '待核' }} · {{ l.verified_by || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError, pushToast } from '../store/store.js';
import StatementReconcileBar from '../components/StatementReconcileBar.vue';

const fin = ref(null);
const tab = ref('reconcile');
const receipts = reactive({});

const pendingRegsCount = computed(
  () => (fin.value?.corp_alipay_regs || []).filter((r) => r.status === 'pending_finance').length
);

async function load() {
  try {
    const res = await apiRequest('/api/finance');
    fin.value = res.data;
    for (const r of fin.value.corp_alipay_regs || []) {
      if (!receipts[r.reg_id]) receipts[r.reg_id] = `ALI-FIN-${r.reg_id.slice(-4)}`;
    }
  } catch (err) {
    handleApiError(err);
  }
}

async function approveReg(regId) {
  try {
    await apiRequest(`/api/finance/alipay-regs/${encodeURIComponent(regId)}/approve`, {
      method: 'POST',
      body: { receipt_no: receipts[regId] || '' },
    });
    pushToast('T+1 支付宝对公核销成功！', 'info');
    await load();
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
