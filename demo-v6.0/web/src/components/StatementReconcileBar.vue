<template>
  <div class="card" data-tour="home-reconcile" style="border-left: 4px solid #1d4ed8;">
    <div class="card-header">
      <div>
        <h3 class="card-title">📊 次日 10:00 前昨日财务对账单（自动推送核漏 · 已去除人工上传）</h3>
        <div class="muted" v-if="data?.batch">
          {{ data.batch.title }} · <strong style="color: #0f766e;">{{ data.batch.sync_source_label }}</strong>
        </div>
      </div>
      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <span class="tag red num" v-if="pendingCount > 0">⚠ 还有 {{ pendingCount }} 条异常待消</span>
        <span class="tag grn" v-else>✓ 昨日账单已全部抓齐核平</span>
        <button class="btn btn-sm" :disabled="busy" @click="syncStatement">🔄 立即同步昨日账单</button>
        <button
          class="btn btn-sm btn-primary"
          :disabled="busy || data?.batch?.status === 'signed_off'"
          @click="signoffBatch"
        >
          {{ data?.batch?.status === 'signed_off' ? '✓ 已签收完结' : '✍ 会计签收昨日对账单' }}
        </button>
      </div>
    </div>

    <div class="table-wrap" v-if="data?.items?.length">
      <table>
        <thead>
          <tr>
            <th>对账流水号 / 时间</th>
            <th>闲鱼账号 / 平台单号</th>
            <th>商品摘要</th>
            <th>财务实扣</th>
            <th>工作台账面</th>
            <th>差异核查与防漏抓动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="st in data.items" :key="st.item_id" :style="st.resolution_state === 'pending' ? 'background: #fff7ed;' : ''">
            <td>
              <div class="num"><strong>{{ st.alipay_tx_no }}</strong></div>
              <div class="muted">{{ st.paid_at_label }}</div>
            </td>
            <td>
              <div>{{ st.account_name }} · {{ st.seller_nick }}</div>
              <div class="muted num">{{ st.external_order_no }}</div>
            </td>
            <td style="max-width: 240px;">{{ st.item_title }}</td>
            <td class="num"><strong>{{ fmtYuan(st.statement_amount_cents) }}</strong></td>
            <td class="num">{{ st.system_amount_cents != null ? fmtYuan(st.system_amount_cents) : '— 漏单无记录 —' }}</td>
            <td>
              <div v-if="st.resolution_state === 'pending'" style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                <span class="tag red" v-if="st.diff_type === 'missing_order'">🚨 系统漏抓单</span>
                <span class="tag amb" v-else-if="st.diff_type === 'amount_diff'">⚠ 金额差额</span>
                <button
                  v-if="st.diff_type === 'missing_order'"
                  class="btn btn-sm btn-danger"
                  :disabled="busy"
                  @click="resolveItem(st.item_id, 'backfill_missing')"
                >
                  ⚡ 一键补抓生成采购单
                </button>
                <button
                  v-else-if="st.diff_type === 'amount_diff'"
                  class="btn btn-sm btn-amber"
                  :disabled="busy"
                  @click="resolveItem(st.item_id, 'confirm_amount_diff')"
                >
                  ✓ 核平保价差额
                </button>
                <button class="btn btn-sm" :disabled="busy" @click="resolveItem(st.item_id, 'ignore_non_po')">标非采购忽略</button>
              </div>
              <div v-else style="display: flex; gap: 6px; align-items: center;">
                <span class="tag grn">✓ {{ statusLabel(st.resolution_state) }}</span>
                <router-link v-if="st.linked_case_id" :to="`/cases/${st.linked_case_id}`" class="btn btn-sm">查看 {{ st.linked_case_id }}</router-link>
              </div>
              <div class="muted" style="margin-top: 2px;">{{ st.note }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { apiRequest } from '../api/client.js';
import { pushToast, handleApiError, fmtYuan, refreshGlobalSummary } from '../store/store.js';

const emit = defineEmits(['updated']);
const data = ref(null);
const busy = ref(false);
const pendingCount = computed(() => (data.value?.items || []).filter((i) => i.resolution_state === 'pending').length);

function statusLabel(s) {
  if (s === 'auto') return '自动核对一致';
  if (s === 'backfilled') return '已补抓生成采购单';
  if (s === 'amount_adjusted') return '已确认差额调平';
  if (s === 'ignored_non_po') return '已标非采购单';
  return s;
}

async function load() {
  try {
    const res = await apiRequest('/api/reconcile');
    data.value = res.data;
  } catch (err) {
    handleApiError(err);
  }
}

async function syncStatement() {
  busy.value = true;
  try {
    const res = await apiRequest('/api/reconcile/sync', { method: 'POST' });
    data.value = res.data;
    pushToast('昨日全天财务对账单已从自动接口重新拉取校验', 'info');
    emit('updated');
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function resolveItem(itemId, action) {
  busy.value = true;
  try {
    const res = await apiRequest(`/api/reconcile/items/${encodeURIComponent(itemId)}/resolve`, {
      method: 'POST',
      body: { action },
    });
    data.value = res.data;
    await refreshGlobalSummary();
    pushToast(action === 'backfill_missing' ? '已一键补抓生成正式采购单并推仓管重点深检！' : '差额已核平入账', 'info');
    emit('updated');
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

async function signoffBatch() {
  if (!data.value?.batch?.batch_id) return;
  busy.value = true;
  try {
    const res = await apiRequest(`/api/reconcile/batches/${encodeURIComponent(data.value.batch.batch_id)}/signoff`, {
      method: 'POST',
    });
    data.value = res.data;
    await refreshGlobalSummary();
    pushToast('昨日对账单已由会计核签完结！', 'info');
    emit('updated');
  } catch (err) {
    handleApiError(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>
