<template>
  <div>
    <div class="tabs" data-tour="cases-filter">
      <button class="tab-btn" :class="{ active: bucket === 'all' }" @click="setBucket('all')">全部订单 ({{ allCount }})</button>
      <button class="tab-btn" :class="{ active: bucket === 'today' }" @click="setBucket('today')">今天采购的（买前 6 步）</button>
      <button class="tab-btn" :class="{ active: bucket === 'issue' }" @click="setBucket('issue')">到货二次议价 · 问题订单（双轨 9 步）</button>
      <button class="tab-btn" :class="{ active: bucket === 'done' }" @click="setBucket('done')">已完结 · 钱货双清</button>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>单号 / 分区</th>
              <th>机型与实况描述</th>
              <th>绑定账号 / 卖家</th>
              <th>四维价格与实付</th>
              <th>当前流程节点 / 95338 状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in filtered" :key="c.case_id">
              <td>
                <span class="tag" :class="c.lvl">{{ c.order_bucket === 'today' ? '今天采购' : c.order_bucket === 'issue' ? '问题议价' : '已完结' }}</span>
                <div class="num" style="margin-top: 3px;"><strong>{{ c.case_id }}</strong></div>
              </td>
              <td style="max-width: 340px;">
                <div><strong>{{ c.title }}</strong></div>
                <div class="muted">{{ c.warehouse_defect_note || c.prebuy_note }}</div>
              </td>
              <td>
                <div>{{ c.account_id }}</div>
                <div class="muted">{{ c.seller_nick }}</div>
              </td>
              <td class="num">
                <div>参考 M {{ fmtYuan(c.ref_cents) }} / 上限 {{ fmtYuan(c.ceiling_cents) }}</div>
                <div><strong>实付 {{ c.paid_cents ? fmtYuan(c.paid_cents) : (c.agreed_cents ? `谈妥 ${fmtYuan(c.agreed_cents)}` : '议价中') }}</strong></div>
              </td>
              <td>
                <span v-if="c.order_bucket === 'today'" class="tag blue">买前第 {{ c.prebuy_step }} / 6 步</span>
                <div v-else-if="c.ticket_id" style="display: flex; flex-direction: column; gap: 3px;">
                  <span class="tag amb">
                    {{ c.arrival_track === 'signed_platform_return' ? '已签收走平台退' : '顺丰站点拒签' }} · 第 {{ c.aftersales_step }}/9 步
                  </span>
                  <span v-if="c.sf_95338_status === 'requested'" class="tag red">🚨 95338 已打退回·锁入库</span>
                  <span v-if="c.agreed_reduction_cents" class="tag grn num">已谈降 {{ fmtYuan(c.agreed_reduction_cents) }}</span>
                </div>
                <span v-else class="tag grn">入库完结</span>
              </td>
              <td>
                <router-link :to="`/cases/${c.case_id}`" class="btn btn-sm btn-primary">进入办理 →</router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError } from '../store/store.js';

const cases = ref([]);
const bucket = ref('all');
const allCount = computed(() => cases.value.length);
const filtered = computed(() => (bucket.value === 'all' ? cases.value : cases.value.filter((c) => c.order_bucket === bucket.value)));

function setBucket(b) {
  bucket.value = b;
}

async function load() {
  try {
    const res = await apiRequest('/api/cases?bucket=all');
    cases.value = res.cases || [];
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
