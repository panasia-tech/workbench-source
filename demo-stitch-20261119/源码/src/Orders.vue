<template>
  <div class="page">
    <header class="head">
      <div><h1>订单<Q k="orders" /></h1><p class="sub">系统自动抓闲鱼付款订单。抓得不对的有四种，都跳红：<b>漏抓、对不上货、卡住没走、状态不同步</b>。</p></div>
      <div class="acts"><button class="btn" @click="openHelp('orders')"><Icon name="help" />怎么用</button><button class="btn" @click="reload"><Icon name="refresh" />刷新</button></div>
    </header>
    <div class="rule">发货时限：<b>实物当天 17:00 前</b>（17:00 以后付款的顺延到次日 17:00）；<b>虚拟付款 1 分钟内</b>。超了就跳红。<Q k="o-deadline" /><span class="tag amb">演示数据 · 平台回执是模拟的</span></div>

    <div class="seg"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k"><i v-if="t.dot" class="dot" :class="t.dot"></i>{{ t.t }}<em>{{ cnt(t.k) }}</em></button></div>

    <div class="cols">
      <div class="list">
        <article v-for="o in shown" :key="o.id" class="o" :class="[o.lvl, { sel: sel?.id === o.id }]" @click="pick(o)">
          <span class="tag" :class="o.lvl === 'red' ? 'red' : o.lvl === 'amb' ? 'amb' : 'grn'">{{ o.gap_label }}</span><Q v-if="GK[o.gap]" :k="GK[o.gap]" />
          <h3>{{ o.title }}</h3>
          <p class="mt"><span>¥{{ o.amount }}</span><span>{{ o.buyer }}</span><span>付款 {{ o.paid }}</span><span class="tag">{{ o.kind === 'virt' ? '虚拟' : '实物' }}</span></p>
          <p v-if="o.why" class="why" :class="o.lvl">{{ o.why }}</p>
        </article>
        <p v-if="!shown.length" class="empty">这一类现在没有订单。</p>
      </div>

      <aside class="side">
        <div v-if="!sel" class="card muted" style="padding: 40px 28px; text-align: center">点左边一笔订单，这里写它为什么红、该做什么。</div>
        <div v-else class="card det">
          <div class="dh"><span class="tag" :class="sel.lvl === 'red' ? 'red' : sel.lvl === 'amb' ? 'amb' : 'grn'">{{ LV[sel.lvl].icon }} {{ sel.gap_label }}</span><Q v-if="GK[sel.gap]" :k="GK[sel.gap]" /><span class="muted">{{ sel.id }}</span></div>
          <h2>{{ sel.title }}</h2>
          <dl class="kv"><dt>买家</dt><dd>{{ sel.buyer }}</dd><dt>金额</dt><dd>¥{{ sel.amount }}</dd><dt>付款</dt><dd>{{ sel.paid }}</dd><dt>平台状态</dt><dd>{{ PS[sel.p_status] }}</dd><dt>系统状态</dt><dd>{{ SS[sel.s_status] }}</dd><dt>货号</dt><dd>{{ sel.sku || '还没对上' }}</dd></dl>
          <p v-if="sel.why" class="why big" :class="sel.lvl">{{ sel.why }}</p>
          <p v-if="sel.note" class="muted" style="margin: 8px 0">{{ sel.note }}</p>

          <div class="fees"><h4>费用、成本与净收益<Q k="o-fees" /></h4>
            <div class="fg"><label>平台费<input v-model.number="fee.platform" type="number" /></label><label>运费<input v-model.number="fee.shipping" type="number" /></label><label>维修 / 返工<input v-model.number="fee.repair" type="number" /></label><label>其它费用<input v-model.number="fee.other" type="number" /></label><label>实际退款<input v-model.number="fee.refund" type="number" /></label><label>实收(空按成交价)<input v-model.number="fee.receivable" type="number" /></label></div>
            <p class="net">净收益 = {{ fee.receivable > 0 ? '实收' : '成交' }} ¥{{ fee.receivable > 0 ? fee.receivable : sel.amount }} − 商品成本 ¥{{ sel.cost_price || 0 }} − 费用 ¥{{ ((fee.platform || 0) + (fee.shipping || 0) + (fee.repair || 0) + (fee.other || 0)) }} − 退款 ¥{{ fee.refund || 0 }} = <b>¥{{ netFee }}</b> <button class="btn pri sm" @click="saveFees">保存费用并重算提成</button></p>
            <p class="muted sm">退款要分「申请 / 平台处理中 / 实际到账」；补差、采购退款回原单。这里先把费用和净收益记下来，真数据等 ERP 财务口径（C13）。</p></div>
          <div class="do">
            <template v-if="sel.id.startsWith('V-')">
              <p class="muted">虚拟订单在产品卡里处理：放行被拦的单，或者先补货。</p>
              <button class="btn pri" @click="goItem(sel.vpid)">去产品卡处理</button>
            </template>
            <template v-else-if="sel.gap === 'missed'">
              <h4>下一步</h4><p class="muted">先把它补抓进系统，再选货。</p>
              <Lock :ok="!locked" reason="先做完练习" @go="act('capture')">补抓进系统</Lock>
            </template>
            <template v-else-if="sel.gap === 'unmatched'">
              <h4>下一步：选是哪一件货</h4>
              <p class="muted">{{ sel.unmatched === 'same_model' ? '同款有多件在库，只能从下面选，已被别的订单占用的不能选。' : '这个商品还没有挂到库存货号，请仓管先挂映射；你也可以先手动选一件。' }}</p>
              <label v-for="c in sel.candidates" :key="c" class="cand"><input type="radio" name="cand" :value="c" v-model="pickCode" />{{ c }}</label>
              <template v-if="!sel.candidates.length"><p class="why red">没有候选货：缺映射。先找仓管把这个闲鱼商品挂到库存货号，别随便找一件发。</p><button class="btn" @click="report">报给仓管挂映射</button></template>
              <Lock :ok="!!pickCode && !locked" :reason="locked ? '先做完练习' : '先选一件货'" @go="act('bind', { sku_code: pickCode })">绑定这件货</Lock>
            </template>
            <template v-else-if="sel.gap === 'desync'">
              <h4>下一步</h4>
              <template v-if="sel.s_status === 'callback_failed'"><p class="muted">已经出库了，只是回传平台失败。先查平台实际状态，再重传，不要盲目重发。</p><Lock :ok="!locked" reason="先做完练习" @go="act('retry-callback')">重传回传</Lock></template>
              <template v-else><p class="muted">买家已{{ sel.p_status === 'cancelled' ? '取消订单' : '改了地址' }}。先同步平台状态，再决定释放货或换单。出库前不能发。</p>
                <Lock :ok="!locked" reason="先做完练习" @go="act('resync')">{{ sel.p_status === 'cancelled' ? '按平台状态取消，释放货' : '改成买家的新地址' }}</Lock></template>
            </template>
            <template v-else-if="sel.gap === 'stuck' || sel.gap === 'pending'">
              <h4>发货出库</h4>
              <label class="f">快递运单号<input v-model="trk" placeholder="发货后粘贴运单号（买家自提无需运单号）" /></label>
              <label class="f">扫码核对货号<span class="row"><input v-model="scanned" placeholder="扫码或输入货号，要和上面的货号一致" /><button class="btn sm" @click="scanned = sel.sku || ''">演示：模拟扫码</button></span></label>
              <Lock :ok="shipOk" :reason="shipWhy" :penalty="rules.ship?.penalty" @go="act('ship', { tracking_no: trk, scanned })">确认出库</Lock>
              <p class="muted" style="margin-top: 8px">{{ rules.ship?.deadline }}</p>
            </template>
            <template v-else><p class="muted">这笔已经正常完成。</p></template>
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
import { finalDb, feesOf } from './demoFinal.js'
import { post } from './api.js'
import { openHelp, toast } from './ui.js'
const GK = { missed: 'o-missed', unmatched: 'o-unmatched', stuck: 'o-stuck', desync: 'o-desync', pending: 'o-pending' }

const TABS = [{ k: 'all', t: '全部' }, { k: 'missed', t: '漏抓', dot: 'red' }, { k: 'unmatched', t: '对不上货', dot: 'red' }, { k: 'stuck', t: '卡住没走', dot: 'red' }, { k: 'desync', t: '状态不同步', dot: 'red' }, { k: 'pending', t: '待发货', dot: 'amb' }, { k: 'ok', t: '正常', dot: 'grn' }]
const PS = { paid: '已付款', cancelled: '买家已取消', addr_changed: '买家改了地址', shipped: '已发货' }
const SS = { none: '系统里没有', pending: '待发货', shipped: '已发货', callback_failed: '已出库，回传失败', cancelled: '已取消' }
const tab = ref('all')
const sel = ref(null)
const pickCode = ref('')
const trk = ref('')
const scanned = ref('')
const locked = computed(() => !state.me?.practice_done)
const rules = computed(() => state.me?.rules || {})
const cnt = (k) => (k === 'all' ? state.orders.length : state.orders.filter((o) => o.gap === k).length)
const shown = computed(() => state.orders.filter((o) => tab.value === 'all' || o.gap === tab.value))
const shipOk = computed(() => !locked.value && !!sel.value?.sku && !!trk.value.trim() && scanned.value.trim() === sel.value?.sku && sel.value?.p_status === 'paid')
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
async function saveFees() {
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
    toast('订单费用与净收益已落库，已自动联动重算提成账本')
  } catch (e) { toast('保存失败：' + e.message) }
}
const shipWhy = computed(() => locked.value ? '先做完练习' : !sel.value?.sku ? '这笔订单还没对上货，先去选货' : sel.value?.p_status !== 'paid' ? '买家已取消或改了地址，先同步状态' : !trk.value.trim() ? '快递运单号还没填' : scanned.value.trim() !== sel.value?.sku ? '扫码的货号和订单要发的货号不一致' : '')

function pick(o) { sel.value = o; pickCode.value = ''; trk.value = ''; scanned.value = '' }
async function reload() { await loadAll(true); if (sel.value) sel.value = state.orders.find((o) => o.id === sel.value.id) || null }
async function act(action, body = {}) {
  try {
    const r = await post(`/demo/orders/${encodeURIComponent(sel.value.id)}/${action}`, body)
    toast(r.msg || '已处理（演示）')
    await loadAll()
    sel.value = state.orders.find((o) => o.id === sel.value.id) || null
  } catch (e) { toast('没办成：' + e.message) }
}
async function report() { await post('/demo/exceptions', { text: `订单 ${sel.value.id}「${sel.value.title}」缺映射，要仓管把闲鱼商品挂到库存货号` }); toast('已报给仓管并在异常清单留痕') }
const goItem = (id) => { location.hash = '#/item/virt/' + id }
function fromQuery() { const q = new URLSearchParams(location.hash.split('?')[1] || '').get('oid'); if (q) { const o = state.orders.find((x) => x.id === q); if (o) pick(o) } }
onMounted(() => { if (!state.loaded) loadAll().then(fromQuery); else fromQuery() })
watch(() => state.orders, () => { if (!sel.value) fromQuery() })
</script>

<style scoped>
.page { padding: 34px 44px 80px; max-width: 1500px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; } .acts { display: flex; gap: 10px; } .acts svg { width: 18px; height: 18px; }
h1 { font-size: 38px; letter-spacing: -.02em; font-weight: 800; } .sub { color: var(--mute); margin-top: 8px; max-width: 720px; }
.rule { margin-top: 18px; background: var(--soft); border-radius: 16px; padding: 12px 18px; font-size: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.seg { display: flex; gap: 6px; flex-wrap: wrap; margin: 20px 0; } .seg button { display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px; border-radius: 999px; background: var(--panel); box-shadow: var(--sh); font-weight: 700; font-size: 14px; color: var(--ink2); } .seg button.on { background: var(--ink); color: var(--bg); } .seg em { font-style: normal; font-size: 12px; opacity: .7; }
.cols { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 24px; align-items: start; } @media (max-width: 1200px) { .cols { grid-template-columns: 1fr; } }
.list { display: grid; gap: 14px; } .o { background: var(--panel); border-radius: 20px; padding: 16px 20px; box-shadow: var(--sh); cursor: pointer; border-left: 8px solid var(--line); transition: transform .12s; } .o:hover { transform: translateX(3px); } .o.red { border-left-color: var(--red); } .o.amb { border-left-color: var(--amb); } .o.grn { border-left-color: var(--grn); } .o.sel { outline: 3px solid var(--acc); }
.o h3 { font-size: 17px; margin: 8px 0 4px; } .mt { display: flex; gap: 14px; flex-wrap: wrap; color: var(--mute); font-size: 13.5px; align-items: center; }
.why { margin-top: 10px; font-size: 13.5px; padding: 8px 12px; border-radius: 12px; } .why.red { background: var(--red-soft); color: var(--red-ink); } .why.amb { background: var(--amb-soft); color: var(--amb-ink); } .why.grn { background: var(--grn-soft); color: var(--grn-ink); } .why.big { font-size: 15px; font-weight: 600; margin: 14px 0; }
.empty { color: var(--mute); padding: 40px 0; text-align: center; }
.side { position: sticky; top: 20px; } .det h2 { font-size: 24px; margin: 8px 0 14px; line-height: 1.3; } .dh { display: flex; justify-content: space-between; align-items: center; }
.do { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); } .do h4 { font-size: 16px; margin-bottom: 8px; }
.fees { margin-top: 14px; padding: 12px; border-radius: 12px; background: var(--soft); } .fees h4 { margin: 0 0 8px; font-size: 14.5px; } .fg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; } @media (max-width: 700px) { .fg { grid-template-columns: 1fr 1fr; } } .fg label { display: grid; gap: 3px; font-size: 11.5px; color: var(--mute); } .fg input { height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--panel); color: var(--ink); } .net { margin: 10px 0 4px; font-size: 13px; } .net b { font-size: 18px; color: var(--grn-ink); } .cand { display: flex; gap: 10px; align-items: center; background: var(--soft); border-radius: 12px; padding: 10px 14px; margin: 8px 0; font-weight: 600; cursor: pointer; }
.f { display: grid; gap: 6px; margin: 12px 0; font-size: 13.5px; color: var(--mute); font-weight: 600; } .f input { height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; background: var(--panel); color: var(--ink); font-weight: 400; width: 100%; } .row { display: flex; gap: 8px; } .row input { flex: 1; }
</style>
