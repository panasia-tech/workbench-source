<template>
  <div class="pb">
    <div class="dbar">
      <button class="btn" @click="goBack">← 返回</button>
      <div class="crumb">采购价格表 · 联动步入式价格清洗 & 选品授权上限</div>
    </div>

    <div class="head">
      <div>
        <h1>采购价格表 <Q k="pb-main" /></h1>
        <p class="muted">维护采购参考价、建议报价、授权上限与实付净成本；改价后可人工二审直接生效并生成 7 天有效版本，支持一键回退旧版，无需主管阻塞审批。</p>
      </div>
      <div class="acts">
        <button class="btn pri" @click="addOpen = true">+ 新增采购型号</button>
      </div>
    </div>

    <!-- 过滤 + 批量调整 -->
    <section class="card toolbar">
      <div class="trow">
        <div class="tabs">
          <button v-for="s in statuses" :key="s" class="btn sm" :class="{ pri: stFilter === s }" @click="stFilter = s">{{ s }} ({{ countBy(s) }})</button>
        </div>
        <div class="batch">
          <span>已选 <b>{{ picked.length }}</b> 行</span>
          <label>调幅 % <input type="number" class="inp-sm" v-model.number="pct" /></label>
          <button class="btn sm" :disabled="!picked.length" @click="preview">预览调价</button>
          <button class="btn ok sm" :disabled="!picked.length || busy" @click="applyBatch(true)">批量二审并直接生效</button>
        </div>
      </div>

      <div v-if="pv.length" class="pvbox">
        <b>批量调价预览（{{ pct >= 0 ? '+' : '' }}{{ pct }}%）：</b>
        <span v-for="x in pv" :key="x.id" class="tag">{{ x.model }}：建议 ¥{{ x.suggest }} / 上限 ¥{{ x.limit }}</span>
        <button class="btn sm" @click="pv = []">关闭预览</button>
      </div>
    </section>

    <section class="card tbl-card">
      <table class="tbl">
        <thead>
          <tr>
            <th><input type="checkbox" :checked="allPicked" @change="toggleAll($event.target.checked)" /></th>
            <th>型号与配置</th>
            <th>参考行情价</th>
            <th>建议报价</th>
            <th>采购授权上限</th>
            <th>谈妥 / 实付 / 返利</th>
            <th>实盘净成本</th>
            <th>状态与有效期</th>
            <th>反馈与备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.id">
            <td><input type="checkbox" :value="r.id" v-model="picked" /></td>
            <td>
              <b>{{ r.model }}</b>
              <div class="muted sm">{{ r.config }} · {{ r.id }}</div>
            </td>
            <td><input type="number" class="num-inp" v-model.number="r.ref" @change="patchRow(r, { ref: r.ref })" /></td>
            <td><input type="number" class="num-inp" v-model.number="r.suggest" @change="patchRow(r, { suggest: r.suggest })" /></td>
            <td><input type="number" class="num-inp" v-model.number="r.limit" @change="patchRow(r, { limit: r.limit })" /></td>
            <td>
              <div class="triple">
                <input type="number" class="num-inp xs" title="谈妥价" v-model.number="r.deal" @change="patchRow(r, { deal: r.deal })" />
                <input type="number" class="num-inp xs" title="实付" v-model.number="r.paid" @change="patchRow(r, { paid: r.paid })" />
                <input type="number" class="num-inp xs" title="返利" v-model.number="r.rebate" @change="patchRow(r, { rebate: r.rebate })" />
              </div>
              <small v-if="r.deal && r.paid && r.deal !== r.paid" class="amb-ink">验货差异 ¥{{ (r.paid - r.deal).toFixed(0) }}</small>
            </td>
            <td class="num"><b>¥{{ netCost(r) }}</b></td>
            <td>
              <span class="tag" :class="stCls(r.status)">{{ r.status }} · {{ r.ver }}</span>
              <div class="muted sm">{{ r.from }} ~ {{ r.to }}</div>
            </td>
            <td><input type="text" class="fb-inp" v-model="r.fb" placeholder="采购/销售反馈" @change="patchRow(r, { fb: r.fb })" /></td>
            <td>
              <div class="acts-row">
                <button class="btn sm" @click="goClean(r)">价格清洗</button>
                <button class="btn ok sm" :disabled="busy" @click="confirmRow(r)">二审生效</button>
                <button v-if="r._prev" class="btn sm" :disabled="busy" @click="rollbackRow(r)">回退</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="addOpen" class="mask" @click.self="addOpen = false">
      <div class="modal">
        <h3>新增采购参考行</h3>
        <div class="mform">
          <label>型号 *<input v-model="draft.model" placeholder="例如：Nintendo Switch OLED 日版" /></label>
          <label>配置与成色<input v-model="draft.config" placeholder="例如：单机 95 新" /></label>
          <label>参考行情价 (¥)<input type="number" v-model.number="draft.ref" /></label>
          <label>建议报价 (¥)<input type="number" v-model.number="draft.suggest" /></label>
          <label>采购授权上限 (¥)<input type="number" v-model.number="draft.limit" /></label>
          <label>实付成本 (¥)<input type="number" v-model.number="draft.paid" /></label>
        </div>
        <div class="mfoot">
          <button class="btn" @click="addOpen = false">取消</button>
          <button class="btn pri" :disabled="busy" @click="createRow">保存并直接二审生效</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { toast } from './ui.js'
import Q from './Q.vue'

const items = ref([])
const picked = ref([])
const stFilter = ref('全部')
const pct = ref(-5)
const pv = ref([])
const busy = ref(false)
const addOpen = ref(false)
const draft = reactive({ model: '', config: '', ref: 0, suggest: 0, limit: 0, paid: 0 })

const statuses = ['全部', '已生效', '待核', '维护中', '已失效']

const filtered = computed(() => (stFilter.value === '全部' ? items.value : items.value.filter((r) => r.status === stFilter.value)))
const allPicked = computed(() => filtered.value.length > 0 && filtered.value.every((r) => picked.value.includes(r.id)))

const countBy = (s) => (s === '全部' ? items.value.length : items.value.filter((x) => x.status === s).length)
const netCost = (r) => Math.max(0, Number(r.paid || r.deal || 0) - Number(r.rebate || 0))
const stCls = (s) => (s === '已生效' ? 'grn' : s === '已失效' ? 'red' : 'amb')

function goBack() {
  if (history.length > 1) history.back()
  else location.hash = '#/ops'
}

function toggleAll(on) {
  picked.value = on ? filtered.value.map((r) => r.id) : []
}

function preview() {
  pv.value = items.value
    .filter((r) => picked.value.includes(r.id))
    .map((r) => ({
      id: r.id,
      model: r.model,
      suggest: Math.round((r.suggest || 0) * (1 + pct.value / 100)),
      limit: Math.round((r.limit || 0) * (1 + pct.value / 100))
    }))
}

async function load() {
  const res = await api('/demo/pricebook')
  items.value = res.items || []
}

async function patchRow(r, body) {
  try {
    const u = await api(`/demo/pricebook/${encodeURIComponent(r.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
    Object.assign(r, u)
  } catch (e) {
    toast(e.message)
  }
}

async function confirmRow(r) {
  busy.value = true
  try {
    const u = await post(`/demo/pricebook/${encodeURIComponent(r.id)}/confirm`, {
      ref: r.ref, suggest: r.suggest, limit: r.limit, deal: r.deal, paid: r.paid, rebate: r.rebate, fb: r.fb
    })
    Object.assign(r, u)
    toast(`${r.model} 已二审生效为 ${u.ver}（有效期至 ${u.to}）`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function rollbackRow(r) {
  busy.value = true
  try {
    const u = await post(`/demo/pricebook/${encodeURIComponent(r.id)}/rollback`)
    Object.assign(r, u)
    delete r._prev
    toast(`${r.model} 已回退到上一版本 ${u.ver}`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function applyBatch(directConfirm) {
  if (!picked.value.length) return
  busy.value = true
  try {
    const res = await post('/demo/pricebook/batch', { ids: picked.value, pct: pct.value, directConfirm })
    items.value = res.items || []
    pv.value = []
    picked.value = []
    toast(`已批量更新并直接生效 ${res.changed} 行`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function createRow() {
  busy.value = true
  try {
    await post('/demo/pricebook', { ...draft, deal: draft.paid, directConfirm: true })
    addOpen.value = false
    Object.assign(draft, { model: '', config: '', ref: 0, suggest: 0, limit: 0, paid: 0 })
    await load()
    toast('已写入采购价格表并生效（同时生成对应清洗快照任务）')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

function goClean(r) {
  location.hash = '#/price-cleaning/' + encodeURIComponent(r.id)
}

onMounted(load)
</script>

<style scoped>
.pb { padding: 26px 38px 80px; max-width: 1620px; display: grid; gap: 16px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.head h1 { font-size: 30px; margin: 0 0 6px; }
.toolbar { display: grid; gap: 10px; padding: 14px 18px; }
.trow { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tabs, .batch, .acts-row, .triple { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.inp-sm { width: 70px; height: 30px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); }
.pvbox { background: var(--acc-soft); padding: 8px 12px; border-radius: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.tbl-card { overflow-x: auto; }
.num-inp { width: 78px; height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); font-weight: 700; }
.num-inp.xs { width: 64px; }
.fb-inp { width: 140px; height: 32px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); font-size: 12.5px; }
.amb-ink { color: var(--amb-ink); font-size: 11.5px; display: block; margin-top: 2px; }
.sm { font-size: 12px; }
.mask { position: fixed; inset: 0; z-index: 80; background: rgba(8,12,22,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal { width: min(560px, 95vw); background: var(--panel); border-radius: 20px; padding: 22px; box-shadow: var(--sh-up); }
.mform { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
.mform label { display: grid; gap: 4px; font-size: 12.5px; color: var(--mute); }
.mform input { height: 36px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--soft); }
.mfoot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
