<template>
  <div class="gc-page">
    <!-- 群控 4 大独立专页顶部切换导航 -->
    <nav class="gc-nav card">
      <div class="gn-tabs">
        <button class="gn-tab" @click="go('gc-matrix')"><i>1</i><span>群控环境与账号矩阵</span><em v-if="badges['gc-matrix']" class="nb">{{ badges['gc-matrix'] }}</em></button>
        <button class="gn-tab on"><i>2</i><span>上下架与联动队列</span></button>
        <button class="gn-tab" @click="go('gc-reprice')"><i>3</i><span>在售智能调价复核</span><em v-if="badges['gc-reprice']" class="nb amb">{{ badges['gc-reprice'] }}</em></button>
        <button class="gn-tab" @click="go('gc-metrics')"><i>4</i><span>15:30 小铺数据看板</span><em v-if="badges['gc-metrics']" class="nb">{{ badges['gc-metrics'] }}</em></button>
      </div>
      <div class="gn-acts">
        <button class="btn sm" @click="load">↻ 刷新队列</button>
        <button class="btn sm pri" @click="go('wash')">+ 去洗图直发新商品</button>
      </div>
    </nav>

    <header class="card hero-bar">
      <div>
        <div class="hero-top">
          <h1>AdsPower 上下架排期队列 &amp; 锁单全号联动下架台</h1>
          <button class="btn sm ghost" @click="showRule = !showRule">📖 上下架与联动规则 {{ showRule ? '▴' : '▾' }}</button>
        </div>
        <p v-if="showRule" class="sub">{{ data.stagger_rule }}</p>
      </div>
      <div v-if="showRule" class="rule-compare">
        <div class="rc-pill red">
          <b>孤品实物（一机一码）</b>
          <span>任一闲鱼号拍下锁单 → 其余挂同款的号必须全号联动下架防超卖</span>
        </div>
        <div class="rc-pill grn">
          <b>多件标品 / 虚拟卡券</b>
          <span>总库存 &gt; 0 时成交号自动原链重新上架保权重；仅库存归零才全号下架</span>
        </div>
      </div>
    </header>

    <!-- 区块 1：孤品已锁单但其余号未下架红灯拦截区（彻底闭环禅道 #111） -->
    <section class="card conflict-sec" :class="{ clean: !data.linked_conflicts?.length }">
      <div class="sec-head">
        <div>
          <h2>🔴 孤品锁单 / 售出待联动下架冲突（{{ data.linked_conflicts?.length || 0 }} 件）</h2>
          <p class="muted">买家已拍下锁单，但其他 AdsPower 浏览器窗口仍有在售链接挂着——一键扇出 <code>goods_delist</code> 并回读状态。</p>
        </div>
      </div>

      <div v-if="data.linked_conflicts?.length" class="cf-list">
        <div v-for="cf in data.linked_conflicts" :key="cf.sku_code" class="cf-card">
          <div class="cf-main">
            <div class="cf-tags">
              <span class="tag red">超卖风险 · 需立即联动下架</span>
              <span class="tag">{{ cf.kind_rule }}</span>
              <span class="tag acc">货号 {{ cf.sku_code }}</span>
            </div>
            <h3>{{ cf.name }}</h3>
            <p>{{ cf.sold_info }}；以下闲鱼号仍在架未撤：</p>
            <div class="lingering">
              <span v-for="s in cf.lingering_shops" :key="s.item_id" class="lg-chip">
                AdsPower #{{ s.env_id }} · <b>{{ s.shop_nick }}</b>（item_id: {{ s.item_id }} · ¥{{ s.price }}）
              </span>
            </div>
          </div>
          <button class="btn pri red-btn" :disabled="busy" @click="doLinkedDelist(cf.sku_code)">
            ⚡ 一键全号联动下架并回读
          </button>
        </div>
      </div>
      <div v-else class="ok-empty">✓ 当前所有已锁单孤品均已完成全号联动下架，无超卖风险。</div>
    </section>

    <!-- 区块 2：AdsPower 异步任务队列（含 25分钟错峰排期 + 失败现场截图查看） -->
    <section class="card queue-sec">
      <div class="sec-head">
        <div>
          <h2>🚀 AdsPower 异步任务执行队列（共 {{ data.tasks?.length || 0 }} 条）</h2>
          <p class="muted">涵盖第 2 步洗图直发的 25 分钟错峰上架单、联动下架单、在售改价单与异常拦截现场截图。</p>
        </div>
        <div class="seg">
          <button :class="{ on: tflt === 'all' }" @click="tflt = 'all'">全部 ({{ data.tasks?.length || 0 }})</button>
          <button :class="{ on: tflt === 'err' }" @click="tflt = 'err'"><i class="dot red"></i>异常附截图 ({{ data.counts?.failed || 0 }})</button>
          <button :class="{ on: tflt === 'sched' }" @click="tflt = 'sched'"><i class="dot amb"></i>25m错峰排期 ({{ data.counts?.scheduled || 0 }})</button>
          <button :class="{ on: tflt === 'ok' }" @click="tflt = 'ok'"><i class="dot grn"></i>已完成 ({{ data.counts?.success || 0 }})</button>
        </div>
      </div>

      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>任务单 / 时间</th>
              <th>动作类型</th>
              <th>AdsPower 窗口 / 店铺</th>
              <th>商品与价格</th>
              <th>当前状态</th>
              <th>执行详情 / 失败步骤与回读</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in shownTasks" :key="t.id" :class="{ errrow: ['FAILED', 'BLOCKED'].includes(t.status) }">
              <td><b>{{ t.id }}</b><br /><span class="muted">{{ t.created_at }} 创建</span></td>
              <td><span class="tag">{{ t.type_label }}</span></td>
              <td><code>#{{ t.env_id }}</code><br /><b>{{ t.shop_nick }}</b></td>
              <td>
                <b>{{ t.title }}</b>
                <br /><span class="muted">SKU: {{ t.sku_code }}<template v-if="t.price"> · ¥{{ t.price }}</template></span>
              </td>
              <td>
                <span class="tag" :class="stBadge(t.status).cls">{{ stBadge(t.status).text }}</span>
                <br v-if="t.status === 'SCHEDULED'" />
                <small v-if="t.status === 'SCHEDULED'" class="muted">排期 {{ t.scheduled_at }}</small>
              </td>
              <td class="detail-cell">
                <p>{{ t.step_detail }}</p>
                <span v-if="t.item_id" class="tag grn">真实回读 item_id: {{ t.item_id }}</span>
              </td>
              <td>
                <div class="row-acts">
                  <button v-if="t.screenshot" class="btn sm" @click="shotTask = t">🖼 看现场截图</button>
                  <button v-if="t.status === 'SCHEDULED'" class="btn sm pri" :disabled="busy" @click="execNow(t)">
                    立即提前执行
                  </button>
                  <button v-if="['FAILED', 'BLOCKED'].includes(t.status)" class="btn sm pri" :disabled="busy" @click="retryTask(t)">
                    {{ t.error_code === 'wuyoumai_intercept' ? '切闲管家 API 下架' : '恢复并重试' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 区块 3：链接老化激活重发池（≥15 天老链接重新上架刷权重） -->
    <section class="card aged-sec">
      <div class="sec-head">
        <div>
          <h2>⏰ 链接老化待重发池（挂牌 ≥ 15 天共 {{ data.aged_listings?.length || 0 }} 条）</h2>
          <p class="muted">闲鱼老链接挂久后自然搜索权重衰减，定期从仓库执行 <code>goods_relist</code> 重新上架可刷新流量池。</p>
        </div>
        <button v-if="data.aged_listings?.length" class="btn pri sm" :disabled="busy" @click="relistAllAged">
          ↻ 一键全部重新上架激活权重
        </button>
      </div>

      <div v-if="data.aged_listings?.length" class="aged-grid">
        <div v-for="ag in data.aged_listings" :key="ag.item_id" class="ag-card">
          <img :src="ag.img" alt="" />
          <div>
            <span class="tag amb">已挂 {{ ag.aged_days }} 天</span>
            <span class="tag">{{ ag.shop_nick }} (#{{ ag.env_id }})</span>
            <h4>{{ ag.title }}</h4>
            <p class="muted sm">¥{{ ag.price }} · 浏览 {{ ag.views }} · 想要 {{ ag.wants }} · item_id {{ ag.item_id }}</p>
          </div>
          <button class="btn sm" :disabled="busy" @click="relistOne(ag)">重新上架</button>
        </div>
      </div>
      <p v-else class="muted">当前所有在售链接均为 15 天内新鲜链接，无需老化重发。</p>
    </section>

    <!-- Playwright 异常现场截图查看弹窗 -->
    <div v-if="shotTask" class="mask" @click.self="shotTask = null">
      <div class="shot-modal card">
        <div class="sm-head">
          <div>
            <span class="tag red">{{ shotTask.id }} · Playwright 网页现场抓拍取证</span>
            <h3>{{ shotTask.shop_nick }} (#{{ shotTask.env_id }}) — {{ shotTask.title }}</h3>
          </div>
          <button class="btn sm" @click="shotTask = null">关闭</button>
        </div>
        <img :src="shotTask.screenshot" :alt="shotTask.step_detail" class="shot-img" />
        <p class="muted">{{ shotTask.step_detail }}</p>
        <div class="sm-foot">
          <button class="btn" @click="go('gc-matrix')">去矩阵台唤起专窗</button>
          <button class="btn pri" :disabled="busy" @click="retryTask(shotTask); shotTask = null">
            {{ shotTask.error_code === 'wuyoumai_intercept' ? '切换闲管家 API 协同下架' : '一键恢复环境并重试此任务' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { loadAll } from './store.js'
import { toast } from './ui.js'

const data = reactive({ stagger_rule: '', linked_conflicts: [], aged_listings: [], tasks: [], counts: {} })
const badges = reactive({})
const tflt = ref('all')
const busy = ref(false)
const showRule = ref(false)
const shotTask = ref(null)

const go = (k) => { location.hash = '#/' + k }

const stBadge = (st) => {
  if (st === 'SUCCESS') return { text: '✓ 已完成', cls: 'grn' }
  if (st === 'SCHEDULED') return { text: '⏳ 错峰排期中', cls: 'amb' }
  if (st === 'BLOCKED') return { text: '⛔ 终态拦截', cls: 'red' }
  if (st === 'FAILED') return { text: '✕ 异常暂停', cls: 'red' }
  return { text: st, cls: '' }
}

const shownTasks = computed(() =>
  (data.tasks || []).filter((t) => {
    if (tflt.value === 'err') return ['FAILED', 'BLOCKED'].includes(t.status)
    if (tflt.value === 'sched') return t.status === 'SCHEDULED'
    if (tflt.value === 'ok') return t.status === 'SUCCESS'
    return true
  })
)

async function load() {
  try {
    const [q, b] = await Promise.all([api('/gc-hub/queue'), api('/gc-hub/badges')])
    Object.assign(data, q)
    Object.assign(badges, b)
  } catch (e) {
    toast('读取队列失败：' + e.message)
  }
}

async function doLinkedDelist(skuCode) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/queue/linked-delist/${encodeURIComponent(skuCode)}`, {})
    toast(r.msg)
    await Promise.all([load(), loadAll(true)])
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function execNow(t) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/queue/execute-scheduled/${t.id}`, {})
    toast(r.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function retryTask(t) {
  busy.value = true
  try {
    const r = await post(`/gc-hub/queue/retry/${t.id}`, {})
    toast(r.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function relistAllAged() {
  busy.value = true
  try {
    const r = await post('/gc-hub/queue/relist-aged', {})
    toast(r.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function relistOne(ag) {
  busy.value = true
  try {
    const r = await post('/gc-hub/queue/relist-aged', { item_ids: [ag.item_id] })
    toast(r.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.gc-page { padding: 18px 32px 64px; max-width: 1720px; display: grid; gap: 12px; }
.gc-nav { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 16px; flex-wrap: wrap; }
.gn-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.gn-tab { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; }
.gn-tab i { width: 22px; height: 22px; border-radius: 50%; background: var(--panel); display: inline-flex; align-items: center; justify-content: center; font-style: normal; font-size: 12px; font-weight: 800; }
.gn-tab.on { background: var(--acc); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.25); }
.gn-tab.on i { background: rgba(255,255,255,.22); color: #fff; }
.gn-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.nb { font-style: normal; padding: 1px 7px; border-radius: 999px; background: var(--red); color: #fff; font-size: 11.5px; font-weight: 800; }
.nb.amb { background: var(--amb); color: #2c1d00; }

.hero-bar { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.hero-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .05em; color: var(--acc); }
.hero-bar h1 { margin: 0; font-size: 24px; }
.hero-bar .sub { margin: 6px 0 0; color: var(--mute); font-size: 13px; max-width: 780px; }
.rule-compare { display: grid; gap: 8px; max-width: 520px; }
.rc-pill { padding: 9px 14px; border-radius: 12px; font-size: 12.5px; display: grid; gap: 2px; }
.rc-pill.red { background: var(--red-soft); color: var(--red-ink); }
.rc-pill.grn { background: var(--grn-soft); color: var(--grn-ink); }

.conflict-sec, .queue-sec, .aged-sec { padding: 22px 26px; display: grid; gap: 16px; }
.conflict-sec { border: 2px solid var(--red); }
.conflict-sec.clean { border-color: #86efac; }
.sec-head { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.sec-head h2 { margin: 0 0 4px; font-size: 20px; }
.sec-head p { margin: 0; font-size: 13px; }

.cf-list { display: grid; gap: 12px; }
.cf-card { padding: 16px 20px; border-radius: 16px; background: var(--red-soft); color: var(--red-ink); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.cf-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.cf-card h3 { margin: 0 0 4px; font-size: 18px; }
.cf-card p { margin: 0 0 8px; font-size: 13.5px; }
.lingering { display: flex; gap: 8px; flex-wrap: wrap; }
.lg-chip { padding: 4px 10px; border-radius: 8px; background: rgba(255,255,255,.85); font-size: 13px; color: var(--ink); }
.red-btn { background: var(--red) !important; color: #fff !important; }
.ok-empty { padding: 14px 18px; border-radius: 12px; background: var(--grn-soft); color: var(--grn-ink); font-weight: 700; }

.seg { display: inline-flex; gap: 4px; padding: 4px; background: var(--soft); border-radius: 12px; flex-wrap: wrap; }
.seg button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: var(--ink2); }
.seg button.on { background: var(--ink); color: var(--bg); }

.errrow td { background: rgba(254, 226, 226, .35); }
.detail-cell { max-width: 420px; }
.detail-cell p { margin: 0 0 4px; font-size: 13px; line-height: 1.45; }
.row-acts { display: flex; gap: 6px; flex-wrap: wrap; }

.aged-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
.ag-card { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 14px; background: var(--soft); }
.ag-card img { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; flex-shrink: 0; }
.ag-card > div { flex: 1; min-width: 0; }
.ag-card h4 { margin: 5px 0 3px; font-size: 14.5px; }

.mask { position: fixed; inset: 0; z-index: 85; background: rgba(8,12,22,.6); display: flex; align-items: center; justify-content: center; padding: 24px; }
.shot-modal { max-width: 900px; width: 100%; padding: 22px 26px; display: grid; gap: 14px; }
.sm-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sm-head h3 { margin: 6px 0 0; font-size: 19px; }
.shot-img { width: 100%; border-radius: 14px; border: 1px solid var(--line); display: block; }
.sm-foot { display: flex; justify-content: flex-end; gap: 10px; }
</style>
