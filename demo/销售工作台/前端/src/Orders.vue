<template>
  <div class="page ord-page">
    <!-- 顶栏：标准电商发货后台头部 + 右上角系统同步异常折叠胶囊 -->
    <header class="ord-head">
      <div>
        <h1>订单与履约中心<Q k="orders" /></h1>
        <p class="sub">按平台与履约状态集中打单发货：<b>实物当日 17:00 前扫码出库</b>，<b>虚拟付款 1 分钟内自动发卡</b>。<Q k="o-deadline" /></p>
      </div>
      <div class="ord-acts">
        <button
          type="button"
          class="sync-pill"
          :class="{ warn: syncAnomalies.length > 0, on: showSyncPanel }"
          @click="showSyncPanel = !showSyncPanel"
          title="系统漏抓、SKU 映射缺失或回执失败等非日常异常收纳在此"
        >
          <span class="dot" :class="syncAnomalies.length > 0 ? 'red' : 'grn'"></span>
          <span>系统同步异常</span>
          <b>{{ syncAnomalies.length }}</b>
          <span class="caret">{{ showSyncPanel ? '▴' : '▾' }}</span>
        </button>
        <button class="btn sm" @click="openHelp('orders')"><Icon name="help" />怎么用</button>
        <button class="btn sm" @click="reload"><Icon name="refresh" />刷新</button>
      </div>
    </header>

    <!-- 折叠的系统同步异常抽屉条：平时收起，不打扰日常发货 -->
    <section v-if="showSyncPanel" class="sync-drawer card">
      <div class="sd-head">
        <div>
          <b>系统同步异常收纳（程序/映射类问题，非员工日常主流程）</b>
          <span class="muted sm">包含漏抓、未挂货号映射、平台回传失败或买家改址不同步。点任意一笔即可在右侧面板处理。</span>
        </div>
        <button class="btn sm" @click="showSyncPanel = false">收起</button>
      </div>
      <div v-if="!syncAnomalies.length" class="sd-empty">
        <svg class="mini-mascot" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
          <circle cx="16" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/>
          <path d="M9 11l-2-5 5 2M23 11l2-5-5 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <circle cx="12.5" cy="16" r="1.2" fill="currentColor"/><circle cx="19.5" cy="16" r="1.2" fill="currentColor"/>
          <path d="M13.5 20.5c1.3 1.1 3.7 1.1 5 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <span>当前无系统同步异常订单，全部订单与平台状态一致。</span>
      </div>
      <div v-else class="sd-list">
        <button
          v-for="o in syncAnomalies"
          :key="o.id"
          type="button"
          class="sd-chip"
          :class="{ sel: sel?.id === o.id }"
          @click="pick(o)"
        >
          <span class="tag red">{{ o.gap_label }}</span>
          <b>{{ o.id }}</b>
          <span class="sd-t">{{ o.title }}</span>
          <span class="muted sm">→ 去处理</span>
        </button>
      </div>
    </section>

    <!-- 千牛/抖店风格：履约状态主 Tab + 类型筛选 + 单号搜索 -->
    <div class="ord-toolbar">
      <div class="st-tabs" role="tablist">
        <button v-for="t in STATUS_TABS" :key="t.k" class="st-tab" :class="{ on: statusTab === t.k }" @click="statusTab = t.k">
          <span>{{ t.t }}</span>
          <em>{{ countByStatus(t.k) }}</em>
        </button>
      </div>
      <div class="ord-filters">
        <div class="kind-pills">
          <button v-for="kf in KIND_FILTERS" :key="kf.k" class="fchip" :class="{ on: kindFilter === kf.k }" @click="kindFilter = kf.k">{{ kf.t }}</button>
        </div>
        <label class="ord-search">
          <Icon name="search" />
          <input v-model="kw" placeholder="搜单号 / 商品 / 买家 / SKU" />
        </label>
      </div>
    </div>

    <!-- 主区：左侧千牛双层订单表 + 右侧紧凑履约与费用核算面板 -->
    <div class="ord-split">
      <section class="ord-table-wrap">
        <div class="qn-cols-hd">
          <span>商品详情与规格 / 货号</span>
          <span>金额与类型</span>
          <span>买家与履约状态</span>
          <span class="right">操作</span>
        </div>

        <div v-for="o in shown" :key="o.id" class="qn-order" :class="[rowTone(o), { sel: sel?.id === o.id }]" @click="pick(o)">
          <!-- 上层：灰底订单元信息条 -->
          <div class="qn-row-top">
            <div class="qn-meta-l">
              <span class="qn-oid">{{ o.id }}</span>
              <span class="tag">{{ o.kind === 'virt' ? '闲鱼虚拟' : '闲鱼实物' }}</span>
              <span class="muted sm">付款时间：{{ o.paid }}</span>
              <span v-if="o.sku" class="muted sm">SKU：<code>{{ o.sku }}</code></span>
            </div>
            <div class="qn-meta-r">
              <span v-if="isSyncIssue(o)" class="tag red">同步异常：{{ o.gap_label }}</span>
              <span v-else class="tag" :class="o.gap === 'pending' ? 'amb' : o.gap === 'ok' ? 'grn' : 'red'">
                {{ displayStatus(o) }}
              </span>
            </div>
          </div>

          <!-- 下层：商品主行 -->
          <div class="qn-row-main">
            <div class="qn-prod">
              <div class="qn-thumb" :class="o.kind === 'virt' ? 'virt' : 'phys'">
                <Icon :name="o.kind === 'virt' ? 'ticket' : 'box'" />
              </div>
              <div class="qn-pinfo">
                <b>{{ o.title }}</b>
                <p v-if="o.why" class="qn-note" :class="o.lvl">{{ o.why }}</p>
                <p v-else class="muted sm">平台状态：{{ PS[o.p_status] || o.p_status }} · 系统状态：{{ SS[o.s_status] || o.s_status }}</p>
              </div>
            </div>

            <div class="qn-amt">
              <strong>¥{{ o.amount }}</strong>
              <span class="muted sm">成本 ¥{{ o.cost_price || 0 }}</span>
            </div>

            <div class="qn-buyer">
              <b>{{ o.buyer }}</b>
              <span class="muted sm">{{ o.kind === 'virt' ? '付款 1 分钟内自动履约' : '当日 17:00 前扫码出库' }}</span>
            </div>

            <div class="qn-op">
              <button v-if="o.id.startsWith('V-')" type="button" class="btn sm pri" @click.stop="goItem(o.vpid)">产品卡处理</button>
              <button v-else-if="o.gap === 'pending' || o.gap === 'stuck'" type="button" class="btn sm pri" @click.stop="pick(o)">扫码出库</button>
              <button v-else-if="isSyncIssue(o)" type="button" class="btn sm bad" @click.stop="pick(o)">修补同步</button>
              <button v-else type="button" class="btn sm" @click.stop="pick(o)">详情 / 核算</button>
            </div>
          </div>
        </div>

        <div v-if="!shown.length" class="ord-empty card">
          <svg class="mini-mascot lg" viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
            <circle cx="18" cy="19" r="11" fill="none" stroke="currentColor" stroke-width="1.8"/>
            <path d="M10 12l-2-6 5.5 2.2M26 12l2-6-5.5 2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            <circle cx="14" cy="18" r="1.3" fill="currentColor"/><circle cx="22" cy="18" r="1.3" fill="currentColor"/>
            <path d="M15 23c1.5 1.2 4.5 1.2 6 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
          <div>
            <b>当前筛选下暂无对应订单</b>
            <p class="muted sm">切换上方履约状态或清空搜索关键词即可查看全部订单。</p>
          </div>
        </div>
      </section>

      <!-- 右侧：履约操作 & 费用净收益核算侧栏 -->
      <aside class="ord-side">
        <div v-if="!sel" class="card ord-side-placeholder">
          <svg class="mini-mascot" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <circle cx="16" cy="17" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>
            <path d="M9 11l-2-5 5 2M23 11l2-5-5 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <circle cx="12.5" cy="16" r="1.1" fill="currentColor"/><circle cx="19.5" cy="16" r="1.1" fill="currentColor"/>
            <path d="M14 20.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <p class="muted">在左侧选择一笔订单，可在此扫码核对货号出库、处理同步状态及核算单票净收益。</p>
        </div>

        <div v-else class="card det">
          <div class="dh">
            <span class="tag" :class="sel.lvl === 'red' ? 'red' : sel.lvl === 'amb' ? 'amb' : 'grn'">{{ LV[sel.lvl]?.icon }} {{ sel.gap_label }}</span>
            <Q v-if="GK[sel.gap]" :k="GK[sel.gap]" />
            <span class="muted sm">{{ sel.id }}</span>
          </div>
          <h2>{{ sel.title }}</h2>
          <dl class="kv compact">
            <dt>买家</dt><dd>{{ sel.buyer }}</dd>
            <dt>实付金额</dt><dd><b>¥{{ sel.amount }}</b></dd>
            <dt>付款时间</dt><dd>{{ sel.paid }}</dd>
            <dt>平台状态</dt><dd>{{ PS[sel.p_status] || sel.p_status }}</dd>
            <dt>系统状态</dt><dd>{{ SS[sel.s_status] || sel.s_status }}</dd>
            <dt>绑定货号</dt><dd><code>{{ sel.sku || '待匹配货号' }}</code></dd>
          </dl>

          <p v-if="sel.why" class="why big" :class="sel.lvl">{{ sel.why }}</p>
          <p v-if="sel.note" class="muted sm" style="margin: 6px 0">{{ sel.note }}</p>

          <!-- 履约主动作区（扫码防错发 / 虚拟产品卡 / 同步异常处理） -->
          <div class="do">
            <template v-if="sel.id.startsWith('V-')">
              <p class="muted sm">虚拟订单在对应产品卡处理自动发卡或补货放行。</p>
              <button class="btn pri" @click="goItem(sel.vpid)">打开虚拟产品卡</button>
            </template>

            <template v-else-if="sel.gap === 'missed'">
              <h4>补抓订单</h4>
              <p class="muted sm">系统漏抓，点击将平台订单拉入 ERP 队列。</p>
              <Lock :ok="!locked" reason="先做完练习" @go="act('capture')">补抓进系统</Lock>
            </template>

            <template v-else-if="sel.gap === 'unmatched'">
              <h4>绑定库存单品</h4>
              <p class="muted sm">{{ sel.unmatched === 'same_model' ? '同款多件在库，请选择未被占用的唯一货号：' : '商品未挂载货号映射，可手动指定或报仓管挂接：' }}</p>
              <label v-for="c in sel.candidates" :key="c" class="cand">
                <input type="radio" name="cand" :value="c" v-model="pickCode" /> {{ c }}
              </label>
              <template v-if="!sel.candidates?.length">
                <p class="why red">无候选单品映射，禁止盲发。</p>
                <button class="btn sm" @click="report">报仓管挂映射</button>
              </template>
              <Lock :ok="!!pickCode && !locked" :reason="locked ? '先做完练习' : '请先选定货号'" @go="act('bind', { sku_code: pickCode })">确认绑定货号</Lock>
            </template>

            <template v-else-if="sel.gap === 'desync'">
              <h4>同步平台状态</h4>
              <template v-if="sel.s_status === 'callback_failed'">
                <p class="muted sm">仓库已出库但平台运单回传失败，请核对后重传。</p>
                <Lock :ok="!locked" reason="先做完练习" @go="act('retry-callback')">重传平台回执</Lock>
              </template>
              <template v-else>
                <p class="muted sm">买家已{{ sel.p_status === 'cancelled' ? '取消订单（409 禁出库）' : '修改收货地址' }}，请先同步再决定出库或释放库存。</p>
                <Lock :ok="!locked" reason="先做完练习" @go="act('resync')">{{ sel.p_status === 'cancelled' ? '同步取消并释放库存' : '更新为最新收货地址' }}</Lock>
              </template>
            </template>

            <template v-else-if="sel.gap === 'stuck' || sel.gap === 'pending'">
              <h4>扫码核对防错发出库</h4>
              <label class="f">快递运单号<input v-model="trk" placeholder="粘贴运单号（自提请填 自提）" /></label>
              <label class="f">
                扫码核对货号（必须等于 {{ sel.sku || '订单SKU' }}）
                <span class="row">
                  <input v-model="scanned" placeholder="扫码枪扫描主机/母码" />
                  <button class="btn sm" @click="scanned = sel.sku || ''">演示模拟扫码</button>
                </span>
              </label>
              <Lock :ok="shipOk" :reason="shipWhy" :penalty="rules.ship?.penalty" @go="act('ship', { tracking_no: trk, scanned })">确认扫码出库</Lock>
              <p class="muted sm" style="margin-top: 6px">{{ rules.ship?.deadline }}</p>
            </template>

            <template v-else>
              <p class="why grn">该订单已完成全部履约与平台状态回传。</p>
            </template>
          </div>

          <!-- 费用、成本与净收益核算 -->
          <div class="fees">
            <h4>单票费用、成本与净收益核算<Q k="o-fees" /></h4>
            <div class="fg">
              <label>平台费<input v-model.number="fee.platform" type="number" /></label>
              <label>运费<input v-model.number="fee.shipping" type="number" /></label>
              <label>维修/返工<input v-model.number="fee.repair" type="number" /></label>
              <label>其它费<input v-model.number="fee.other" type="number" /></label>
              <label>实际退款<input v-model.number="fee.refund" type="number" /></label>
              <label>实收金额<input v-model.number="fee.receivable" type="number" /></label>
            </div>
            <div class="net-bar">
              <span>净收益：<b>¥{{ netFee }}</b></span>
              <button class="btn pri sm" @click="saveFees">保存费用并重算提成</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import Q from './Q.vue'
import { computed, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import Lock from './Lock.vue'
import { state, loadAll, LV } from './store.js'
import { feesOf } from './demoFinal.js'
import { post } from './api.js'
import { openHelp, toast } from './ui.js'

const GK = { missed: 'o-missed', unmatched: 'o-unmatched', stuck: 'o-stuck', desync: 'o-desync', pending: 'o-pending' }
const PS = { paid: '已付款', cancelled: '买家已取消', addr_changed: '买家改了地址', shipped: '已发货' }
const SS = { none: '系统未同步', pending: '待打单发货', shipped: '已出库发货', callback_failed: '出库回传待重试', cancelled: '已取消释放' }

const STATUS_TABS = [
  { k: 'all', t: '全部订单' },
  { k: 'wait_ship', t: '待发货' },
  { k: 'virt_auto', t: '虚拟自动发卡' },
  { k: 'shipped', t: '已发货 / 完成' },
  { k: 'aftersale', t: '售后 / 取消拦截' },
]

const KIND_FILTERS = [
  { k: 'all', t: '全部类型' },
  { k: 'phys', t: '实物仓发' },
  { k: 'virt', t: '虚拟与服务' },
]

const statusTab = ref('all')
const kindFilter = ref('all')
const kw = ref('')
const showSyncPanel = ref(false)
const sel = ref(null)
const pickCode = ref('')
const trk = ref('')
const scanned = ref('')
const locked = computed(() => !state.me?.practice_done)
const rules = computed(() => state.me?.rules || {})

const SYNC_GAPS = new Set(['missed', 'unmatched', 'desync'])
function isSyncIssue (o) { return SYNC_GAPS.has(o.gap) }
const syncAnomalies = computed(() => (state.orders || []).filter(isSyncIssue))

function matchStatusTab (o, k) {
  if (k === 'all') return true
  if (k === 'virt_auto') return o.kind === 'virt'
  if (k === 'aftersale') return o.p_status === 'cancelled' || o.p_status === 'addr_changed' || o.gap === 'desync'
  if (k === 'shipped') return o.gap === 'ok' || o.s_status === 'shipped'
  if (k === 'wait_ship') return o.gap === 'pending' || o.gap === 'stuck' || o.s_status === 'pending'
  return true
}

function countByStatus (k) {
  return (state.orders || []).filter(o => matchStatusTab(o, k)).length
}

const shown = computed(() => {
  const w = kw.value.trim().toLowerCase()
  return (state.orders || []).filter(o => {
    if (!matchStatusTab(o, statusTab.value)) return false
    if (kindFilter.value === 'phys' && o.kind === 'virt') return false
    if (kindFilter.value === 'virt' && o.kind !== 'virt') return false
    if (w && !`${o.id} ${o.title} ${o.buyer} ${o.sku || ''}`.toLowerCase().includes(w)) return false
    return true
  })
})

function rowTone (o) {
  if (o.gap === 'ok') return 'grn'
  if (o.gap === 'pending') return 'amb'
  return 'red'
}

function displayStatus (o) {
  if (o.gap === 'ok') return '已完成发货'
  if (o.gap === 'pending') return '待打单出库'
  if (o.gap === 'stuck') return '超时待出库'
  return o.gap_label || '待处理'
}

const shipOk = computed(() => !locked.value && !!sel.value?.sku && !!trk.value.trim() && scanned.value.trim() === sel.value?.sku && sel.value?.p_status === 'paid')
const shipWhy = computed(() =>
  locked.value ? '先完成新人三关练习'
    : !sel.value?.sku ? '订单尚未绑定库存货号'
      : sel.value?.p_status !== 'paid' ? '平台状态为取消/改址，先同步状态'
        : !trk.value.trim() ? '请先填写快递运单号'
          : scanned.value.trim() !== sel.value?.sku ? '扫码货号与绑定单品不一致，防错发拦截' : ''
)

const fee = computed(() => {
  if (!sel.value) return { platform: 0, shipping: 0, repair: 0, other: 0, refund: 0, receivable: 0 }
  const f = feesOf(sel.value.id)
  if (sel.value.fees && !f._synced) { Object.assign(f, sel.value.fees); f._synced = true }
  return f
})
const netFee = computed(() => {
  const f = fee.value
  const rev = Number(f.receivable) > 0 ? Number(f.receivable) : (Number(sel.value?.amount) || 0)
  const cost = Number(sel.value?.cost_price) || 0
  return (rev - cost - (f.platform || 0) - (f.shipping || 0) - (f.repair || 0) - (f.other || 0) - (f.refund || 0)).toFixed(2)
})

async function saveFees () {
  if (!sel.value) return
  try {
    const r = await post(`/demo/orders/${encodeURIComponent(sel.value.id)}/fees`, {
      platform: fee.value.platform || 0,
      shipping: fee.value.shipping || 0,
      repair: fee.value.repair || 0,
      other: fee.value.other || 0,
      refund: fee.value.refund || 0,
      receivable: fee.value.receivable || 0
    })
    sel.value.fees = { ...fee.value }
    sel.value.net_profit = r.net_profit ?? Number(netFee.value)
    toast('订单费用与净收益已保存并重算提成')
  } catch (e) { toast('保存失败：' + e.message) }
}

function pick (o) { sel.value = o; pickCode.value = ''; trk.value = ''; scanned.value = '' }
async function reload () { await loadAll(true); if (sel.value) sel.value = state.orders.find(o => o.id === sel.value.id) || null }
async function act (action, body = {}) {
  try {
    const r = await post(`/demo/orders/${encodeURIComponent(sel.value.id)}/${action}`, body)
    toast(r.msg || '操作已执行')
    await loadAll()
    sel.value = state.orders.find(o => o.id === sel.value.id) || null
  } catch (e) { toast('操作未通过：' + e.message) }
}
async function report () {
  await post('/demo/exceptions', { text: `订单 ${sel.value.id}「${sel.value.title}」缺 SKU 映射，请仓管挂接` })
  toast('已提报仓管处理货号映射')
}
const goItem = (id) => { location.hash = '#/item/virt/' + id }
function fromQuery () {
  const q = new URLSearchParams(location.hash.split('?')[1] || '').get('oid')
  if (q) {
    const o = state.orders.find(x => x.id === q)
    if (o) pick(o)
  } else if (!sel.value && state.orders?.length) {
    pick(state.orders[0])
  }
}
onMounted(() => { if (!state.loaded) loadAll().then(fromQuery); else fromQuery() })
watch(() => state.orders, () => { if (!sel.value && state.orders?.length) fromQuery() })
</script>

<style scoped>
.ord-page { padding: 18px 28px 54px; max-width: 1580px; }
.ord-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 12px; }
.ord-head h1 { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.sub { color: var(--mute); font-size: 13.5px; margin-top: 4px; }
.ord-acts { display: flex; gap: 8px; align-items: center; }

.sync-pill { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 999px; background: var(--soft); border: 1px solid var(--line); font-size: 12.5px; font-weight: 600; color: var(--ink2); }
.sync-pill.warn { border-color: rgba(229, 72, 77, .45); background: var(--red-soft); color: var(--red-ink); }
.sync-pill.on { outline: 2px solid var(--acc); }
.sync-pill b { font-size: 13px; }
.sync-pill .caret { opacity: .65; font-size: 11px; }

.sync-drawer { margin-bottom: 12px; padding: 12px 16px; border: 1px solid var(--line); }
.sd-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 10px; }
.sd-head b { font-size: 13.5px; display: block; }
.sd-list { display: flex; gap: 8px; flex-wrap: wrap; }
.sd-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 9px; background: var(--soft); border: 1px solid var(--line); font-size: 12.5px; }
.sd-chip.sel { border-color: var(--acc); background: var(--acc-soft); }
.sd-t { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-empty { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--grn-ink); padding: 4px 0; }
.mini-mascot { color: var(--acc); flex: none; }
.mini-mascot.lg { color: var(--mute); }

.ord-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; margin-bottom: 12px; flex-wrap: wrap; }
.st-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.st-tab { height: 32px; padding: 0 12px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--ink2); display: inline-flex; align-items: center; gap: 6px; }
.st-tab:hover { background: var(--soft); }
.st-tab em { font-style: normal; font-size: 11px; background: var(--soft); border: 1px solid var(--line); padding: 0 6px; border-radius: 999px; color: var(--mute); }
.st-tab.on { background: var(--acc); color: #fff; }
.st-tab.on em { background: rgba(255, 255, 255, .22); color: #fff; border-color: transparent; }

.ord-filters { display: flex; gap: 8px; align-items: center; }
.kind-pills { display: flex; gap: 4px; background: var(--soft); padding: 3px; border-radius: 8px; }
.fchip { height: 26px; padding: 0 10px; border-radius: 6px; font-size: 12.5px; font-weight: 600; color: var(--mute); }
.fchip.on { background: var(--panel); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
.ord-search { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); width: 220px; }
.ord-search svg { width: 15px; height: 15px; color: var(--mute); flex: none; }
.ord-search input { border: 0; background: none; outline: none; width: 100%; font-size: 12.5px; }

.ord-split { display: grid; grid-template-columns: minmax(0, 1.35fr) 390px; gap: 16px; align-items: start; }
.ord-table-wrap { display: grid; gap: 10px; }
.qn-cols-hd { display: grid; grid-template-columns: 2.2fr 0.75fr 1fr 110px; gap: 12px; padding: 6px 14px; font-size: 12px; font-weight: 700; color: var(--mute); }
.qn-cols-hd .right { text-align: right; }

.qn-order { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; cursor: pointer; transition: border-color .12s, box-shadow .12s; }
.qn-order:hover { border-color: var(--acc); box-shadow: var(--sh); }
.qn-order.sel { border: 2px solid var(--acc); }
.qn-row-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 7px 14px; background: var(--soft); border-bottom: 1px solid var(--line); }
.qn-meta-l { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.qn-oid { font-weight: 700; font-size: 12.5px; color: var(--ink); }
.qn-row-main { display: grid; grid-template-columns: 2.2fr 0.75fr 1fr 110px; gap: 12px; align-items: center; padding: 12px 14px; }
.qn-prod { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.qn-thumb { width: 42px; height: 42px; border-radius: 9px; display: grid; place-items: center; flex: none; background: var(--acc-soft); color: var(--acc); }
.qn-thumb.virt { background: var(--amb-soft); color: var(--amb-ink); }
.qn-thumb svg { width: 20px; height: 20px; }
.qn-pinfo b { display: block; font-size: 14px; line-height: 1.35; margin-bottom: 3px; }
.qn-note { font-size: 12px; padding: 3px 8px; border-radius: 6px; display: inline-block; margin-top: 2px; }
.qn-note.red { background: var(--red-soft); color: var(--red-ink); }
.qn-note.amb { background: var(--amb-soft); color: var(--amb-ink); }
.qn-amt strong { display: block; font-size: 16px; color: var(--ink); }
.qn-buyer b { display: block; font-size: 13px; margin-bottom: 2px; }
.qn-op { text-align: right; }

.ord-empty { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 36px; border: 1px solid var(--line); }

.ord-side { position: sticky; top: 14px; }
.ord-side-placeholder { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 40px 24px; border: 1px solid var(--line); }
.det { padding: 18px; border: 1px solid var(--line); }
.dh { display: flex; align-items: center; gap: 8px; }
.dh .sm { margin-left: auto; }
.det h2 { font-size: 18px; line-height: 1.35; margin: 10px 0 12px; }
.kv.compact { grid-template-columns: 74px 1fr; gap: 6px 10px; font-size: 13px; }
.why { padding: 8px 10px; border-radius: 8px; font-size: 12.5px; margin: 10px 0; }
.why.red { background: var(--red-soft); color: var(--red-ink); }
.why.amb { background: var(--amb-soft); color: var(--amb-ink); }
.why.grn { background: var(--grn-soft); color: var(--grn-ink); }
.do { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.do h4 { font-size: 14px; margin-bottom: 8px; }
.cand { display: flex; gap: 8px; align-items: center; background: var(--soft); border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 13px; font-weight: 600; }
.f { display: grid; gap: 5px; margin: 8px 0; font-size: 12.5px; color: var(--mute); font-weight: 600; }
.f input { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; background: var(--soft); color: var(--ink); font-weight: 400; width: 100%; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; }

.fees { margin-top: 14px; padding: 12px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); }
.fees h4 { margin: 0 0 8px; font-size: 13.5px; }
.fg { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; }
.fg label { display: grid; gap: 3px; font-size: 11px; color: var(--mute); }
.fg input { height: 30px; border: 1px solid var(--line); border-radius: 7px; padding: 0 8px; background: var(--panel); color: var(--ink); font-size: 12.5px; }
.net-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 13px; }
.net-bar b { font-size: 18px; color: var(--grn-ink); }
</style>
