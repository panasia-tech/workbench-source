<template>
  <div class="page sc">
    <header class="head">
      <div><h1>来源大台账<Q k="sel-src" /></h1>
        <p class="sub">100 个货源站、榜单、评论区与卖家库视觉总览（有数据标实况，缺数据标缺口）。</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" @click="showCaliber = !showCaliber">📐 {{ showCaliber ? '收起双口径说明' : '双口径分工说明 ▾' }}</button>
        <button class="btn" @click="goSpecBase">规格与兜底基准台 ›</button>
        <button class="btn pri" @click="goBookoff">BOOKOFF 全量库 611 万条 ›</button>
      </div>
    </header>

    <!-- 双口径来源站定位说明卡（渐进披露：默认折叠不占首屏，点上方按钮展开） -->
    <section v-if="showCaliber" class="dual-caliber">
      <div class="dc-box macro">
        <span class="tag amb">口径 1 · 宏观全品类大纲站</span>
        <b>类型全覆盖，具体型号不强求</b>
        <p>如 <b>BookOff（2,735 个类目树 / 209 采购大品类）</b>、爱回收 28 大类、闲鱼 43 类目榜、HardOff —— 具体型号虽然漏得一塌糊涂，但能把几十万种商品「有哪些品类赛道可做」全部框全，绝不漏大方向。</p>
      </div>
      <div class="dc-box vert">
        <span class="tag acc">口径 2 · 垂类具体型号精钻站</span>
        <b>不求全品类，单类掏空 1 万个具体型号 + 硬参数</b>
        <p>如 <b>显示器去屏库网 / 中关村ZOL / 太平洋产品库</b>（已抓 8,044+ 型号含尺寸/分辨率/超频Hz/面板），显卡去 TechPowerUp，手机苹果去 EveryMac/GSMArena —— 抓齐具体型号后再去闲鱼爬价与同档走量兜底。</p>
      </div>
    </section>

    <div class="tabs-bar">
      <div class="tabs"><button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.t }}<em>{{ t.n }}</em></button></div>
      <div v-if="tab === 'sites'" class="sum"><span class="tag grn">样本 {{ cnt('样本') }}</span><span class="tag acc">部分目录 {{ cnt('部分目录') }}</span><span class="tag red">受阻 {{ cnt('受阻') }}</span><span class="tag amb">待适配 {{ cnt('待适配') }}</span>
        <span class="muted sm" title="来自交付包 100 站程序（2026-10-28 一页有界采集，非整库同步）">共 {{ sites.length }} 站 · {{ total }} 条</span></div>
    </div>

    <!-- 平台来源（100 站） -->
    <section v-if="tab === 'sites'">
      <div class="flt"><button v-for="b in BIZ" :key="b.k" :class="{ on: biz === b.k }" @click="biz = b.k">{{ b.t }}</button>
        <span class="vw"><button :class="{ on: view === 'gallery' }" @click="setView('gallery')">Gallery</button><button :class="{ on: view === 'table' }" @click="setView('table')">表格</button></span><input v-model="qs" placeholder="搜站名" /></div>

      <template v-if="view === 'gallery'">
        <h3 v-if="biz === 'all' && !qs" class="gh3">你点名的大平台</h3>
        <div v-if="biz === 'all' && !qs" class="sgal"><article v-for="n in named" :key="n.t" class="sc2 star"><div class="si" :class="imgCls(n.id)" :style="bgs(n.id)"><img v-if="im(n.id)" :src="'/img/sources/' + im(n.id).file" alt="" /><b v-else>{{ n.t.slice(0, 1) }}</b></div>
          <div class="sb"><h4>{{ n.t }}</h4><span class="tag" :class="n.cls">{{ n.st }}</span><p>{{ n.note }}</p></div></article></div>
        <h3 class="gh3">{{ biz === 'all' ? '100 站' : BIZN[biz] }}<small>{{ shownSites.length }} 站</small></h3>
        <div class="sgal"><article v-for="s in shownSites" :key="s.id" class="sc2"><div class="si" :class="imgCls(s.id)" :style="bgs(s.id)"><img v-if="im(s.id)" :src="'/img/sources/' + im(s.id).file" alt="" /><b v-else>{{ s.site.slice(0, 1) }}</b><i v-if="!im(s.id)" class="noimg">官方图没取到</i></div>
          <div class="sb"><h4>{{ s.site }}</h4><div class="stg"><span class="tag" :class="STC[s.st]">{{ s.st }}</span><span class="tag">{{ BIZN[s.biz] }}</span><span class="tag">{{ s.n }} 条</span></div><p>{{ s.note }}</p></div></article></div>
        <p class="muted sm">图片是各平台官方网站首页的宣发图 / 图标（2026-11-11 取，仅内部展示，出处见 演示数据出处.md）；没取到的（被拒绝或要登录）显示首字，不拿别的图顶。</p>
      </template>

      <template v-else>
      <div class="named card"><b>你点名的大平台</b>
        <div v-for="n in named" :key="n.t" class="nm"><span class="tag" :class="n.cls">{{ n.st }}</span><b>{{ n.t }}</b><span class="muted">{{ n.note }}</span></div></div>
      <table class="tbl"><thead><tr><th>站点</th><th>业务</th><th>语言</th><th>状态</th><th>记录</th><th>带价</th><th>带图</th><th>说明 / 缺口</th></tr></thead>
        <tbody><tr v-for="s in shownSites" :key="s.id"><td><b>{{ s.site }}</b><small>{{ s.id }}</small></td><td>{{ BIZN[s.biz] }}</td><td>{{ s.lang }}</td><td><span class="tag" :class="STC[s.st]">{{ s.st }}</span></td><td>{{ s.n }}</td><td>{{ s.pr }}</td><td>{{ s.img }}</td><td class="nt">{{ s.note }}</td></tr></tbody></table>
      </template>
    </section>

    <!-- 榜单 -->
    <section v-else-if="tab === 'rank'">
      <p class="muted">榜单是<b>长期抓</b>的来源：历史全部纳入，之后只有新增才新增；抓取地址是手机浏览器形式（你给的闲鱼榜单链接）。本机没有榜单数据（在服务器上），<b>要程序员再抓一遍</b>。</p>
      <div class="cards"><article v-for="r in ranks" :key="r.t" class="rc card"><div class="rh"><img v-if="r.img && im(r.img)" class="lg" :src="'/img/sources/' + im(r.img).file" alt="" /><b>{{ r.t }}</b><span class="tag" :class="r.cls">{{ r.st }}</span></div><p class="muted">{{ r.d }}</p>
        <dl><dt>口径</dt><dd>{{ r.k }}</dd><dt>周期</dt><dd>{{ r.p }}</dd><dt>缺口</dt><dd class="gap">{{ r.gap }}</dd></dl></article></div>
    </section>

    <!-- 评论区 -->
    <section v-else-if="tab === 'rev'">
      <p class="muted">评论区买家图是<b>长期抓</b>的来源（给「图库」补各号不雷同的图）。调研结论在记忆笔记里，<b>代码一行都没有实现</b>；图片服务后台的 73 个组件（33 个评论类）全是目录。</p>
      <table class="tbl"><thead><tr><th>平台</th><th>官方 / 第三方 / 开源取法</th><th>状态</th><th>缺口</th></tr></thead><tbody><tr v-for="r in reviews" :key="r.p"><td><img v-if="r.img && im(r.img)" class="lg2" :src="'/img/sources/' + im(r.img).file" alt="" /><b>{{ r.p }}</b></td><td class="nt">{{ r.how }}</td><td><span class="tag red">没实现</span></td><td class="nt">{{ r.gap }}</td></tr></tbody></table>
    </section>

    <!-- 卖家库 -->
    <section v-else-if="tab === 'seller'">
      <p class="muted">闲鱼 43 个类目榜（约 3 万条，去重后一万多卖家）→ 唯一卖家 → 主页采集（在售 + 已售）→ 公司细分类 → 和型号库双向匹配。<b>现在工作台里一项都没有</b>，下面是指标位，等数据进来。</p>
      <div class="kpis"><div v-for="k in SK" :key="k.t" class="kp"><span>{{ k.t }}</span><b>—</b><small>{{ k.d }}</small></div></div>
      <div class="card roles"><b>卖家角色（禅道 B08）</b><span class="tag">同行参考</span><span class="tag amb">可能供给</span><span class="tag grn">经核供给</span><span class="tag">待核</span><span class="muted">有商品 ≠ 已验证可供货；高价、销量、排名不能当成本、利润或本型号成交量。</span></div>
      <div class="card roles"><b>每日调研配额</b><span class="muted">每个业务员一天调研约 5 个商家（你的口径）；先把商家和主营业务阐述好、分门别类整理，全量数据全部留存。<b>谁调研哪些，你来派</b>，我不自动派。</span></div>
    </section>

    <!-- 缺口汇总 -->
    <section v-else>
      <p class="muted">下面是上面各页的缺口合在一起，<b>给程序员的清单</b>（也是禅道要补的需求线索）。</p>
      <table class="tbl"><thead><tr><th>#</th><th>缺口</th><th>在哪一页</th><th>谁来</th></tr></thead><tbody><tr v-for="(g, i) in allGaps" :key="i"><td>{{ i + 1 }}</td><td class="nt">{{ g.t }}</td><td>{{ g.w }}</td><td><span class="tag" :class="g.cls">{{ g.who }}</span></td></tr></tbody></table>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import Q from './Q.vue'

const tab = ref('sites'), biz = ref('all'), qs = ref(''), sites = ref([]), imgs = ref({}), showCaliber = ref(false)
const VKEY = 'src_view'
const view = ref((() => { try { return localStorage.getItem(VKEY) === 'table' ? 'table' : 'gallery' } catch { return 'gallery' } })())
const goBookoff = () => { location.hash = '#/bookoff' }
const goSpecBase = () => { location.hash = '#/spec-baseline' }
const setView = (v) => { view.value = v; try { localStorage.setItem(VKEY, v) } catch { /* 存不了就算了 */ } }
const im = (id) => imgs.value[id]
const imgCls = (id) => { const m = im(id); if (!m) return 'none'; return m.kind + (m.w < 48 ? ' tiny' : '') + (m.kind === 'promo' && m.w / m.h > 1.9 ? ' wide' : '') }
const bgs = (id) => { const m = im(id); return m && m.kind === 'promo' && m.w / m.h > 1.9 ? { '--bg': `url(/img/sources/${m.file})` } : {} }
const BIZ = [{ k: 'all', t: '全部' }, { k: 'used3c', t: '二手 3C' }, { k: 'luxury', t: '二奢' }, { k: 'virtual', t: '虚拟 / 票务' }, { k: 'catalog', t: '型号目录' }]
const BIZN = { used3c: '二手 3C', luxury: '二奢', virtual: '虚拟 / 票务', catalog: '型号目录' }
const STC = { 样本: 'grn', 部分目录: 'acc', 受阻: 'red', 待适配: 'amb' }
const NOTE_ZH = [[/first-page sample does not establish a full catalogue/i, '只有第一页样本，不是整库'], [/No business product records parsed/i, '没解析出商品记录（返回 200 不等于抓成功）'], [/access challenge/i, '遇到验证 / 风控页'], [/HTTP 403/i, 'HTTP 403 被拒绝；没有重试和备用路径'], [/HTTP 503/i, 'HTTP 503 服务不可用'], [/not following another domain/i, '跳到了别的域名，没有跟'], [/timed out|timeout/i, '连接超时'], [/login|challenge/i, '要登录或验证']]
const zh = (n) => { for (const [r, t] of NOTE_ZH) if (r.test(n || '')) return t; return n || '' }
onMounted(async () => { try { imgs.value = await (await fetch('/data/source-images.json')).json() } catch { /* 没有图就显示首字 */ }
  try { const d = await (await fetch('/data/sources-100.json')).json(); sites.value = d.sites.map((x) => ({ ...x, note: zh(x.note) })) } catch { /* 没有就空着 */ } })
const total = computed(() => sites.value.reduce((s, x) => s + x.n, 0))
const cnt = (st) => sites.value.filter((s) => s.st === st).length
const shownSites = computed(() => sites.value.filter((s) => (biz.value === 'all' || s.biz === biz.value) && (!qs.value || (s.site + s.id).toLowerCase().includes(qs.value.toLowerCase()))))
const st = (id) => sites.value.find((s) => s.id === id)
const named = computed(() => [
  { t: '爱回收', id: 'aihuishou' }, { t: 'Bookoff', id: 'bookoff' }, { t: 'Hard Off（日本）', id: 'hardoff' }, { t: '京东', id: 'jd' }, { t: '中关村在线（型号资料）', id: 'zol' }].map((x) => { const s = st(x.id); return { t: x.t, id: x.id, st: s ? s.st : '不在 100 站里', cls: s ? STC[s.st] : 'red', note: s ? `${s.n} 条记录；${s.note}` : '台账里没有，要程序员加入' } })
  .concat([{ t: '闲鱼（挂牌 / 已售）', id: 'xianyu', st: '有采集器', cls: 'acc', note: '巡航台关键词行情 + 卖家主页采集已写；工作台没接，数据在服务器' }, { t: '淘宝（新品零售 / 榜单）', id: 'taobao', st: '没有', cls: 'red', note: '要官方联盟接口 + 自建兜底（禅道 B11）' }, { t: '厂商官网 / 大型商品库（规格）', id: '', st: '没有', cls: 'red', note: '型号库的品牌、规格、发布时间要靠它补' }]))
const TABS = computed(() => [{ k: 'sites', t: '平台来源', n: sites.value.length }, { k: 'rank', t: '榜单', n: ranks.length }, { k: 'rev', t: '评论区', n: reviews.length }, { k: 'seller', t: '卖家库', n: '' }, { k: 'gap', t: '缺口汇总', n: allGaps.value.length }])
const ranks = [
  { t: '闲鱼 43 个类目榜', img: 'xianyu', st: '数据在服务器', cls: 'amb', d: '约 3 万条，去重后一万多卖家；榜单行保留平台原分类、排名、期次。昵称是脱敏的，卖家主页地址要还原（Codex 当时写过方法，代码要程序员找）。', k: '榜单排名（平台口径），不是成交量', p: '长期；历史全纳入，之后只新增', gap: '本机没有数据；入口地址是手机浏览器形式；要程序员重抓并导进来，对接卖家库' },
  { t: '闲鱼「票务卡券」榜（110005）', img: 'xianyu', st: '数据在服务器', cls: 'amb', d: '接到虚拟侧，写进产品卡「需求信号」', k: '闲鱼已售 / 排名', p: '长期', gap: '虚拟侧没接；要按 SKU 归并' },
  { t: '闲鱼「游戏卡」榜（60002）', img: 'xianyu', st: '数据在服务器', cls: 'amb', d: '同上', k: '闲鱼已售 / 排名', p: '长期', gap: '虚拟侧没接' },
  { t: '淘宝卡券榜', img: 'taobao', st: '没有', cls: 'red', d: '官方开放平台 / 联盟接口为主，自建兜底；两条都要能独立跑', k: '淘宝联盟销量字段（开通后实测）', p: '长期', gap: '接口没申请 / 没接；需要登录，遇验证码停止不绕过' },
  { t: '京东卡券榜', img: 'jd', st: '没有', cls: 'red', d: '京东联盟商品接口可按 30 天引单量排序', k: '30 天引单量（联盟口径），不等于全平台销量，不和闲鱼已售混加', p: '长期', gap: '接口没申请 / 没接；不登录时搜索会跳风控页' },
  { t: '推特博主理论（Grok Bot 长跑）', st: '产物在 Google Drive', cls: 'amb', d: '连跑几十小时，产物导入线索池；母条和变体分开', k: '自述 / 已核 / 估算三档证据', p: '按任务书', gap: '线索池没做；导入前要去个人账号和私信编号' }]
const reviews = [
  { p: '淘宝 / 天猫', img: 'taobao', how: '官方：开放平台评价接口（要资质）；第三方：数据商；开源：爬虫（要登录）', gap: '三条路都没试；要定走哪条' }, { p: '京东', img: 'jd', how: '官方：京东联盟 / 开放平台评价；第三方数据商；开源爬虫', gap: '同上' },
  { p: '拼多多', how: '官方接口基本不开放；第三方数据商为主', gap: '同上' }, { p: '小红书', how: '官方：基本不开放；第三方数据商；开源爬虫（风控强）', gap: '同上' }, { p: '贴吧', how: '开源爬虫为主，公开页面', gap: '同上' }]
const SK = [{ t: '榜单原始行', d: '平台榜单的每一行' }, { t: '唯一卖家', d: '按稳定 ID 去重' }, { t: '已分类 / 待分类', d: '公司细分类字典' }, { t: '多类卖家', d: '一店多类，主体仍算一个' }, { t: '商品已匹配 / 待核 / 无匹配', d: '卖家商品 ↔ 型号' }, { t: 'Library 型号覆盖', d: '有卖家的型号 ÷ 型号总数' }]
const allGaps = computed(() => [
  { t: '型号库只有约 8 千个监控型号（你说十几万）：按大站整库抓', w: '实物选品', who: '程序员', cls: 'amb' }, { t: '型号缺品牌（大多数监控型号只有型号字符串）：从厂商库 / 目录补品牌、系列、规格', w: '实物选品', who: '程序员', cls: 'amb' },
  { t: '行情只有约 136 个型号有最新价：重采、查原因（空结果 / 低于 100 元错误价）', w: '实物选品', who: '程序员', cls: 'red' }, { t: '分类字典（大类→品类→品牌）要和 Library 同一套', w: '实物选品', who: '你', cls: 'amb' },
  { t: '闲鱼 43 类目榜数据导入、卖家主页还原、卖家库（唯一卖家、细分类、型号匹配）', w: '榜单 / 卖家库', who: '程序员', cls: 'red' }, { t: '淘宝 / 京东卡券榜：官方接口申请 + 自建兜底', w: '榜单', who: '程序员', cls: 'red' },
  { t: '评论区买家图：三平台以上都没实现', w: '评论区', who: '程序员', cls: 'red' }, { t: `100 站里 ${cnt('受阻') + cnt('待适配')} 站受阻 / 待适配：逐站适配或换来源`, w: '平台来源', who: '程序员', cls: 'red' },
  { t: '爱回收、Bookoff 不在已跑通的样本里：要单独适配（回收价 / 日本二手价口径分开，日元换算要你定）', w: '平台来源', who: '程序员 + 你', cls: 'red' }, { t: '厂商官网 / 大型商品库没有：型号规格和发布时间靠它', w: '平台来源', who: '程序员', cls: 'red' },
  { t: '虚拟：榜单需求信号、线索池（Grok 产物）、供货同行 / 群台账', w: '虚拟选品', who: '程序员', cls: 'red' }, { t: '选品状态、派给业务员要后端保存（现在页面标记不保存）', w: '实物选品', who: '程序员', cls: 'amb' }])
</script>

<style scoped>
.sc { padding: 16px 28px 64px; max-width: 1560px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; flex-wrap: wrap; } .head h1 { font-size: 28px; margin: 2px 0; letter-spacing: -.02em; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .sub { margin: 0; color: var(--mute); max-width: 860px; line-height: 1.5; font-size: 13.5px; }
.dual-caliber { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; margin: 12px 0 6px; }
.dc-box { background: var(--panel); border-radius: 16px; padding: 14px 18px; box-shadow: var(--sh); display: grid; gap: 6px; border-left: 5px solid var(--acc); }
.dc-box.macro { border-left-color: var(--amb); }
.dc-box b { font-size: 15.5px; }
.dc-box p { margin: 0; font-size: 13px; color: var(--mute); line-height: 1.6; }
.tabs-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0 6px; flex-wrap: wrap; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; } .tabs button { height: 34px; padding: 0 14px; border-radius: 10px; background: var(--soft); font-weight: 700; color: var(--ink2); display: inline-flex; gap: 8px; align-items: center; } .tabs button.on { background: var(--acc); color: #fff; } .tabs em { font-style: normal; font-size: 12px; opacity: .8; }
.sum { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; } .flt { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0 8px; } .flt button { height: 28px; padding: 0 12px; border-radius: 999px; background: var(--soft); font-weight: 600; font-size: 13px; } .flt button.on { background: var(--acc-soft); color: var(--acc); } .flt input { height: 30px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--soft); color: var(--ink); margin-left: auto; }
.named { margin-bottom: 14px; display: grid; gap: 6px; } .nm { display: flex; gap: 10px; align-items: baseline; font-size: 14px; flex-wrap: wrap; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; background: var(--panel); border-radius: 16px; overflow: hidden; } .tbl th { text-align: left; padding: 10px 12px; color: var(--mute); font-size: 12.5px; background: var(--soft); } .tbl td { padding: 9px 12px; border-top: 1px solid var(--line); vertical-align: top; } .tbl td small { display: block; color: var(--mute); font-size: 11.5px; } .nt { color: var(--ink2); line-height: 1.6; max-width: 520px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; } .rc { display: grid; gap: 6px; } .rh { display: flex; justify-content: space-between; gap: 8px; align-items: center; } .rc p { margin: 0; font-size: 13.5px; } .rc dl { display: grid; grid-template-columns: 44px 1fr; gap: 4px 10px; margin: 6px 0 0; font-size: 13px; } .rc dt { color: var(--mute); } .rc dd { margin: 0; } .gap { color: var(--red-ink); }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin: 12px 0; } .kp { background: var(--panel); border-radius: 16px; padding: 14px 16px; display: grid; gap: 2px; box-shadow: var(--sh); } .kp span { color: var(--mute); font-size: 13px; } .kp b { font-size: 34px; color: var(--mute); } .kp small { color: var(--mute); font-size: 12px; } .roles { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }

.vw { display: inline-flex; gap: 4px; background: var(--soft); padding: 3px; border-radius: 12px; margin-left: 10px; } .vw button { height: 28px; padding: 0 12px; border-radius: 9px; font-weight: 700; font-size: 13px; background: none; } .vw button.on { background: var(--panel); box-shadow: var(--sh); }
.gh3 { margin: 10px 0 8px; font-size: 16px; display: flex; gap: 10px; align-items: baseline; } .gh3 small { color: var(--mute); font-weight: 500; font-size: 13px; }
.sgal { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; } .sc2 { background: var(--panel); border-radius: 18px; overflow: hidden; box-shadow: var(--sh); display: grid; grid-template-rows: auto 1fr; } .sc2.star { outline: 2px solid var(--acc); }
.si { position: relative; aspect-ratio: 16 / 10; background: var(--soft); display: flex; align-items: center; justify-content: center; overflow: hidden; } .si.promo img { width: 100%; height: 100%; object-fit: cover; display: block; } .si.logo { background: linear-gradient(135deg, #f3f4f8, #dfe3ee); } .si.logo img { max-width: 46%; max-height: 62%; object-fit: contain; image-rendering: auto; filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .18)); }
.si.tiny img { width: 44px; height: 44px; max-width: none; max-height: none; padding: 8px; box-sizing: content-box; background: #fff; border-radius: 14px; filter: drop-shadow(0 3px 8px rgba(0, 0, 0, .18)); } .si.wide { background: #0e1020; } .si.wide::before { content: ''; position: absolute; inset: -24px; background: var(--bg) center / cover; filter: blur(20px) saturate(1.15) brightness(.85); } .si.wide img { position: relative; width: 100%; height: 100%; object-fit: contain; }
.si.none { background: linear-gradient(135deg, var(--soft), var(--acc-soft)); } .si b { font-size: 44px; color: var(--mute); } .noimg { position: absolute; right: 8px; bottom: 6px; font-style: normal; font-size: 11px; color: var(--mute); }
.sb { padding: 10px 14px 14px; display: grid; gap: 6px; align-content: start; } .sb h4 { margin: 0; font-size: 15.5px; } .sb p { margin: 0; font-size: 12.5px; color: var(--mute); line-height: 1.5; } .stg { display: flex; gap: 5px; flex-wrap: wrap; }
.rh .lg { width: 28px; height: 28px; object-fit: contain; border-radius: 6px; margin-right: 8px; } .lg2 { width: 20px; height: 20px; object-fit: contain; vertical-align: middle; margin-right: 8px; border-radius: 4px; } .rh { justify-content: flex-start; } .rh .tag { margin-left: auto; } .sm { font-size: 12.5px; }
</style>
