<template>
  <div class="iq">
    <div class="dbar">
      <button class="btn" @click="goBack">← 返回</button>
      <div class="crumb">询单与报价 · 归属锁定、产品底线检查、成交转实单</div>
    </div>

    <div class="head">
      <div>
        <h1>询单与报价 <Q k="iq-main" /></h1>
        <p class="muted">每条询单同一时间只归属一名销售，报价自动对照产品卡成本底线，客户接受后一键转入正式订单并触发提成重算。</p>
      </div>
      <button class="btn pri" @click="newOpen = true">+ 新建买家询单</button>
    </div>

    <div class="iq-grid">
      <!-- 左侧列表 -->
      <section class="card list-card">
        <div class="tabs">
          <button v-for="s in states" :key="s" class="btn sm" :class="{ pri: flt === s }" @click="flt = s">{{ s }}</button>
        </div>
        <div class="qrows">
          <button v-for="q in filtered" :key="q.id" class="qrow" :class="{ cur: sel?.id === q.id }" @click="sel = q">
            <div class="qt">
              <b>{{ q.buyer }} · {{ q.platform }}</b>
              <span class="tag" :class="stCls(q.state)">{{ q.state }}</span>
            </div>
            <div class="qp">{{ q.product }}</div>
            <div class="qb muted">
              <span>{{ q.id }} · 归属：{{ q.owner ? nameOf(q.owner) : '待认领' }}</span>
              <b class="num">¥{{ q.amount }}</b>
            </div>
          </button>
        </div>
      </section>

      <!-- 右侧详情 -->
      <section v-if="sel" class="card det-card">
        <div class="dh">
          <div>
            <div class="dt-tags">
              <span class="tag acc">{{ sel.id }}</span>
              <span class="tag">{{ sel.platform }} · {{ sel.source }}</span>
              <span class="tag" :class="stCls(sel.state)">{{ sel.state }}</span>
              <span v-if="sel.order_id" class="tag grn">已转订单 {{ sel.order_id }}</span>
            </div>
            <h2>{{ sel.buyer }} 咨询「{{ sel.product }}」</h2>
            <p class="muted sm">来询时间 {{ sel.at }} ｜ 当前归属：<b>{{ sel.owner ? nameOf(sel.owner) : '未归属' }}</b></p>
          </div>
          <div class="acts">
            <button v-if="!sel.owner || sel.owner !== myUser" class="btn pri sm" :disabled="busy" @click="claim">{{ sel.owner ? '接手归属' : '我来接' }}</button>
            <button v-if="sel.state !== '已成交' && sel.state !== '已丢单'" class="btn ok sm" :disabled="busy" @click="toOrder">✓ 客户确定，转成订单</button>
          </div>
        </div>

        <p v-if="readOnly" class="ro-warn">该询单归属「{{ nameOf(sel.owner) }}」，你当前为只读（点右上「接手归属」后才可报价和跟进，防止两人重复报价）。</p>

        <!-- 关联产品卡底线参考 -->
        <div v-if="linkedProd" class="floor-ref">
          <span>关联产品卡成本参考：<b>{{ linkedProd.name }}</b></span>
          <span>进价 ¥{{ linkedProd.cost }} ｜ 售价底线 ({{ linkedProd.floor_pct }}%)：<b>¥{{ linkedProd.floor_price || Math.round(linkedProd.cost * linkedProd.floor_pct / 100) }}</b> ｜ 当前定价 ¥{{ linkedProd.price }}</span>
        </div>

        <!-- 报价版本 -->
        <div class="blk">
          <h4>报价版本记录</h4>
          <div v-if="sel.quotes?.length" class="ver-box">
            <div v-for="v in sel.quotes" :key="v.v" class="vrow" :class="{ acc: v.accepted }">
              <b>v{{ v.v }} · ¥{{ v.price }}</b>
              <span class="muted">效期 {{ v.valid }} · {{ v.note || '无备注' }}</span>
              <span v-if="v.warn" class="tag red">{{ v.warn }}</span>
              <span v-if="v.accepted" class="tag grn">客户已选定</span>
              <button v-else-if="!readOnly && sel.state !== '已成交'" class="btn sm" :disabled="busy" @click="acceptQuote(v.v)">标为客户接受</button>
            </div>
          </div>
          <p v-else class="muted sm">还没有报过价，可在下方新增第 1 版报价。</p>

          <div v-if="!readOnly && sel.state !== '已成交' && sel.state !== '已丢单'" class="qform">
            <input type="number" v-model.number="qPrice" placeholder="报价金额 ¥" />
            <input type="text" v-model="qValid" placeholder="效期(如 7天)" />
            <input type="text" v-model="qNote" placeholder="报价说明 / 交付范围" />
            <button class="btn pri sm" :disabled="busy || !qPrice" @click="sendQuote">+ 发出新版报价</button>
          </div>
        </div>

        <!-- 跟进与丢单 -->
        <div class="blk">
          <h4>跟进留痕与结果闭环</h4>
          <ul class="flw">
            <li v-for="(f, i) in sel.follow" :key="i"><b>{{ f.t }}</b> {{ f.text }}</li>
            <li v-if="!sel.follow?.length" class="muted">暂无跟进记录</li>
          </ul>
          <div v-if="!readOnly && sel.state !== '已成交'" class="qform">
            <input type="text" v-model="fText" placeholder="记录本轮沟通要点..." />
            <button class="btn sm" :disabled="busy || !fText.trim()" @click="addFollow">记录跟进</button>
          </div>
          <div v-if="!readOnly && sel.state !== '已成交' && sel.state !== '已丢单'" class="lost-row">
            <input type="text" v-model="lostReason" placeholder="如果丢单：写清原因（至少 4 个字，如 嫌贵 / 暂无需求）" />
            <button class="btn bad sm" :disabled="busy || lostReason.trim().length < 4" @click="markLost">标记丢单</button>
          </div>
          <p v-if="sel.lost" class="ro-warn">丢单原因：{{ sel.lost }}</p>
        </div>
      </section>
    </div>

    <div v-if="newOpen" class="mask" @click.self="newOpen = false">
      <div class="modal">
        <h3>新建买家询单</h3>
        <div class="mform">
          <label>买家称呼 *<input v-model="nd.buyer" placeholder="例如：闲鱼小王" /></label>
          <label>来源平台
            <select v-model="nd.platform">
              <option>闲鱼</option><option>小红书</option><option>淘宝</option><option>京东</option>
            </select>
          </label>
          <label class="full">关联虚拟/服务产品卡（自动校验底线并支持转订单）
            <select v-model="nd.pid" @change="onPickProd">
              <option value="">-- 手填产品名称 --</option>
              <option v-for="p in vProds" :key="p.id" :value="p.id">{{ p.name }}（售价 ¥{{ p.price }} / 底线 ¥{{ p.floor_price }}）</option>
            </select>
          </label>
          <label v-if="!nd.pid" class="full">手填产品名<input v-model="nd.product" placeholder="产品名称" /></label>
          <label>意向金额 (¥)<input type="number" v-model.number="nd.amount" /></label>
          <label>触达渠道<input v-model="nd.source" placeholder="如 闲鱼搜索" /></label>
        </div>
        <div class="mfoot">
          <button class="btn" @click="newOpen = false">取消</button>
          <button class="btn pri" :disabled="busy || !nd.buyer.trim()" @click="createInq">建单并归属我</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, me, post } from './api.js'
import { loadAll, nameOf } from './store.js'
import { toast } from './ui.js'
import Q from './Q.vue'

const items = ref([])
const vProds = ref([])
const sel = ref(null)
const flt = ref('全部')
const busy = ref(false)
const qPrice = ref('')
const qValid = ref('7天')
const qNote = ref('')
const fText = ref('')
const lostReason = ref('')
const newOpen = ref(false)
const nd = reactive({ buyer: '', platform: '闲鱼', pid: '', product: '', amount: 0, source: '闲鱼搜索' })

const myUser = computed(() => me().username || 'chenxm')
const states = ['全部', '新询', '跟进中', '已报价', '待客户', '已成交', '已丢单']
const filtered = computed(() => (flt.value === '全部' ? items.value : items.value.filter((x) => x.state === flt.value)))
const readOnly = computed(() => sel.value && sel.value.owner && sel.value.owner !== myUser.value)
const linkedProd = computed(() => (sel.value?.pid ? vProds.value.find((p) => p.id === sel.value.pid) : null))

const stCls = (s) => (s === '已成交' ? 'grn' : s === '已丢单' ? 'red' : s === '待客户' ? 'acc' : 'amb')

function goBack() {
  if (history.length > 1) history.back()
  else location.hash = '#/ops'
}

function onPickProd() {
  const p = vProds.value.find((x) => x.id === nd.pid)
  if (p) {
    nd.product = p.name
    nd.amount = p.price
  }
}

async function load() {
  const [iq, vp] = await Promise.all([api('/demo/inquiries'), api('/virtual/products').catch(() => ({ items: [] }))])
  items.value = iq.items || []
  vProds.value = vp.items || []
  if (sel.value) sel.value = items.value.find((x) => x.id === sel.value.id) || items.value[0] || null
  else sel.value = items.value[0] || null
}

async function claim() {
  if (!sel.value) return
  busy.value = true
  try {
    const u = await api(`/demo/inquiries/${encodeURIComponent(sel.value.id)}`, { method: 'PATCH', body: JSON.stringify({ owner: myUser.value }) })
    Object.assign(sel.value, u)
    toast('已锁定归属为你本人')
  } finally {
    busy.value = false
  }
}

async function sendQuote() {
  if (!sel.value || !qPrice.value) return
  busy.value = true
  try {
    const res = await post(`/demo/inquiries/${encodeURIComponent(sel.value.id)}/quote`, {
      price: Number(qPrice.value), valid: qValid.value, note: qNote.value
    })
    Object.assign(sel.value, res.item)
    qPrice.value = ''
    qNote.value = ''
    toast(res.warn ? '报价已发出，注意：' + res.warn : '新版报价已发出')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function acceptQuote(v) {
  busy.value = true
  try {
    const u = await post(`/demo/inquiries/${encodeURIComponent(sel.value.id)}/accept`, { v })
    Object.assign(sel.value, u)
    toast(`已选定 v${v} 报价，可以直接转为正式订单`)
  } finally {
    busy.value = false
  }
}

async function addFollow() {
  busy.value = true
  try {
    const u = await post(`/demo/inquiries/${encodeURIComponent(sel.value.id)}/follow`, { text: fText.value })
    Object.assign(sel.value, u)
    fText.value = ''
  } finally {
    busy.value = false
  }
}

async function toOrder() {
  busy.value = true
  try {
    const res = await post(`/demo/inquiries/${encodeURIComponent(sel.value.id)}/to-order`)
    Object.assign(sel.value, res.item)
    await loadAll()
    toast(res.msg)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function markLost() {
  busy.value = true
  try {
    const u = await post(`/demo/inquiries/${encodeURIComponent(sel.value.id)}/lost`, { reason: lostReason.value })
    Object.assign(sel.value, u)
    lostReason.value = ''
    toast('已归档丢单原因')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function createInq() {
  busy.value = true
  try {
    const row = await post('/demo/inquiries', { ...nd, owner: myUser.value })
    newOpen.value = false
    Object.assign(nd, { buyer: '', platform: '闲鱼', pid: '', product: '', amount: 0, source: '闲鱼搜索' })
    await load()
    sel.value = items.value.find((x) => x.id === row.id) || items.value[0]
    toast('询单已建立')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.iq { padding: 26px 38px 80px; max-width: 1580px; display: grid; gap: 16px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.head h1 { font-size: 30px; margin: 0 0 6px; }
.iq-grid { display: grid; grid-template-columns: 380px 1fr; gap: 16px; align-items: start; }
.list-card { display: grid; gap: 10px; }
.tabs { display: flex; gap: 5px; flex-wrap: wrap; }
.qrows { display: grid; gap: 8px; max-height: 620px; overflow-y: auto; }
.qrow { text-align: left; padding: 12px; border-radius: 14px; background: var(--soft); border: 2px solid transparent; display: grid; gap: 4px; }
.qrow.cur { border-color: var(--acc); background: var(--acc-soft); }
.qt, .qb { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
.qp { font-size: 13.5px; font-weight: 600; }
.det-card { display: grid; gap: 16px; }
.dh { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.dt-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.dh h2 { margin: 0 0 4px; font-size: 22px; }
.acts { display: flex; gap: 8px; }
.ro-warn { background: var(--amb-soft); color: var(--amb-ink); padding: 9px 12px; border-radius: 10px; font-size: 13px; margin: 0; }
.floor-ref { background: var(--acc-soft); padding: 10px 14px; border-radius: 12px; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 13.5px; }
.blk { border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 10px; }
.blk h4 { margin: 0; }
.ver-box { display: grid; gap: 6px; }
.vrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-radius: 10px; background: var(--soft); }
.vrow.acc { border: 1.5px solid var(--grn); background: var(--grn-soft); }
.qform, .lost-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.qform input, .lost-row input { flex: 1; min-width: 140px; height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--soft); }
.flw { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; font-size: 13.5px; }
.sm { font-size: 12px; }
.mask { position: fixed; inset: 0; z-index: 80; background: rgba(8,12,22,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { width: min(560px, 95vw); background: var(--panel); border-radius: 20px; padding: 22px; box-shadow: var(--sh-up); }
.mform { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
.mform .full { grid-column: 1 / -1; }
.mform label { display: grid; gap: 4px; font-size: 12.5px; color: var(--mute); }
.mform input, .mform select { height: 36px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--soft); }
.mfoot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
