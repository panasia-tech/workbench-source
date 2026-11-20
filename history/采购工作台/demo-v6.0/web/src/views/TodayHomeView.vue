<template>
  <div v-if="dash">
    <div class="grid grid-4" data-tour="home-kpis" style="margin-bottom: 14px;">
      <div class="card">
        <div class="muted">今天采购的（买前 6 步）</div>
        <div class="kpi-num num" style="color: #1d4ed8;">{{ dash.counts.today }} 笔</div>
        <div class="muted">预算已锁定 {{ fmtYuan(dash.pool?.reserved_cents) }} / {{ fmtYuan(dash.pool?.total_budget_cents) }}</div>
      </div>
      <div class="card">
        <div class="muted">二次议价 · 问题订单（双轨 9 步）</div>
        <div class="kpi-num num" style="color: #dc2626;">{{ dash.counts.issue }} 笔</div>
        <div class="muted">待审 T+1 对公 {{ dash.pending_finance_count }} 笔</div>
      </div>
      <div class="card">
        <div class="muted">闲鱼监控融合引擎</div>
        <div class="kpi-num num" style="color: #0f766e;">{{ dash.monitor_stats.active_tasks_count }} 任务 / {{ dash.monitor_stats.hits_count }} 命中</div>
        <div class="muted"><router-link to="/monitor">进入监控捡漏中心 →</router-link></div>
      </div>
      <div class="card">
        <div class="muted">两段各 10% 独立提成战果</div>
        <div class="kpi-num num" style="color: #059669;">
          {{ fmtYuan(dash.commission_summary.pre_confirmed_cents + dash.commission_summary.post_confirmed_cents) }}
        </div>
        <div class="muted">
          买前确认 {{ fmtYuan(dash.commission_summary.pre_confirmed_cents) }} + 到货待转 {{ fmtYuan(dash.commission_summary.post_estimated_cents) }}
        </div>
      </div>
    </div>

    <div style="margin-bottom: 14px;">
      <StatementReconcileBar @updated="loadDash" />
    </div>

    <div class="grid grid-2" style="margin-bottom: 14px;">
      <div class="card" data-tour="home-accounts">
        <div class="card-header">
          <h3 class="card-title">🛡 闲鱼账号 5% 退款/纠纷红标防护雷达</h3>
          <router-link to="/accounts" class="btn btn-sm">账号与 1+3 专窗 →</router-link>
        </div>
        <div style="display: flex; flex-direction: column; gap: 9px;">
          <div
            v-for="a in dash.accounts"
            :key="a.id"
            style="border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;"
            :style="a.risk_level === 'amb' || a.risk_level === 'red' ? 'background: #fffbeb; border-color: #fcd34d;' : 'background: #f8fafc;'"
          >
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>{{ a.account_name }}</strong>
                <span class="muted" style="margin-left: 6px;">{{ a.window_role }}</span>
              </div>
              <span class="tag" :class="a.risk_level">{{ a.status_badge }}</span>
            </div>
            <div class="muted" style="margin-top: 4px;">
              近30天 {{ a.rolling_30d_orders }} 单 · 退款 {{ a.rolling_30d_refunds }}（<strong class="num">{{ a.refund_rate_pct }}%</strong>）· 纠纷 {{ a.rolling_30d_disputes }}（<strong class="num">{{ a.dispute_rate_pct }}%</strong>）
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🪟 1+3 专窗后台执行脉搏</h3>
          <button class="btn btn-sm" @click="openVideoTutorial('ch6', 105.29)">▶ 看 10m 验机与派送盯梢讲解</button>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div
            v-for="j in dash.executor_jobs"
            :key="j.job_id"
            style="border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; background: #f8fafc;"
          >
            <div style="display: flex; justify-content: space-between;">
              <strong style="font-size: 13px;">{{ j.window_name }} · {{ j.account_name }}</strong>
              <span class="tag" :class="j.status === 'triggered_10m_sla' ? 'red' : 'grn'">{{ j.status }}</span>
            </div>
            <div class="muted" style="margin-top: 3px;">{{ j.detail }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🔥 急需跟进采购与二次议价订单（点单号进全流程驾驶舱）</h3>
        <router-link to="/cases" class="btn btn-sm btn-primary">查看全部订单 →</router-link>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>优先级 / 订单号</th>
              <th>机型与情况摘要</th>
              <th>绑定账号</th>
              <th>目标 / 实付</th>
              <th>当前所处节点</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in dash.urgent_cases" :key="c.case_id">
              <td>
                <span class="tag" :class="c.lvl">{{ c.order_bucket === 'today' ? '今天采购' : '二次议价' }}</span>
                <div class="num" style="margin-top: 2px;"><strong>{{ c.case_id }}</strong></div>
              </td>
              <td>
                <div><strong>{{ c.title }}</strong></div>
                <div class="muted">{{ c.warehouse_defect_note || c.prebuy_note }}</div>
              </td>
              <td>{{ c.account_id }} / {{ c.seller_nick }}</td>
              <td class="num">
                M {{ fmtYuan(c.ref_cents) }}<br />
                实付 {{ c.paid_cents ? fmtYuan(c.paid_cents) : '未付' }}
              </td>
              <td>
                <span class="tag slate">{{ c.order_bucket === 'today' ? `买前第 ${c.prebuy_step} 步` : '到货挽损跟进' }}</span>
              </td>
              <td>
                <router-link :to="`/cases/${c.case_id}`" class="btn btn-sm btn-primary">进入办理</router-link>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { fmtYuan, handleApiError, openVideoTutorial } from '../store/store.js';
import StatementReconcileBar from '../components/StatementReconcileBar.vue';

const dash = ref(null);
async function loadDash() {
  try {
    const res = await apiRequest('/api/dashboard');
    dash.value = res.data;
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(loadDash);
</script>
