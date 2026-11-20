<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>寻源监听去重 & 1前台+3后台专窗队列</h1>
        <p class="page-sub">
          独立监听端推送商品链接自动防撞单去重；<b>1个前台监督主窗 + 3个后台专责执行窗</b>（后台窗 #3 专盯顺丰进入「派送中」秒推赵仓管 10 分钟极速验货）。
        </p>
      </div>
      <div class="page-acts">
        <Q k="windows" label="专窗架构规矩" />
      </div>
    </header>

    <!-- 1. 1前台 + 3后台 专窗矩阵卡片 -->
    <section class="win-grid" style="margin-bottom: 16px">
      <article
        v-for="w in windows"
        :key="w.window_id"
        class="card win-card"
        :class="{ sf: w.window_id === 'WIN-BG-03', fg: w.window_id === 'WIN-FG-01' }"
      >
        <div class="wc-top">
          <span class="mono win-code">{{ w.window_id }}</span>
          <span class="tag" :class="w.window_id === 'WIN-BG-03' ? 'red' : 'acc'">{{ w.bound_account }}</span>
        </div>
        <h4>{{ w.role_mode }}</h4>
        <p class="wc-task">{{ w.current_task }}</p>
        <div class="wc-foot">
          <span class="tag grn">● 运行正常</span>
          <small class="muted">{{ w.boundary_note }}</small>
        </div>
      </article>
    </section>

    <!-- 2. 双栏工作区：左「独立监听端商品投递与线索池」 | 右「后台执行器任务队列 (executor_jobs)」 -->
    <div class="split-2" style="margin-bottom: 18px">
      <!-- 左：独立监听端商品链接投递去重台 -->
      <section class="card">
        <div class="sec-hd">
          <div>
            <h3>📡 独立监听端 · 新上架链接幂等投递台</h3>
            <small class="muted">按 <code>platform + product_id + account_id</code> 自动去重，防同一卖家被连轰两次首报</small>
          </div>
        </div>

        <div class="ingest-form">
          <div class="form-row">
            <label>
              <span>闲鱼商品 ID</span>
              <input v-model="ingestForm.product_id" class="input" placeholder="如 GF-8899102" />
            </label>
            <label>
              <span>识别机型</span>
              <select v-model="ingestForm.model_code" class="input">
                <option value="IP15P-256-NAT">iPhone 15 Pro 256G</option>
                <option value="SONY-A7M4-BODY">Sony A7M4 单机身</option>
                <option value="MBP14-M3-16-512">MacBook Pro 14 M3</option>
                <option value="ASUS-VG27AQML1A">华硕 TUF 27寸 2K</option>
              </select>
            </label>
          </div>
          <div class="form-row">
            <label>
              <span>商品标题</span>
              <input v-model="ingestForm.title" class="input" placeholder="卖家商品标题" />
            </label>
            <label>
              <span>卖家挂价 (元)</span>
              <input v-model.number="ingestForm.price_yuan" type="number" class="input" />
            </label>
          </div>
          <label class="chk-line">
            <input v-model="ingestForm.spec_conflict" type="checkbox" />
            <span>模拟「标题单机身 vs 正文套机头」规格冲突（自动拦截首报转人工待核）</span>
          </label>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button type="button" class="btn sm pri" :disabled="busy" @click="submitIngest">
              🚀 投递链接并派发后台窗 #1 首报任务
            </button>
            <button type="button" class="btn sm" :disabled="busy" @click="testDedup">
              🔁 重发已存在 ID（验证防撞单去重）
            </button>
          </div>
        </div>

        <div class="sub-lbl">当前寻源线索池（{{ leads.length }} 条）</div>
        <div class="lead-list">
          <div v-for="ld in leads" :key="ld.lead_id" class="lead-row">
            <div>
              <span class="mono muted" style="font-size: 11.5px">{{ ld.product_id }}</span>
              <b style="margin-left: 6px">{{ ld.title }}</b>
              <div class="muted" style="font-size: 12px">
                卖家：{{ ld.seller_name }} · 挂价 {{ fmtYuan(ld.seller_price_cents) }} · 参考 {{ fmtYuan(ld.ref_price_cents) }}
              </div>
            </div>
            <div>
              <a v-if="ld.conversation_id" href="#/im-sandbox" class="btn sm" @click="pickConv(ld.conversation_id)">
                已开聊 ›
              </a>
              <button v-else type="button" class="btn sm pri" :disabled="busy" @click="promoteLead(ld.lead_id)">
                转入会话陪谈
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 右：后台执行器任务队列 (executor_jobs) -->
      <section class="card">
        <div class="sec-hd">
          <div>
            <h3>⚙️ 后台执行器任务队列 & 顺丰派送盯梢回执</h3>
            <small class="muted">预置标准接口 <code>GET /api/executor/jobs</code> & <code>POST /api/executor/jobs/ack</code> 随时挂载真实 RPA</small>
          </div>
        </div>

        <div class="job-list">
          <div v-for="jb in jobs" :key="jb.job_id" class="job-row">
            <div class="jb-top">
              <div>
                <span class="tag acc">{{ jb.window_id }}</span>
                <b style="margin-left: 6px">{{ jobTypeLabel(jb.job_type) }}</b>
                <code class="mono" style="margin-left: 6px; font-size: 11.5px">{{ jb.product_id || jb.conv_id }}</code>
              </div>
              <span class="tag" :class="jobStatusCls(jb.status)">{{ jobStatusLabel(jb.status) }}</span>
            </div>
            <p class="jb-desc">{{ jb.payload?.summary || jb.payload?.reason || '等待后台窗口拉取执行' }}</p>
            <div class="jb-foot">
              <span class="muted" style="font-size: 11.5px">
                回执号：{{ jb.platform_message_id || '待回传' }} · {{ jb.account_id }}
              </span>
              <button
                v-if="jb.status === 'queued'"
                type="button"
                class="btn sm pri"
                :disabled="busy"
                @click="ackJob(jb.job_id)"
              >
                ✓ 模拟后台窗执行完成回执
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 3. 折叠收起：后台自动抓单防漏防重模拟 -->
    <Fold title="🔧 订单自动同步与防漏单 8 大异常保护自测（主管 / 技术验证用，点击展开）">
      <div class="sc-grid" style="margin-top: 8px">
        <div v-for="s in scenarios" :key="s.code" class="sc-card">
          <b>{{ s.title }}</b>
          <p class="muted" style="font-size: 13px">{{ s.desc }}</p>
          <Lock
            :ok="isPracticeUnlocked()"
            :busy="busy"
            kind="sm"
            :reason="`请先完成新手防踩坑练习（${practiceDoneCount()}/3）`"
            @go="runScenario(s)"
          >
            点此测试保护 ›
          </Lock>
        </div>
      </div>

      <div v-if="events.length" class="tblwrap" style="margin-top: 14px">
        <table class="tbl">
          <thead>
            <tr>
              <th>测试项目</th>
              <th>订单号</th>
              <th>工作台保护结果</th>
              <th>详细说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in events" :key="e.event_id">
              <td><span class="tag">{{ e.scenario_code }}</span></td>
              <td class="mono">{{ e.external_order_no }}</td>
              <td><b>{{ e.outcome }}</b></td>
              <td>{{ e.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Fold>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { store, callAction, isPracticeUnlocked, practiceDoneCount, notify } from '../store.js';
import { fmtYuan } from '../api.js';
import Q from '../components/Q.vue';
import Lock from '../components/Lock.vue';
import Fold from '../components/Fold.vue';

const busy = ref(false);
const events = computed(() => store.dashboard.rpa_events || []);
const windows = computed(() => store.dashboard.window_leases || []);
const leads = computed(() => store.dashboard.discovery_leads || []);
const jobs = computed(() => store.dashboard.executor_jobs || []);

const ingestForm = reactive({
  product_id: `GF-${Math.floor(8820000 + Math.random() * 9000)}`,
  model_code: 'IP15P-256-NAT',
  title: 'iPhone 15 Pro 256G 原色 几乎全新（女生自用底壳未拍清）',
  price_yuan: 4799,
  spec_conflict: false,
});

const scenarios = [
  { code: 'W10-01', title: '抓来的订单缺金额或快递号', desc: '自动标为待补齐，绝不糊里糊涂当正常单放过。' },
  { code: 'W10-02', title: '手工填单与自动抓单重复', desc: '自动合并成同一笔采购单，绝不扣两遍买货预算。' },
  { code: 'W10-03', title: '断网恢复后自动补抓漏单', desc: '每晚 22:00 前自动核查补齐断网期间拍下的订单。' },
  { code: 'W10-04', title: '拍下没付款取消退回预算', desc: '卖家反悔取消后，预留预算自动退回全组资金池。' },
  { code: 'W10-05', title: '付完钱未发货取消盯退款', desc: '自动生成待会计核对的退款记录，到账前不冲减成本。' },
  { code: 'W10-06', title: '已发货半路取消锁死库存', desc: '自动挂上顺丰半路拦截锁，截回前严禁上架售卖。' },
  { code: 'W10-07', title: '迟到的旧消息不冲乱新进度', desc: '已付款的单子收到迟到的旧提醒会自动忽略，不会倒退。' },
  { code: 'W10-08', title: '连点两次不生成重复记录', desc: '防手抖重复推送，连续点两次只记一笔账。', fixedIdem: 'rpa-fixed-demo-key' },
];

function jobTypeLabel(tp) {
  if (tp === 'first_offer') return '抓多图快照 & 自动首报';
  if (tp === 'slow_followup') return '慢慢压价 48h 温和回访';
  if (tp === 'sf_delivery_watch') return '⚡ 顺丰派送盯梢 → 推仓管10m验货';
  return tp;
}

function jobStatusLabel(st) {
  if (st === 'completed') return '✓ 已完成回执';
  if (st === 'queued') return '排队待执行';
  if (st === 'triggered_10m_sla') return '⚡ 已触发仓管10m倒计时';
  if (st === 'blocked_conflict') return '⛔ 规格冲突已拦截';
  return st;
}

function jobStatusCls(st) {
  if (st === 'completed') return 'grn';
  if (st === 'queued') return 'amb';
  if (st === 'triggered_10m_sla' || st === 'blocked_conflict') return 'red';
  return '';
}

async function submitIngest() {
  busy.value = true;
  try {
    const res = await callAction('/api/leads/ingest', {
      platform: 'goofish',
      product_id: ingestForm.product_id.trim(),
      account_id: 'ACC-GF-01',
      model_code: ingestForm.model_code,
      title: ingestForm.title.trim(),
      seller_price_cents: Math.round(Number(ingestForm.price_yuan || 4800) * 100),
      spec_conflict: ingestForm.spec_conflict,
    });
    if (res.deduplicated) {
      notify(res.message);
    } else {
      notify(`投递成功！已生成任务 ${res.job_id}（状态：${res.job_status}）`);
      ingestForm.product_id = `GF-${Math.floor(8820000 + Math.random() * 9000)}`;
    }
  } finally {
    busy.value = false;
  }
}

async function testDedup() {
  busy.value = true;
  try {
    const res = await callAction('/api/leads/ingest', {
      platform: 'goofish',
      product_id: 'GF-8812034',
      account_id: 'ACC-GF-01',
      title: '重复推送测试商品',
    });
    notify(res.message || '已完成去重校验');
  } finally {
    busy.value = false;
  }
}

async function promoteLead(leadId) {
  busy.value = true;
  try {
    const res = await callAction('/api/discovery/promote', { lead_id: leadId }, '已创建会话并转入会话陪谈台！');
    if (res?.conversation_id) {
      store.selectedConvId = res.conversation_id;
      window.location.hash = '#/im-sandbox';
    }
  } finally {
    busy.value = false;
  }
}

function pickConv(cid) {
  store.selectedConvId = cid;
  localStorage.setItem('pw_conv_id', cid);
}

async function ackJob(jobId) {
  busy.value = true;
  try {
    await callAction('/api/executor/jobs/ack', { job_id: jobId, status: 'completed' }, `任务 ${jobId} 已回执完成！`);
  } finally {
    busy.value = false;
  }
}

async function runScenario(s) {
  busy.value = true;
  try {
    await callAction(
      '/api/orders/rpa-simulate',
      {
        scenario_code: s.code,
        idempotency_key: s.fixedIdem || `rpa-${s.code}-${Date.now()}`,
      },
      `已完成「${s.title}」保护测试！`
    );
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.win-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.win-card {
  display: grid;
  gap: 8px;
  align-content: space-between;
}
.win-card.fg {
  border-color: var(--acc);
}
.win-card.sf {
  border-color: var(--red);
  background: linear-gradient(180deg, var(--panel), var(--red-soft));
}
.wc-top,
.wc-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.win-code {
  font-size: 12px;
  font-weight: 800;
  color: var(--mute);
}
.win-card h4 {
  font-size: 14px;
  line-height: 1.4;
}
.wc-task {
  font-size: 12.5px;
  color: var(--ink2);
  line-height: 1.45;
}
.split-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}
.sec-hd {
  margin-bottom: 12px;
}
.ingest-form {
  background: var(--soft);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.form-row label {
  display: grid;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
}
.chk-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.sub-lbl {
  font-size: 12px;
  font-weight: 800;
  color: var(--mute);
  margin-bottom: 8px;
}
.lead-list,
.job-list {
  display: grid;
  gap: 8px;
}
.lead-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 11px;
  background: var(--soft);
  font-size: 13px;
}
.job-row {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--soft);
  display: grid;
  gap: 5px;
}
.jb-top,
.jb-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.jb-desc {
  font-size: 12.5px;
  color: var(--ink2);
}
.sc-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.sc-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
  display: grid;
  gap: 8px;
  align-content: space-between;
}
@media (max-width: 1120px) {
  .win-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split-2 { grid-template-columns: minmax(0, 1fr); }
  .sc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .win-grid, .form-row, .sc-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
