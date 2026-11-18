<template>
  <div class="pe">
    <!-- 五阶段：提交 / 验收 / 退回 / 版本 -->
    <section class="card">
      <h4>经营五阶段 · 材料留痕与直接推进<Q k="pe-stages" /> <small class="muted">第 1 步系统梳理，第 2 步人工二审确认后直接推进，无主管审批卡点</small></h4>
      <ol class="stg">
        <li v-for="s in st" :key="s.n" :class="s.state"><i>{{ s.state === 'done' ? '✓' : s.n }}</i><div><b>{{ s.name }}</b><small>{{ s.ver || '还没版本' }} · {{ s.note || '还没交材料' }}</small><span v-if="s.review" class="tag" :class="s.review === '通过' ? 'grn' : 'red'">{{ s.review }}</span></div></li>
      </ol>
      <div v-if="cur" class="submit">
        <input v-model="cur.note" placeholder="本阶段材料：同行摸底 / 供给核验 / 实操结果 / 经营方案 / 复盘" />
        <button class="btn sm pri" @click="submitStage">提交本阶段</button>
        <template v-if="cur.state === 'submitted'"><button class="btn sm ok" @click="reviewStage('通过')">人工二审确认生效</button><button class="btn sm" @click="reviewStage('退回')">退回补材料（写意见）</button></template>
        <span class="muted sm">重提不覆盖：每次提交版本 +1，旧意见保留。</span>
      </div>
      <div class="rvact"><b>复盘决定：</b><select v-model="rv.decision"><option v-for="d in DEC" :key="d">{{ d }}</option></select><input v-model="rv.note" placeholder="依据：净收益、退款、耗时、返工" /><button class="btn sm" @click="saveReview">存复盘</button><span v-if="db.reviews[p.id]" class="tag" :class="db.reviews[p.id].decision === '退出' ? 'red' : db.reviews[p.id].decision === '暂停' ? 'amb' : 'grn'">当前：{{ db.reviews[p.id].decision }}</span></div>
      <p class="muted sm">暂停后要安排存量订单；恢复前重新核供给、规则、能力；调整后下一单再验证。</p>
    </section>

    <!-- 票券 / 交通 / 住宿交付条件 -->
    <section class="card">
      <h4>票券 / 交通 / 住宿 · 交付条件<Q k="pe-ticket" /> <small class="muted">这些条件必须随订单留版本，改退按当时版本</small></h4>
      <div class="tf">
        <label>园区 / 场馆<input v-model="tk.park" placeholder="例如 雪窦山" /></label><label>日期<input v-model="tk.date" placeholder="2026-11-20" /></label>
        <label>票种<input v-model="tk.type" placeholder="成人 / 儿童 / 双人" /></label><label>游客<input v-model="tk.visitor" placeholder="谁去 / 几张" /></label>
        <label class="ck"><input type="checkbox" v-model="tk.realName" />需要实名预约</label>
        <label>出票状态<select v-model="tk.issue"><option>未出票</option><option>已出票</option><option>出票失败</option></select></label>
        <label>预约状态<select v-model="tk.book"><option>未预约</option><option>已预约</option><option>预约失败</option></select></label>
        <label>承运方<input v-model="tk.carrier" placeholder="大巴 / 铁路 / 航司" /></label><label>上下车站点<input v-model="tk.station" placeholder="出发 → 到达" /></label>
        <label>班次 / 时间<input v-model="tk.depart" placeholder="11-20 08:30" /></label><label>时区<input v-model="tk.tz" placeholder="北京时间 / 当地时间" /></label>
        <label>住宿房源<input v-model="tk.hotel" placeholder="民宿 / 酒店" /></label><label>晚数<input v-model.number="tk.nights" type="number" /></label>
        <label>住客<input v-model.number="tk.guests" type="number" /></label><label>全费用<input v-model.number="tk.total" type="number" /></label>
      </div>
      <input v-model="tk.refund" class="wide" placeholder="改退条件：谁承担、提前多久、退到哪里" />
      <p class="muted sm">当前版本 {{ tk.ver }}；改一次条件，版本 +1，历史订单仍按旧版。</p>
    </section>

    <!-- 利润类型 / 阶段量化 -->
    <section class="card">
      <h4>利润类型 · 阶段量化<Q k="pe-profit" /></h4>
      <div class="tf"><label>利润从哪来<select v-model="pf.type"><option>价差</option><option>代订</option><option>组合拆分</option><option>服务费</option></select></label><label>客户为什么付<input v-model="pf.reason" placeholder="省时间 / 有资格 / 组合稀缺" /></label><label>可持续性<select v-model="pf.lasting"><option>长期</option><option>限期</option><option>待核</option></select></label></div>
      <div class="metrics"><div><span>唯一机会</span><b>{{ p.step >= 1 ? '1' : '0' }}</b></div><div><span>已核路径</span><b>{{ p.sourcing?.main ? '1' : '0' }}</b></div><div><span>实测</span><b>{{ p.step >= 5 ? '通过' : '未做' }}</b></div><div><span>独立复现</span><b>{{ p.step >= 6 ? '通过' : '未做' }}</b></div><div><span>实际订单</span><b>{{ p.week_sales || 0 }}</b></div><div><span>净贡献</span><b>¥{{ net }}</b></div></div>
      <div class="tf" style="margin-top:8px">
        <label>阶段预算 (¥)<input type="number" v-model.number="exCfg.stageBudget" /></label>
        <label>退款止损线 (%)<input type="number" v-model.number="exCfg.stopLossPct" step="0.5" /></label>
        <label>复查周期 (天)<input type="number" v-model.number="exCfg.recheckDays" /></label>
        <div style="display:flex;align-items:flex-end"><button class="btn sm pri" @click="saveExCfg">保存预算与止损阈值</button></div>
      </div>
    </section>

    <!-- 程序化交付 / 预约 / 接单承诺 -->
    <section class="card">
      <h4>程序化交付 · 预约<Q k="pe-program" /> <small class="muted">能标准化的服务才做成预约码</small></h4>
      <div v-if="p.kind === 'svc'">
        <p class="muted">这项服务{{ canProgram ? '可以' : '暂不建议' }}包装成卡券 / 预约码。预约码、时段、核销、取消释放、回执回原单在「程序化交付」里做。</p>
        <button class="btn pri sm" @click="goProgram">打开程序化交付 ›</button>
        <div class="res"><b>接单承诺：</b><span v-if="capPct >= 90" class="tag amb">本周产能 {{ capPct }}%：不接急单，转同行</span><span v-else class="tag grn">本周产能 {{ capPct }}%：可以接</span><input v-model="rs.commit" placeholder="承诺写清：几小时、谁来做、做不到怎么转" /><button class="btn sm" @click="saveRes">存承诺</button></div>
      </div>
      <p v-else class="muted">卡券类走卡密 / 代充，不走预约。</p>
    </section>

    <!-- 订单状态 / 提成 -->
    <section class="card">
      <h4>订单状态 · 提成<Q k="pe-order" /></h4>
      <div class="flow5"><span v-for="s in ['展示', '查看', '兑换', '核销', '到账']" :key="s" :class="{ on: p.kind === 'virt' }">{{ s }}</span></div>
      <p class="muted sm">卡券要把「展示 / 查看 / 兑换 / 核销 / 实际到账」分开；现在是演示状态。</p>
      <div class="rvact"><b>提成：</b><span class="muted">交付人 {{ p.kind === 'svc' ? '20%' : '10%' }} / 建卡人 5%；退款扣回。</span><button class="btn sm" @click="goComm">去提成账本 ›</button></div>
    </section>

    <!-- 机会池 -->
    <section class="card wide">
      <h4>机会池<Q k="pe-opp" /> <small class="muted">客户反复问、暂时做不了的，不丢</small></h4>
      <div v-for="o in db.opportunities" :key="o.id" class="op"><span class="tag" :class="o.state === '已立项' ? 'grn' : 'amb'">{{ o.state }}</span><span>{{ o.text }}</span><span class="muted">{{ o.from }}</span><button class="btn sm" @click="o.state = o.state === '待研究' ? '已立项' : '待研究'">{{ o.state === '待研究' ? '立项' : '放回' }}</button></div>
      <div class="opadd"><input v-model="opp" placeholder="客户反复问、暂时做不了的需求" /><button class="btn sm" @click="addOpp">进机会池</button></div>
    </section>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import Q from './Q.vue'
import { finalDb as db, stagesOf, ticketOf, profitOf, reserveOf } from './demoFinal.js'
import { toast } from './ui.js'

const props = defineProps({ p: Object })
const DEC = ['继续', '扩大', '调整', '暂停', '退出']
const st = computed(() => stagesOf(props.p.id))
const cur = computed(() => st.value.find((s) => s.state === 'doing' || s.state === 'submitted'))
const rv = reactive({ decision: db.reviews[props.p.id]?.decision || '继续', note: db.reviews[props.p.id]?.note || '' })
const tk = computed(() => ticketOf(props.p.id))
const pf = computed(() => profitOf(props.p.id))
const rs = computed(() => reserveOf(props.p.id))
const net = computed(() => (props.p.price ? ((props.p.price - props.p.cost) * (props.p.week_sales || 0)).toFixed(0) : '0'))
const capPct = computed(() => (props.p.capacity ? Math.round((props.p.capacity.booked / props.p.capacity.week_limit) * 100) : 0))
const canProgram = computed(() => props.p.kind === 'svc' && !['topup'].includes(props.p.delivery))
const opp = reactive({ text: '' })
watch(() => props.p.id, () => { rv.decision = db.reviews[props.p.id]?.decision || '继续'; rv.note = db.reviews[props.p.id]?.note || '' })

function submitStage() {
  const s = cur.value
  if (!s) return toast('五个阶段都做完了')
  if (!s.note.trim()) return toast('先写本阶段材料')
  const n = Number((s.ver || 'v0').replace(/\D/g, '')) + 1
  s.ver = 'v' + n; s.state = 'submitted'; s.review = ''
  toast(`已提交 ${s.name} ${s.ver}，点击「人工二审确认生效」即可直接推进下一阶段`)
}
const exCfg = ref({ stageBudget: 500, stopLossPct: 8, recheckDays: 7 })
const exHdr = () => ({ Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || ''), 'Content-Type': 'application/json' })
fetch('/api/demo/product-extras/' + encodeURIComponent(props.p.id), { headers: exHdr() })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d) exCfg.value = { stageBudget: Number(d.stageBudget ?? 500), stopLossPct: Number(d.stopLossPct ?? 8), recheckDays: Number(d.recheckDays ?? 7) } })
  .catch(() => {})
async function saveExCfg() {
  try {
    const r = await fetch('/api/demo/product-extras/' + encodeURIComponent(props.p.id), {
      method: 'PUT', headers: exHdr(), body: JSON.stringify(exCfg.value)
    })
    if (!r.ok) throw new Error('保存失败')
    toast('阶段预算与止损阈值已保存到服务端')
  } catch (e) { toast(e.message) }
}
function reviewStage(verdict) {
  const s = cur.value
  if (!s) return
  if (verdict === '退回' && !s.note.trim()) return toast('退回要写清缺哪项证据')
  s.review = verdict
  if (verdict === '通过') { s.state = 'done'; const nx = st.value.find((x) => x.n === s.n + 1); if (nx) nx.state = 'doing'; toast('人工二审已确认，直接进入下一阶段') }
  else { s.state = 'doing'; toast('已打回补材料，补充后再交（版本 +1）') }
}
function saveReview() { db.reviews[props.p.id] = { decision: rv.decision, note: rv.note, at: new Date().toISOString().slice(5, 10) }; toast('已存复盘：' + rv.decision) }
function saveRes() { rs.value.note = rs.value.commit; toast('接单承诺已存') }
function goProgram() { location.hash = '#/program' }
function goComm() { location.hash = '#/commission' }
function addOpp() { if (!opp.text.trim()) return toast('写一句需求'); db.opportunities.unshift({ id: 'OP-' + Date.now().toString(36), text: opp.text.trim(), from: props.p.name, at: new Date().toISOString().slice(5, 10), state: '待研究' }); opp.text = ''; toast('已进机会池') }
</script>

<style scoped>
.pe { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } .wide { grid-column: 1 / -1; } @media (max-width: 1100px) { .pe { grid-template-columns: 1fr; } }
.card h4 { margin: 0 0 10px; font-size: 16px; } .card h4 small { font-weight: 400; }
.stg { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; } .stg li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 12px; background: var(--soft); } .stg li > i { width: 26px; height: 26px; border-radius: 50%; background: var(--line); color: var(--mute); font-style: normal; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; font-size: 12px; }
.stg li.done > i { background: var(--grn); color: #fff; } .stg li.doing > i, .stg li.submitted > i { background: var(--acc); color: #fff; } .stg li > div { display: grid; gap: 2px; } .stg b { font-size: 14px; } .stg small { color: var(--mute); font-size: 12px; }
.submit, .rvact { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; } .submit input, .rvact input { flex: 1; min-width: 180px; height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); } .rvact select { height: 34px; border: 1px solid var(--line); border-radius: 9px; background: var(--soft); color: var(--ink); padding: 0 8px; }
.tf { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } @media (max-width: 700px) { .tf { grid-template-columns: 1fr; } } .tf label { display: grid; gap: 3px; font-size: 12px; color: var(--mute); } .tf input, .tf select { height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); } .tf .ck { display: flex; gap: 6px; align-items: center; font-size: 13px; } .wide { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: 9px; padding: 0 10px; background: var(--soft); color: var(--ink); margin-top: 8px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; } .metrics div { background: var(--soft); border-radius: 12px; padding: 8px 10px; } .metrics span { display: block; font-size: 11.5px; color: var(--mute); } .metrics b { font-size: 18px; }
.res { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; } .res input { flex: 1; min-width: 200px; height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); }
.flow5 { display: flex; gap: 6px; flex-wrap: wrap; } .flow5 span { flex: 1; min-width: 60px; text-align: center; background: var(--soft); border-radius: 10px; padding: 8px 4px; font-weight: 700; font-size: 12.5px; color: var(--mute); } .flow5 span.on { background: var(--acc-soft); color: var(--acc); }
.op { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13.5px; } .op > span:nth-child(2) { flex: 1; min-width: 200px; } .opadd { display: flex; gap: 8px; margin-top: 10px; } .opadd input { flex: 1; height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); } .sm { font-size: 12px; }
</style>
