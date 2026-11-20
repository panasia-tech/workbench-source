<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'
import AuthLinkDialog from './AuthLinkDialog.vue'

const isDesktop = useDesktop()

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const yesterday = new Date(Date.now() - 86400000)
const range = ref([ymd(new Date(yesterday.getTime() - 6 * 86400000)), ymd(yesterday)])

const list = ref([])
const loading = ref(false)
const current = ref(null) // 正在看的支付宝明细
const fetching = ref(false)
const authDlg = ref(null)

const flows = ref({}) // 流水分类：卖货进账、平台服务费、提现……
async function loadFlows() {
  try {
    flows.value = (await api.get('/ledger/options')).data.flows || {}
  } catch {
    /* 下拉缺了不挡看对账 */
  }
}
loadFlows()

async function setFlow(b, flow) {
  try {
    const { data } = await api.post(`/ledger/bills/${b.id}/flow`, { flow })
    Object.assign(b, data)
  } catch (err) {
    ElMessage.error(errText(err, '改分类失败'))
  }
}

const MATCH = { order_no: '订单号对上', amount: '金额对上', approx: '金额差一点（扣了服务费）', noshop: '金额对上（这件货没记在哪家店卖的）' }

function params() {
  return { start: range.value[0], end: range.value[1] }
}

async function load() {
  loading.value = true
  try {
    list.value = (await api.get('/ledger/reconcile', { params: params() })).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function openOne(a) {
  try {
    current.value = (await api.get(`/ledger/reconcile/${a.alipay_id}`, { params: params() })).data
  } catch (err) {
    ElMessage.error(errText(err, '打不开'))
  }
}

async function fetchNow() {
  fetching.value = true
  try {
    const { data } = await api.post(`/ledger/reconcile/${current.value.alipay_id}/fetch`, null, { params: params() })
    if (data.errors.length) ElMessage.warning(`有 ${data.error} 天没拉到：${data.errors[0]}`)
    else ElMessage.success(`拉好了：${data.ok} 天有流水，${data.empty} 天没流水`)
    await openOne({ alipay_id: current.value.alipay_id })
  } catch (err) {
    ElMessage.error(errText(err, '拉账单失败'))
  } finally {
    fetching.value = false
  }
}

// ---- 电脑上的汇总和筛选 ----
const AUTH_TYPE = { none: 'info', authorized: 'success', expired: 'danger', error: 'danger' }
const onlyMiss = ref(false) // 流水只看没对上的进账

const totals = computed(() => {
  const ok = list.value.filter((a) => a.auth_status === 'authorized')
  return {
    all: list.value.length,
    authorized: ok.length,
    income: ok.reduce((n, a) => n + Number(a.income_total || 0), 0).toFixed(2),
    matched: ok.reduce((n, a) => n + (a.matched_count || 0), 0),
    unmatched: ok.reduce((n, a) => n + (a.unmatched_count || 0), 0),
    problems: list.value.filter((a) => a.auth_status !== 'authorized' || a.fetch_errors.length || !a.shops).length,
  }
})

const bills = computed(() => {
  const all = current.value?.bills || []
  return onlyMiss.value ? all.filter((b) => Number(b.income) > 0 && !b.order) : all
})

const billMissCount = computed(() => (current.value?.bills || []).filter((b) => Number(b.income) > 0 && !b.order).length)

function back() {
  current.value = null
  load()
}

function onRange() {
  if (current.value) openOne({ alipay_id: current.value.alipay_id })
  else load()
}

onMounted(load)
</script>

<template>
  <!-- 电脑：总览一张表（一行一个支付宝），点进去左右两张表：没见到进账的单 | 支付宝流水 -->
  <template v-if="isDesktop">
    <div v-if="current">
      <div class="lgd-card">
        <div class="lgd-card__head">
          <div class="d-head">
            <a class="lgd-back" @click="back">‹ 对账总览</a>
            <el-divider direction="vertical" />
            <b class="d-head__name">{{ current.account }}</b>
            <span class="lgd-muted">对的是这几家店的销售单：{{ current.shop_names.join('、') || '没挂店铺，对不了' }}</span>
          </div>
          <div class="lgd-toolbar">
            <el-date-picker
              v-model="range"
              type="daterange"
              value-format="YYYY-MM-DD"
              range-separator="到"
              :clearable="false"
              style="width: 260px"
              @change="onRange"
            />
            <el-button :loading="fetching" :disabled="current.auth_status !== 'authorized'" @click="fetchNow">现在拉这几天的账单</el-button>
          </div>
        </div>
      </div>

      <div class="d-cols">
        <div class="lgd-card">
          <div class="lgd-card__head">
            <h3 class="lgd-card__title">卖了还没见到进账的单 <small>{{ current.orders_without_income.length }}</small></h3>
          </div>
          <div class="lgd-card__body--table">
            <el-table :data="current.orders_without_income" size="small" stripe empty-text="没有">
              <el-table-column label="商品 / 单号" min-width="140">
                <template #default="{ row }">
                  {{ row.product_title || row.order_no }}
                  <div v-if="row.external_order_no" class="lgd-muted lgd-num">{{ row.external_order_no }}</div>
                </template>
              </el-table-column>
              <el-table-column label="店铺 / 下单时间" min-width="130">
                <template #default="{ row }">
                  {{ row.shop_name }}
                  <div class="lgd-muted">{{ row.created_at }}</div>
                </template>
              </el-table-column>
              <el-table-column label="金额" width="96" align="right">
                <template #default="{ row }"><b class="lgd-num">¥{{ row.amount }}</b></template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <div class="lgd-card">
          <div class="lgd-card__head">
            <h3 class="lgd-card__title">支付宝流水 <small>{{ current.bills.length }} 笔<template v-if="billMissCount"> · <span class="lgd-danger">{{ billMissCount }} 笔进账没对上</span></template></small></h3>
            <el-checkbox v-model="onlyMiss">只看没对上的进账</el-checkbox>
          </div>
          <div class="lgd-card__body--table">
            <el-table :data="bills" size="small" stripe :empty-text="current.bills.length ? '没有' : '这几天没拉到流水'">
              <el-table-column label="时间" prop="occurred_at" width="130" />
              <el-table-column label="名目 / 对方" min-width="170">
                <template #default="{ row }">
                  {{ row.item_name || row.biz_type || '—' }}
                  <div v-if="row.counterparty" class="lgd-muted">{{ row.counterparty }}</div>
                </template>
              </el-table-column>
              <el-table-column label="是什么钱" width="130">
                <template #default="{ row }">
                  <el-select :model-value="row.flow" size="small" placeholder="没分类" @change="(v) => setFlow(row, v)">
                    <el-option v-for="(label, k) in flows" :key="k" :label="label" :value="k" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="金额" width="100" align="right">
                <template #default="{ row }">
                  <b v-if="Number(row.income) > 0" class="lgd-ok lgd-num">+{{ row.income }}</b>
                  <b v-else class="lgd-muted lgd-num">-{{ row.expense }}</b>
                </template>
              </el-table-column>
              <el-table-column label="对上 ERP 的单" min-width="200">
                <template #default="{ row }">
                  <template v-if="Number(row.income) > 0">
                    <span v-if="row.order" class="lgd-ok">{{ MATCH[row.match_how] }}：{{ row.order.product_title || row.order.order_no }}（¥{{ row.order.amount }}）</span>
                    <span v-else class="lgd-danger">没对上 ERP 的单</span>
                  </template>
                  <span v-else class="lgd-muted">支出</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="lgd-card">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">
          支付宝 <small>{{ totals.all }} 个 · 已授权 {{ totals.authorized }} 个 · 进账 ¥{{ totals.income }} · 对上 {{ totals.matched }} 笔 ·
            <span :class="{ 'lgd-danger': totals.unmatched }">没对上 {{ totals.unmatched }} 笔</span></small>
        </h3>
        <div class="lgd-toolbar">
          <el-date-picker
            v-model="range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="到"
            :clearable="false"
            style="width: 260px"
            @change="onRange"
          />
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
      <div class="lgd-card__body--table">
        <el-table v-loading="loading" :data="list" stripe empty-text="台账里还没有支付宝" class="d-table" @row-click="openOne">
          <el-table-column label="支付宝" min-width="150">
            <template #default="{ row }">
              <b>{{ row.account }}</b>
              <div v-if="row.alias" class="lgd-muted">{{ row.alias }}</div>
            </template>
          </el-table-column>
          <el-table-column label="法人 / 主体" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.legal_person_name }}
              <div class="lgd-muted">{{ row.entity_name }}</div>
            </template>
          </el-table-column>
          <el-table-column label="授权" width="96">
            <template #default="{ row }">
              <el-tag size="small" :type="AUTH_TYPE[row.auth_status] || 'info'">{{ row.auth_label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="拉到" width="70" align="right">
            <template #default="{ row }"><span v-if="row.auth_status === 'authorized'">{{ row.days_fetched }} 天</span></template>
          </el-table-column>
          <el-table-column label="进账" width="120" align="right">
            <template #default="{ row }"><span v-if="row.auth_status === 'authorized'" class="lgd-num">¥{{ row.income_total }}</span></template>
          </el-table-column>
          <el-table-column label="对上" width="70" align="right">
            <template #default="{ row }"><span v-if="row.auth_status === 'authorized'">{{ row.matched_count }} 笔</span></template>
          </el-table-column>
          <el-table-column label="没对上" width="80" align="right">
            <template #default="{ row }">
              <span v-if="row.auth_status === 'authorized'" :class="{ 'lgd-danger': row.unmatched_count }">{{ row.unmatched_count }} 笔</span>
            </template>
          </el-table-column>
          <el-table-column label="要处理的" min-width="200">
            <template #default="{ row }">
              <div v-if="row.auth_status !== 'authorized' && row.auth_error" class="lgd-danger">{{ row.auth_error }}</div>
              <div v-if="row.fetch_errors.length" class="lgd-danger">有 {{ row.fetch_errors.length }} 天没拉到账单：{{ row.fetch_errors[0].error }}</div>
              <div v-if="row.auth_status === 'authorized' && !row.shops" class="lg-warn">还没挂店铺，进账没法对</div>
            </template>
          </el-table-column>
          <el-table-column label="" width="150" align="center" fixed="right">
            <template #default="{ row }">
              <el-button v-if="row.auth_status !== 'authorized'" link type="primary" @click.stop="authDlg.open(row.alipay_id, row.account)">授权对账</el-button>
              <el-button link type="primary" @click.stop="openOne(row)">明细</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </template>

  <!-- 手机：原样 -->
  <template v-else>
    <div class="lg-card rc-range">
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="到"
        :clearable="false"
        style="width: 100%"
        @change="onRange"
      />
    </div>

    <!-- 一个支付宝的明细 -->
    <div v-if="current">
      <div class="lg-row" style="margin-bottom: 10px">
        <a class="rc-back" @click="back">‹ 返回</a>
        <el-button size="small" :loading="fetching" :disabled="current.auth_status !== 'authorized'" @click="fetchNow">现在拉这几天的账单</el-button>
      </div>
      <div class="lg-card">
        <b>{{ current.account }}</b>
        <div class="lg-muted">对的是这几家店的销售单：{{ current.shop_names.join('、') || '没挂店铺，对不了' }}</div>
      </div>

      <div class="lg-section">卖了还没见到进账的单（{{ current.orders_without_income.length }}）</div>
      <div v-if="!current.orders_without_income.length" class="lg-card lg-muted">没有</div>
      <div v-for="o in current.orders_without_income" :key="o.id" class="lg-card rc-line">
        <div class="lg-row">
          <span>{{ o.product_title || o.order_no }}</span>
          <b>¥{{ o.amount }}</b>
        </div>
        <div class="lg-muted">{{ o.shop_name }} · {{ o.created_at }}<span v-if="o.external_order_no"> · {{ o.external_order_no }}</span></div>
      </div>

      <div class="lg-section">支付宝流水（{{ current.bills.length }}）</div>
      <div v-if="!current.bills.length" class="lg-card lg-muted">这几天没拉到流水</div>
      <div v-for="b in current.bills" :key="b.flow_no" class="lg-card rc-line">
        <div class="lg-row">
          <span>{{ b.item_name || b.biz_type || '—' }}</span>
          <b v-if="Number(b.income) > 0" class="rc-in">+{{ b.income }}</b>
          <b v-else class="rc-out">-{{ b.expense }}</b>
        </div>
        <div class="lg-muted">{{ b.occurred_at }}<span v-if="b.counterparty"> · {{ b.counterparty }}</span> · {{ b.flow_label }}</div>
        <div v-if="Number(b.income) > 0" :class="b.order ? 'rc-ok' : 'rc-miss'">
          <template v-if="b.order">{{ MATCH[b.match_how] }}：{{ b.order.product_title || b.order.order_no }}（¥{{ b.order.amount }}）</template>
          <template v-else>没对上 ERP 的单</template>
        </div>
      </div>
    </div>

    <!-- 总览 -->
    <div v-else v-loading="loading">
      <div v-if="!list.length && !loading" class="lg-card lg-muted">台账里还没有支付宝</div>
      <div v-for="a in list" :key="a.alipay_id" class="lg-card rc-item" @click="openOne(a)">
        <div class="lg-row">
          <div>
            <b>{{ a.account }}</b>
            <div class="lg-muted">{{ a.legal_person_name }} · {{ a.entity_name }}</div>
          </div>
          <span :class="['rc-auth', 'rc-auth--' + a.auth_status]">{{ a.auth_label }}</span>
        </div>
        <div v-if="a.auth_status === 'authorized'" class="rc-nums">
          <span>进账 ¥{{ a.income_total }}</span>
          <span>对上 {{ a.matched_count }} 笔</span>
          <span :class="{ 'rc-miss': a.unmatched_count }">没对上 {{ a.unmatched_count }} 笔</span>
        </div>
        <div v-else-if="a.auth_error" class="rc-miss">{{ a.auth_error }}</div>
        <div v-if="a.fetch_errors.length" class="rc-miss">有 {{ a.fetch_errors.length }} 天没拉到账单：{{ a.fetch_errors[0].error }}</div>
        <div v-if="a.auth_status === 'authorized' && !a.shops" class="lg-warn">还没挂店铺，进账没法对</div>
        <el-button v-if="a.auth_status !== 'authorized'" size="small" type="primary" plain class="rc-auth-btn" @click.stop="authDlg.open(a.alipay_id, a.account)">授权对账</el-button>
      </div>
    </div>
  </template>
  <AuthLinkDialog ref="authDlg" />
</template>

<style scoped>
.d-head { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.d-head__name { font-size: 16px; }
.d-cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 16px; align-items: start; }
.d-table :deep(.el-table__row) { cursor: pointer; }
.rc-range { padding: 10px; }
.rc-range :deep(.el-date-editor) { width: 100% !important; box-sizing: border-box; }
.rc-back { color: var(--lg-accent); cursor: pointer; font-size: 15px; }
.rc-item { cursor: pointer; }
.rc-line { padding: 10px 14px; margin-bottom: 8px; }
.rc-nums { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 14px; }
.rc-in { color: #047857; }
.rc-out { color: var(--lg-ink-2); }
.rc-ok { margin-top: 4px; font-size: 13px; color: #047857; }
.rc-miss { margin-top: 4px; font-size: 13px; color: var(--lg-danger); }
.rc-auth-btn { margin-top: 8px; }
.rc-auth { flex-shrink: 0; font-size: 12px; padding: 2px 8px; border-radius: 4px; background: #f3f4f6; color: var(--lg-ink-2); }
.rc-auth--authorized { background: #ecfdf5; color: #047857; }
.rc-auth--expired, .rc-auth--error { background: #fef2f2; color: var(--lg-danger); }
</style>
