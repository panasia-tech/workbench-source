<template>
  <div class="gc-page">
    <!-- 群控 4 大独立专页顶部切换导航 -->
    <nav class="gc-nav card">
      <div class="gn-tabs">
        <button class="gn-tab" @click="go('gc-matrix')"><i>1</i><span>群控环境与账号矩阵</span><em v-if="badges['gc-matrix']" class="nb">{{ badges['gc-matrix'] }}</em></button>
        <button class="gn-tab" @click="go('gc-queue')"><i>2</i><span>上下架与联动队列</span><em v-if="badges['gc-queue']" class="nb">{{ badges['gc-queue'] }}</em></button>
        <button class="gn-tab" @click="go('gc-reprice')"><i>3</i><span>在售智能调价复核</span><em v-if="badges['gc-reprice']" class="nb amb">{{ badges['gc-reprice'] }}</em></button>
        <button class="gn-tab on"><i>4</i><span>15:30 小铺数据看板</span></button>
      </div>
      <div class="gn-acts">
        <div class="seg">
          <button :class="{ on: period === '7d' }" @click="switchPeriod('7d')">近 7 天快照</button>
          <button :class="{ on: period === '1d' }" @click="switchPeriod('1d')">近 1 天快照</button>
        </div>
        <button class="btn sm pri" @click="reportOpen = !reportOpen">
          📋 {{ reportOpen ? '收起 Markdown 经营日报' : '生成/复制今日经营日报' }}
        </button>
      </div>
    </nav>

    <header class="card hero-bar">
      <div>
        <div class="hero-top">
          <h1>闲鱼小铺每日经营数据总览 &amp; 异常诊断台</h1>
          <button class="btn sm ghost" @click="showRule = !showRule">📖 抓取口径说明 {{ showRule ? '▴' : '▾' }}</button>
        </div>
        <p v-if="showRule" class="sub">{{ data.schedule_rule }}</p>
      </div>
    </header>

    <!-- 可展开：每日自动生成的 Markdown 经营日报 -->
    <section v-if="reportOpen" class="card md-report">
      <div class="mr-head">
        <b>📄 自动生成的《群控小铺经营日报》（可直接复制发公司钉钉群）</b>
        <button class="btn sm pri" @click="copyReport">一键复制全文</button>
      </div>
      <pre>{{ data.daily_markdown }}</pre>
    </section>

    <!-- 区块 1：自动标红异常雷达 -->
    <section class="card alert-sec" v-if="data.alerts?.length">
      <h2>🔴 今日小铺自动标红异常（共 {{ data.alerts.length }} 项需关注）</h2>
      <div class="al-grid">
        <div v-for="(al, i) in data.alerts" :key="i" class="al-card" :class="al.lvl">
          <div>
            <div class="al-top">
              <span class="tag" :class="al.lvl">{{ al.kind }}</span>
              <b>{{ al.shop_nick }} (AdsPower #{{ al.env_id }})</b>
            </div>
            <p>{{ al.detail }}</p>
          </div>
          <div class="al-acts">
            <button v-if="al.kind.includes('漏抓')" class="btn sm pri" :disabled="busy" @click="recapture(al.env_id)">
              🔄 一键恢复并补抓原图
            </button>
            <button v-else-if="al.kind.includes('0 支付')" class="btn sm" @click="go('gc-reprice')">去智能调价 ›</button>
            <button v-else class="btn sm" @click="go('gc-matrix')">去矩阵擦亮 ›</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 区块 2：全矩阵汇总指标 + 交易漏斗 + 流量来源分布 -->
    <div class="ovw-two">
      <section class="card kpi-matrix">
        <h3>全矩阵汇总核心指标（{{ period === '7d' ? '近 7 天' : '近 1 天' }}）</h3>
        <div class="km-grid">
          <div><span>总访问 UV</span><b>{{ fmt(data.summary?.visit_uv) }}</b></div>
          <div><span>商品曝光次数</span><b>{{ fmt(data.summary?.exposure_cnt) }}</b></div>
          <div><span>商品曝光 UV</span><b>{{ fmt(data.summary?.exposure_uv) }}</b></div>
          <div><span>商品浏览 UV</span><b>{{ fmt(data.summary?.browse_uv) }}</b></div>
          <div><span>总询单人次</span><b>{{ fmt(data.summary?.inquiry_cnt) }}</b></div>
          <div><span>总支付笔数</span><b class="grn">{{ fmt(data.summary?.pay_orders) }}</b></div>
          <div><span>总支付金额</span><b class="grn">¥{{ fmtMoney(data.summary?.pay_amount) }}</b></div>
          <div><span>平均3分钟响应率</span><b :class="(data.summary?.avg_resp_3min || 0) < 75 ? 'amb' : 'acc'">{{ data.summary?.avg_resp_3min ?? '—' }}%</b></div>
          <div><span>平均首次响应</span><b>{{ data.summary?.avg_first_sec ?? '—' }}秒</b></div>
          <div><span>总粉丝 / 新增</span><b>{{ fmt(data.summary?.fans_total) }} <small>+{{ fmt(data.summary?.fans_new) }}</small></b></div>
        </div>
      </section>

      <section class="card funnel-box">
        <h3>曝光 → 浏览 → 询单 → 支付漏斗 &amp; 浏览来源占比</h3>
        <div class="fn-bars">
          <div class="fn-row"><span>1. 曝光人数 UV</span><div class="fbar"><i style="width: 100%"></i></div><b>{{ fmt(data.summary?.exposure_uv) }}</b></div>
          <div class="fn-row"><span>2. 浏览人数 UV</span><div class="fbar"><i style="width: 68%"></i></div><b>{{ fmt(data.summary?.browse_uv) }}</b></div>
          <div class="fn-row"><span>3. 询单会话人次</span><div class="fbar"><i style="width: 38%"></i></div><b>{{ fmt(data.summary?.inquiry_cnt) }}</b></div>
          <div class="fn-row"><span>4. 成交支付笔数</span><div class="fbar grn"><i style="width: 22%"></i></div><b>{{ fmt(data.summary?.pay_orders) }} 笔</b></div>
        </div>
        <div class="src-strip">
          <div v-for="s in data.traffic_sources" :key="s.name" class="src-chip">
            <span>{{ s.name }}</span><b>{{ s.pct }}%</b>
          </div>
        </div>
      </section>
    </div>

    <!-- 区块 3：ERP 智能体经营数据自然语言速查（带数据源引用） -->
    <section class="card agent-qa">
      <div class="aq-head">
        <div>
          <h3>🤖 ERP 智能体 · 小铺经营数据直查（回答强制附数据引用）</h3>
          <p class="muted sm">小铺每日指标与原始截图已同步接入智能体检索底座，支持直接按业务问题定位问题账号。</p>
        </div>
        <div class="aq-chips">
          <button v-for="q in PRESET_QS" :key="q" class="q-chip" @click="askQ(q)">{{ q }}</button>
        </div>
      </div>
      <div class="aq-inp">
        <input class="inp" v-model="question" placeholder="输入问题，例如：最近7天哪些账号有浏览但0支付？哪个账号曝光下滑超30%？" @keyup.enter="askQ(question)" />
        <button class="btn pri" @click="askQ(question)">提问查询</button>
      </div>
      <div v-if="qaRes" class="aq-ans">
        <div class="aa-top"><b>{{ qaRes.summary }}</b><span class="tag acc">{{ qaRes.cite }}</span></div>
        <div v-if="qaRes.rows?.length" class="tblwrap">
          <table class="tbl">
            <thead>
              <tr><th v-for="k in Object.keys(qaRes.rows[0])" :key="k">{{ k }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in qaRes.rows" :key="idx">
                <td v-for="k in Object.keys(row)" :key="k">{{ row[k] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 区块 4：各闲鱼账号明细排行表（支持点开查看当日保存的 3 张原始网页截图） + 宿主机对比 -->
    <section class="card tbl-sec">
      <div class="sec-head">
        <div>
          <h2>📊 各闲鱼账号小铺数据明细表（未抓到字段严格保留「—」，绝不填 0）</h2>
          <p class="muted sm">点击任意账号右侧「🖼 看当日原图」即可调阅保存的概览、转化漏斗、客服响应原始系统截图。</p>
        </div>
      </div>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>账号 / 环境</th>
              <th>宿主机 / 负责人</th>
              <th>抓取状态</th>
              <th>曝光次数 (环比)</th>
              <th>浏览 UV (点击率)</th>
              <th>询单人次</th>
              <th>支付笔数 / 金额</th>
              <th>3分钟响应率</th>
              <th>原始系统截图</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in data.accounts" :key="r.env_id" :class="{ missrow: r.status !== 'ok' }">
              <td><b>{{ r.shop_nick }}</b><br /><code>#{{ r.env_id }}</code></td>
              <td>{{ r.host }}<br /><span class="muted">{{ r.owner }}</span></td>
              <td>
                <span class="tag" :class="r.status === 'ok' ? 'grn' : 'red'">{{ r.captured_at }}</span>
              </td>
              <td>
                <template v-if="r.exposure_cnt !== null">
                  <b>{{ fmt(r.exposure_cnt) }}</b>
                  <span :class="(r.exposure_chg_pct || 0) <= -30 ? 'bad-txt' : 'ok-txt'">
                    ({{ r.exposure_chg_pct > 0 ? '+' : '' }}{{ r.exposure_chg_pct }}%)
                  </span>
                </template>
                <span v-else class="muted">—（未抓取）</span>
              </td>
              <td>
                <template v-if="r.browse_uv !== null">{{ fmt(r.browse_uv) }} <span class="muted">({{ r.ctr_pct }}%)</span></template>
                <span v-else class="muted">—</span>
              </td>
              <td>{{ r.inquiry_cnt !== null ? r.inquiry_cnt : '—' }}</td>
              <td>
                <template v-if="r.pay_orders !== null">
                  <b>{{ r.pay_orders }} 笔</b> · ¥{{ fmtMoney(r.pay_amount) }}
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <span v-if="r.resp_3min_rate !== null" class="tag" :class="r.resp_3min_rate < 70 ? 'red' : 'grn'">
                  {{ r.resp_3min_rate }}%
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <div class="row-acts">
                  <button class="btn sm" @click="shotAccount = r">🖼 看当日原图 ({{ r.screenshots?.length || 0 }})</button>
                  <button v-if="r.status !== 'ok'" class="btn sm pri" :disabled="busy" @click="recapture(r.env_id)">补抓</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style="margin: 18px 0 8px">🖥 按群控宿主机汇总排行</h3>
      <div class="tblwrap">
        <table class="tbl">
          <thead><tr><th>宿主机</th><th>纳管账号数</th><th>缺数账号</th><th>总商品曝光</th><th>总询单人次</th><th>总支付金额</th></tr></thead>
          <tbody>
            <tr v-for="h in data.hosts" :key="h.host">
              <td><b>{{ h.host }}</b></td>
              <td>{{ h.accounts }} 个</td>
              <td><span :class="h.missing ? 'bad-txt' : ''">{{ h.missing }} 个</span></td>
              <td>{{ fmt(h.exposure_cnt) }}</td>
              <td>{{ fmt(h.inquiry_cnt) }}</td>
              <td><b>¥{{ fmtMoney(h.pay_amount) }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 原始截图查看抽屉 -->
    <div v-if="shotAccount" class="mask" @click.self="shotAccount = null">
      <aside class="drawer">
        <div class="dh">
          <div>
            <p class="eyebrow">15:30 原始网页截图留存档案 · AdsPower #{{ shotAccount.env_id }}</p>
            <h2>{{ shotAccount.shop_nick }} · {{ shotAccount.captured_at }}</h2>
          </div>
          <button class="btn sm" @click="shotAccount = null">关闭</button>
        </div>
        <div class="shot-stack">
          <div v-for="(u, i) in shotAccount.screenshots" :key="i" class="shot-card">
            <img :src="u" alt="小铺数据原始截图" />
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { toast } from './ui.js'

const period = ref('7d')
const data = reactive({ schedule_rule: '', summary: {}, traffic_sources: [], alerts: [], accounts: [], hosts: [], daily_markdown: '' })
const badges = reactive({})
const reportOpen = ref(false)
const busy = ref(false)
const showRule = ref(false)
const shotAccount = ref(null)

const PRESET_QS = [
  '最近7天哪些账号有浏览但0支付？',
  '哪些账号曝光下降超过30%？',
  '哪个账号客服3分钟响应率最低？',
  '成交额最高的是哪几个账号？'
]
const question = ref(PRESET_QS[0])
const qaRes = ref(null)

const go = (k) => { location.hash = '#/' + k }
const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'))
const fmtMoney = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

async function load() {
  try {
    const [m, b] = await Promise.all([api(`/gc-hub/metrics?period=${period.value}`), api('/gc-hub/badges')])
    Object.assign(data, m)
    Object.assign(badges, b)
    if (shotAccount.value) {
      shotAccount.value = m.accounts.find((x) => x.env_id === shotAccount.value.env_id) || null
    }
  } catch (e) {
    toast('读取小铺数据失败：' + e.message)
  }
}

function switchPeriod(p) {
  period.value = p
  load()
}

function copyReport() {
  navigator.clipboard?.writeText(data.daily_markdown || '').catch(() => {})
  toast('已复制今日 Markdown 经营日报全文')
}

async function recapture(envId) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/metrics/recapture/${envId}`, {})
    toast(r.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function askQ(q) {
  question.value = q
  try {
    qaRes.value = await post('/gc-hub/metrics/ask', { question: q })
  } catch (e) {
    toast(e.message)
  }
}

onMounted(async () => {
  await load()
  await askQ(PRESET_QS[0])
})
</script>

<style scoped>
.gc-page { padding: 18px 32px 64px; max-width: 1720px; display: grid; gap: 12px; }
.gc-nav { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 16px; flex-wrap: wrap; }
.gn-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.gn-tab { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; }
.gn-tab i { width: 22px; height: 22px; border-radius: 50%; background: var(--panel); display: inline-flex; align-items: center; justify-content: center; font-style: normal; font-size: 12px; font-weight: 800; }
.gn-tab.on { background: var(--acc); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.25); }
.gn-tab.on i { background: rgba(255,255,255,.22); color: #fff; }
.gn-acts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.nb { font-style: normal; padding: 1px 7px; border-radius: 999px; background: var(--red); color: #fff; font-size: 11.5px; font-weight: 800; }
.nb.amb { background: var(--amb); color: #2c1d00; }
.seg { display: inline-flex; gap: 4px; padding: 4px; background: var(--soft); border-radius: 12px; }
.seg button { height: 32px; padding: 0 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: var(--ink2); }
.seg button.on { background: var(--ink); color: var(--bg); }

.hero-bar { padding: 14px 20px; }
.hero-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .05em; color: var(--acc); }
.hero-bar h1 { margin: 0; font-size: 24px; }
.hero-bar .sub { margin: 6px 0 0; color: var(--mute); font-size: 13px; }

.md-report { padding: 18px 22px; display: grid; gap: 10px; background: #0f172a; color: #e2e8f0; }
.mr-head { display: flex; justify-content: space-between; align-items: center; }
.md-report pre { margin: 0; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.55; color: #cbd5e1; }

.alert-sec { padding: 20px 24px; display: grid; gap: 14px; border: 2px solid var(--red); }
.alert-sec h2 { margin: 0; font-size: 19px; }
.al-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 12px; }
.al-card { padding: 14px 16px; border-radius: 14px; display: flex; justify-content: space-between; align-items: center; gap: 14px; }
.al-card.red { background: var(--red-soft); color: var(--red-ink); }
.al-card.amb { background: var(--amb-soft); color: var(--amb-ink); }
.al-top { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.al-card p { margin: 0; font-size: 13px; line-height: 1.45; }

.ovw-two { display: grid; grid-template-columns: 1.25fr 1fr; gap: 18px; }
.kpi-matrix, .funnel-box, .agent-qa, .tbl-sec { padding: 22px 26px; display: grid; gap: 14px; }
.kpi-matrix h3, .funnel-box h3, .agent-qa h3 { margin: 0; font-size: 18px; }
.km-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.km-grid > div { padding: 12px 14px; border-radius: 14px; background: var(--soft); }
.km-grid span { display: block; font-size: 12px; color: var(--mute); }
.km-grid b { font-size: 22px; font-weight: 800; letter-spacing: -.02em; }
.km-grid b.grn { color: var(--grn); }
.km-grid b.acc { color: var(--acc); }
.km-grid b.amb { color: var(--amb-ink); }
.km-grid small { font-size: 12px; color: var(--grn-ink); }

.fn-bars { display: grid; gap: 10px; }
.fn-row { display: grid; grid-template-columns: 135px 1fr 100px; gap: 12px; align-items: center; font-size: 13.5px; }
.fbar { height: 14px; border-radius: 999px; background: var(--soft); overflow: hidden; }
.fbar i { display: block; height: 100%; border-radius: 999px; background: var(--acc); }
.fbar.grn i { background: var(--grn); }
.src-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.src-chip { padding: 9px 10px; border-radius: 12px; background: var(--soft); text-align: center; }
.src-chip span { display: block; font-size: 11.5px; color: var(--mute); }
.src-chip b { font-size: 16px; }

.aq-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.aq-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.q-chip { padding: 5px 12px; border-radius: 999px; background: var(--acc-soft); color: var(--acc); font-size: 12.5px; font-weight: 700; }
.aq-inp { display: flex; gap: 10px; }
.inp { flex: 1; height: 42px; border: 1.5px solid var(--line); border-radius: 12px; padding: 0 14px; background: var(--panel); font: inherit; }
.aq-ans { padding: 14px 16px; border-radius: 14px; background: var(--soft); display: grid; gap: 10px; }
.aa-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }

.missrow td { background: rgba(254, 226, 226, .35); }
.bad-txt { color: var(--red-ink); font-weight: 800; margin-left: 4px; }
.ok-txt { color: var(--grn-ink); font-weight: 700; margin-left: 4px; }
.row-acts { display: flex; gap: 6px; flex-wrap: wrap; }

.mask { position: fixed; inset: 0; z-index: 85; background: rgba(8,12,22,.56); display: flex; justify-content: flex-end; }
.drawer { width: min(760px, 100%); height: 100%; overflow-y: auto; background: var(--panel); padding: 26px 28px 60px; display: grid; align-content: start; gap: 18px; }
.dh { display: flex; justify-content: space-between; align-items: flex-start; }
.dh h2 { margin: 4px 0 0; font-size: 21px; }
.shot-stack { display: grid; gap: 16px; }
.shot-card img { width: 100%; border-radius: 14px; border: 1px solid var(--line); display: block; }
</style>
