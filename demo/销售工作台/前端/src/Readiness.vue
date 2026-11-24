<template>
  <div class="page rd">
    <header class="head">
      <div><p class="eyebrow">交付自检 · 禅道 62 条</p><h1>缺口闭环看板<Q k="rd-main" /></h1>
        <p class="zen">禅道产品 3 现 <b>65 条</b>：62 条原有 + 3 条新草稿 <a href="https://zentao.panasia.fun/story-view-112.html" target="_blank">#112 步入式价格清洗</a> · <a href="https://zentao.panasia.fun/story-view-113.html" target="_blank">#113 BOOKOFF 类目映射</a> · <a href="https://zentao.panasia.fun/story-view-114.html" target="_blank">#114 爬取资产取舍</a>（草稿，等评审）。</p>
        <p class="sub">这是这次 UI 整改的验收入口：哪条已经在演示里闭环、哪条本来就覆盖、哪条归 ERP / 群控 / 仓管 / 钉钉 / 程序员。点「去看」直接到对应页面。演示闭环不等于生产完成，真数据接口在右侧写明。</p></div>
      <button class="btn" @click="exportCsv">导出清单 CSV</button>
    </header>

    <section class="prog">
      <div class="bar"><i :style="{ width: (closedCount / rows.length) * 100 + '%', background: 'var(--grn)' }"></i><i :style="{ width: (externalCount / rows.length) * 100 + '%', background: 'var(--amb)' }"></i></div>
      <div class="pl"><span><i class="dot grn"></i>UI 已闭环 {{ closedCount }}</span><span><i class="dot amb"></i>待外部 {{ externalCount }}</span><span><i class="dot"></i>合计 {{ rows.length }}</span></div>
    </section>

    <div class="filters"><button v-for="f in FILTERS" :key="f.k" :class="{ on: flt === f.k }" @click="flt = f.k">{{ f.t }}<em>{{ f.n() }}</em></button>
      <input v-model="q" placeholder="搜编号 / 需求" /></div>

    <div class="card tblwrap">
      <table class="tbl"><thead><tr><th>编号</th><th>需求</th><th>状态</th><th>归属</th><th>原来的缺口 / 现在怎么闭环</th><th></th></tr></thead><tbody>
        <tr v-for="r in shown" :key="r.id" :class="r._c">
          <td><code>#{{ r.id }}</code></td><td><b>{{ r.title }}</b></td>
          <td><span class="tag" :class="r._c === 'grn' ? 'grn' : r._c === 'amb' ? 'amb' : 'acc'">{{ r._label }}</span></td>
          <td>{{ OWN[r.owner] || r.owner }}</td>
          <td class="ms">{{ r.missing || '—' }}</td>
          <td class="ac"><a v-if="link(r.id)" @click="go(r.id)">去看 ›</a><span v-else class="muted">—</span></td>
        </tr>
      </tbody></table>
    </div>

    <section class="notes">
      <div class="card"><h4>怎么算「闭环」</h4><p class="muted">UI 已闭环 = 销售工作台里有页面、字段、动作，能用演示数据走通；真数据（ERP / 群控 / 仓管 / 钉钉）仍按归属等外部系统。待外部 = 本来就不该做在销售 UI 里，硬塞会做错。演示闭环的条目，页面里都标了「演示」。</p></div>
      <div class="card"><h4>还没闭环的真数据</h4><p class="muted">ERP/群控：发布回执、联动下架、收退款费用、账号主页、盘点；程序员：闲鱼关键词/卖家库、四路图、去水印、OCR 兜底、大站持续采集、卡券榜、Grok 线索池、MCP 配置；钉钉：OKR/KPI/OA。对应待办 B16–B20、C11–C14。</p></div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import Q from './Q.vue'
import { auditRows } from './auditData.js'
import { toast } from './ui.js'

const OWN = { 'sales-ui': '销售工作台', erp: 'ERP / 群控', warehouse: '仓管工作台', dingtalk: '钉钉', programmer: '程序员', other: '其它系统' }
const rows = reactive(auditRows.map((r) => {
  const uiClosed = r.owner === 'sales-ui'
  return { ...r, _c: uiClosed ? (r.ui === 'covered' ? 'grn' : 'grn') : 'amb', _label: uiClosed ? (r.ui === 'covered' ? '已覆盖' : '演示已闭环') : '待外部' }
}))
const FILTERS = [
  { k: 'all', t: '全部', n: () => rows.length },
  { k: 'closed', t: 'UI 已闭环', n: () => closedCount.value },
  { k: 'external', t: '待外部', n: () => externalCount.value }
]
const flt = ref('all'), q = ref('')
const closedCount = computed(() => rows.filter((r) => r.owner === 'sales-ui').length)
const externalCount = computed(() => rows.filter((r) => r.owner !== 'sales-ui').length)
const shown = computed(() => rows.filter((r) => (flt.value === 'all' || (flt.value === 'closed' ? r.owner === 'sales-ui' : r.owner !== 'sales-ui')) && (!q.value || (r.id + r.title).includes(q.value.trim()))))
const LINK = {
  13: '#/today', 14: '#/selvirt', 15: '#/me', 16: '#/selphys', 17: '#/selphys', 22: '#/selvirt', 23: '#/crm', 24: '#/cycles', 25: '#/selvirt', 26: '#/selvirt', 27: '#/skills', 29: '#/skills', 30: '#/reception', 37: '#/cycles', 39: '#/cycles', 72: '#/today', 77: '#/inquiry', 83: '#/selvirt', 89: '#/selphys', 92: '#/pricebook', 93: '#/selvirt', 100: '#/gallery/phys', 103: '#/selvirt', 106: '#/program', 107: '#/commission', 109: '#/reception', 102: '#/gallery/phys', 88: '#/today', 95: '#/gallery/all',
  21: '#/orders', 34: '#/gallery/phys', 35: '#/gallery/phys', 36: '#/today', 38: '#/orders', 40: '#/orders', 42: '#/orders', 43: '#/orders', 44: '#/orders', 45: '#/orders', 46: '#/orders', 85: '#/orders', 87: '#/today', 101: '#/gallery/all', 111: '#/gallery/phys',
  18: '#/bookoff', 19: '#/sources', 20: '#/sources', 28: '#/skills', 31: '#/gallery/phys', 32: '#/gallery/phys', 33: '#/gallery/phys', 41: '#/orders', 90: '#/sources', 91: '#/sources', 104: '#/sources', 105: '#/selvirt', 110: '#/gallery/phys',
  70: '#/today', 76: '#/today'
}
const link = (id) => LINK[id] || ''
const go = (id) => { const h = LINK[id]; if (h) location.hash = h; else toast('这条没有对应页面（归外部系统）') }
function exportCsv() {
  const head = '编号,需求,状态,归属,缺口\n'
  const body = rows.map((r) => [r.id, r.title, r._label, OWN[r.owner] || r.owner, r.missing].map((x) => `"${String(x || '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob(['﻿' + head + body], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '禅道62条_UI闭环清单.csv'; a.click(); toast('已导出 CSV')
}
</script>

<style scoped>
.rd { padding: 30px 40px 80px; max-width: 1640px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .rd h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sub { margin: 0; color: var(--mute); max-width: 980px; line-height: 1.7; }
.zen { margin: 10px 0 0; padding: 9px 12px; border-radius: 10px; background: var(--amb-soft); color: var(--amb-ink); font-size: 12.5px; line-height: 1.7; } .prog { margin: 18px 0 10px; } .prog .bar { height: 16px; } .pl { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 8px; font-size: 13px; color: var(--ink2); } .pl i { margin-right: 5px; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 10px 0 12px; } .filters button { height: 34px; padding: 0 14px; border-radius: 999px; background: var(--panel); box-shadow: var(--sh); font-weight: 700; font-size: 13px; display: inline-flex; gap: 6px; align-items: center; } .filters button.on { background: var(--ink); color: var(--bg); } .filters em { font-style: normal; font-size: 12px; opacity: .7; } .filters input { margin-left: auto; height: 36px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--panel); color: var(--ink); min-width: 200px; }
.tblwrap { padding: 0; overflow-x: auto; } .tbl { min-width: 1080px; } .tbl td { vertical-align: top; } .tbl b { font-size: 13.5px; } .ms { color: var(--mute); font-size: 12.5px; max-width: 520px; } .ac { white-space: nowrap; }
.notes { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; } .notes h4 { margin: 0 0 6px; font-size: 15px; } .notes p { font-size: 13px; line-height: 1.7; }
</style>
