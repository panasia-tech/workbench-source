<template>
  <div class="gal">
    <header class="head">
      <div class="ttl">
        <h1>库存实物</h1>
        <p class="sum" data-tour="gal-counts">
          <button class="big red" @click="flt = flt === 'red' ? 'all' : 'red'"><b>{{ cnt.red }}</b> 件要处理</button>
          <button class="big amb" @click="flt = flt === 'amb' ? 'all' : 'amb'"><b>{{ cnt.amb }}</b> 件注意</button>
          <button class="big grn" @click="flt = flt === 'grn' ? 'all' : 'grn'"><b>{{ cnt.grn }}</b> 件正常</button>
          <span class="muted">共 {{ skus.length }} 件单件实物（WMS 唯一库存真源）</span><Q k="g-counts" />
        </p>
      </div>
      <div class="tools">
        <label class="search"><Icon name="search" /><input v-model="q" placeholder="搜型号、货号、SN、库位、附件袋" /></label>
        <button class="btn" @click="go('aux')">附属与原盒台账 ›</button>
        <button class="btn" @click="openHelp('gallery')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <div class="clean-notice">
      <div>
        <b>✨ 历史存量库存阻塞当日清零 Gallery（对齐销售工作台待洗 Gallery）</b>
        <span style="margin-left:8px">把「缺全量验货、缺完整通电视频、缺本机实拍图、缺 SPU/子母码」致客服卖不了的商品集中列出，当场逐关补齐转绿。</span>
      </div>
      <button class="btn sm pri" @click="go('legacy-wash')">进入历史库存阻塞清洗 Gallery →</button>
    </div>

    <div class="bar2">
      <div class="seg" data-tour="gal-seg" role="tablist" aria-label="动作紧急度">
        <button :class="{ on: flt === 'all' }" @click="flt = 'all'">全部</button>
        <button :class="{ on: flt === 'red' }" @click="flt = 'red'"><i class="dot red"></i>要处理</button>
        <button :class="{ on: flt === 'amb' }" @click="flt = 'amb'"><i class="dot amb"></i>注意</button>
        <button :class="{ on: flt === 'grn' }" @click="flt = 'grn'"><i class="dot grn"></i>正常</button>
      </div><Q k="g-filter" />
      <div class="seg" role="tablist" aria-label="分组维度">
        <span class="muted" style="padding:0 6px;font-size:12.5px">按</span>
        <button v-for="b in BY" :key="b.k" :class="{ on: by === b.k }" @click="by = b.k">{{ b.t }}</button>
        <span class="muted" style="padding:0 6px;font-size:12.5px">看</span>
      </div><Q k="g-group" />
    </div>

    <section v-for="g in groups" :key="g.key" class="grp">
      <h2>
        <span v-if="g.dot" class="dot" :class="g.dot"></span>
        {{ g.title }}<em>{{ g.items.length }}</em>
      </h2>
      <div class="grid">
        <article
          v-for="it in g.items"
          :key="it.code"
          class="gc"
          :class="it.lvl"
          tabindex="0"
          @click="openItemDetail(it.code)"
          @keydown.enter="openItemDetail(it.code)"
        >
          <div class="img">
            <img v-if="it.realImgCount > 0 && it.realThumb" :src="it.realThumb" :alt="it.model" />
            <div v-else class="noimg">
              <b>待补实拍图</b>
              <span>没有这件货的验货实拍图，绝不拿同款商品图或库位图冒充</span>
            </div>
            <span class="badge" :class="it.lvl">{{ LV[it.lvl].icon }} {{ LV[it.lvl].text }}</span>
            <span class="kind">{{ it.zone }}</span>
            <span class="srcb" :class="{ miss: it.realImgCount === 0 }">
              {{ it.realImgCount > 0 ? `本件实拍 ×${it.realImgCount}` : '待补图' }}
            </span>
          </div>

          <div class="body">
            <h3>{{ it.brand }} {{ it.model }}</h3>
            <p class="sub">货号 <code>{{ it.code }}</code> · 库位 <b>{{ it.location }}</b></p>
            <p class="imgline">
              <span :class="{ bad: it.realImgCount === 0 }">实拍图 {{ it.realImgCount }}</span>
              <span :class="{ warn: it.locImgCount === 0 }">库位图 {{ it.locImgCount }}</span>
              <span>瑕疵图 {{ it.defectImgCount }}</span>
            </p>
            <div class="m">
              <span>进价 ¥{{ it.cost }}</span>
              <span class="b" :class="it.age.lvl">{{ it.age.short }}</span>
            </div>
            <div class="chips">
              <span class="tag">袋 {{ it.bagCode || '无' }}</span>
              <span class="tag">{{ it.boxCode ? '有原盒' : '无原盒' }}</span>
            </div>
            <div class="why" :class="it.lvl">
              <span>
                {{ it.issues[0]?.text || '图、库位、附件袋、库龄均正常，不用管' }}
                <b v-if="it.issues.length > 1"> +{{ it.issues.length - 1 }}</b>
              </span>
            </div>
          </div>
        </article>
      </div>
    </section>

    <div v-if="!enrichedShown.length" class="card" style="text-align:center;padding:56px 20px;margin-top:20px">
      <b style="font-size:18px;display:block;margin-bottom:6px">{{ q ? `没有找到「${q}」` : '这一类现在没有商品' }}</b>
      <p class="muted">{{ q ? '换个货号、SN 或库位关键词试试。' : '好事：没有这一类要处理的库存问题。' }}</p>
      <button v-if="q || flt !== 'all'" class="btn" style="margin-top:12px" @click="q = ''; flt = 'all'">清空筛选</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import { store, LV, ageOf, skuIssues, skuLevel, openItemDetail, openHelp, go } from '../store/warehouseStore.js'

const KIND_NAME = { monitor: '显示器', phone: '手机', audio: '音响', camera: '微单相机', dryer: '个护电器', mac: '电脑主机' }
const BY = [
  { k: 'status', t: '状态' },
  { k: 'zone', t: '分位库区' },
  { k: 'cat', t: '品类' },
  { k: 'age', t: '库龄周期' }
]

const q = computed({ get: () => store.galleryFilter.q, set: v => { store.galleryFilter.q = v } })
const flt = computed({ get: () => store.galleryFilter.flt, set: v => { store.galleryFilter.flt = v } })
const by = computed({ get: () => store.galleryFilter.by, set: v => { store.galleryFilter.by = v } })

const skus = computed(() =>
  store.data.skus.map(s => {
    const issues = skuIssues(s)
    const lvl = skuLevel(s)
    const age = ageOf(s.ageDays)
    return { ...s, issues, lvl, age }
  })
)

const cnt = computed(() => ({
  red: skus.value.filter(s => s.lvl === 'red').length,
  amb: skus.value.filter(s => s.lvl === 'amb').length,
  grn: skus.value.filter(s => s.lvl === 'grn').length
}))

const enrichedShown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return skus.value.filter(s => {
    if (flt.value !== 'all' && s.lvl !== flt.value) return false
    if (!kw) return true
    return `${s.code} ${s.sn} ${s.brand} ${s.model} ${s.location} ${s.bagCode} ${s.zone}`.toLowerCase().includes(kw)
  })
})

const groups = computed(() => {
  const list = enrichedShown.value
  if (by.value === 'status') {
    return ['red', 'amb', 'grn'].map(l => ({
      key: l,
      dot: l,
      title: { red: '要处理，先做这些', amb: '注意，有空看看', grn: '正常，不用管' }[l],
      items: list.filter(i => i.lvl === l)
    })).filter(g => g.items.length)
  }
  const pick = {
    zone: i => i.zone,
    cat: i => KIND_NAME[i.kind] || '其它实物',
    age: i => i.age.long.split('（')[0]
  }[by.value]
  const map = new Map()
  for (const it of list) {
    const k = pick(it)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(it)
  }
  return [...map].map(([k, items]) => ({ key: k, title: k, items }))
})
</script>
