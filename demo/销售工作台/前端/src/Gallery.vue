<template>
  <div class="gal">
    <header class="head">
      <div class="ttl">
        <h1>{{ TITLE[lens] }}</h1>
        <span v-if="state.imgSearch" class="poolbar">图池：<b class="amb">待审 {{ state.imgSearch.counts.REVIEWING || 0 }}</b><b class="red">失败 {{ state.imgSearch.counts.FAILED || 0 }}</b><b class="grn">就绪 {{ state.imgSearch.counts.READY || 0 }}</b><Q k="g-pool" /><a v-if="state.imgSearch.url" :href="state.imgSearch.url" target="_blank" rel="noopener">去审 ›</a></span>
      </div>
      <div class="tools">
        <label class="search" data-tour="gal-search"><Icon name="search" /><input v-model="q" placeholder="搜名称、货号、品牌" /></label>
        <button v-if="lens === 'all' || lens === 'phys'" class="btn sm pri" @click="go('wash')">✨ 批量洗价洗图</button>
        <button v-if="lens === 'virt'" class="btn sm pri" @click="go('virt-new')">+ 新增虚拟商品</button>
        <button v-if="lens === 'virt' || lens === 'svc'" class="btn sm" @click="go('skills')">Skill 台账 ›</button>
        <button class="btn sm" @click="openHelp('gallery')"><Icon name="help" />怎么用</button>
        <button class="btn sm" @click="loadAll(true)"><Icon name="refresh" />{{ state.loading ? '读取中…' : '刷新' }}</button>
      </div>
    </header>

    <div class="bar2">
      <div class="seg" data-tour="gal-seg" role="tablist" aria-label="状态">
        <button :class="{ on: flt === 'all' }" @click="flt = 'all'">全部 <b class="cn">{{ pool.length }}</b></button>
        <button :class="{ on: flt === 'red' }" @click="flt = 'red'"><i class="dot red"></i>要处理 <b class="cn red">{{ cnt.red }}</b></button>
        <button :class="{ on: flt === 'amb' }" @click="flt = 'amb'"><i class="dot amb"></i>注意 <b class="cn amb">{{ cnt.amb }}</b></button>
        <button :class="{ on: flt === 'grn' }" @click="flt = 'grn'"><i class="dot grn"></i>正常 <b class="cn grn">{{ cnt.grn }}</b></button>
      </div><Q k="g-counts" />
      <div class="seg by" data-tour="gal-by" role="tablist" aria-label="看法">
        <span class="muted">按</span>
        <button v-for="b in BY" :key="b.k" :class="{ on: by === b.k }" @click="by = b.k">{{ b.t }}</button>
        <span class="muted">看</span>
      </div><Q k="g-group" />
    </div>

    <p v-if="state.partial.length" class="part">部分数据没读到：{{ state.partial.join('、') }}。下面的红黄绿可能少算了这几项（已有内容没有被清空）。<button class="btn sm" @click="loadAll(true)">重新读取</button></p>
    <div v-if="state.loading && !state.items.length" class="skeleton"><i v-for="n in 8" :key="n"></i></div>

    <section v-for="g in groups" :key="g.key" class="grp">
      <h2 v-if="by !== 'none'"><span v-if="g.dot" class="dot" :class="g.dot"></span>{{ g.title }}<em>{{ g.items.length }}</em></h2>
      <div class="grid">
        <article v-for="it in g.items" :key="it.key" class="gc" :class="it.lvl" tabindex="0" @click="$emit('open', it)" @keydown.enter="$emit('open', it)">
          <div class="img">
            <img v-if="it.img" :src="it.img" :alt="it.name" loading="lazy" /><div v-else class="noimg"><b>待补图</b><span>没有验货实拍图，不会拿别的图冒充</span></div>
            <span class="badge" :class="it.lvl">{{ LV[it.lvl].icon }} {{ LV[it.lvl].text }}</span>
            <span class="kind">{{ KIND[it.kind] }}</span><span class="srcb" :class="{ miss: it.imgKind === '待补图', soft: it.imgKind.includes('非实拍') }">{{ it.imgKind }}</span>
          </div>
          <div class="body">
            <h3>{{ it.name }}</h3>
            <p class="sub">{{ it.sub }}</p>
            <p v-if="it.imgs && !it.locked" class="imgline"><span :class="{ bad: !it.imgs.real }">实拍图 {{ it.imgs.real }}</span><span :class="{ warn: !it.imgs.loc }">库位图 {{ it.imgs.loc }}</span><span v-if="it.imgs.shops">上架图 {{ it.imgs.listed }}/{{ it.imgs.shops }} 个号</span></p>
            <div class="m"><span>{{ it.a }}</span><span :class="['b', it.ageLvl]">{{ it.b }}</span></div>
            <div class="chips">
              <span v-for="c in it.chips" :key="c" class="tag">{{ c }}</span>
              <template v-if="(it.shops || []).length > 4">
                <span class="shopsum" :title="shopTitle(it)">{{ it.shops.length }} 个号</span>
                <span v-for="x in shopSum(it)" :key="x.lvl" class="shopsum" :class="x.lvl" :title="shopTitle(it)">{{ x.n }} {{ x.t }}</span>
              </template>
              <template v-else><span v-if="(it.shops || []).length" class="shopsum plain">各号</span><span v-for="s in it.shops || []" :key="s.id" class="shopdot" :class="s.lvl" :title="s.label + '：' + s.state">{{ s.label.slice(0, 1) }}</span></template>
            </div>
            <p class="why" :class="it.lvl">{{ it.issues[0]?.text || '一切正常，不用管' }}<em v-if="it.issues.length > 1">+{{ it.issues.length - 1 }} · 步入解决 ›</em><em v-else-if="it.lvl !== 'grn'">步入解决 ›</em></p>
            <div v-if="it.kind === 'phys' && !it.locked" class="quick-wash" @click.stop>
              <button class="btn sm pri" @click="go('price-cleaning/' + encodeURIComponent(it.code))">① 洗价格页</button>
              <button class="btn sm" @click="go('image-cleaning/' + encodeURIComponent(it.code))">② 洗图片页</button>
            </div>
          </div>
        </article>
      </div>
    </section>
    <div v-if="!shown.length && !state.loading" class="empty"><b>{{ !state.items.length ? (state.error ? '还没读到商品' : '这里还没有商品') : q ? '没有找到「' + q + '」' : '这一类现在没有商品' }}</b><p>{{ !state.items.length ? (state.error ? '点上面的「重新读取」再试；已有的内容不会被清空。' : '商品由仓管入库后自动出现在这里。') : q ? '换个关键词，或者清掉搜索框。' : '好事：没有这一类的问题。' }}</p><button v-if="q" class="btn" @click="q = ''">清掉搜索</button></div>
  </div>
</template>

<script setup>
import Q from './Q.vue'
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { LV, state, loadAll } from './store.js'
import { openHelp, gf } from './ui.js'
// 号多的时候（真数据 22 个号）不再一个号一个字，改成「22 个号 · 3 通过 · 17 待办 · 2 要整改」
const SUMT = { grn: '通过', amb: '待办', red: '要整改' }
const shopSum = (it) => ['grn', 'amb', 'red'].map((l) => ({ lvl: l, t: SUMT[l], n: (it.shops || []).filter((s) => s.lvl === l).length })).filter((x) => x.n)
const shopTitle = (it) => (it.shops || []).map((s) => s.label + '：' + s.state).join('\n')

const go = (h) => { location.hash = '#/' + h }
const props = defineProps({ lens: { type: String, default: 'all' } })
defineEmits(['open'])
const TITLE = { all: '库存商品', phys: '实物', virt: '虚拟商品', svc: '服务' }
const KIND = { phys: '实物', virt: '虚拟', svc: '服务' }
const BY = [{ k: 'status', t: '状态' }, { k: 'type', t: '类型' }, { k: 'cat', t: '品类' }, { k: 'src', t: '来源' }]
const q = computed({ get: () => gf.q, set: (v) => (gf.q = v) })
const flt = computed({ get: () => gf.flt, set: (v) => (gf.flt = v) })
const by = computed({ get: () => gf.by, set: (v) => (gf.by = v) })

const pool = computed(() => state.items.filter((i) => props.lens === 'all' || i.kind === props.lens))
const cnt = computed(() => ({
  red: pool.value.filter((i) => i.lvl === 'red').length,
  amb: pool.value.filter((i) => i.lvl === 'amb').length,
  grn: pool.value.filter((i) => i.lvl === 'grn').length
}))
const shown = computed(() => {
  const k = q.value.trim().toLowerCase()
  return pool.value.filter((i) => (flt.value === 'all' || i.lvl === flt.value) && (!k || (i.name + i.code + i.sub).toLowerCase().includes(k)))
})
const groups = computed(() => {
  const list = shown.value
  if (by.value === 'status') {
    return ['red', 'amb', 'grn'].map((l) => ({ key: l, dot: l, title: { red: '要处理，先做这些', amb: '注意，有空看看', grn: '正常，不用管' }[l], items: list.filter((i) => i.lvl === l) })).filter((g) => g.items.length)
  }
  const pick = { type: (i) => i.group.type, cat: (i) => i.group.cat, src: (i) => i.group.src }[by.value]
  const map = new Map()
  for (const i of list) {
    const k = pick(i)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(i)
  }
  return [...map].map(([k, items]) => ({ key: k, title: k, items }))
})
</script>

<style scoped>
.gal { padding: 14px 28px 56px; max-width: 1760px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.ttl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
h1 { font-size: 26px; letter-spacing: -.02em; line-height: 1.1; font-weight: 800; }
.tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.search { display: flex; align-items: center; gap: 8px; height: 34px; width: 210px; padding: 0 11px; background: var(--panel); border-radius: 10px; box-shadow: var(--sh); color: var(--mute); }
.search svg { width: 16px; height: 16px; }
.search input { border: 0; outline: 0; background: none; flex: 1; font-size: 13px; }
.btn svg { width: 16px; height: 16px; }
.bar2 { display: flex; align-items: center; gap: 10px; margin: 10px 0 2px; flex-wrap: wrap; }
.seg { display: inline-flex; align-items: center; gap: 4px; padding: 3px; background: var(--panel); border-radius: 12px; box-shadow: var(--sh); }
.seg button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 9px; font-weight: 600; font-size: 13.5px; color: var(--ink2); }
.seg button.on { background: var(--ink); color: var(--bg); }
.cn { font-weight: 800; font-size: 13px; }
.cn.red { color: var(--red); } .cn.amb { color: var(--amb); } .cn.grn { color: var(--grn); }
.seg button.on .cn { color: inherit; opacity: .92; }
.seg.by { padding-left: 12px; padding-right: 12px; margin-left: auto; } .seg.by .muted { font-size: 12.5px; }
.grp { margin-top: 10px; }
.grp h2 { display: flex; align-items: center; gap: 8px; font-size: 16.5px; font-weight: 700; margin-bottom: 8px; }
.grp h2 em { font-style: normal; font-size: 13px; font-weight: 700; background: var(--soft); color: var(--mute); border-radius: 999px; padding: 1px 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 24px; }
.gc { background: var(--panel); border-radius: var(--r); box-shadow: var(--sh); overflow: hidden; cursor: pointer; transition: transform .16s ease, box-shadow .16s ease; outline: 0; position: relative; }
.gc:hover, .gc:focus-visible { transform: translateY(-5px); box-shadow: var(--sh-up); }
.gc.red { box-shadow: 0 0 0 2.5px var(--red), var(--sh); } .gc.amb { box-shadow: 0 0 0 2px #f6cf72, var(--sh); }
.gc.red:hover { box-shadow: 0 0 0 2.5px var(--red), var(--sh-up); }
.img { position: relative; aspect-ratio: 1 / 1; background: var(--soft); }
.img img { width: 100%; height: 100%; object-fit: cover; }
.badge { position: absolute; left: 14px; top: 14px; display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 13px; border-radius: 999px; font-weight: 800; font-size: 13.5px; box-shadow: 0 4px 14px rgba(0, 0, 0, .28); }
.badge.red { background: var(--red); color: #fff; } .badge.amb { background: var(--amb); color: #2c1d00; } .badge.grn { background: var(--grn); color: #fff; }
.noimg { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--amb-ink); background: repeating-linear-gradient(45deg, var(--amb-soft), var(--amb-soft) 12px, var(--soft) 12px, var(--soft) 24px); font-size: 12.5px; text-align: center; padding: 20px; } .noimg b { font-size: 22px; }
.srcb { position: absolute; left: 14px; bottom: 14px; height: 24px; padding: 0 10px; border-radius: 999px; background: rgba(11, 18, 32, .62); color: #fff; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; } .srcb.miss { background: var(--amb); color: #2c1d00; }
.kind { position: absolute; right: 14px; top: 14px; height: 26px; padding: 0 11px; border-radius: 999px; background: rgba(11, 18, 32, .62); color: #fff; font-size: 12.5px; font-weight: 600; display: inline-flex; align-items: center; backdrop-filter: blur(6px); }
.body { padding: 16px 18px 18px; }
.body h3 { font-size: 17px; line-height: 1.35; font-weight: 700; min-height: 46px; }
.sub { color: var(--mute); font-size: 12.5px; margin-top: 3px; }
.m { display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px; font-size: 14px; font-weight: 600; }
.m .b { color: var(--ink2); } .m .b.red { color: var(--red); } .m .b.amb { color: var(--amb-ink); }
.chips { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; min-height: 24px; }
.shopdot { width: 24px; height: 24px; border-radius: 8px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.shopdot.red { background: var(--red-soft); color: var(--red-ink); } .shopdot.amb { background: var(--amb-soft); color: var(--amb-ink); } .shopdot.grn { background: var(--grn-soft); color: var(--grn-ink); }
.why { margin-top: 12px; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.45; font-weight: 500; }
.why em { font-style: normal; font-weight: 700; margin-left: 8px; opacity: .7; }
.why.red { background: var(--red-soft); color: var(--red-ink); } .why.amb { background: var(--amb-soft); color: var(--amb-ink); } .why.grn { background: var(--grn-soft); color: var(--grn-ink); }
.err { margin-top: 18px; color: var(--red-ink); background: var(--red-soft); padding: 12px 16px; border-radius: 12px; }
.empty { text-align: center; color: var(--mute); padding: 80px 0; } .empty b { font-size: 20px; color: var(--ink); display: block; margin-bottom: 6px; }
.part { margin-top: 16px; background: var(--amb-soft); color: var(--amb-ink); padding: 11px 16px; border-radius: 12px; display: flex; gap: 12px; align-items: center; font-weight: 600; font-size: 14px; }
.skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 24px; margin-top: 30px; }
.skeleton i { height: 420px; border-radius: var(--r); background: linear-gradient(90deg, var(--soft), var(--panel), var(--soft)); background-size: 200% 100%; animation: sk 1.2s linear infinite; }
@keyframes sk { to { background-position: -200% 0; } }
.srcb.soft { background: var(--amb-soft) !important; color: var(--amb-ink) !important; }
.poolbar { margin-left: 8px; font-size: 12.5px; color: var(--mute); display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; } .poolbar b { font-weight: 700; padding: 1px 8px; border-radius: 999px; background: var(--soft); } .poolbar b.amb { background: var(--amb-soft); color: var(--amb-ink); } .poolbar b.red { background: var(--red-soft); color: var(--red-ink); } .poolbar b.grn { background: var(--grn-soft); color: var(--grn-ink); }
.imgline { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; font-size: 12.5px; color: var(--mute); } .imgline .bad { color: var(--red-ink); font-weight: 800; } .imgline .warn { color: var(--amb-ink); font-weight: 700; }
.shopsum { font-size: 12.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; background: var(--soft); color: var(--ink2); white-space: nowrap; } .shopsum.plain { background: none; padding-left: 0; color: var(--mute); font-weight: 600; }
.shopsum.grn { background: var(--grn-soft); color: var(--grn-ink); } .shopsum.amb { background: var(--amb-soft); color: var(--amb-ink); } .shopsum.red { background: var(--red-soft); color: var(--red-ink); }
.wash-banner { margin-top: 22px; background: linear-gradient(90deg, #eff6ff 0%, #f0fdf4 100%); border: 1.5px solid #93c5fd; border-radius: 18px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.wash-banner.virt-banner { background: linear-gradient(90deg, #f5f3ff 0%, #ecfdf5 100%); border-color: #a78bfa; }
.wash-banner.virt-banner b { color: #4c1d95; }
.wash-banner b { display: block; font-size: 15.5px; color: #1e3a8a; }
.wash-banner span { font-size: 13px; color: #475569; }
.quick-wash { display: flex; gap: 8px; margin-top: 10px; }
.quick-wash .btn { flex: 1; justify-content: center; }
</style>
