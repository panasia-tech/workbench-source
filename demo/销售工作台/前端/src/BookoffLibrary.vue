<template>
  <div class="page bl">
    <header class="head">
      <div><p class="eyebrow">BOOKOFF · 全量商品库</p><h1>日本 BOOKOFF 全量库<Q k="bl-main" /></h1>
        <p class="sub">2026-09-08 抓取的 BOOKOFF Online 全量商品：图书、CD、DVD/蓝光、漫画、杂志、游戏。<b>611 万条</b>，带当时售价、库存、发售日、图片。按关键词/品类查，点开看详情和原页。</p></div>
      <span class="tag amb" v-if="!stats.sample">数据快照 · 不是实时价</span><span class="tag red" v-else>样本库（{{ (stats.total || 0).toLocaleString() }} 条）· 全量库未挂载</span>
    </header>

    <div v-if="err" class="card warn"><b>全量库没连上：</b>{{ err }}<p class="muted">需要插上铠侠盘，并运行 `启动H5.sh`；库里是 611 万条离线快照。</p></div>
    <template v-else>
      <section class="stats">
        <div class="st"><b>{{ (stats.total || 0).toLocaleString() }}</b><span>商品记录</span></div>
        <div class="st"><b>{{ stats.categories?.length || 0 }}</b><span>大类</span></div>
        <div class="st"><b>{{ stats.treeTotal || '—' }}<small> / {{ stats.leafTotal || '—' }} 叶</small></b><span>官网类目</span></div>
        <div class="st"><b>¥{{ stats.median || '—' }}</b><span>售价中位数</span></div>
        <div class="st"><b>{{ (stats.inStock || 0).toLocaleString() }}</b><span>抓取时在库</span></div>
        <div class="st"><b>{{ (stats.withImage || 0).toLocaleString() }}</b><span>有真实图</span></div>
        <div class="st"><b>{{ stats.snapshot || '2026-09-08' }}</b><span>快照日期</span></div>
      </section>

      <section class="search card">
        <div class="srow"><input v-model="q" placeholder="搜书名 / 作者 / 型号（日文也可以）" @keyup.enter="doSearch" /><button class="btn pri" @click="doSearch">搜</button><button class="btn" @click="reset">清空</button></div>
        <div class="cats"><button :class="{ on: !cat }" @click="cat = ''; doSearch()">全部</button><button v-for="c in stats.categories || []" :key="c.name" :class="{ on: cat === c.name }" @click="cat = c.name; doSearch()">{{ c.name }} <em>{{ c.n.toLocaleString() }}</em></button></div>
        <div class="genres"><span class="lb">子类标签：</span><button v-for="g in stats.genres || []" :key="g.name" :class="{ on: genre === g.name }" @click="genre = genre === g.name ? '' : g.name; doSearch()">{{ g.name }} <em>{{ g.n.toLocaleString() }}</em></button><input v-model="genre" placeholder="或输入子类标签" @keyup.enter="doSearch" /><button class="btn sm" @click="openTree">官网类目树 {{ (stats.treeTotal || 0).toLocaleString() }} ›</button></div>
        <div class="filters"><label>最低价<input v-model.number="min" type="number" placeholder="日元" /></label><label>最高价<input v-model.number="max" type="number" placeholder="日元" /></label><label class="ck"><input type="checkbox" v-model="onlyImg" @change="doSearch" />只看有图</label><label>排序<select v-model="sort" @change="doSearch"><option value="rel">相关度</option><option value="price_asc">价格从低到高</option><option value="price_desc">价格从高到低</option><option value="new">发售日新到旧</option></select></label><label>日元汇率<input v-model.number="fx.jpy_to_cny" type="number" step="0.001" @change="saveFx" /></label><label>运费税费%<input v-model.number="fx.freight_tax_pct" type="number" step="1" @change="saveFx" /></label><span class="muted sm">已按 汇率 {{ fx.jpy_to_cny }} + 运税 {{ fx.freight_tax_pct }}% 实时折算人民币到手参考成本。</span></div>
      </section>

      <div class="resbar"><b>{{ total.toLocaleString() }}</b> 条<template v-if="q"> · 搜「{{ q }}」</template><template v-if="cat"> · {{ cat }}</template><span v-if="loading" class="tag amb">查询中…</span><span v-if="slow" class="muted sm">全量库在铠侠盘上，第一次查会慢一点</span></div>

      <div class="grid">
        <article v-for="x in items" :key="x.item_id" class="bc card" @click="open(x)">
          <div class="bi"><img v-if="x.image_url && !x.image_url.includes('item_ll.png')" :src="x.image_url" alt="" loading="lazy" referrerpolicy="no-referrer" @error="$event.target.style.display='none'" /><span v-else class="noimg">{{ x.category }}</span></div>
          <div class="bb"><span class="tag">{{ x.category }}</span><h3>{{ x.title }}</h3><p class="au">{{ x.author || '作者未录' }}<template v-if="x.genre"> · {{ x.genre }}</template></p>
            <div class="bp"><b>¥{{ (x.price_yen || 0).toLocaleString() }} JPY</b><span class="tag acc">≈ ¥{{ toCny(x.price_yen) }}</span><span class="tag" :class="x.stock === 'in_stock' ? 'grn' : ''">{{ x.stock === 'in_stock' ? '在库' : '库存未知' }}</span><span class="tag">{{ x.offer === 'new' ? '新品' : '二手' }}</span></div>
            <p class="rel">{{ x.release_date || '发售日未录' }}</p></div>
        </article>
      </div>
      <p v-if="!loading && !items.length" class="empty">没有结果。换个关键词，或去掉品类/价格筛选。</p>

      <div class="pager"><button class="btn" :disabled="page <= 1" @click="go(page - 1)">上一页</button><span>第 {{ page }} 页</span><button class="btn" :disabled="items.length < size" @click="go(page + 1)">下一页</button></div>
    </template>

    <div v-if="det" class="mask" @click.self="det = null"><div class="modal">
      <div class="mh"><div><span class="tag">{{ det.category }}</span><h3>{{ det.title }}</h3><p class="muted">{{ det.author || '作者未录' }}<template v-if="det.genre"> · {{ det.genre }}</template></p></div><button class="btn sm" @click="det = null">关闭</button></div>
      <div class="mb"><div class="mp"><img v-if="det.image_url && !det.image_url.includes('item_ll.png')" :src="det.image_url" alt="" referrerpolicy="no-referrer" @error="$event.target.style.display='none'" /><span v-else class="noimg">{{ det.category }}</span></div><dl class="kv"><dt>BOOKOFF 编号</dt><dd>{{ det.item_id }}</dd><dt>日元售价</dt><dd>¥{{ (det.price_yen || 0).toLocaleString() }} JPY</dd><dt>折合人民币成本</dt><dd><b>¥{{ toCny(det.price_yen) }}</b><small class="muted">（汇率 {{ fx.jpy_to_cny }} × (1 + {{ fx.freight_tax_pct }}% 运费关税)）</small></dd><dt>库存</dt><dd>{{ det.stock === 'in_stock' ? '抓取时在库' : '库存未知' }}</dd><dt>类型</dt><dd>{{ det.offer === 'new' ? '新品' : '二手' }}</dd><dt>发售日</dt><dd>{{ det.release_date || '未录' }}</dd><dt>分类</dt><dd>{{ det.category }} / {{ det.genre || '—' }}</dd><dt>抓取时间</dt><dd>{{ det.crawled_at }}</dd></dl></div>
      <p class="muted sm">这是 2026-09-08 的快照，不是当前售价；BOOKOFF 图片从官方 CDN 加载，需要联网。已按当前汇率与运税率折算人民币到手参考成本。</p>
      <div class="mf"><button class="btn" @click="det = null">返回</button><button class="btn ok" @click="addToPricebook(det)">+ 加入采购价格表</button><a class="btn pri" :href="det.source_url" target="_blank" rel="noopener">打开原页</a></div>
    </div></div>

    <div v-if="treeOpen" class="mask" @click.self="treeOpen = false"><div class="modal tree">
      <div class="mh"><div><span class="tag amb">官网结构</span><h3>BOOKOFF 官网类目树</h3><p class="muted">2,735 个类目 / 2,384 个叶子（4 级）。当时抓到了编码、URL、数量，<b>没抓名称</b>；点编码或「官网」去看名称。商品侧只有 207 个 genreCode、9,120 个 genre 标签，映射不完整——这是缺口。</p></div><button class="btn sm" @click="treeOpen = false">关闭</button></div>
      <div v-if="!tree" class="muted" style="padding: 30px; text-align: center">读类目树…</div>
      <div v-for="r in roots" :key="r.code" class="tnode root">
        <button @click="toggle(r.code)"><b>{{ r.code }}</b><span>{{ (r.count || 0).toLocaleString() }} 条</span><i>{{ expanded[r.code] ? '−' : '+' }}</i></button><a class="tgo" :href="'https://shopping.bookoff.co.jp/search/genre/' + r.code" target="_blank">官网 ›</a>
        <div v-if="expanded[r.code]" class="tch">
          <div v-for="c in childrenOf(r.code)" :key="c.code" class="tnode">
            <button @click="toggle(c.code)"><b>{{ c.code }}</b><span>{{ (c.count || 0).toLocaleString() }}</span><i v-if="c.children?.length">{{ expanded[c.code] ? '−' : '+' }}</i></button><a class="tgo" :href="'https://shopping.bookoff.co.jp/search/genre/' + c.code" target="_blank">官网 ›</a>
            <div v-if="expanded[c.code]" class="tch">
              <div v-for="g in childrenOf(c.code)" :key="g.code" class="tnode">
                <button @click="toggle(g.code)"><b>{{ g.code }}</b><span>{{ (g.count || 0).toLocaleString() }}</span><i v-if="g.children?.length">{{ expanded[g.code] ? '−' : '+' }}</i></button><a class="tgo" :href="'https://shopping.bookoff.co.jp/search/genre/' + g.code" target="_blank">官网 ›</a>
                <div v-if="expanded[g.code]" class="tch">
                  <div v-for="h in childrenOf(g.code)" :key="h.code" class="tnode leaf"><b>{{ h.code }}</b><span>{{ (h.count || 0).toLocaleString() }}</span><a :href="'https://shopping.bookoff.co.jp/search/genre/' + h.code" target="_blank">官网 ›</a></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div></div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import Q from './Q.vue'
import { toast } from './ui.js'

const stats = ref({}), items = ref([]), total = ref(0), page = ref(1), size = 24
const q = ref(''), cat = ref(''), genre = ref(''), onlyImg = ref(true), min = ref(null), max = ref(null), sort = ref('rel')
const treeOpen = ref(false), tree = ref(null), expanded = reactive({})
const loading = ref(false), slow = ref(false), err = ref(''), det = ref(null)
let timer
async function get(url) {
  const r = await fetch(url)
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.detail || ('HTTP ' + r.status))
  return d
}
async function loadStats() { try { stats.value = await get('/api/bookoff/stats') } catch (e) { err.value = e.message } }
async function doSearch() {
  page.value = 1; await fetchPage()
}
async function fetchPage() {
  loading.value = true; slow.value = false; clearTimeout(timer); timer = setTimeout(() => (slow.value = true), 1500)
  try {
    const p = new URLSearchParams({ page: page.value, size, sort: sort.value })
    if (q.value.trim()) p.set('q', q.value.trim()); if (cat.value) p.set('category', cat.value); if (genre.value.trim()) p.set('genre', genre.value.trim()); if (!onlyImg.value) p.set('img', 'all')
    if (min.value != null) p.set('min', min.value); if (max.value != null) p.set('max', max.value)
    const d = await get('/api/bookoff/search?' + p.toString())
    items.value = d.items || []; total.value = d.total || 0; err.value = ''
  } catch (e) { err.value = e.message; items.value = [] } finally { loading.value = false; clearTimeout(timer) }
}
function go(p) { if (p < 1) return; page.value = p; fetchPage() }
function reset() { q.value = ''; cat.value = ''; genre.value = ''; onlyImg.value = true; min.value = null; max.value = null; sort.value = 'rel'; doSearch() }
const fx = reactive({ jpy_to_cny: 0.047, freight_tax_pct: 12 })
const fxHdr = () => ({ Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || ''), 'Content-Type': 'application/json' })
function toCny(yen) {
  const y = Number(yen || 0)
  if (!y) return 0
  return Math.round(y * (Number(fx.jpy_to_cny) || 0.047) * (1 + (Number(fx.freight_tax_pct) || 0) / 100))
}
async function loadFx() {
  try {
    const r = await fetch('/api/demo/fx', { headers: fxHdr() })
    if (r.ok) Object.assign(fx, await r.json())
  } catch { /* fallback default fx */ }
}
async function saveFx() {
  try {
    const r = await fetch('/api/demo/fx', { method: 'PUT', headers: fxHdr(), body: JSON.stringify(fx) })
    if (r.ok) { Object.assign(fx, await r.json()); toast('已更新日元汇率与运费关税率') }
  } catch (e) { toast(e.message) }
}
async function addToPricebook(x) {
  const cny = toCny(x.price_yen)
  const suggest = Math.round(cny * 1.45)
  try {
    const r = await fetch('/api/demo/pricebook', {
      method: 'POST', headers: fxHdr(),
      body: JSON.stringify({
        model: x.title.slice(0, 40),
        config: `BOOKOFF ${x.category} · ${x.offer === 'new' ? '新品' : '二手'} · ¥${x.price_yen}JPY`,
        ref: suggest, suggest, limit: Math.round(cny * 1.1), deal: cny, paid: cny,
        fb: `来自 BOOKOFF 货源库 (${x.item_id})，折合人民币成本 ¥${cny}`
      })
    })
    if (!r.ok) throw new Error('加入失败')
    toast('已加入采购价格表（含汇率与运税成本）')
  } catch (e) { toast(e.message) }
}
function open(x) { det.value = x }
const roots = computed(() => (tree.value?.categories || []).filter((c) => c.depth === 0))
const childrenOf = (code) => (tree.value?.categories || []).filter((c) => c.parent === code)
function toggle(code) { expanded[code] = !expanded[code] }
async function openTree() { treeOpen.value = true; if (!tree.value) { try { tree.value = await (await fetch('/data/bookoff-categories.json')).json() } catch (e) { err.value = '类目树读不到：' + e.message } } }
onMounted(async () => { await Promise.all([loadFx(), loadStats()]); if (!err.value) await fetchPage() })
</script>

<style scoped>
.bl { padding: 30px 40px 80px; max-width: 1680px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .bl h1 { font-size: 34px; margin: 6px 0; letter-spacing: -.02em; } .sub { margin: 0; color: var(--mute); max-width: 980px; line-height: 1.7; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 12px; } .st { background: var(--panel); border-radius: 16px; padding: 12px 16px; box-shadow: var(--sh); } .st b { font-size: 25px; letter-spacing: -.02em; } .st span { display: block; color: var(--mute); font-size: 12px; }
.search { padding: 14px 16px; } .srow { display: flex; gap: 8px; flex-wrap: wrap; } .srow input { flex: 1; min-width: 220px; height: 42px; border: 1px solid var(--line); border-radius: 12px; padding: 0 14px; background: var(--soft); color: var(--ink); font: inherit; }
.cats { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; } .cats button { height: 32px; padding: 0 12px; border-radius: 999px; background: var(--soft); font-weight: 700; font-size: 12.5px; color: var(--ink2); } .cats button.on { background: var(--acc); color: #fff; } .cats em { font-style: normal; opacity: .65; font-size: 11px; margin-left: 3px; }
.genres { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; } .genres .lb { font-size: 12px; color: var(--mute); font-weight: 700; } .genres button { height: 28px; padding: 0 10px; border-radius: 999px; background: var(--soft); font-weight: 600; font-size: 12px; color: var(--ink2); } .genres button.on { background: var(--ink); color: var(--bg); } .genres em { font-style: normal; opacity: .6; margin-left: 3px; } .genres input { height: 30px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--panel); color: var(--ink); width: 160px; font-size: 12.5px; }
.tree { width: min(900px, 100%); } .tnode { border-top: 1px solid var(--line); padding: 4px 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; } .tnode > .tgo { flex: none; font-size: 11.5px; } .tnode > .tch { flex-basis: 100%; } .tnode > button { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; padding: 5px 8px; border-radius: 8px; font-size: 13px; } .tnode > button:hover { background: var(--soft); } .tnode > button b { min-width: 76px; color: var(--acc); } .tnode > button span { color: var(--mute); font-size: 12px; } .tnode > button i { margin-left: auto; font-style: normal; font-weight: 800; color: var(--mute); } .tnode > button a { margin-left: 8px; font-size: 11.5px; } .tnode.root > button { font-weight: 800; } .tch { margin-left: 18px; border-left: 2px solid var(--line); padding-left: 8px; } .tnode.leaf { display: flex; gap: 10px; align-items: center; padding: 4px 8px; font-size: 12.5px; } .tnode.leaf b { color: var(--acc); min-width: 76px; } .tnode.leaf span { color: var(--mute); } .tnode.leaf a { margin-left: auto; }
.filters { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 10px; } .filters label { display: grid; gap: 3px; font-size: 11.5px; color: var(--mute); } .filters input, .filters select { height: 34px; border: 1px solid var(--line); border-radius: 9px; padding: 0 9px; background: var(--soft); color: var(--ink); width: 110px; } .filters .sm { margin-left: auto; }
.resbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0 8px; font-size: 13.5px; } .resbar b { font-size: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; } .bc { padding: 0; overflow: hidden; cursor: pointer; transition: transform .12s; } .bc:hover { transform: translateY(-3px); } .bi { aspect-ratio: 4/3; background: var(--soft); display: flex; align-items: center; justify-content: center; color: var(--mute); font-size: 12px; } .bi img { width: 100%; height: 100%; object-fit: contain; background: #fff; } .bi .noimg { font-size: 12.5px; color: var(--mute); background: var(--soft); width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; } .filters .ck { display: flex; flex-direction: row; gap: 5px; align-items: center; font-size: 12px; color: var(--ink2); } .filters .ck input { width: auto; height: auto; }
.bb { padding: 10px 12px 12px; display: grid; gap: 3px; } .bb h3 { margin: 2px 0; font-size: 14px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; } .au { font-size: 11.5px; color: var(--mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .bp { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; } .bp b { font-size: 17px; } .rel { font-size: 11.5px; color: var(--mute); }
.empty { padding: 40px; text-align: center; color: var(--mute); } .pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin: 22px 0; }
.mask { position: fixed; inset: 0; z-index: 80; background: rgba(8,12,22,.55); display: flex; align-items: center; justify-content: center; padding: 18px; } .modal { width: min(760px, 100%); max-height: 90vh; overflow: auto; background: var(--panel); border-radius: 20px; padding: 22px; box-shadow: var(--sh-up); } .mh { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; } .mh h3 { margin: 4px 0; font-size: 20px; } .mb { display: grid; grid-template-columns: 220px 1fr; gap: 16px; margin: 12px 0; } @media (max-width: 700px) { .mb { grid-template-columns: 1fr; } } .mp { background: #fff; border-radius: 12px; overflow: hidden; } .mp img { width: 100%; max-height: 300px; object-fit: contain; } .mf { display: flex; justify-content: flex-end; gap: 8px; }
.warn { margin-top: 18px; padding: 16px 18px; background: var(--amb-soft); color: var(--amb-ink); } .warn b { font-size: 16px; } .warn p { margin: 6px 0 0; font-size: 13px; }
</style>
