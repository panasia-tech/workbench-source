<template>
  <div>
    <div class="banner amb" style="margin-bottom: 14px;">
      <div>
        <strong>🛡 平台红线硬规则：近 30 天退款率 / 纠纷率严禁超过 5.0%（达 ≥3.8% 黄色预警 · 再退 1 单破 5% 禁止接高危秒拍）</strong>
        <div class="muted" style="color: #92400e;">所有监控自动锁定、IM 议价和 1+3 专窗任务均与下方真实号池实时校验。</div>
      </div>
    </div>

    <div class="grid grid-3" style="margin-bottom: 16px;">
      <div
        v-for="a in accounts"
        :key="a.id"
        class="card"
        :style="a.risk_level === 'grn' ? 'border-top: 4px solid #059669;' : 'border-top: 4px solid #d97706;'"
      >
        <div class="card-header" style="margin-bottom: 6px;">
          <div>
            <strong>{{ a.account_name }}</strong>
            <div class="muted">{{ a.nickname }} · {{ a.window_role }}</div>
          </div>
          <span class="tag" :class="a.risk_level">{{ a.status_badge }}</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; background: #f8fafc; padding: 10px; border-radius: 8px;">
          <div>
            <div class="muted">30天总成单</div>
            <div class="kpi-num num" style="font-size: 19px;">{{ a.rolling_30d_orders }} 单</div>
          </div>
          <div>
            <div class="muted">距 5% 红标安全余量</div>
            <div class="kpi-num num" style="font-size: 19px;" :style="a.remaining_refund_quota <= 0 ? 'color: #dc2626;' : 'color: #059669;'">
              {{ a.remaining_refund_quota }} 单
            </div>
          </div>
          <div>
            <div class="muted">退款率（30d: {{ a.rolling_30d_refunds }}）</div>
            <strong class="num" :style="a.refund_rate_pct >= 3.8 ? 'color: #dc2626;' : ''">{{ a.refund_rate_pct }}%</strong>
          </div>
          <div>
            <div class="muted">纠纷率（30d: {{ a.rolling_30d_disputes }}）</div>
            <strong class="num">{{ a.dispute_rate_pct }}%</strong>
          </div>
        </div>

        <div class="muted" style="margin-bottom: 8px;">{{ a.window_desc }}</div>
        <div style="display: flex; gap: 6px;">
          <input v-model="cookieInputs[a.id]" class="input" placeholder="绑定/刷新桌面端 MTOP Cookie" />
          <button class="btn btn-sm btn-primary" @click="saveCookie(a.id)">保存</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">🪟 1 + 3 专窗调度架构（1 前台人工监督窗 + 3 后台自动执行窗）</h3>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>专窗编号 / 名称</th>
              <th>绑定闲鱼号</th>
              <th>作业类型</th>
              <th>当前目标</th>
              <th>状态与执行流水</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in jobs" :key="j.job_id">
              <td><strong>{{ j.window_name }}</strong><div class="muted">{{ j.window_id }}</div></td>
              <td>{{ j.account_name }}</td>
              <td><code>{{ j.job_type }}</code></td>
              <td class="num">{{ j.target_ref }}</td>
              <td>
                <span class="tag" :class="j.status === 'triggered_10m_sla' ? 'red' : 'grn'">{{ j.status }}</span>
                <div class="muted" style="margin-top: 2px;">{{ j.detail }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { apiRequest } from '../api/client.js';
import { pushToast, handleApiError } from '../store/store.js';

const accounts = ref([]);
const jobs = ref([]);
const cookieInputs = reactive({});

async function load() {
  try {
    const res = await apiRequest('/api/accounts');
    accounts.value = res.accounts || [];
    jobs.value = res.executor_jobs || [];
  } catch (err) {
    handleApiError(err);
  }
}

async function saveCookie(id) {
  try {
    await apiRequest(`/api/accounts/${encodeURIComponent(id)}/cookie`, {
      method: 'POST',
      body: { mtop_cookie: cookieInputs[id] || '' },
    });
    pushToast('MTOP 凭证已加密更新并同步至监控池', 'info');
    cookieInputs[id] = '';
  } catch (err) {
    handleApiError(err);
  }
}

onMounted(load);
</script>
