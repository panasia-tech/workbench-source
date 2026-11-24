<template>
  <div class="page ops">
    <header class="head">
      <div><p class="eyebrow">经营 · 交付</p><h1>经营中枢<Q k="ops-main" /></h1>
        <p class="sub">询单、周期、价格表、程序化交付、提成、交付自检，都在这里。原来散在「今天」和各个后台的动作，收成一张能点进去的经营台。</p></div>
      <span class="tag amb">演示数据 · 不写生产</span>
    </header>

    <div class="grid">
      <article v-for="c in cards" :key="c.k" class="card oc" :class="c.cls" tabindex="0" @click="go(c.k)" @keydown.enter="go(c.k)">
        <div class="oi"><Icon :name="c.icon" /></div>
        <div class="ob"><h3>{{ c.t }}</h3><p>{{ c.d }}</p><div class="om"><b>{{ c.n }}</b><span>{{ c.u }}</span></div></div>
        <span class="go">打开 ›</span>
      </article>
    </div>

    <section class="card quick">
      <h3>本周要盯的三件事</h3>
      <div class="q"><span class="tag red">价格</span><div><b>采购价格表有 {{ pendingPrice }} 行待核 / 维护中</b><p class="muted">采购参考价与价格清洗已全面联网闭环，两步法人工二审后直接生效。</p></div><button class="btn sm" @click="go('pricebook')">去价格表</button></div>
      <div class="q"><span class="tag amb">交付</span><div><b>{{ pendingCycle ? '下一期 ' + pendingCycle.id + ' 还没交' : '本期已交付' }}</b><p class="muted">周一 09:00；漏跑要写原因和补跑计划。</p></div><button class="btn sm" @click="go('cycles')">去周期</button></div>
      <div class="q"><span class="tag acc">自检</span><div><b>禅道 62 条：{{ closed }} 条 UI 已闭环，{{ external }} 条待外部</b><p class="muted">演示闭环不等于生产完成，逐条看归属。</p></div><button class="btn sm" @click="go('readiness')">去自检</button></div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Q from './Q.vue'
import Icon from './Icon.vue'
import { finalDb as db } from './demoFinal.js'
import { auditRows } from './auditData.js'

const cards = computed(() => [
  { k: 'gc-matrix', t: 'AdsPower 账号矩阵', d: '全浏览器执行端对账、防发错号软闸、单号主页、免明文开窗与动态码、派单负荷自动均衡。', n: 8, u: '个环境', icon: 'grid', cls: 'acc' },
  { k: 'gc-queue', t: '群控上下架与联动队列', d: '同号 25 分钟错峰排期、孤品锁单全号联动下架、Playwright 失败现场截图重试。', n: 2, u: '单待联动', icon: 'spark', cls: '' },
  { k: 'gc-reprice', t: '在售智能调价复核', d: '拒绝无脑一键涨跌：按行情+库龄生成涨/降/观察建议，人工确认即下发（零主管审批）。', n: 5, u: '条待复核', icon: 'ledger', cls: '' },
  { k: 'gc-metrics', t: '15:30 小铺数据看板', d: '曝光→浏览→询单→支付漏斗、掉流>30%标红、原始截图留存、智能体问答与日报。', n: '15:30', u: '每日抓拍', icon: 'today', cls: '' },
  { k: 'inquiry', t: '询单与报价', d: '归属、报价版本、有效期、客户接受哪版、丢单原因、订单回原询单。', n: db.inquiries.filter((q) => !['已成交', '已丢单'].includes(q.state)).length, u: '条在跟', icon: 'chat', cls: '' },
  { k: 'cycles', t: '周期交付 / 复盘', d: '每周一期：全量清单、图片快照、原始价格、漏跑补跑；经营复盘和机会池。', n: db.cycles.filter((c) => c.status !== '已交付' && c.status !== '已补跑').length, u: '期待交', icon: 'today', cls: '' },
  { k: 'price-cleaning', t: '两步法价格清洗', d: '抓拍闲鱼真实快照机器初审 → 人工二审直接生效并上架。', n: Object.keys(db.priceCleaning).length, u: '个待二审', icon: 'ledger', cls: '' },
  { k: 'pricebook', t: '采购价格表', d: '参考价、建议报价、授权上限、谈妥价、实付、净成本；版本生效、回退、反馈。', n: db.pricebook.filter((r) => ['待核', '维护中'].includes(r.status)).length, u: '行待核', icon: 'ledger', cls: '' },
  { k: 'program', t: '服务程序化交付', d: '服务包装成卡券 / 预约码：时段、占位、核销、取消释放、回执回原订单。', n: db.programs.reduce((n, p) => n + p.booked, 0), u: '单已占', icon: 'ticket', cls: '' },
  { k: 'commission', t: '提成账本', d: '成交提成、建卡人分成、上新奖；按订单算，退款扣回。', n: '¥' + db.commission.filter((r) => r.state === '待确认').reduce((s, r) => s + r.amount, 0).toFixed(2), u: '待确认', icon: 'order', cls: '' },
  { k: 'bookoff', t: 'BOOKOFF 全量库', d: '日本 BOOKOFF 611 万条商品：书名/作者/品类/价格/库存/发售日/图片，按需检索。', n: '611万', u: '条', icon: 'book', cls: '' },
  { k: 'readiness', t: '交付自检', d: '禅道 62 条逐条：UI 已闭环 / 已覆盖 / 待外部，点进去看页面。', n: closed.value + '/' + auditRows.length, u: '已闭环', icon: 'skill', cls: 'acc' }
])
const closed = computed(() => auditRows.filter((r) => r.owner === 'sales-ui').length)
const external = computed(() => auditRows.filter((r) => r.owner !== 'sales-ui').length)
const pendingPrice = computed(() => db.pricebook.filter((r) => ['待核', '维护中'].includes(r.status)).length)
const opsHdr = () => ({ Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '') })
Promise.all([
  fetch('/api/demo/pricebook', { headers: opsHdr() }).then((r) => (r.ok ? r.json() : null)),
  fetch('/api/demo/commission', { headers: opsHdr() }).then((r) => (r.ok ? r.json() : null)),
  fetch('/api/demo/inquiries', { headers: opsHdr() }).then((r) => (r.ok ? r.json() : null)),
  fetch('/api/price-clean/skus', { headers: opsHdr() }).then((r) => (r.ok ? r.json() : null)),
]).then(([pb, cm, iq, pc]) => {
  if (pb?.items) db.pricebook = pb.items
  if (cm?.items) db.commission = cm.items
  if (iq?.items) db.inquiries = iq.items
  if (pc?.items) db.priceCleaning = Object.fromEntries(pc.items.filter((x) => x.step !== 'active').map((x) => [x.code, x]))
}).catch(() => {})
const pendingCycle = computed(() => db.cycles.find((c) => c.status === '未开始'))
const go = (k) => { location.hash = '#/' + k }
</script>

<style scoped>
.ops { padding: 30px 40px 80px; max-width: 1560px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .ops h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sub { margin: 0; color: var(--mute); max-width: 900px; line-height: 1.7; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; margin-top: 18px; } .oc { display: flex; gap: 14px; align-items: flex-start; cursor: pointer; transition: transform .12s; padding: 18px 20px; } .oc:hover { transform: translateY(-3px); } .oc.acc { border-top: 5px solid var(--acc); }
.oi { width: 48px; height: 48px; border-radius: 16px; background: var(--acc-soft); color: var(--acc); display: flex; align-items: center; justify-content: center; flex: none; } .oi svg { width: 26px; height: 26px; }
.ob { flex: 1; min-width: 0; } .ob h3 { margin: 0 0 4px; font-size: 17px; } .ob p { margin: 0; color: var(--mute); font-size: 13px; line-height: 1.6; } .om { margin-top: 8px; display: flex; gap: 6px; align-items: baseline; } .om b { font-size: 26px; letter-spacing: -.02em; } .om span { color: var(--mute); font-size: 12.5px; } .go { color: var(--acc); font-weight: 700; font-size: 13px; align-self: center; white-space: nowrap; }
.quick { margin-top: 16px; } .quick h3 { margin: 0 0 10px; } .q { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); flex-wrap: wrap; } .q > div { flex: 1; min-width: 220px; } .q b { font-size: 14.5px; } .q p { font-size: 12.5px; margin: 2px 0 0; } .q .btn { margin-left: auto; }
</style>
