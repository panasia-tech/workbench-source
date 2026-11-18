<template>
  <div class="dpage">
    <div class="dbar">
      <button class="btn" @click="$emit('back')"><Icon name="back" />返回</button>
      <span class="crumb">实物 / {{ d.sku?.product_name || code }}</span>
      <span style="margin-left: auto; display: flex; gap: 8px">
        <button class="btn pri" @click="goGcQueue">🚀 AdsPower 群控队列 ›</button>
        <button class="btn" @click="openHelp('detail')"><Icon name="help" />怎么用</button>
      </span>
    </div>

    <p v-if="err" class="errbox">{{ err }}</p>
    <div v-else-if="loading && !d.sku" class="muted" style="padding: 80px 0; text-align: center">读取中…</div>

    <template v-else-if="d.sku">
      <section class="hero" :class="{ zoom }">
        <div class="pic" data-tour="dt-pic">
          <div class="big" :class="d.lvl" :title="d.imgs.length ? '点击全屏高清预览大图' : ''" @click="d.imgs.length && openLightbox(d.imgs, d.cur, d.heroKind)"><img v-if="d.imgs.length" :src="d.imgs[d.cur]" :alt="d.heroKind" /><span v-if="d.imgs.length" class="hk" :class="{ soft: d.heroKind !== '实拍图' }">{{ d.heroKind }} · 🔍点击放大</span><div v-else class="noimg"><b>待补图</b><span>这件货一张图都没有，不拿库位图或同款图占位</span></div></div>
          <div class="thumbs"><button v-for="(u, i) in d.imgs" :key="u" :class="{ on: i === d.cur }" @click="d.cur = i" @dblclick="openLightbox(d.imgs, i, d.heroKind)"><img :src="u" alt="" /></button></div>
        </div>
        <div class="info">
          <div class="row1">
            <span class="badge-l" :class="d.lvl">{{ LV[d.lvl].icon }} {{ LV[d.lvl].text }}</span>
            <span class="tag dark">{{ PHASE[d.sku.warehouse_phase] || '在库' }}</span>
            <span class="tag">{{ d.sku.brand }}</span>
          </div>
          <h1>{{ d.sku.product_name }}</h1>
          <p class="codes">货号 <b>{{ d.sku.sku_code }}</b>　库位 <b>{{ d.sku.location_code || '—' }}</b>　成色 <b>{{ d.sku.condition_grade || '—' }}</b></p>

          <div class="issuebox" data-tour="dt-issues" :class="d.lvl">
            <div class="t">{{ d.issues.length ? `现在有 ${d.issues.length} 件事要看` : '这件货没有要处理的事' }}<Q k="p-issues" /></div>
            <ul v-if="d.issues.length"><li v-for="(it, i) in d.issues" :key="i"><i class="dot" :class="it.lvl"></i><span>{{ it.text }}</span><a v-if="it.go" @click="jump(it.go)">去看 ›</a></li></ul>
            <p v-else class="okline">价、图、库龄都在正常范围，已可直接上架或在售。</p>
          </div>

          <p class="qrow">采购成本 / 价格围栏 / 闲鱼清洗均价<Q k="p-facts" /></p>
          <div class="facts" data-tour="dt-facts">
            <div><span>采购成本</span><b>¥{{ money(d.sku.cost_price) }}</b></div>
            <div><span>成本围栏</span><b>¥{{ money(d.sku.cost_price) }}</b><small>售价 ≥ 采购成本</small></div>
            <div><span>建议/当前价</span><b>¥{{ money(d.sku.suggest_price) }}</b></div>
            <div><span>闲鱼清洗均价</span><b>{{ d.market ? '¥' + money(d.market) : '待抓快照' }}</b><small v-if="!d.market">点下方抓快照算均价</small><button class="btn sm" @click="cleanPrice">看闲鱼原始快照 ↗</button></div>
          </div>
        </div>
      </section>

      <FlowPhys :code="code" :item="itemRow" :market="d.market" @changed="load" />

      <Fold v-model="unitOpen" title="单件资料 · AI 图 · 样板" help="ue-unit">
        <template #chips><span class="chip">一机一 SKU / 链接</span><span class="chip">AI 图工具留痕</span><span class="chip">样板闸门</span><span class="chip">去水印 / 视觉筛选</span></template>
        <UnitExtras :sku="d.sku" />
      </Fold>

      <Fold v-model="imgOpen" id="imgs" data-tour="dt-imgs" title="三种图" help="p-imgs">
        <template #chips>
          <span class="chip" :class="d.dups.length || d.shops.some((x) => x.listed && !x.images.length) ? 'red' : d.shops.length && d.shops.every((x) => x.images.length) ? 'grn' : 'amb'">上架图 {{ d.shops.filter((x) => x.images.length).length }}/{{ d.shops.length }} 个号{{ d.dups.length ? ' · 雷同' : '' }}</span>
          <span class="chip" :class="d.kinds.real.length ? '' : 'red'">实拍图 {{ d.kinds.real.length }}</span>
          <span class="chip" :class="d.kinds.loc.length ? '' : 'amb'">库位图 {{ d.kinds.loc.length }}</span>
        </template>
        <ImagesPanel :kinds="d.kinds" :shops="d.shops" :dups="d.dups" :crawled="crawledOf" :rejected="d.li?.rejected?.length || 0" :max="d.li?.max_per_shop || 9" :start="imgStart" />
      </Fold>

      <Fold v-model="sliceOpen" id="slice" title="录屏切片（屏幕类）" help="p-slice">
        <template #chips><span class="chip">手机录 · 电脑切 · 看有没有问题</span></template>
        <SliceTool :item="{ code: props.code }" @uploaded="onSliced" />
      </Fold>

      <Fold v-model="more" data-tour="dt-fold" title="更多详情" help="p-more">
        <template #chips>
          <span class="chip" :class="d.ageLvl">库龄：{{ ageOf(d.days).short }}</span>
          <span class="chip" :class="priceLvl">价格范围：{{ d.prices.length ? d.prices.length + ' 个号已填' : '还没填价' }}</span>
          <span class="chip">{{ d.shops.length }} 个号</span>
          <span class="chip">流转 {{ (d.sku.stock_events || []).length }} 条</span>
        </template>
      <div class="secs">
          <section id="age" class="card">
            <h3>库龄与周期<Q k="p-age" /> <small>7 天一个周期，最多 4 个周期</small></h3>
            <p class="agen"><b>{{ d.days }}</b> 天 <span class="tag" :class="d.ageLvl">{{ d.cycleText }}</span></p>
            <div class="cycles">
              <div v-for="n in 4" :key="n" class="cy" :class="cyClass(n)"><i :style="{ width: cyFill(n) + '%' }"></i><span>第 {{ n }} 周期<em>{{ (n - 1) * 7 }}–{{ n * 7 }} 天</em></span></div>
            </div>
            <p class="rule"><i class="dot grn"></i>第 1–2 周期（0–14 天）正常　<i class="dot amb"></i>第 3–4 周期（15–28 天）该清仓　<i class="dot red"></i>满 28 天算滞销</p>
            <dl class="kv" style="margin-top: 16px">
              <dt>入库时间</dt><dd>{{ d.age?.stock_age?.inbound_at || '—' }}</dd>
            <dt>WMS 库龄线</dt><dd v-if="d.age?.stock_age">系统里现在是：{{ d.age.stock_age.target_days }} 天目标 / {{ d.age.stock_age.clearance_days }} 天清仓 / {{ d.age.stock_age.max_days }} 天上限，当前「{{ d.age.stock_age.stage_label }}」。<template v-if="d.age.stock_age.max_days !== 28">这页按 7 天一个周期、满 28 天算滞销来标红黄绿，和系统里的线不一样，要对齐的话由管理员改库龄三条线。</template></dd><dd v-else>读不到</dd>
              <dt>链接焕新</dt><dd>在架满 {{ d.age?.auto_refresh?.cycle_days || 7 }} 天没卖掉，自动删掉重发<template v-if="d.age?.auto_refresh?.next_at">；下次 {{ d.age.auto_refresh.next_at }}</template></dd>
              <dt>库存状态</dt><dd>{{ STATUS[d.sku.status] || d.sku.status }}<template v-if="d.sku.reserve_source">（{{ d.sku.reserve_source === 'PLATFORM_SOLD' ? '平台已售，货已锁住' : '切单锁货' }}）</template></dd>
            </dl>
          </section>
  
          <section id="price" class="card">
            <h3>价格是否在范围内<Q k="p-price" /> <small>成本的 130% ～ 500%</small></h3>
            <div v-if="d.prices.length" class="gauge">
              <div class="track">
                <div class="z red" style="left: 0; width: 6.67%"></div><div class="z grn" style="left: 6.67%; width: 88.9%"></div><div class="z amb" style="left: 95.57%; width: 4.43%"></div>
                <div v-for="p in d.prices" :key="p.id" class="pt" :class="p.lvl" :style="{ left: gx(p.pct) + '%' }" :title="p.label + ' ¥' + p.price">{{ p.label.slice(0, 1) }}</div>
              </div>
              <div class="ticks"><span style="left: 0">成本 100%</span><span style="left: 6.67%">130%</span><span style="left: 95.57%">500%</span></div>
            </div>
            <p v-else class="muted">还没有任何一个号填过价。</p>
            <div v-if="d.prices.length" class="tblwrap"><table class="tbl"><tr><th>店铺</th><th>售价</th><th>占成本</th><th>判断</th></tr>
              <tr v-for="p in d.prices" :key="p.id"><td>{{ p.label }}</td><td class="num">¥{{ p.price }}</td><td class="num">{{ p.pct }}%</td><td><span class="tag" :class="p.lvl">{{ p.lvl === 'red' ? '✕ 低于底线' : p.lvl === 'amb' ? '! 偏高' : '✓ 正常' }}</span></td></tr></table></div>
            <dl class="kv" style="margin-top: 14px"><dt>行情</dt><dd>{{ d.market ? '¥' + money(d.market) + '（' + (d.marketBasis || '—') + '）' : '没有行情价，爬虫还没爬到' }}</dd><dt>价格走势</dt><dd>{{ d.hist?.series?.length ? d.hist.series.length + ' 个点' : '暂无走势数据' }}</dd></dl>
          </section>
  
          <section id="shops" class="card wide">
            <h3>各个号的上架情况<Q k="p-shops" /> <small>使用第 1 步确认的统一售价 + 第 2 步各号互不重复净图直接上架</small></h3>
            <div class="shops">
              <div v-for="s in d.shops" :key="s.id" class="shop" :class="s.lvl">
                <div class="sh"><b>{{ s.label }}</b><span class="tag" :class="s.lvl">{{ LV[s.lvl].icon }} {{ s.state }}</span><span v-if="s.listed" class="tag dark">在架</span><button class="btn sm" @click.stop="openHome(s)">前往主页</button></div>
                <div class="si"><img v-for="(u, sidx) in s.images.slice(0, 3)" :key="u" :src="u" alt="" style="cursor:zoom-in" title="点击放大预览" @click="openLightbox(s.images, sidx, s.label + ' 上架图')" /><span v-if="!s.images.length" class="muted">还没选图</span></div>
                <p class="sp">{{ s.price ? '售价 ¥' + s.price : '还没填价' }}</p>
                <p v-if="s.problem" class="sn">{{ s.problem }}</p>
              </div>
            </div>
          </section>

          <section id="flow" class="card">
            <h3>流转记录<Q k="p-flow" /></h3>
            <p v-if="!(d.sku.stock_events || []).length" class="muted">暂无流转记录</p>
            <ul v-else class="tl"><li v-for="e in d.sku.stock_events" :key="e.id"><b>{{ e.event_type }}</b><span>{{ e.ref_no || '' }}</span><em>{{ e.created_at }}</em></li></ul>
          </section>
          <section class="card">
            <h3>关联单号<Q k="p-links" /></h3>
            <dl class="kv"><dt>采购单</dt><dd>{{ d.sku.purchase_order_no || '—' }}</dd><dt>货号</dt><dd>{{ d.sku.sku_code }}</dd><dt>快递单号</dt><dd>{{ d.sku.tracking_no || '—' }}</dd><dt>在架数</dt><dd>{{ d.sku.on_shelf_count || 0 }} 个号</dd></dl>
          </section>
        </div>
      </Fold>
    </template>
    <div v-if="shopHome" class="mask" @click.self="shopHome = null"><div class="modal shopm">
      <div class="mh"><h3>{{ shopHome.label }} · 账号主页</h3><button class="btn sm" @click="shopHome = null">关闭</button></div>
      <p class="muted">这个号发布的所有商品（演示）：{{ shopHome.listed ? '在架' : '未在架' }} · {{ shopHome.images?.length || 0 }} 张上架图。正式版从平台发布记录同步。</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>货号</th><th>名称</th><th>状态</th></tr></thead><tbody><tr v-for="x in shopList" :key="x.code"><td>{{ x.code }}</td><td>{{ x.name }}</td><td><span class="tag" :class="x.lvl">{{ x.lvl === 'red' ? '要处理' : x.lvl === 'amb' ? '注意' : '正常' }}</span></td></tr></tbody></table></div>
      <h4>盘点：系统库存 vs 实际库存</h4>
      <div class="stk"><label>系统在库<input v-model.number="stk.system" type="number" /></label><label>实际盘点<input v-model.number="stk.actual" type="number" /></label><b>差异 {{ diff > 0 ? '+' + diff : diff }}</b><button class="btn sm pri" @click="doStock">提交盘点（演示）</button></div>
      <p class="muted sm">差异不为 0 要写原因（错发 / 未入库 / 丢失），盘点归仓管工作台；销售端只读。</p>
    </div></div>
    <div v-if="lb.open" class="mask" style="z-index:90;background:rgba(10,15,28,.86)" @click.self="lb.open = false">
      <div style="background:#fff;border-radius:20px;padding:16px;max-width:min(920px,94vw);max-height:90vh;display:flex;flex-direction:column;gap:12px">
        <img :src="lb.list[lb.idx]" alt="" style="max-height:74vh;max-width:88vw;object-fit:contain;border-radius:12px;background:#f8fafc" />
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div><b>{{ lb.title }}</b> <span class="muted">（{{ lb.idx + 1 }} / {{ lb.list.length }}）</span></div>
          <div style="display:flex;gap:8px">
            <button v-if="lb.list.length > 1" class="btn sm" @click="lb.idx = (lb.idx - 1 + lb.list.length) % lb.list.length">← 上一张</button>
            <button v-if="lb.list.length > 1" class="btn sm" @click="lb.idx = (lb.idx + 1) % lb.list.length">下一张 →</button>
            <button class="btn sm pri" @click="lb.open = false">关闭大图</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<script setup>
import Q from './Q.vue'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import FlowPhys from './FlowPhys.vue'
import Fold from './Fold.vue'
import ImagesPanel from './ImagesPanel.vue'
import UnitExtras from './UnitExtras.vue'
import SliceTool from './SliceTool.vue'
import { openHelp } from './ui.js'
import { REAL, api, post } from './api.js'
import { toast as say } from './ui.js'
import { LV, state, loadAll, money, daysSince, ageOf, cellLvl, worst, imageKinds, imgKey, imgUrl, IMG_RULES } from './store.js'


function cleanPrice() {
  const id = d.sku.sku_code
  location.hash = '#/price-cleaning/' + encodeURIComponent(id)
}

const props = defineProps({ code: String })
defineEmits(['back'])
const PHASE = { pending_negotiation: '待议价', pending_inbound: '待入库', pending_create: '待创建上架信息', pending_publish: '待发布', listing: '发布中', on_sale: '在售', locked: '待发货', shipped: '已发货' }
const STATUS = { IN_STOCK: '在库', RESERVED: '已锁单', SHIPPED: '已发货', LOSS: '报损' }
const SHOP_STATE = { NONE: '待选图上架', DRAFT: '已暂存待发', SUBMITTED: '待确认上架', APPROVED: '已就绪', REJECTED: '待重选', STALE: '成本变动待核' }
const itemRow = computed(() => state.items.find((i) => i.key === 'phys:' + props.code))
const d = reactive({ sku: null, heroKind: '', kinds: { loc: [], real: [], defect: [], material: [], other: [] }, dups: [], li: null, imgs: [], cur: 0, issues: [], lvl: 'grn', shops: [], prices: [], age: null, hist: null, ratio: '1.3', floor: null, market: null, marketBasis: '', days: 0, ageLvl: 'grn', cycleText: '' })
const loading = ref(false)
const lb = reactive({ open: false, list: [], idx: 0, title: '' })
function openLightbox(list, idx = 0, title = '商品实拍预览') {
  if (!list || !list.length) return
  lb.list = list
  lb.idx = Math.max(0, Math.min(idx, list.length - 1))
  lb.title = title
  lb.open = true
}
const err = ref('')
const toast = ref('')
const flash = (m) => { toast.value = m; setTimeout(() => (toast.value = ''), 2200) }
const rank = { red: 0, amb: 1, grn: 2 }

async function load() {
  loading.value = true
  err.value = ''
  try {
    const c = encodeURIComponent(props.code)
    const [sku, age, ap, shopsRaw, hist, li] = await Promise.all([
      api(`/inventory/skus/${c}`), api(`/listing/skus/${c}/stock-age`).catch(() => null), api(`/listing-approvals/skus/${c}`).catch(() => null),
      api(`/listing/skus/${c}/shops`).catch(() => []), api(`/inventory/skus/${c}/price-history`).catch(() => null),
      api(`/listing/skus/${c}/listing-images`).catch(() => null)
    ])
    const kinds = imageKinds(sku)
    const days = daysSince(sku.inbound_at)
    const a = ageOf(days)
    const listedBy = Object.fromEntries((shopsRaw || []).map((x) => [x.shop_id, x.publish_status === 'LISTED']))
    const cost = Number(sku.cost_price || 0)
    const shops = (ap?.shops || []).map((s) => {
      const c2 = s.cell || {}
      const ax = s.approval
      return {
        id: s.id, label: s.label, state: c2.needs_fix ? '在架待整改' : c2.label || SHOP_STATE[c2.state], lvl: cellLvl(c2.state, c2.needs_fix), listed: !!listedBy[s.id] || !!c2.listed,
        images: (ax?.images || []).map(imgUrl).filter(Boolean), price: ax?.price || null, note: ax?.review_note || '', problem: c2.problem || '',
        by: ax?.submitted_by_name ? ax.submitted_by_name + ' 提交' : '', canReview: c2.state === 'SUBMITTED'
      }
    })
    const prices = shops.filter((s) => s.price && cost).map((s) => {
      const pct = Math.round((Number(s.price) / cost) * 100)
      return { id: s.id, label: s.label, price: s.price, pct, lvl: pct < 100 ? 'red' : pct > 500 ? 'amb' : 'grn' }
    })
    const row = state.items.find((i) => i.key === 'phys:' + props.code)
    const issues = row ? row.issues.slice() : []
    for (const p of prices) {
      if (p.lvl === 'red') issues.unshift({ lvl: 'red', text: `「${p.label}」售价低于采购成本（占成本 ${p.pct}%），倒挂拦截`, go: 'price' })
      if (p.lvl === 'amb') issues.push({ lvl: 'amb', text: `「${p.label}」的售价是成本的 ${p.pct}%，高于 500%，确认没输错`, go: 'price' })
    }
    // 行情价每天抓一次，较上一次波动超过 10% 就报警（以详情里刚读到的走势为准）
    const ser = hist?.series || [], pa = ser[ser.length - 1], pb = ser[ser.length - 2]
    if (pa && pb && pb.price && !issues.some((i) => i.price)) {
      const pct = Math.round(((pa.price - pb.price) / pb.price) * 1000) / 10
      if (Math.abs(pct) > IMG_RULES.priceAlertPct) issues.unshift({ lvl: Math.abs(pct) > 20 ? 'red' : 'amb', price: true, text: `行情价波动 ${pct > 0 ? '+' : ''}${pct}%（${pb.date} ¥${pb.price} → ${pa.date} ¥${pa.price}），超过 ${IMG_RULES.priceAlertPct}%，核对一下`, go: 'price' })
    }
    // 各号的上架图不能雷同：两个号用了同一张图，平台会判铺货
    const seen = {}
    for (const s of shops) for (const u of new Set(s.images.map(imgKey))) (seen[u] ||= []).push(s.label)
    const pair = {}
    for (const labs of Object.values(seen)) for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) { const k = labs[i] + '\u0001' + labs[j]; pair[k] = (pair[k] || 0) + 1 }
    const dups = Object.entries(pair).map(([k, n]) => { const [a, b] = k.split('\u0001'); return { a, b, n } })
    if (dups.length) issues.unshift({ lvl: 'red', text: `上架图雷同：${dups.map((x) => `「${x.a}」和「${x.b}」有 ${x.n} 张同样的图`).join('；')}，平台会判铺货`, go: 'imgs' })
    issues.sort((x, y) => rank[x.lvl] - rank[y.lvl])
    Object.assign(d, {
      sku, kinds, dups, li, imgs: kinds.real.length ? kinds.real : kinds.material, heroKind: kinds.real.length ? '实拍图' : kinds.material.length ? '商品图（不是这件货的实拍）' : '', cur: 0, issues, lvl: worst(issues), shops, prices, age, hist,
      ratio: ap?.min_cost_ratio || '1.3', floor: ap?.floor_price ?? cost * 1.3, market: ap?.market?.price || hist?.stats?.latest?.price || null, marketBasis: ap?.market?.basis || '', days, ageLvl: a.lvl, cycleText: a.long
    })
  } catch (e) { err.value = '读取详情失败：' + e.message; d.sku = null } finally { loading.value = false }
}
const gx = (pct) => Math.max(0, Math.min(100, ((pct - 100) / 450) * 100))
const cyFill = (n) => Math.max(0, Math.min(100, ((d.days - (n - 1) * 7) / 7) * 100))
const cyClass = (n) => (n <= 2 ? 'grn' : 'amb') + (d.days >= 28 ? ' over' : '')
const more = ref(false)
const imgOpen = ref(false)
const unitOpen = ref(false), sliceOpen = ref(false)
const shopHome = ref(null), stk = reactive({ system: 12, actual: 12 })
const shopList = computed(() => state.items.filter((i) => i.kind === 'phys').slice(0, 10))
const diff = computed(() => (Number(stk.actual) || 0) - (Number(stk.system) || 0))
function openHome(s) { shopHome.value = s; stk.system = 12; stk.actual = 12 }
function doStock() { say(diff.value === 0 ? '账实一致（演示）' : '差异 ' + diff.value + '，已提交仓管复核（演示）') }
async function onSliced() { await loadAll(true); await load(); imgOpen.value = true }
const imgStart = ref('listing')
const crawledOf = computed(() => (Array.isArray(d.li?.crawled) ? d.li.crawled.map(imgUrl).filter(Boolean) : []))
const zoom = ref(false)
const priceLvl = computed(() => (d.prices.some((x) => x.lvl === 'red') ? 'red' : d.prices.some((x) => x.lvl === 'amb') ? 'amb' : d.prices.length ? 'grn' : ''))
const goGcQueue = () => { location.hash = '#/gc-queue' }
const jump = (id) => { if (id === 'shops' && d.sku?.status === 'RESERVED') { location.hash = '#/gc-queue'; return } if (id === 'imgs') { imgOpen.value = true; if (!d.kinds.real.length) imgStart.value = 'real' } else more.value = true; nextTick(() => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)) }

async function review(s, approve) {
  let note = ''
  if (!approve) { note = (window.prompt(`退回「${s.label}」：写清楚哪里要改，员工会原样看到。`, '') || '').trim(); if (!note) return flash('退回要写原因') }
  try {
    await post(`/listing-approvals/skus/${encodeURIComponent(props.code)}/review`, { shop_ids: [s.id], approve, note })
    flash(approve ? '已通过' : '已退回')
    await loadAll(); await load()
  } catch (e) { flash('没办成：' + e.message) }
}
onMounted(async () => { if (!state.items.length) await loadAll(); await load(); const j = new URLSearchParams((location.hash.split('?')[1]) || '').get('jump'); if (j) jump(j) })
watch(() => props.code, load)
</script>

<style scoped>
.errbox { color: var(--red-ink); background: var(--red-soft); padding: 14px 18px; border-radius: 14px; }
.agen { font-size: 15px; margin-bottom: 14px; } .agen b { font-size: 46px; letter-spacing: -.02em; margin-right: 4px; } .agen .tag { margin-left: 10px; height: 28px; }
.mask { position: fixed; inset: 0; z-index: 80; background: rgba(8,12,22,.55); display: flex; align-items: center; justify-content: center; padding: 18px; } .shopm { width: min(720px, 100%); max-height: 88vh; overflow: auto; background: var(--panel); border-radius: 20px; padding: 22px; box-shadow: var(--sh-up); } .mh { display: flex; justify-content: space-between; align-items: center; gap: 10px; } .mh h3 { margin: 0; } .stk { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin: 8px 0; } .stk label { display: grid; gap: 3px; font-size: 12px; color: var(--mute); } .stk input { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); color: var(--ink); width: 110px; } .cycles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.cy { position: relative; height: 66px; border-radius: 14px; overflow: hidden; background: var(--soft); }
.cy i { position: absolute; inset: 0 auto 0 0; } .cy.grn i { background: #a6e2c9; } .cy.amb i { background: #f8dc92; } .cy.over i { background: #f4b4b6; }
.cy span { position: relative; display: block; padding: 11px 13px; font-weight: 700; font-size: 13.5px; line-height: 1.35; color: #14202b; } .cy em { display: block; font-style: normal; font-weight: 500; opacity: .65; font-size: 12px; }
.rule { margin-top: 14px; font-size: 13px; color: var(--mute); display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.shops { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.shop { border: 2px solid var(--line); border-radius: 20px; padding: 16px 18px; } .shop.red { border-color: #f4b4b6; background: var(--red-soft); } .shop.amb { border-color: #f6dc9a; } .shop.grn { border-color: #a6e2c9; }
.sh { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .sh b { font-size: 16px; margin-right: auto; }
.si { display: flex; gap: 8px; margin: 12px 0; min-height: 68px; align-items: center; } .si img { width: 68px; height: 68px; border-radius: 12px; object-fit: cover; }
.sp { font-size: 17px; font-weight: 800; } .sp small { font-weight: 400; color: var(--mute); font-size: 12.5px; }
.sn { margin-top: 8px; font-size: 13px; color: var(--red-ink); background: var(--panel); padding: 7px 11px; border-radius: 10px; }
.sa { margin-top: 12px; display: flex; gap: 8px; }
.tl { list-style: none; margin: 0; padding: 0; } .tl li { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); } .tl em { margin-left: auto; font-style: normal; color: var(--mute); font-size: 13px; }
.pic .big { position: relative; } .hk { position: absolute; left: 8px; bottom: 8px; font-size: 12px; font-weight: 800; padding: 3px 9px; border-radius: 8px; background: rgba(0,0,0,.6); color: #fff; } .hk.soft { background: var(--amb-ink); }
.noimg { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; padding: 14px; background: repeating-linear-gradient(45deg, var(--soft), var(--soft) 12px, var(--panel) 12px, var(--panel) 24px); } .noimg b { font-size: 16px; color: var(--red-ink); } .noimg span { font-size: 12.5px; color: var(--mute); }
.qrow { margin: 10px 0 6px; font-size: 12.5px; color: var(--mute); display: flex; align-items: center; }
</style>
