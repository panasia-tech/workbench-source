<template>
  <Login v-if="needLogin" />
  <div v-else-if="isOutsourceMode" class="cs-sandbox-shell">
    <CsWorkbench :embedded="false" :locked-outsource="true" :initial-actor="csInitialActor" @switch-sales-acct="switchTo" />
  </div>
  <div v-else class="shell">
    <nav class="dock" aria-label="主导航">
      <button class="brand" @click="goDock('all')"><span><Icon name="grid" /></span>销售工作台</button>
      <div v-for="g in NAV" :key="g.label" class="navgroup">
        <p>{{ g.label }}</p>
        <button v-for="d in g.items" :key="d.key" class="di" :class="{ on: active === d.key }" :aria-current="active === d.key ? 'page' : undefined" @click="goDock(d.key)">
          <Icon :name="d.icon" /><span class="lb">{{ d.label }}</span><i v-if="badge(d.key)" class="n">{{ badge(d.key) }}</i>
        </button>
      </div>
    </nav>
    <div class="workspace">
    <header class="topbar">
      <div class="trail"><span class="desktop-label">{{ currentGroup }}</span><span class="desktop-label slash">/</span><b>{{ currentLabel }}</b></div>
      <div class="toptools">
        <span class="mode">{{ REAL ? '真实数据 · 只读' : '本机演示' }}</span>
        <button class="skin-btn" @click="toggleSkin" :title="ui.skin === 'dark' ? '当前：Claude 黑色皮肤（点击切回浅色）' : '切换为 Claude 黑色皮肤'">
          <span>{{ ui.skin === 'dark' ? '☀️ 浅色皮肤' : '🌙 Claude 黑色皮肤' }}</span>
        </button>
        <button class="topsearch" @click="openFinder" aria-label="找功能"><Icon name="search" /><span>找功能</span><kbd class="desktop-label">{{ shortcut }}</kbd></button>
        <button class="account" :aria-expanded="menu" @click="menu = !menu"><span class="av">{{ (user.name || '我').slice(0, 1) }}</span><span class="desktop-label">{{ user.name || '未登录' }}</span></button>
        <div v-if="menu" class="pop">
          <button class="di" @click="navigate('me')"><Icon name="people" />我的</button>
          <button class="di" @click="toggleSkin(); menu = false">{{ ui.skin === 'dark' ? '☀️ 切换为 Stitch 浅色皮肤' : '🌙 切换为 Claude 黑色皮肤' }}</button>
          <template v-if="REAL"><p>已登录 ERP 账号</p><button class="di" @click="logout">退出登录</button></template>
          <template v-else><p>切换演示账号</p><button v-for="a in ACCTS" :key="a.u" class="di" @click="switchTo(a.u)">{{ a.n }} · {{ a.r }}</button></template>
        </div>
      </div>
    </header>
    <main class="main" ref="mainEl" :class="{ 'main-cs-flush': view.name === 'cs-workbench' }">
      <div v-if="REAL" class="realbar"><b>真实数据 · 只读</b>实物（库存、库龄、上架审批、缺口）来自真 ERP（WMS），不会写入生产。虚拟 / 服务、练习是演示数据：真 ERP 里还没有这部分，用本机演示库跑，卡片上标了「演示数据」。</div>
      <div v-if="state.me && !state.me.practice_done && view.name !== 'learn' && view.name !== 'cs-workbench'" class="gatebar"><Icon name="lock" />真实任务先锁着：先在「学」里做完 3 个练习才能操作真实订单和商品。<button class="btn sm" @click="goDock('learn')">去做练习</button></div>
      <div v-if="state.error" class="errbar"><span>{{ state.error }}</span><button class="btn sm" @click="loadAll(true)">重新读取</button></div>
      <Today v-if="view.name === 'today'" />
      <Ops v-else-if="view.name === 'ops'" />
      <Inquiry v-else-if="view.name === 'inquiry'" />
      <Cycles v-else-if="view.name === 'cycles'" />
      <Pricebook v-else-if="view.name === 'pricebook'" />
      <WashGallery v-else-if="view.name === 'wash'" />
      <PriceCleaning v-else-if="view.name === 'price-cleaning'" :key="view.id" :case-id="view.id" />
      <ImageCleaning v-else-if="view.name === 'image-cleaning'" :key="view.id" :case-id="view.id" />
      <VirtCreate v-else-if="view.name === 'virt-new'" />
      <GcMatrix v-else-if="view.name === 'gc-matrix'" />
      <GcQueue v-else-if="view.name === 'gc-queue'" />
      <GcReprice v-else-if="view.name === 'gc-reprice'" />
      <GcMetrics v-else-if="view.name === 'gc-metrics'" />
      <ProgramDelivery v-else-if="view.name === 'program'" />
      <Commission v-else-if="view.name === 'commission'" />
      <Readiness v-else-if="view.name === 'readiness'" />
      <BookoffLibrary v-else-if="view.name === 'bookoff'" />
      <Gallery v-else-if="view.name === 'gallery'" :lens="view.lens" @open="open" />
      <Orders v-else-if="view.name === 'orders'" />
      <Learn v-else-if="view.name === 'learn'" />
      <Manual v-else-if="view.name === 'manual'" />
      <Skills v-else-if="view.name === 'skills'" />
      <SelGallery v-else-if="view.name === 'selphys'" kind="phys" />
      <VirtIntelHub v-else-if="view.name === 'virt-intel'" />
      <SelGallery v-else-if="view.name === 'selvirt'" kind="virt" />
      <SpecBaselineHub v-else-if="view.name === 'spec-baseline'" />
      <Sources v-else-if="view.name === 'sources'" />
      <Crm v-else-if="view.name === 'crm'" />
      <Reception v-else-if="view.name === 'reception'" />
      <Assist v-else-if="view.name === 'assist'" />
      <CsWorkbench v-else-if="view.name === 'cs-workbench'" :embedded="true" :initial-actor="csInitialActor" @switch-sales-acct="switchTo" />
      <TutorialLedger v-else-if="view.name === 'tutorials'" />
      <Me v-else-if="view.name === 'me'" />
      <DetailPhys v-else-if="view.name === 'item' && view.kind === 'phys'" :code="view.id" @back="back" />
      <DetailVirt v-else-if="view.name === 'item'" :id="view.id" @back="back" />
    </main>
    </div>
    <dialog ref="finder" class="finder" @click.self="closeFinder">
      <div class="finder-inner">
        <div class="finder-head"><b>找功能</b><button class="btn sm" @click="closeFinder">关闭</button></div>
        <label class="finder-input"><Icon name="search" /><input ref="finderInput" v-model="query" placeholder="搜索页面或操作" aria-label="搜索功能" @keydown.enter="matches[0] && navigate(matches[0].key)" /></label>
        <div v-for="g in finderGroups" :key="g.label" class="navgroup">
          <p>{{ g.label }}</p>
          <button v-for="d in g.items" :key="d.key" class="di" :class="{ on: active === d.key }" @click="navigate(d.key)"><Icon :name="d.icon" />{{ d.label }}</button>
        </div>
        <p v-if="!matches.length" class="finder-empty">没有找到。试试页面名称或「发货」「报价」。</p>
      </div>
    </dialog>
    <Help /><TermModal /><VideoModal /><Practice /><Tour />
    <div v-if="ui.toast" class="toast">{{ ui.toast }}</div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import Icon from './Icon.vue'
import Today from './Today.vue'
import Gallery from './Gallery.vue'
import Orders from './Orders.vue'
import Learn from './Learn.vue'
import Manual from './Manual.vue'
import Skills from './Skills.vue'
import TermModal from './TermModal.vue'
import Me from './Me.vue'
import DetailPhys from './DetailPhys.vue'
import DetailVirt from './DetailVirt.vue'
import Help from './Help.vue'
import VideoModal from './VideoModal.vue'
import Practice from './Practice.vue'
import Tour from './Tour.vue'
import Login from './Login.vue'
import Reception from './Reception.vue'
import SelGallery from './SelGallery.vue'
import VirtIntelHub from './VirtIntelHub.vue'
import SpecBaselineHub from './SpecBaselineHub.vue'
import Sources from './Sources.vue'
import Crm from './Crm.vue'
import Assist from './Assist.vue'
import Ops from './Ops.vue'
import Inquiry from './Inquiry.vue'
import Cycles from './Cycles.vue'
import Pricebook from './Pricebook.vue'
import WashGallery from './WashGallery.vue'
import PriceCleaning from './PriceCleaning.vue'
import ImageCleaning from './ImageCleaning.vue'
import VirtCreate from './VirtCreate.vue'
import GcMatrix from './GcMatrix.vue'
import GcQueue from './GcQueue.vue'
import GcReprice from './GcReprice.vue'
import GcMetrics from './GcMetrics.vue'
import ProgramDelivery from './ProgramDelivery.vue'
import Commission from './Commission.vue'
import Readiness from './Readiness.vue'
import BookoffLibrary from './BookoffLibrary.vue'
import CsWorkbench from './cs/CsWorkbench.vue'
import TutorialLedger from './TutorialLedger.vue'
import { mapSalesUserToCsActor } from './cs/store.js'
import { loadAll, state, buildTasks } from './store.js'
import { me, ROLE, REAL, api } from './api.js'
import { ui, setFont, setSkin, toggleSkin } from './ui.js'

const DOCK_ALL = [
  { key: 'wash', label: '清洗上架', icon: 'spark' },
  { key: 'all', label: '库存商品', icon: 'grid' },
  { key: 'selphys', label: '实物选品', icon: 'pick' },
  { key: 'spec-baseline', label: '规格与基准', icon: 'ledger' },
  { key: 'virt-intel', label: '外部情报', icon: 'ledger' },
  { key: 'selvirt', label: '虚拟选品', icon: 'pick' },
  { key: 'sources', label: '来源台账', icon: 'ledger' },
  { key: 'today', label: '今天', icon: 'today' },
  { key: 'ops', label: '经营', icon: 'ledger' },
  { key: 'phys', label: '实物', icon: 'box' },
  { key: 'virt', label: '虚拟', icon: 'ticket' },
  { key: 'svc', label: '服务', icon: 'spark' },
  { key: 'gc-matrix', label: '账号矩阵', icon: 'grid' },
  { key: 'gc-queue', label: '上下架队列', icon: 'spark' },
  { key: 'gc-reprice', label: '在售调价', icon: 'ledger' },
  { key: 'gc-metrics', label: '小铺数据', icon: 'today' },
  { key: 'skills', label: 'Skill 台账', icon: 'skill' },
  { key: 'crm', label: '客户资源', icon: 'people' },
  { key: 'cs-workbench', label: '外部客服', icon: 'chat' },
  { key: 'reception', label: '接待', icon: 'chat' },
  { key: 'assist', label: '接管', icon: 'assist' },
  { key: 'orders', label: '订单', icon: 'order' },
  { key: 'learn', label: '学', icon: 'learn' },
  { key: 'tutorials', label: '教程台账', icon: 'book' },
  { key: 'manual', label: '说明书', icon: 'book' }
]
// 真数据只接 WMS 这条线：库存商品、今天（按库存红黄绿生成）、实物。订单对账/虚拟/服务/练习是演示功能，真 ERP 里没有
const DOCK = REAL ? DOCK_ALL.filter((d) => ['wash', 'all', 'selphys', 'spec-baseline', 'virt-intel', 'selvirt', 'sources', 'crm', 'cs-workbench', 'today', 'ops', 'phys', 'virt', 'svc', 'gc-matrix', 'gc-queue', 'gc-reprice', 'gc-metrics', 'skills', 'reception', 'assist', 'learn', 'tutorials', 'manual'].includes(d.key)) : DOCK_ALL
const logout = async () => { try { await fetch('/__session', { method: 'DELETE' }) } catch { /* 没有也行 */ } localStorage.clear(); sessionStorage.clear(); location.reload() }
const ACCTS = [
  { u: 'chenxm', n: '陈小满', r: '销售业务员' },
  { u: 'zhoubb', n: '周小北', r: '销售业务员' },
  { u: 'admin', n: '销售主管', r: '主管视角' },
  { u: 'newbie', n: '新同事', r: '第一天（练习门禁）' },
  { u: 'outsource_lu', n: '林小鹿', r: '外部外包客服（脱敏沙盒）' },
  { u: 'cs_newbie', n: '周小萌', r: '外部客服新人（3关门禁）' }
]
const u = me()
const user = { name: u.name, role: ROLE[u.role] || u.role }
const isOutsourceMode = computed(() => u.role === 'OUTSOURCE_CS')
const csInitialActor = computed(() => mapSalesUserToCsActor(u.username || localStorage.getItem('erp_user') || 'chenxm'))
const menu = ref(false)
const operations = [
  ['inquiry', '询单与报价', 'chat', '跟单 报价锁版'],
  ['cycles', '周期交付 / 复盘', 'today', '周报 研究'],
  ['pricebook', '采购价格表', 'ledger', '调价 版本'],
  ['price-cleaning', '第1步：洗价格', 'ledger', '闲鱼 快照 行情 均价'],
  ['image-cleaning', '第2步：洗图片', 'spark', '大库 图库 三栏 选图'],
  ['virt-new', '新增虚拟商品', 'ticket', '建卡 卡密 阿奇索 闲管家 直充 虚拟'],
  ['program', '服务程序化交付', 'ticket', '预约 核销 卡券'],
  ['commission', '提成账本', 'order', '退款 扣回'],
  ['bookoff', 'BOOKOFF 商品库', 'book', '日本 图书 游戏'],
  ['readiness', '交付自检', 'skill', '禅道 缺口'],
  ['me', '我的', 'people', '设置 字体 个人']
].map(([key, label, icon, aliases]) => ({ key, label, icon, aliases }))
const navOrder = [
  ['商品', ['all', 'phys', 'virt', 'svc', 'wash']],
  ['工作', ['today', 'cs-workbench', 'reception', 'assist', 'orders', 'crm']],
  ['选品', ['selphys', 'virt-intel', 'selvirt', 'sources', 'spec-baseline']],
  ['群控', ['gc-matrix', 'gc-queue', 'gc-reprice', 'gc-metrics']],
  ['经营', ['ops', 'skills']],
  ['帮助', ['tutorials', 'learn', 'manual']]
]
const NAV = navOrder.map(([label, keys]) => ({ label, items: keys.map((key) => DOCK.find((d) => d.key === key)).filter(Boolean) }))
const searchGroups = NAV.map((g) => ({ ...g, items: [...g.items, ...(g.label === '经营' ? operations.slice(0, -1) : g.label === '帮助' ? operations.slice(-1) : [])] }))
const aliases = { today: '任务 上报 派单', 'cs-workbench': '外部客服 外包 实拍 保修 富阳 退款 409 绩效', tutorials: '教程 视频 台账 节点 时间码 Skill 兜底 缺口 CAD 三角洲', 'virt-intel': '外部情报 在售商品 赛马 油条 CAD 餐饮券 闲鱼 虚拟盈利 QQ群 游标', reception: '聊天 客服 10宫格', assist: '接管 聊天 10宫格', orders: '发货 出库 运单 退款', all: '库存 SKU', learn: '培训 练习', selvirt: '虚拟 选品 卡券', selphys: '选品 型号 多视角 显示器', 'spec-baseline': '规格 兜底 基准 防呆 走量 高端 卓威 超频 OLED 77款 选品', 'gc-matrix': '群控 AdsPower 矩阵 账号 串号 动态码 主页', 'gc-queue': '上下架 联动下架 错峰 截图 重试 擦亮', 'gc-reprice': '智能调价 改价 复核 锁价', 'gc-metrics': '小铺数据 15:30 曝光 转化 日报' }
const query = ref('')
const finder = ref(null)
const finderInput = ref(null)
const finderGroups = computed(() => {
  const word = query.value.trim().toLowerCase()
  return searchGroups.map((g) => ({ ...g, items: g.items.filter((d) => `${d.label} ${d.key} ${d.aliases || aliases[d.key] || ''}`.toLowerCase().includes(word)) })).filter((g) => g.items.length)
})
const matches = computed(() => finderGroups.value.flatMap((g) => g.items))
const shortcut = /Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
function openFinder() {
  if (finder.value?.open) return
  menu.value = false
  query.value = ''
  finder.value?.showModal()
  nextTick(() => finderInput.value?.focus())
}
function closeFinder() { finder.value?.close() }
function navigate(key) { closeFinder(); menu.value = false; goDock(key) }
const mainEl = ref(null)

function parse() {
  const raw = (location.hash || '#/gallery/all').replace(/^#\/?/, '')
  const p = raw.split('?')[0].split('/')
  const decode = (s) => { try { return decodeURIComponent(s || '') } catch { return '' } }
  if (p[0] === 'wash') return { name: 'wash' }
  if (p[0] === 'price-cleaning') return { name: 'price-cleaning', id: decode(p[1]) }
  if (p[0] === 'image-cleaning') return { name: 'image-cleaning', id: decode(p[1]) }
  if (p[0] === 'virt-new') return { name: 'virt-new' }
  if (['gc-matrix', 'gc-queue', 'gc-reprice', 'gc-metrics'].includes(p[0])) return { name: p[0] }
  if (p[0] === 'item') return { name: 'item', kind: p[1], id: decode(p[2]) }
  if (p[0] === 'gallery') return { name: 'gallery', lens: ['all', 'phys', 'virt', 'svc'].includes(p[1]) ? p[1] : 'all' }
  return p[0] === 'today' || p[0] === 'cs-workbench' || p[0] === 'tutorials' || p[0] === 'virt-intel' || p[0] === 'orders' || p[0] === 'learn' || p[0] === 'manual' || p[0] === 'skills' || p[0] === 'selphys' || p[0] === 'spec-baseline' || p[0] === 'selvirt' || p[0] === 'sources' || p[0] === 'crm' || p[0] === 'reception' || p[0] === 'assist' || p[0] === 'ops' || p[0] === 'bookoff' || p[0] === 'inquiry' || p[0] === 'cycles' || p[0] === 'pricebook' || p[0] === 'program' || p[0] === 'commission' || p[0] === 'readiness' || p[0] === 'me' ? { name: p[0] } : { name: 'gallery', lens: 'all' }
}
const view = ref(parse())
let last = '#/gallery/all'
window.addEventListener('hashchange', () => { view.value = parse(); mainEl.value?.scrollTo(0, 0) })
const active = computed(() => {
  if (view.value.name === 'wash' || view.value.name === 'price-cleaning' || view.value.name === 'image-cleaning') return 'wash'
  if (view.value.name === 'virt-new') return 'virt'
  if (view.value.name === 'gallery') return view.value.lens
  if (view.value.name === 'item') return view.value.kind === 'phys' ? 'phys' : view.value.kind
  return view.value.name
})
const currentGroup = computed(() => searchGroups.find((g) => g.items.some((d) => d.key === active.value))?.label || '商品')
const currentLabel = computed(() => {
  if (view.value.name === 'cs-workbench') return '外部客服工作台 V3（单应用合入）'
  if (view.value.name === 'tutorials') return '原生教程与视频台账（岗位视角 / 客服独立视图）'
  if (view.value.name === 'virt-intel') return '虚拟外部情报与盈利赛马中心（线索 / 在售 / 同题赛马）'
  if (view.value.name === 'wash') return '待洗商品 Gallery'
  if (view.value.name === 'price-cleaning') return '第 1 步：洗价格（闲鱼快照去噪）'
  if (view.value.name === 'image-cleaning') return '第 2 步：洗图片（大库三栏直发）'
  if (view.value.name === 'virt-new') return '新增虚拟商品（三步大页面 · 同行工具对标）'
  if (view.value.name === 'gc-matrix') return '群控环境与账号矩阵（AdsPower 全浏览器）'
  if (view.value.name === 'gc-queue') return '上下架错峰队列 & 锁单联动下架'
  if (view.value.name === 'gc-reprice') return '存量在售智能调价与人工复核'
  if (view.value.name === 'gc-metrics') return '15:30 闲鱼小铺数据与异常日报'
  if (view.value.name === 'spec-baseline') return '选品规格与兜底基准台（95%走量兜底 · 防呆尺 · 多品类预留）'
  return [...DOCK, ...operations].find((d) => d.key === active.value)?.label || '销售工作台'
})
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !needLogin) { e.preventDefault(); openFinder() }
  if (e.key === 'Escape') menu.value = false
})
const goDock = (k) => { location.hash = ['all', 'phys', 'virt', 'svc'].includes(k) ? '#/gallery/' + k : '#/' + k }
const open = (it) => { last = location.hash || '#/today'; location.hash = `#/item/${it.kind}/${encodeURIComponent(it.id)}`; sessionStorage.setItem('scroll', String(mainEl.value?.scrollTop || window.scrollY || 0)) }
const back = () => { location.hash = last.startsWith('#/item') ? '#/gallery/all' : last; setTimeout(() => { const y = Number(sessionStorage.getItem('scroll') || 0); mainEl.value?.scrollTo(0, y) }, 60) }
function badge(k) {
  if (k === 'gc-matrix' || k === 'gc-queue' || k === 'gc-reprice' || k === 'gc-metrics') return gcBadge[k] || 0
  if (k === 'wash') return state.items.filter((i) => i.kind === 'phys' && !i.locked && i.lvl !== 'grn').length
  if (k === 'today') return buildTasks(state.me?.username || 'chenxm').filter((t) => t.lvl === 'red' && (state.me?.supervisor || t.owner === state.me?.username)).length
  if (k === 'orders') return state.orders.filter((o) => o.lvl === 'red').length
  if (k === 'reception') return msgBadge.need
  if (k === 'assist') return msgBadge.esc
  if (k === 'learn') return state.me && !state.me.practice_done ? '!' : 0
  if (k === 'all' || k === 'phys' || k === 'virt' || k === 'svc') return state.items.filter((i) => (k === 'all' || i.kind === k) && i.lvl === 'red').length
  return 0
}
// 接待 / 协助 / 群控的角标
const msgBadge = reactive({ need: 0, esc: 0 })
const gcBadge = reactive({ 'gc-matrix': 0, 'gc-queue': 0, 'gc-reprice': 0, 'gc-metrics': 0 })
async function loadBadges() {
  try { msgBadge.need = (await api('/demo/inbox-summary')).vs_queue || 0 } catch { /* 没有就不显示 */ }
  try { msgBadge.esc = REAL ? ((await api('/gc-ops/chat-sla/waiting')).items || []).filter((x) => x.escalated).length : (await api('/demo/inbox-summary')).phys_esc || 0 } catch { /* 同上 */ }
  try { Object.assign(gcBadge, await api('/gc-hub/badges')) } catch { /* 同上 */ }
}
const switchTo = (name) => { const url = new URL(location.href); url.searchParams.set('as', name); location.href = url.toString() }
const needLogin = !localStorage.getItem('erp_token')
onMounted(() => { setFont(ui.fontBig); setSkin(ui.skin); if (!needLogin && !isOutsourceMode.value) { loadAll(true); loadBadges(); setInterval(loadBadges, 30000) } })
</script>

