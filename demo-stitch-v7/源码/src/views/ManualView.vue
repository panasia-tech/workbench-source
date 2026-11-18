<template>
  <div class="dpage">
    <div class="ph">
      <div>
        <h1>说明书 · 页面 SOP、防呆矩阵与仓内术语</h1>
        <p class="sub">所有页面右上角「?」抽屉内容汇总于此 · 支持关键词检索，员工上报并由主管定案的新规则也会自动沉淀到这里</p>
      </div>
      <input
        v-model="kw"
        class="inp"
        style="width:320px"
        placeholder="搜操作、防呆原因或术语（如 坏货全检 / 附件袋 / 拒签）…"
      />
    </div>

    <!-- 一线新沉淀规则（来自「今天 -> 遇到没见过的情况 -> 主管记成规则」） -->
    <div v-if="ruledExceptions.length" class="card" style="margin-bottom:14px;border-left:4px solid var(--acc)">
      <div class="ch">
        <h2>最新沉淀的一线实战补充规则（{{ ruledExceptions.length }} 条）</h2>
        <span class="tag acc">来自「遇到没见过的情况」主管定案</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div v-for="ex in ruledExceptions" :key="ex.id" class="why-box grn" style="margin:0">
          <b>{{ ex.id }}（{{ ex.who }} 上报 · {{ ex.t }}）：</b>{{ ex.text }}
        </div>
      </div>
    </div>

    <!-- 核心业务术语速查 -->
    <div class="card" style="margin-bottom:14px">
      <h2>核心仓管防呆术语速查</h2>
      <div class="term-grid" style="margin-top:10px">
        <div v-for="[term, desc] in filteredTerms" :key="term" class="term-box">
          <b>{{ term }}</b>
          <p class="muted" style="font-size:13px;margin-top:4px">{{ desc }}</p>
        </div>
      </div>
    </div>

    <!-- 各模块标准作业与防呆矩阵 -->
    <div style="display:flex;flex-direction:column;gap:12px">
      <div v-for="sec in filteredSections" :key="sec.key" class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:8px">
          <h2>{{ sec.title }}</h2>
          <button class="btn sm ghost" @click="go(sec.key)">去该页面 ›</button>
        </div>

        <div class="kv" style="margin-bottom:10px">
          <span class="k">什么时候用</span><span>{{ sec.when }}</span>
          <span class="k">谁来负责</span><span>{{ sec.who }}</span>
          <span class="k">做成什么样算完</span><span>{{ sec.success }}</span>
          <span class="k">边界与叫停红线</span><span style="color:var(--red);font-weight:600">{{ sec.stop }}</span>
        </div>

        <Fold
          title="标准操作步骤与防呆拦截矩阵"
          :model-value="Boolean(openMap[sec.key] || kw.trim().length > 0)"
          @update:model-value="v => (openMap[sec.key] = v)"
        >
          <template #chips>
            <span class="chip">{{ sec.steps.length }} 步标准动作</span>
            <span class="chip">{{ (sec.guards || []).length }} 条硬拦截</span>
          </template>
          <ol style="margin:0 0 12px 18px;font-size:13px;line-height:1.7">
            <li v-for="(st, i) in sec.steps" :key="i">{{ st }}</li>
          </ol>

          <table v-if="sec.guards && sec.guards.length" class="tbl">
            <thead>
              <tr>
                <th>触发前置场景</th>
                <th>容易犯的错</th>
                <th>系统怎么硬拦</th>
                <th>正确做法与恢复方式</th>
                <th style="width:100px">责任与留证</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(g, gi) in sec.guards" :key="gi">
                <td>{{ g.pre }}</td>
                <td style="color:var(--red)">{{ g.mistake }}</td>
                <td><b>{{ g.block }}</b></td>
                <td>{{ g.tip }}（{{ g.recover }}）</td>
                <td class="muted" style="font-size:12px">{{ g.owner }}<br />{{ g.evidence }}</td>
              </tr>
            </tbody>
          </table>
        </Fold>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import Fold from '../components/Fold.vue'
import { store, HELP_DICT, GLOSSARY, go } from '../store/warehouseStore.js'

const kw = ref('')
const openMap = reactive({ orders: true, locations: true })
const MAIN_KEYS = ['today', 'supervisor', 'boss', 'orders', 'asn', 'courier', 'inspect', 'outbound', 'locations', 'ledger', 'legacy-wash', 'battery', 'gallery', 'detail', 'anomaly', 'media', 'aux', 'stocktake', 'standards', 'readiness', 'learn']

const ruledExceptions = computed(() => (store.data.exceptions || []).filter(e => e.ruled))

const filteredTerms = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return Object.entries(GLOSSARY).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q))
})

const filteredSections = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return MAIN_KEYS.map(k => ({ key: k === 'detail' ? 'gallery' : k, ...HELP_DICT[k] })).filter(sec => {
    if (!sec.title) return false
    if (!q) return true
    const blob = JSON.stringify(sec).toLowerCase()
    return blob.includes(q)
  })
})
</script>

<style scoped>
.term-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.term-box {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
}
</style>
