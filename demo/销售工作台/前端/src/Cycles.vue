<template>
  <div class="page cy">
    <header class="head">
      <div><p class="eyebrow">F01 · F03 · C03</p><h1>周期交付 / 复盘 / 研究<Q k="cy-main" /></h1>
        <p class="sub">每周一 09:00 交一期：这一期抓了什么、全量清单、图片快照、原始价格、漏跑和补跑。经营结果回到选品：继续、扩大、调整、暂停、退出；客户反复问但做不了的进机会池。</p></div>
      <button class="btn" @click="resetAll">恢复演示数据</button>
    </header>

    <div class="tabs"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}<em>{{ t.n() }}</em></button></div>

    <section v-if="tab === 'cycles'" class="sec">
      <div class="cycle" v-for="c in db.cycles" :key="c.id">
        <div class="ch"><div><span class="tag" :class="c.status === '已交付' ? 'grn' : c.status === '已补跑' ? 'acc' : c.status === '有漏跑' ? 'red' : 'amb'">{{ c.status }}</span><b>{{ c.id }}</b><span class="muted">{{ c.at }}</span></div>
          <button class="btn sm" @click="openCycle(c)">{{ open === c.id ? '收起' : '看这一期' }}</button></div>
        <p class="muted">{{ c.scope }}<template v-if="c.note"> · {{ c.note }}</template></p>
        <div class="cf"><span>已采 <b>{{ c.items.toLocaleString() }}</b> 条</span><span>图片快照 <b>{{ c.images }}</b></span><span>原始价格 <b>{{ c.prices.toLocaleString() }}</b></span><span v-if="c.missed" class="tag red">漏跑 {{ c.missed }}</span></div>
        <div v-if="open === c.id" class="cd">
          <div class="cdg">
            <div><h4>全量清单（演示）</h4><table class="tbl"><thead><tr><th>来源</th><th>条目</th><th>价格</th><th>卖家</th></tr></thead><tbody><tr v-for="x in sampleItems(c)" :key="x.n"><td>{{ x.src }}</td><td>{{ x.n }}</td><td class="num">{{ x.p }}</td><td>{{ x.s }}</td></tr></tbody></table></div>
            <div><h4>原始价格历史</h4><table class="tbl"><thead><tr><th>型号</th><th>本期</th><th>上期</th><th>变化</th></tr></thead><tbody><tr v-for="x in samplePrices()" :key="x.m"><td>{{ x.m }}</td><td class="num">¥{{ x.a }}</td><td class="num">¥{{ x.b }}</td><td :class="x.a > x.b ? 'up' : 'down'">{{ x.a > x.b ? '+' : '' }}{{ x.a - x.b }}%</td></tr></tbody></table></div>
          </div>
          <div class="ca"><span class="muted">图片快照：{{ c.snap || '还没生成' }}</span>
            <button v-if="c.status === '未开始'" class="btn sm pri" @click="deliver(c)">生成本期快照并交付</button>
            <button v-if="c.missed && c.status !== '已补跑'" class="btn sm" @click="rerun(c)">补跑漏掉的 {{ c.missed }} 项</button>
            <button class="btn sm" @click="go('sources')">去来源台账看采集 ›</button></div>
        </div>
      </div>
      <div class="card add"><h4>下一期</h4><p class="muted">周一 09:00 自动交；没交要写原因和补跑计划。期次、范围、版本都留在这里，历史不覆盖。</p><button class="btn pri" @click="addCycle">+ 排下一期</button></div>
    </section>

    <section v-else-if="tab === 'theme'" class="sec">
      <div class="card"><h4>本周主题任务<small class="muted">　每周只调研一个主题，范围写清楚</small></h4>
        <div v-for="t in db.themes" :key="t.week" class="th"><div><b>{{ t.week }} · {{ t.theme }}</b><p class="muted">{{ t.scope }} · 基线 {{ t.base }} · 负责人 {{ nameOf(t.owner) }} · 截止 {{ t.due }}</p></div><span class="tag" :class="t.state === '进行中' ? 'amb' : 'grn'">{{ t.state }}</span></div>
        <div class="form"><input v-model="nt.week" placeholder="周，例如 2026-W47" /><input v-model="nt.theme" placeholder="主题，例如 手表" /><input v-model="nt.scope" placeholder="范围，例如 智能手表 / 表带" /><input v-model="nt.due" placeholder="截止 11-23" /><button class="btn pri" @click="addTheme">排主题</button></div>
      </div>
    </section>

    <section v-else-if="tab === 'review'" class="sec">
      <div class="card"><h4>经营复盘<small class="muted">　用真实结果决定：继续 / 扩大 / 调整 / 暂停 / 退出</small></h4>
        <div v-for="p in reviewables" :key="p.id" class="rv"><div class="rh"><b>{{ p.name }}</b><span class="muted">{{ p.id }} · 本周 {{ p.week_sales || 0 }} 单 · 退款率 {{ ((p.refund_rate || 0) * 100).toFixed(1) }}%</span></div>
          <div class="ra"><select v-model="rv[p.id].decision"><option v-for="d in DEC" :key="d">{{ d }}</option></select><input v-model="rv[p.id].note" placeholder="依据：净收益、退款、耗时、返工" /><button class="btn sm pri" @click="saveReview(p)">存结论</button><span v-if="db.reviews[p.id]" class="tag" :class="db.reviews[p.id].decision === '退出' ? 'red' : db.reviews[p.id].decision === '暂停' ? 'amb' : 'grn'">当前：{{ db.reviews[p.id].decision }}</span></div>
          <p v-if="db.reviews[p.id]" class="muted sm">{{ db.reviews[p.id].at }} · {{ db.reviews[p.id].note }}</p>
        </div>
      </div>
      <div class="card" style="margin-top: 14px"><h4>机会池<small class="muted">　客户反复问、暂时做不了的，不丢</small></h4>
        <div v-for="o in db.opportunities" :key="o.id" class="op"><span class="tag" :class="o.state === '已立项' ? 'grn' : 'amb'">{{ o.state }}</span><span>{{ o.text }}</span><span class="muted">{{ o.from }} · {{ o.at }}</span><button class="btn sm" @click="o.state = o.state === '待研究' ? '已立项' : '待研究'">{{ o.state === '待研究' ? '立项' : '放回' }}</button></div>
        <div class="form"><input v-model="no.text" placeholder="客户反复问的需求" /><input v-model="no.from" placeholder="来自哪个产品" /><button class="btn pri" @click="addOpp">进机会池</button></div>
      </div>
    </section>

    <section v-else class="sec">
      <div class="card"><h4>浙江餐饮 / 新品牌周期研究<small class="muted">　杭州、温州、台州；商场名录、渠道路径、小额实操都要留证</small></h4>
        <table class="tbl"><thead><tr><th>城市</th><th>品牌 / 门店</th><th>商场 / 位置</th><th>渠道路径</th><th>小额实操</th><th>状态</th><th></th></tr></thead><tbody>
          <tr v-for="z in db.zhejiang" :key="z.id"><td>{{ z.city }}</td><td><b>{{ z.brand }}</b></td><td>{{ z.mall }}</td><td>{{ z.channel }}</td><td>{{ z.test }}</td><td><span class="tag" :class="z.state === '已核验' ? 'grn' : z.state === '失败' ? 'red' : 'amb'">{{ z.state }}</span></td><td><button class="btn sm" @click="z.state = z.state === '待核' ? '已核验' : '待核'">切换</button></td></tr>
        </tbody></table>
        <div class="form"><input v-model="nz.city" placeholder="城市" /><input v-model="nz.brand" placeholder="品牌 / 门店" /><input v-model="nz.mall" placeholder="商场 / 位置" /><input v-model="nz.channel" placeholder="渠道 / 路径" /><button class="btn pri" @click="addZ">加一行</button></div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import Q from './Q.vue'
import { finalDb as db, uid } from './demoFinal.js'
import { state } from './store.js'
import { toast } from './ui.js'
import { resetFinal } from './demoFinal.js'

const TABS = [
  { k: 'cycles', t: '周期交付', n: () => db.cycles.length },
  { k: 'theme', t: '本周主题', n: () => db.themes.length },
  { k: 'review', t: '经营复盘', n: () => Object.keys(db.reviews).length },
  { k: 'zhejiang', t: '浙江餐饮研究', n: () => db.zhejiang.length }
]
const tab = ref('cycles'), open = ref('')
const DEC = ['继续', '扩大', '调整', '暂停', '退出']
const nameOf = (u) => (state.pool || {})[u] || u || ''
const go = (h) => { location.hash = '#/' + h }
const reviewables = computed(() => state.items.filter((i) => i.kind !== 'phys'))
const rv = reactive({})
for (const p of reviewables.value) rv[p.id] = { decision: db.reviews[p.id]?.decision || '继续', note: db.reviews[p.id]?.note || '' }
function saveReview(p) { db.reviews[p.id] = { decision: rv[p.id].decision, note: rv[p.id].note, at: new Date().toISOString().slice(5, 10) }; toast('已存复盘结论：' + rv[p.id].decision) }
function openCycle(c) { open.value = open.value === c.id ? '' : c.id }
const sampleItems = (c) => [
  { src: '闲鱼 43 类目榜', n: Math.max(1, Math.round(c.items * 0.42)), p: '¥30–¥9,800', s: '4,120' },
  { src: '爱回收 / Bookoff', n: Math.max(1, Math.round(c.items * 0.31)), p: '¥80–¥12,000', s: '—' },
  { src: '淘宝 / 京东卡券榜', n: Math.max(1, Math.round(c.items * 0.18)), p: '¥9.9–¥299', s: '860' },
  { src: '评论区 / 卖家库', n: Math.max(1, Math.round(c.items * 0.09)), p: '—', s: '1,203' }
]
const samplePrices = () => [{ m: '27M2N5510P', a: 899, b: 870 }, { m: 'iPhone 15 Pro 256G', a: 4899, b: 4950 }, { m: 'Mac mini M4', a: 3399, b: 0 }]
function deliver(c) { c.status = '已交付'; c.items = 1800 + Math.floor(Math.random() * 60); c.images = 600; c.prices = 8044; c.snap = new Date().toLocaleString('zh-CN', { hour12: false }); toast('本期快照已生成（演示）') }
function rerun(c) { c.status = '已补跑'; c.missed = 0; c.note += '；已补跑'; toast('漏跑已补，历史保留') }
function addCycle() { const n = db.cycles.length + 46; db.cycles.push({ id: 'C-2026-W' + n, at: '2026-11-23 09:00', status: '未开始', scope: '待定', items: 0, images: 0, prices: 0, missed: 0, note: '', snap: '' }); toast('已排下一期') }
const nt = reactive({ week: '', theme: '', scope: '', due: '' })
function addTheme() { if (!nt.week || !nt.theme) return toast('周和主题都要写'); db.themes.unshift({ ...nt, owner: 'chenxm', state: '进行中', base: '上一期全量库' }); nt.week = nt.theme = nt.scope = nt.due = ''; toast('已排主题') }
const no = reactive({ text: '', from: '' })
function addOpp() { if (!no.text.trim()) return toast('写一句需求'); db.opportunities.unshift({ id: uid('OP'), text: no.text.trim(), from: no.from || '—', at: new Date().toISOString().slice(5, 10), state: '待研究' }); no.text = no.from = ''; toast('已进机会池') }
const nz = reactive({ city: '', brand: '', mall: '', channel: '' })
function addZ() { if (!nz.city || !nz.brand) return toast('城市和品牌要写'); db.zhejiang.unshift({ id: uid('ZJ'), ...nz, test: '待做', state: '待核' }); nz.city = nz.brand = nz.mall = nz.channel = ''; toast('已加一行') }
function resetAll() { resetFinal(); toast('演示数据已恢复') }
</script>

<style scoped>
.cy { padding: 30px 40px 80px; max-width: 1560px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .cy h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sub { margin: 0; color: var(--mute); max-width: 920px; line-height: 1.7; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 18px 0 14px; } .tabs button { height: 38px; padding: 0 16px; border-radius: 999px; background: var(--panel); box-shadow: var(--sh); font-weight: 700; font-size: 14px; color: var(--ink2); display: inline-flex; align-items: center; gap: 8px; } .tabs button.on { background: var(--ink); color: var(--bg); } .tabs em { font-style: normal; font-size: 12px; opacity: .7; }
.sec { display: grid; gap: 12px; } .cycle { background: var(--panel); border-radius: 18px; padding: 16px 18px; box-shadow: var(--sh); } .ch { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; } .ch > div { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .ch b { font-size: 17px; }
.cf { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 13.5px; color: var(--ink2); } .cf b { font-size: 16px; }
.cd { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); } .cdg { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; } .cd h4 { margin: 0 0 6px; font-size: 15px; } .ca { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.up { color: var(--red-ink); font-weight: 700; } .down { color: var(--grn-ink); font-weight: 700; }
.th { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); } .th b { font-size: 16px; } .form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; } .form input { flex: 1; min-width: 140px; height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--soft); color: var(--ink); }
.rv { padding: 12px 0; border-top: 1px solid var(--line); } .rh { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; } .ra { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; } .ra select, .ra input { height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 8px; background: var(--soft); color: var(--ink); } .ra input { flex: 1; min-width: 220px; }
.op { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; } .op > span:nth-child(2) { flex: 1; min-width: 220px; }
.card h4 { margin: 0 0 10px; font-size: 16px; } .card h4 small { font-weight: 400; }
</style>
