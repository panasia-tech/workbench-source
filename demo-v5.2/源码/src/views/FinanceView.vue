<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>对账审批（支付宝对公 T+1）& 个人收益看板</h1>
        <p class="page-sub">
          两段各 <b>10%</b> 独立计提（买前差额×10% + 到货实际退回差价×10%，绝不重复计提）；大额议价统一走「整单全退关单 + 支付宝对公次日 10:00 T+1 审批」。
        </p>
      </div>
      <div class="page-acts">
        <Q k="finance" label="怎么对账与T+1审批" />
      </div>
    </header>

    <!-- 0. 个人单日收益目标进度看板（预计 / 已确认 / 已发放 严格独立展示，绝不混加） -->
    <section class="earn-board" style="margin-bottom: 18px">
      <div class="eb-main num">
        <div class="eb-hd">
          <span>🎯 个人今日累计预计提成（对比单日目标）</span>
          <div class="target-edit">
            <span>今日目标(元)：</span>
            <input v-model.number="targetYuanInput" type="number" class="input sm-in" />
            <button type="button" class="btn sm" :disabled="busy" @click="saveDailyTarget">更新目标</button>
          </div>
        </div>
        <div class="eb-nums">
          <b>¥{{ ((earnings.today_expected_cents || 0) / 100).toFixed(2) }}</b>
          <span>
            / 目标 {{ fmtYuan(earnings.daily_target_cents || 100000) }}
            · 还差 <b>¥{{ ((earnings.remaining_to_target_cents || 0) / 100).toFixed(2) }}</b>
            （完成 {{ earnings.progress_pct || 0 }}%）
          </span>
        </div>
        <div class="bar" style="height: 10px">
          <i :style="{ width: (earnings.progress_pct || 0) + '%', background: '#ffda00' }" />
        </div>
        <small class="eb-formula">
          📐 零重算铁律：买前在途预计 {{ fmtYuan(earnings.pre_buy_expected_cents || 0) }} + 到货退差在途预计 {{ fmtYuan(earnings.post_arrival_expected_cents || 0) }}（严禁把到货退差 R 代回买前公式重算）
        </small>
      </div>

      <div class="eb-cols num">
        <div class="eb-col">
          <span>预计提成（含在途）</span>
          <b>¥{{ ((earnings.today_expected_cents || 0) / 100).toFixed(2) }}</b>
          <small>待入库与T+1核销转正</small>
        </div>
        <div class="eb-col">
          <span>已确认待发</span>
          <b class="acc-txt">¥{{ ((earnings.confirmed_cents || 0) / 100).toFixed(2) }}</b>
          <small>财务已确认待发薪</small>
        </div>
        <div class="eb-col">
          <span>已发放落袋</span>
          <b class="grn-txt">¥{{ ((earnings.paid_cents || 0) / 100).toFixed(2) }}</b>
          <small>已正式计入工资</small>
        </div>
      </div>
    </section>

    <!-- 0b. 次日 10:00 前 · 财务昨日对账单 × 采购订单抓全核对舱（防止付款漏抓单、金额差额穿孔） -->
    <StatementReconcilePanel :default-open="true" />

    <div v-if="!canFinance" class="banner amb" style="margin-bottom: 16px">
      💡 你当前是 <b>{{ role.name }}（{{ role.role_label }}）</b>，可透明查看所有「支付宝对公支付登记单（T+1 次日 10:00 审批）」与提成明细；审批打款与核销回执由【陈会计】执行。
      <button type="button" class="btn sm pri" style="margin-left: 10px" @click="switchFinance">
        切到【陈会计】体验次日 10:00 T+1 审批 ›
      </button>
    </div>

    <!-- 1. 整单全退 + 支付宝对公支付订单登记与次日 10:00（T+1）财务审批表 -->
    <section class="card" style="margin-bottom: 18px">
      <h3>
        🏦 整单全退关单 · 支付宝对公支付订单登记表（财务次日 10:00 T+1 账单审批）
        <small>防平台一刀切红标 · 防卖家恶意差评 · 防二次申诉（整单关闭后平台不再管辖）</small>
      </h3>
      <div v-if="corpRegs.length === 0" class="muted" style="padding: 12px 0">
        暂无待审批的支付宝对公支付登记单。
      </div>
      <div v-else class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>T+1 审批状态</th>
              <th>关联订单</th>
              <th class="num-r">原单全退关单额</th>
              <th class="num-r">对公实转卖家</th>
              <th class="num-r">到货折让差价 R</th>
              <th>卖家收款支付宝 & 实名</th>
              <th>审批批次（T+1）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rg in corpRegs" :key="rg.reg_id" :class="{ hit: rg.approval_status !== 'approved_paid' }">
              <td>
                <span class="tag" :class="rg.approval_status === 'approved_paid' ? 'grn' : 'amb'">
                  {{ rg.approval_status === 'approved_paid' ? `✓ 已审批打款 (${rg.alipay_corp_receipt_no})` : '⏳ 待次日 10:00 审批' }}
                </span>
              </td>
              <td>
                <a v-if="rg.case_id" :href="`#/case/${rg.case_id}`">
                  <b>{{ caseTitleById(rg.case_id) || rg.po_id }} ›</b>
                </a>
                <span v-else>{{ rg.po_id }}</span>
                <div class="muted" style="font-size:12px">关单号：{{ rg.platform_close_no }}</div>
              </td>
              <td class="num-r">{{ fmtYuan(rg.original_paid_cents) }}</td>
              <td class="num-r"><b>{{ fmtYuan(rg.agreed_payout_cents) }}</b></td>
              <td class="num-r" style="color: var(--grn)"><b>{{ fmtYuan(rg.bargain_saved_cents) }}</b></td>
              <td>
                <b>{{ rg.seller_alipay_name }}</b>
                <div class="mono muted" style="font-size:12px">{{ rg.seller_alipay_account }}</div>
              </td>
              <td>
                <span class="tag acc">{{ rg.expected_approve_at }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 2. 我的采购谈价提成表（两段各 10% 独立明细） -->
    <section class="card" style="margin-bottom: 18px">
      <h3>
        💰 采购谈价提成明细（买前省钱×10% + 到货实际退差×10% · 独立核算不重复计提）
        <small>机器入库、财务完成 T+1 对账审批后正式确认发放；全额退货未留成自动冲零</small>
      </h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>对应订单</th>
              <th>提成段落</th>
              <th class="num-r">预计提成</th>
              <th class="num-r">已确认/已发</th>
              <th>当前状态</th>
              <th>独立核算说明</th>
              <th v-if="canFinance" class="row-acts">财务确认</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cm in comms" :key="cm.comm_id">
              <td>
                <a v-if="caseOfPo(cm.po_id)" :href="`#/case/${caseOfPo(cm.po_id).case_id}`">
                  <b>{{ caseOfPo(cm.po_id).title }} ›</b>
                </a>
                <span v-else>{{ cm.po_id }}</span>
              </td>
              <td>
                <span class="tag" :class="cm.policy_mode?.startsWith('post_arrival') ? 'grn' : 'acc'">
                  {{ cm.policy_mode?.startsWith('post_arrival') ? '到货退差 10% 提成' : '买前省钱 10% 提成' }}
                </span>
              </td>
              <td class="num-r">{{ fmtYuan(cm.estimated_cents) }}</td>
              <td class="num-r"><b>{{ fmtYuan(cm.confirmed_cents) }}</b></td>
              <td>
                <span class="tag" :class="cm.status === 'paid' ? 'grn' : cm.status === 'confirmed' ? 'acc' : cm.status === 'reversed' ? 'red' : 'amb'">
                  {{ statusLabel(cm.status) }}
                </span>
              </td>
              <td>{{ cm.note }}</td>
              <td v-if="canFinance" class="row-acts">
                <button
                  type="button"
                  class="btn sm ok"
                  :disabled="cm.status === 'reversed' || cm.status === 'paid' || busy"
                  @click="commAct(cm.comm_id, 'pay')"
                >
                  确认发放
                </button>
                <button
                  type="button"
                  class="btn sm bad"
                  style="margin-left: 6px"
                  :disabled="cm.status === 'reversed' || busy"
                  @click="commAct(cm.comm_id, 'reverse')"
                >
                  全退冲回
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 3. 收付款与支付宝对公支付流水核销表 -->
    <section class="card" style="margin-bottom: 18px">
      <h3>
        🧾 收付款与支付宝对公支付 T+1 核对表
        <small>待核对 {{ pendingCount }} 笔 · 已核对 {{ ledger.length - pendingCount }} 笔（填入对公电子回单号即完成次日 10:00 审批核销）</small>
      </h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>状态</th>
              <th>关联订单</th>
              <th>渠道</th>
              <th class="num-r">金额</th>
              <th>说明</th>
              <th class="row-acts">支付宝对公/退款真实回执号</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in sortedLedger" :key="row.entry_id" :class="{ hit: row.status !== 'verified' }">
              <td>
                <span class="tag" :class="row.status === 'verified' ? 'grn' : 'red'">
                  {{ row.status === 'verified' ? '✓ 已核实' : '⏳ 待陈会计 T+1 审批核实' }}
                </span>
              </td>
              <td>
                <a v-if="caseOfPo(row.po_id)" :href="`#/case/${caseOfPo(row.po_id).case_id}`">
                  <b>{{ caseOfPo(row.po_id).title }} ›</b>
                </a>
                <span v-else>{{ row.po_id }}</span>
              </td>
              <td>{{ row.channel }}</td>
              <td class="num-r">
                <b>{{ row.direction === 'inflow' ? '+' : '-' }}{{ fmtYuan(row.amount_cents) }}</b>
              </td>
              <td>{{ row.note }}</td>
              <td class="row-acts">
                <span v-if="row.status === 'verified'" class="tag grn mono">{{ row.receipt_id }}</span>
                <div v-else style="display: inline-flex; gap: 6px; align-items: center">
                  <input
                    v-model="receipts[row.entry_id]"
                    class="input mono"
                    style="width: 185px"
                    placeholder="填对公回执 如 ALI-CORP-T1-01"
                  />
                  <button
                    type="button"
                    class="btn sm pri"
                    :disabled="!canFinance || !(receipts[row.entry_id] || '').trim() || busy"
                    @click="verify(row.entry_id)"
                  >
                    完成审批核实
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 4. 每台机器真实净成本汇总 -->
    <section class="card">
      <h3>
        📦 每台机器真实净成本表
        <small>真实净成本 = 原实付 − 已到账整单/部分退款 + 换配件维修费 + 支付宝对公直转卖家款</small>
      </h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>订单商品</th>
              <th class="num-r">原实付</th>
              <th class="num-r">已到账退款</th>
              <th class="num-r">支付宝对公直转款</th>
              <th class="num-r">真实净成本</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in g06List" :key="g.po_id">
              <td>
                <a v-if="caseOfPo(g.po_id)" :href="`#/case/${caseOfPo(g.po_id).case_id}`">
                  <b>{{ caseOfPo(g.po_id).title }} ›</b>
                </a>
                <b v-else>{{ g.po_id }}</b>
              </td>
              <td class="num-r">{{ fmtYuan(g.po_paid_cents) }}</td>
              <td class="num-r">{{ fmtYuan(g.refund_cents) }}</td>
              <td class="num-r">{{ fmtYuan((g.wechat_extra_cents || 0) + (g.pending_wechat_cents || 0)) }}</td>
              <td class="num-r"><b>{{ fmtYuan(g.net_cost_cents) }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { store, currentRole, setActor, callAction, notify } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from '../components/Q.vue';
import StatementReconcilePanel from '../components/StatementReconcilePanel.vue';

const busy = ref(false);
const receipts = reactive({ 'FIN-1002': 'ALI-CORP-20261117-1000' });
const targetYuanInput = ref(1000);

const role = computed(() => currentRole());
const canFinance = computed(() => ['finance', 'supervisor'].includes(role.value.role));
const corpRegs = computed(() => store.dashboard.corp_alipay_registrations || []);
const ledger = computed(() => store.dashboard.finance_ledger || []);
const sortedLedger = computed(() =>
  [...ledger.value].sort((a, b) => (a.status === 'verified' ? 1 : 0) - (b.status === 'verified' ? 1 : 0))
);
const pendingCount = computed(() => ledger.value.filter((x) => x.status !== 'verified').length);
const g06List = computed(() => store.dashboard.g06_net_costs || []);
const comms = computed(() => store.dashboard.commissions || []);
const earnings = computed(() => store.dashboard.daily_earnings || { daily_target_cents: 100000 });

watch(
  () => earnings.value.daily_target_cents,
  (v) => {
    if (v) targetYuanInput.value = Math.round(v / 100);
  },
  { immediate: true }
);

function caseOfPo(poId) {
  return (store.dashboard.cases || []).find((c) => c.po_id === poId);
}

function caseTitleById(cid) {
  return (store.dashboard.cases || []).find((c) => c.case_id === cid)?.title || '';
}

function statusLabel(st) {
  if (st === 'paid') return '✓ 已发放';
  if (st === 'confirmed') return '✓ 已确认待发';
  if (st === 'reversed') return '已全退冲回';
  return '预计（待T+1审批与入库）';
}

function switchFinance() {
  setActor('chenkj');
  notify('已切换为【陈会计】，现在可以填写支付宝对公电子回单完成次日 10:00 T+1 审批了');
}

async function saveDailyTarget() {
  busy.value = true;
  try {
    await callAction(
      '/api/earnings/target',
      { target_cents: Math.round(Number(targetYuanInput.value || 1000) * 100) },
      `已将个人单日预计提成目标更新为 ¥${targetYuanInput.value}`
    );
  } finally {
    busy.value = false;
  }
}

async function verify(entryId) {
  busy.value = true;
  try {
    await callAction(
      '/api/finance/verify-receipt',
      { entry_id: entryId, receipt_id: receipts[entryId].trim() },
      'T+1 账单审批与对公支付回执核实成功！单机真实净成本已同步更新'
    );
  } finally {
    busy.value = false;
  }
}

async function commAct(commId, action) {
  busy.value = true;
  try {
    await callAction(
      `/api/commissions/${commId}/action`,
      { action },
      action === 'reverse' ? '已按全额退货冲回提成' : '提成已确认发放！'
    );
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.earn-board {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 14px;
}
.eb-main {
  background: linear-gradient(135deg, #0f172a, #1e293b);
  color: #fff;
  border-radius: 18px;
  padding: 18px 20px;
  display: grid;
  gap: 8px;
}
.eb-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
}
.target-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.sm-in {
  width: 82px;
  min-height: 32px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.24);
}
.eb-nums {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.eb-nums > b {
  font-size: 30px;
  font-weight: 900;
  color: #ffda00;
}
.eb-formula {
  font-size: 12px;
  opacity: 0.86;
}
.eb-cols {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.eb-col {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px;
  display: grid;
  gap: 4px;
  align-content: center;
}
.eb-col span {
  font-size: 12px;
  color: var(--mute);
  font-weight: 700;
}
.eb-col b {
  font-size: 21px;
  font-weight: 900;
}
.eb-col small {
  font-size: 11.5px;
  color: var(--mute);
}
.acc-txt { color: var(--acc); }
.grn-txt { color: var(--grn); }

@media (max-width: 980px) {
  .earn-board { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .eb-cols { grid-template-columns: minmax(0, 1fr); }
}
</style>
