<template>
  <div class="cm">
    <div class="dbar">
      <button class="btn" @click="goBack">← 返回</button>
      <div class="crumb">提成账本 · 实时联动实物出库单与虚拟 / 服务交付订单</div>
    </div>

    <div class="head">
      <div>
        <h1>提成账本 <Q k="cm-main" /></h1>
        <p class="muted">按订单实际净毛利（实收 − 商品成本 − 平台/运费/返工 − 退款）实时核算成交提成、建卡人 5% 分成与上新奖；退款单自动扣回。</p>
      </div>
      <div class="acts">
        <button class="btn" :disabled="busy" @click="recalc">↻ 同步订单重算提成</button>
      </div>
    </div>

    <section class="kpis">
      <div class="card kpi"><span>已确认可发放</span><b class="grn-ink num">¥{{ sumOk.toFixed(2) }}</b><small>{{ okCount }} 笔流水</small></div>
      <div class="card kpi"><span>待确认流水</span><b class="amb-ink num">¥{{ sumPend.toFixed(2) }}</b><small>{{ pendCount }} 笔待核对</small></div>
      <div class="card kpi"><span>已退款扣回</span><b class="red-ink num">−¥{{ sumClaw.toFixed(2) }}</b><small>{{ clawCount }} 笔扣回</small></div>
      <div class="card kpi">
        <span>按人员切换</span>
        <div class="tabs">
          <button v-for="o in ownerTabs" :key="o.k" class="btn sm" :class="{ pri: ownerFilter === o.k }" @click="ownerFilter = o.k">{{ o.l }}</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="bar-top">
        <h3>提成流水明细 <small>退款或修改订单费用后会自动联动重算或标「已扣回」</small></h3>
        <div class="tabs">
          <button v-for="t in typeTabs" :key="t" class="btn sm" :class="{ pri: typeFilter === t }" @click="typeFilter = t">{{ t }}</button>
        </div>
      </div>

      <table class="tbl">
        <thead>
          <tr><th>流水号</th><th>类型</th><th>订单 / 产品</th><th>归属人</th><th>净毛利基数</th><th>比例</th><th>提成金额</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id" :class="{ hit: r.refund }">
            <td class="num">{{ r.id }}<br /><small class="muted">{{ r.at }}</small></td>
            <td><span class="tag">{{ r.type }}</span></td>
            <td>
              <b>{{ r.product }}</b>
              <div class="muted sm">订单 {{ r.order }} · SKU {{ r.sku }}<template v-if="r.cost != null">（成本 ¥{{ r.cost }} / 费用 ¥{{ r.fees }}）</template></div>
            </td>
            <td>{{ nameOf(r.owner) }}</td>
            <td class="num">¥{{ Number(r.base).toFixed(2) }}</td>
            <td class="num">{{ (r.rate * 100).toFixed(0) }}%</td>
            <td class="num">
              <b :class="r.refund ? 'red-ink' : 'grn-ink'">{{ r.refund ? '−' : '+' }}¥{{ Number(r.amount).toFixed(2) }}</b>
            </td>
            <td><span class="tag" :class="r.refund ? 'red' : r.state === '已确认' ? 'grn' : 'amb'">{{ r.state }}</span></td>
            <td>
              <div class="acts-row">
                <button v-if="!r.refund && r.state !== '已确认'" class="btn ok sm" :disabled="busy" @click="doAct(r, 'confirm')">确认</button>
                <button v-if="!r.refund" class="btn bad sm" :disabled="busy" @click="doAct(r, 'claw')">退款扣回</button>
                <button v-else class="btn sm" :disabled="busy" @click="doAct(r, 'unclaw')">撤销扣回</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card calc-box">
      <h3>口径算例验算器 <small>核对「售价 − 成本 − 费用」毛利与提成是否一致</small></h3>
      <div class="fg">
        <label>A 成交实收 (¥)<input type="number" v-model.number="calc.a" /></label>
        <label>B 商品成本 (¥)<input type="number" v-model.number="calc.b" /></label>
        <label>C 平台/运费/售后 (¥)<input type="number" v-model.number="calc.c" /></label>
        <label>提成比例 (%)<input type="number" v-model.number="calc.pct" /></label>
      </div>
      <p class="calc-res">
        单单净毛利 = ¥{{ calcMargin }} ｜ 按 {{ calc.pct }}% 提成 = <b class="grn-ink">¥{{ calcComm }}</b> ｜ 建卡人 5% 分成 = <b>¥{{ (calcMargin * 0.05).toFixed(2) }}</b>
      </p>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { loadAll, nameOf } from './store.js'
import { toast } from './ui.js'
import Q from './Q.vue'

const items = ref([])
const busy = ref(false)
const ownerFilter = ref('ALL')
const typeFilter = ref('全部')
const calc = reactive({ a: 990, b: 640, c: 28, pct: 10 })

const ownerTabs = [
  { k: 'ALL', l: '全部人员' },
  { k: 'chenxm', l: '陈小满' },
  { k: 'zhoubb', l: '周小北' }
]
const typeTabs = ['全部', '成交提成', '建卡人分成', '上新奖']

const filtered = computed(() =>
  items.value.filter((r) => (ownerFilter.value === 'ALL' || r.owner === ownerFilter.value) && (typeFilter.value === '全部' || r.type === typeFilter.value))
)
const sumOk = computed(() => filtered.value.filter((r) => !r.refund && r.state === '已确认').reduce((s, r) => s + Number(r.amount || 0), 0))
const okCount = computed(() => filtered.value.filter((r) => !r.refund && r.state === '已确认').length)
const sumPend = computed(() => filtered.value.filter((r) => !r.refund && r.state === '待确认').reduce((s, r) => s + Number(r.amount || 0), 0))
const pendCount = computed(() => filtered.value.filter((r) => !r.refund && r.state === '待确认').length)
const sumClaw = computed(() => filtered.value.filter((r) => r.refund).reduce((s, r) => s + Number(r.amount || 0), 0))
const clawCount = computed(() => filtered.value.filter((r) => r.refund).length)

const calcMargin = computed(() => Math.max(0, (calc.a || 0) - (calc.b || 0) - (calc.c || 0)).toFixed(2))
const calcComm = computed(() => ((Number(calcMargin.value) * (calc.pct || 0)) / 100).toFixed(2))

function goBack() {
  if (history.length > 1) history.back()
  else location.hash = '#/ops'
}

async function load() {
  const res = await api('/demo/commission')
  items.value = res.items || []
}

async function recalc() {
  busy.value = true
  try {
    const res = await post('/demo/commission/recalc')
    items.value = res.items || []
    await loadAll()
    toast('已根据最新订单、成本与费用重新核算提成')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function doAct(r, act) {
  busy.value = true
  try {
    const res = await post(`/demo/commission/${encodeURIComponent(r.id)}/${act}`)
    items.value = res.items || []
    await loadAll()
    toast(act === 'confirm' ? '已确认提成' : act === 'claw' ? '已执行退款扣回并更新汇总' : '已撤销扣回')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.cm { padding: 26px 40px 80px; max-width: 1520px; display: grid; gap: 18px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.head h1 { font-size: 30px; margin: 0 0 6px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; }
.kpi { display: grid; gap: 6px; padding: 16px 20px; }
.kpi span { font-size: 13px; color: var(--mute); font-weight: 600; }
.kpi b { font-size: 28px; letter-spacing: -.02em; }
.bar-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.bar-top h3 { margin: 0; }
.tabs, .acts-row { display: flex; gap: 6px; flex-wrap: wrap; }
.sm { font-size: 12px; }
.grn-ink { color: var(--grn-ink); }
.amb-ink { color: var(--amb-ink); }
.red-ink { color: var(--red-ink); }
.fg { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 10px; }
.fg label { display: grid; gap: 4px; font-size: 12.5px; color: var(--mute); }
.fg input { height: 36px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--soft); }
.calc-res { margin-top: 10px; font-size: 15px; }
</style>
