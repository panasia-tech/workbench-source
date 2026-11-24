<template>
  <div class="wg-page">
    <header class="wg-head">
      <div>
        <h1>全量历史库存清洗 Gallery</h1>
        <p class="wg-sub">在库 {{ counts.all }} 件商品（{{ counts.spu_total || spuGroups.length }} 个 SPU），点选商品步入洗价与三栏选图直发。</p>
      </div>
      <div class="wg-tools">
        <button class="btn" @click="showPipe = !showPipe">📖 {{ showPipe ? '收起流程说明' : '两步流程说明 ▾' }}</button>
        <label class="wg-search">
          <Icon name="search" />
          <input v-model="q" placeholder="搜品牌、型号、SPU码、货号…" @input="page = 1" />
        </label>
        <button class="btn" :disabled="loading" @click="load">
          <Icon name="refresh" />{{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 流程总览（默认折叠，点上方按钮展开） -->
    <section v-if="showPipe" class="wg-pipeline">
      <div class="wp-node on">
        <i>☷</i>
        <div>
          <b>全量库存 Gallery（{{ counts.all }} 件 / {{ counts.spu_total || spuGroups.length }} SPU）</b>
          <small>含满 28 天历史老库存 {{ counts.aged_28d || 0 }} 件 · 好图池 {{ counts.good_lane || 0 }} / 坏图池 {{ counts.bad_lane || 0 }}</small>
        </div>
      </div>
      <span class="wp-arrow">→</span>
      <div class="wp-node">
        <i>1</i>
        <div>
          <b>第 1 步大页：闲鱼多词快照洗价格</b>
          <small>同 SPU 最多 12 搜索词抓取闲鱼原版网页快照 · 四事实核价确认</small>
        </div>
      </div>
      <span class="wp-arrow">→</span>
      <div class="wp-node">
        <i>2</i>
        <div>
          <b>第 2 步大页：三栏精修图池选图直发</b>
          <small>好图/坏图分流 · 多店互不重图 · 一键排入 AdsPower 群控</small>
        </div>
      </div>
    </section>

    <!-- 多维筛选栏：视图模式 + 阶段 + 历史28天 + 图池好坏分流 + 品类 -->
    <div class="wg-filter-deck card">
      <div class="wfd-row">
        <div class="mode-seg">
          <button :class="{ on: viewMode === 'sku' }" @click="viewMode = 'sku'; page = 1">
            📦 单件 SKU 逐件模式（{{ counts.all }}）
          </button>
          <button :class="{ on: viewMode === 'spu' }" @click="viewMode = 'spu'; page = 1">
            🗂 按 SPU 型号归并模式（{{ counts.spu_total || spuGroups.length }}）
          </button>
        </div>

        <div class="wg-tabs">
          <button :class="{ on: tab === 'all' }" @click="tab = 'all'; page = 1">
            全部 <b>{{ counts.all }}</b>
          </button>
          <button :class="{ on: tab === 'step1_price' }" @click="tab = 'step1_price'; page = 1">
            <span class="sdot amb"></span>① 待洗价格 <b>{{ counts.step1_price }}</b>
          </button>
          <button :class="{ on: tab === 'step2_image' }" @click="tab = 'step2_image'; page = 1">
            <span class="sdot acc"></span>② 待洗图片 <b>{{ counts.step2_image }}</b>
          </button>
          <button :class="{ on: tab === 'published' }" @click="tab = 'published'; page = 1">
            <span class="sdot grn"></span>✓ 已洗净在架 <b>{{ counts.published }}</b>
          </button>
        </div>
      </div>

      <div class="wfd-row sub-filters">
        <div class="chip-group">
          <span class="cg-lbl">库龄筛选：</span>
          <button class="fchip" :class="{ on: !onlyAged28 }" @click="onlyAged28 = false; page = 1">全部库龄</button>
          <button class="fchip red-chip" :class="{ on: onlyAged28 }" @click="onlyAged28 = !onlyAged28; page = 1">
            🔥 满 28 天历史老库存（{{ counts.aged_28d || 0 }}）
          </button>
        </div>

        <div class="chip-group">
          <span class="cg-lbl">图池分流 (product-image-service)：</span>
          <button class="fchip" :class="{ on: laneFilter === 'all' }" @click="laneFilter = 'all'; page = 1">全部</button>
          <button class="fchip grn-chip" :class="{ on: laneFilter === 'good' }" @click="laneFilter = 'good'; page = 1">
            ✓ 好图列表 &gt;30张（{{ counts.good_lane || 0 }}）
          </button>
          <button class="fchip amb-chip" :class="{ on: laneFilter === 'bad' }" @click="laneFilter = 'bad'; page = 1">
            ⚠ 坏图列表 ≤30张待重搜（{{ counts.bad_lane || 0 }}）
          </button>
        </div>

        <div class="chip-group">
          <span class="cg-lbl">品类：</span>
          <select v-model="catFilter" class="cat-sel" @change="page = 1">
            <option value="all">全部 6 大品类</option>
            <option value="显示器">显示器</option>
            <option value="空气净化器">空气净化器</option>
            <option value="音响">音响</option>
            <option value="脱毛仪">脱毛仪</option>
            <option value="Apple产品">Apple产品</option>
            <option value="默认/其它">默认/其它</option>
          </select>
        </div>
      </div>
    </div>

    <div v-if="loading && !items.length" class="wg-empty">正在读取全量历史库存清洗画廊…</div>

    <!-- ==================== 模式 A：按 SPU 型号归并视图（165 个 SPU） ==================== -->
    <template v-else-if="viewMode === 'spu'">
      <div v-if="pagedSpus.length" class="wg-grid">
        <article
          v-for="g in pagedSpus"
          :key="g.spuCode"
          class="wg-card"
          :class="g.overallStage"
          @click="goPrice(g.leadSkuCode)"
        >
          <div class="wg-img">
            <img v-if="g.coverUrl" :src="g.coverUrl" :alt="g.name" loading="lazy" />
            <div v-else class="wg-noimg">待配图</div>
            <button class="zoom-btn" title="放大预览商品图" @click.stop="zoomImg = { url: g.coverUrl, title: `${g.brand} ${g.model} (SPU ${g.spuCode})` }">🔍</button>
            <span class="stage-pill" :class="g.overallStage">SPU 共 {{ g.skuCount }} 件 · {{ stageText(g) }}</span>
            <span class="cover-pill" :class="{ bad: g.imageLane === 'bad' }">
              {{ g.imageLane === 'bad' ? `⚠ 坏图池(${g.formalPoolCount}张)` : `✓ 好图池(${g.formalPoolCount}张)` }}
            </span>
            <span v-if="g.maxAgeDays >= 15" class="age-pill" :class="{ red: g.maxAgeDays >= 28 }">
              最高在库 {{ g.maxAgeDays }} 天
            </span>
          </div>

          <div class="wg-body">
            <div class="wg-title-row">
              <h3>{{ g.brand ? g.brand + ' ' : '' }}{{ g.model }}</h3>
              <span class="cost-tag">最低成本 ¥{{ money(g.minCost) }}</span>
            </div>
            <p class="wg-meta">
              SPU <code>{{ g.spuCode }}</code> · {{ g.category }} · 含货号 {{ g.skuCodes.slice(0, 3).join('、') }}{{ g.skuCodes.length > 3 ? ` 等${g.skuCodes.length}件` : '' }}
            </p>
            <div class="step-rows">
              <div class="srow-item" :class="{ done: !!g.confirmedPrice }">
                <span class="sn">{{ g.confirmedPrice ? '✓' : '1' }}</span>
                <div class="stxt">
                  <b>SPU 共享闲鱼多词快照策略</b>
                  <span v-if="g.confirmedPrice" class="ok-txt">已确认基准价 ¥{{ g.confirmedPrice }}（同 SPU 兄弟件自动共享）</span>
                  <span v-else>预估清洗均价 <em>¥{{ g.recommendedPrice || '待采集' }}</em> · 一次配词覆盖 {{ g.skuCount }} 件</span>
                </div>
              </div>
              <div class="srow-item" :class="{ done: g.imageLane === 'good' && g.publishedSkuCount === g.skuCount }">
                <span class="sn">2</span>
                <div class="stxt">
                  <b>SPU 精修图池与在架进度</b>
                  <span>已在架 {{ g.publishedSkuCount }} / {{ g.skuCount }} 件 · {{ g.imageLane === 'bad' ? '图池不足30张建议扩搜' : '正式图池充裕可不重样分图' }}</span>
                </div>
              </div>
            </div>
            <div class="wg-actions" @click.stop>
              <button class="btn pri main-cta" @click="goPrice(g.leadSkuCode)">
                进入 SPU 多词洗价与快照页（代表件 {{ g.leadSkuCode }}）→
              </button>
              <div class="sub-ctas">
                <button class="btn sm" @click="goPrice(g.leadSkuCode)">① SPU 洗价格</button>
                <button class="btn sm" @click="goImage(g.leadSkuCode)">② SPU 三栏图池</button>
                <button class="btn sm ghost" @click="q = g.model; viewMode = 'sku'; page = 1">展开 {{ g.skuCount }} 件</button>
              </div>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="wg-empty"><b>没有匹配的 SPU</b></div>
    </template>

    <!-- ==================== 模式 B：单件 SKU 逐件视图（259+ 件） ==================== -->
    <template v-else>
      <div v-if="pagedSkus.length" class="wg-grid">
        <article
          v-for="it in pagedSkus"
          :key="it.code"
          class="wg-card"
          :class="it.overallStage"
          @click="enterMainFlow(it)"
        >
          <div class="wg-img">
            <img v-if="it.coverUrl" :src="it.coverUrl" :alt="it.name" loading="lazy" />
            <div v-else class="wg-noimg">待配图</div>
            <button v-if="it.coverUrl" class="zoom-btn" title="点击放大查看高清图" @click.stop="zoomImg = { url: it.coverUrl, title: `${it.brand} ${it.model} · ${it.code}` }">🔍</button>

            <span class="stage-pill" :class="it.overallStage">{{ stageText(it) }}</span>
            <span class="cover-pill" :class="{ bad: it.imageLane === 'bad' }">
              {{ it.coverKind }} · {{ it.imageLane === 'bad' ? '坏图池' : '好图池' }}
            </span>
            <span v-if="it.stockAgeDays >= 15" class="age-pill" :class="{ red: it.stockAgeDays >= 28 }">
              在库 {{ it.stockAgeDays }} 天{{ it.stockAgeDays >= 28 ? '·历史老货' : '' }}
            </span>
          </div>

          <div class="wg-body">
            <div class="wg-title-row">
              <h3>{{ it.brand ? it.brand + ' ' : '' }}{{ it.model }}</h3>
              <span class="cost-tag">成本 ¥{{ money(it.cost) }}</span>
            </div>
            <p class="wg-meta">货号 <code>{{ it.code }}</code> · SPU <code>{{ it.spuCode }}</code> · 库位 {{ it.locationCode }}</p>

            <div class="step-rows">
              <div class="srow-item" :class="{ done: it.priceDone }">
                <span class="sn">{{ it.priceDone ? '✓' : '1' }}</span>
                <div class="stxt">
                  <b>第 1 步 · 洗价格</b>
                  <span v-if="it.priceDone" class="ok-txt">已确认统一售价 ¥{{ it.confirmedPrice }}</span>
                  <span v-else-if="it.priceStep === 'waiting_crawl'" class="warn-txt">无在售样本 · 点入用 AI 纠改型号重爬</span>
                  <span v-else>闲鱼 {{ it.totalCards }} 条已初筛 · 预估均价 <em>¥{{ it.recommendedPrice || '—' }}</em>（留 {{ it.validCount }} 去 {{ it.rejectedCount }}）</span>
                </div>
              </div>

              <div class="srow-item" :class="{ done: it.imageDone }">
                <span class="sn">{{ it.imageDone ? '✓' : '2' }}</span>
                <div class="stxt">
                  <b>第 2 步 · 洗图片</b>
                  <span v-if="it.imageDone" class="ok-txt">全部 {{ it.totalShopCount }} 个闲鱼号已选净图在架</span>
                  <span v-else>推荐 {{ it.recommendedImgCount }} 张 / 拦截 {{ it.notRecommendedImgCount }} 张 · 正式池 {{ it.formalPoolCount }} 张</span>
                </div>
              </div>
            </div>

            <div class="wg-actions" @click.stop>
              <button class="btn pri main-cta" @click="enterMainFlow(it)">
                {{ primaryCtaText(it) }}
              </button>
              <div class="sub-ctas">
                <button class="btn sm" @click="goPrice(it.code)">① 洗价格页</button>
                <button class="btn sm" @click="goImage(it.code)">② 洗图片页</button>
                <button class="btn sm ghost" title="查看库龄与单品台账" @click="goDetail(it.code)">详情</button>
              </div>
            </div>
          </div>
        </article>
      </div>

      <div v-else class="wg-empty">
        <b>当前筛选下没有商品</b>
        <p>可重置筛选条件查看全部 {{ counts.all }} 件真实在库商品。</p>
        <button class="btn" @click="resetFilters">重置全部筛选</button>
      </div>
    </template>

    <!-- 分页导航 -->
    <div v-if="totalPages > 1" class="wg-pager">
      <button class="btn sm" :disabled="page <= 1" @click="page--">← 上一页</button>
      <span>第 <b>{{ page }}</b> / {{ totalPages }} 页（当前匹配 {{ activeTotal }} 项）</span>
      <button class="btn sm" :disabled="page >= totalPages" @click="page++">下一页 →</button>
    </div>

    <!-- 封面图高清放大预览弹窗 -->
    <div v-if="zoomImg" class="wg-zoom-mask" @click="zoomImg = null">
      <div class="wg-zoom-box" @click.stop>
        <img :src="zoomImg.url" alt="" />
        <div class="wg-zoom-bar">
          <b>{{ zoomImg.title }}</b>
          <button class="btn sm pri" @click="zoomImg = null">关闭预览</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { api } from './api.js'
import { money } from './store.js'

const PAGE_SIZE = 36
const items = ref([])
const spuGroups = ref([])
const counts = ref({ all: 0, spu_total: 0, aged_28d: 0, good_lane: 0, bad_lane: 0, step1_price: 0, step2_image: 0, published: 0 })
const viewMode = ref('sku')
const tab = ref('all')
const onlyAged28 = ref(false)
const laneFilter = ref('all')
const catFilter = ref('all')
const q = ref('')
const page = ref(1)
const loading = ref(false)
const zoomImg = ref(null)
const showPipe = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await api('/wash-workflow/skus')
    items.value = res.items || []
    spuGroups.value = res.spuGroups || []
    counts.value = res.counts || { all: items.value.length, step1_price: 0, step2_image: 0, published: 0 }
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  q.value = ''
  tab.value = 'all'
  onlyAged28.value = false
  laneFilter.value = 'all'
  catFilter.value = 'all'
  page.value = 1
}

const filteredSkus = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return items.value.filter((it) => {
    if (tab.value !== 'all' && it.overallStage !== tab.value) return false
    if (onlyAged28.value && !it.aged28d) return false
    if (laneFilter.value !== 'all' && it.imageLane !== laneFilter.value) return false
    if (catFilter.value !== 'all' && it.category !== catFilter.value) return false
    if (!kw) return true
    return `${it.brand} ${it.model} ${it.name} ${it.code} ${it.spuCode}`.toLowerCase().includes(kw)
  })
})

const filteredSpus = computed(() => {
  const kw = q.value.trim().toLowerCase()
  return spuGroups.value.filter((g) => {
    if (tab.value !== 'all' && g.overallStage !== tab.value) return false
    if (onlyAged28.value && !g.aged28d) return false
    if (laneFilter.value !== 'all' && g.imageLane !== laneFilter.value) return false
    if (catFilter.value !== 'all' && g.category !== catFilter.value) return false
    if (!kw) return true
    return `${g.brand} ${g.model} ${g.name} ${g.spuCode} ${g.skuCodes.join(' ')}`.toLowerCase().includes(kw)
  })
})

const activeTotal = computed(() => (viewMode.value === 'spu' ? filteredSpus.value.length : filteredSkus.value.length))
const totalPages = computed(() => Math.max(1, Math.ceil(activeTotal.value / PAGE_SIZE)))
const pagedSkus = computed(() => filteredSkus.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
const pagedSpus = computed(() => filteredSpus.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

function stageText(it) {
  if (it.overallStage === 'published') return '✓ 已洗净在架'
  if (it.overallStage === 'step2_image') return '② 待洗图片上架'
  if (it.priceStep === 'waiting_crawl') return '① 待抓闲鱼快照'
  return '① 待洗价格'
}

function primaryCtaText(it) {
  if (it.overallStage === 'step1_price') return '开始第 1 步：洗价格 →'
  if (it.overallStage === 'step2_image') return '进入第 2 步：洗图片并上架 →'
  return '已上架 · 重新核对价格/图片 →'
}

function goPrice(code) {
  location.hash = '#/price-cleaning/' + encodeURIComponent(code)
}

function goImage(code) {
  location.hash = '#/image-cleaning/' + encodeURIComponent(code)
}

function goDetail(code) {
  location.hash = '#/phys/' + encodeURIComponent(code)
}

function enterMainFlow(it) {
  if (it.overallStage === 'step2_image') return goImage(it.code)
  return goPrice(it.code)
}

onMounted(load)
</script>

<style scoped>
.wg-page { padding: 12px 28px 56px; max-width: 1680px; margin: 0 auto; }
.wg-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.wg-eyebrow { font-size: 13px; font-weight: 800; color: var(--acc); letter-spacing: .02em; }
.wg-head h1 { font-size: 25px; font-weight: 900; letter-spacing: -.02em; margin: 0 0 2px; }
.wg-sub { color: var(--mute); font-size: 13px; margin: 0; }
.wg-tools { display: flex; gap: 8px; align-items: center; }
.wg-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 10px; background: var(--panel); border: 1px solid var(--line); }
.wg-search svg { width: 16px; height: 16px; color: var(--mute); }
.wg-search input { border: 0; background: none; outline: none; width: 210px; font-size: 13.5px; color: var(--ink); }

.wg-pipeline { margin-top: 12px; padding: 12px 16px; border-radius: 16px; background: var(--panel); border: 1px solid var(--line); display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.wp-node { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 220px; }
.wp-node i { width: 32px; height: 32px; border-radius: 10px; background: var(--soft); color: var(--ink); font-style: normal; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.wp-node.on i { background: var(--acc); color: #fff; }
.wp-node div { display: grid; gap: 2px; }
.wp-node b { font-size: 14px; }
.wp-node small { font-size: 12px; color: var(--mute); }
.wp-arrow { color: var(--mute); font-weight: 800; font-size: 18px; }

.wg-filter-deck { margin-top: 8px; padding: 8px 14px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); display: grid; gap: 6px; }
.wfd-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mode-seg { display: inline-flex; background: var(--soft); padding: 3px; border-radius: 10px; gap: 4px; }
.mode-seg button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 800; color: var(--mute); cursor: pointer; }
.mode-seg button.on { background: var(--panel); color: var(--acc); box-shadow: 0 2px 6px rgba(15,23,42,.08); }

.wg-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.wg-tabs button { height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); font-weight: 700; font-size: 12.5px; color: var(--ink); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.wg-tabs button.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.wg-tabs button b { font-size: 12px; opacity: .86; }
.sdot { width: 8px; height: 8px; border-radius: 99px; }
.sdot.amb { background: var(--amb); }
.sdot.acc { background: var(--acc); }
.sdot.grn { background: var(--grn); }

.sub-filters { padding-top: 6px; border-top: 1px dashed var(--line); justify-content: flex-start; gap: 14px; }
.chip-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cg-lbl { font-size: 12.5px; font-weight: 700; color: var(--mute); }
.fchip { height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--soft); font-size: 12px; font-weight: 700; color: var(--ink); cursor: pointer; }
.fchip.on { background: var(--acc-soft); border-color: var(--acc); color: var(--acc); }
.fchip.red-chip.on { background: #fee2e2; border-color: #ef4444; color: #b91c1c; }
.fchip.grn-chip.on { background: #dcfce7; border-color: #22c55e; color: #15803d; }
.fchip.amb-chip.on { background: #fef3c7; border-color: #f59e0b; color: #b45309; }
.cat-sel { height: 28px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); padding: 0 10px; font-size: 12px; font-weight: 700; color: var(--ink); }

.wg-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fill, minmax(335px, 1fr)); gap: 16px; }
.wg-card { background: var(--panel); border-radius: 20px; border: 1.5px solid var(--line); overflow: hidden; display: flex; flex-direction: column; cursor: pointer; transition: transform .15s, box-shadow .15s, border-color .15s; }
.wg-card:hover { transform: translateY(-3px); box-shadow: var(--sh-up); border-color: var(--acc); }
.wg-card.step2_image { border-color: rgba(37, 99, 235, .42); }
.wg-card.published { border-color: rgba(22, 163, 74, .42); }

.wg-img { position: relative; aspect-ratio: 16 / 10; background: #eef2f6; overflow: hidden; }
.wg-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wg-noimg { height: 100%; display: grid; place-items: center; color: var(--mute); font-weight: 700; }
.zoom-btn { position: absolute; right: 10px; bottom: 10px; z-index: 3; width: 32px; height: 32px; border-radius: 9px; border: 0; background: rgba(15,23,42,.72); color: #fff; cursor: zoom-in; font-size: 14px; }
.stage-pill { position: absolute; left: 10px; top: 10px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 800; background: #fef3c7; color: #92400e; }
.stage-pill.step2_image { background: #dbeafe; color: #1d4ed8; }
.stage-pill.published { background: #dcfce7; color: #15803d; }
.cover-pill { position: absolute; right: 10px; top: 10px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; background: rgba(15,23,42,.72); color: #fff; }
.cover-pill.bad { background: rgba(217, 119, 6, .92); color: #fff; }
.age-pill { position: absolute; left: 10px; bottom: 10px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 800; background: #fef3c7; color: #92400e; }
.age-pill.red { background: #fee2e2; color: #b91c1c; }

.wg-body { padding: 15px 17px 17px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
.wg-title-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.wg-title-row h3 { margin: 0; font-size: 17.5px; font-weight: 800; line-height: 1.25; }
.cost-tag { font-size: 12px; font-weight: 800; color: var(--mute); background: var(--soft); padding: 2px 8px; border-radius: 8px; white-space: nowrap; }
.wg-meta { margin: 0; font-size: 12.5px; color: var(--mute); }
.wg-meta code { font-family: ui-monospace, SFMono-Regular, monospace; background: var(--soft); padding: 1px 5px; border-radius: 5px; color: var(--ink); }

.step-rows { display: grid; gap: 7px; padding: 10px 12px; border-radius: 13px; background: var(--soft); }
.srow-item { display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; }
.srow-item .sn { width: 20px; height: 20px; border-radius: 99px; background: #cbd5e1; color: #1e293b; font-weight: 800; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
.srow-item.done .sn { background: var(--grn); color: #fff; }
.stxt { display: grid; gap: 2px; line-height: 1.35; }
.stxt b { font-size: 12.5px; }
.stxt span { color: var(--mute); }
.stxt em { font-style: normal; font-weight: 800; color: var(--acc); }
.ok-txt { color: var(--grn-ink) !important; font-weight: 700; }
.warn-txt { color: #b91c1c !important; font-weight: 700; }

.wg-actions { margin-top: auto; display: grid; gap: 8px; pt: 4px; }
.main-cta { width: 100%; justify-content: center; height: 38px; font-weight: 800; }
.sub-ctas { display: flex; gap: 6px; }
.sub-ctas .btn { flex: 1; justify-content: center; white-space: nowrap; font-size: 12px; padding: 0 8px; }

.wg-pager { margin-top: 24px; display: flex; align-items: center; justify-content: center; gap: 16px; font-size: 14px; }
.wg-empty { margin-top: 32px; padding: 56px 24px; text-align: center; background: var(--panel); border-radius: 20px; border: 1px dashed var(--line); color: var(--mute); display: grid; gap: 8px; justify-items: center; }

.wg-zoom-mask { position: fixed; inset: 0; z-index: 95; background: rgba(10, 15, 28, .85); display: grid; place-items: center; padding: 24px; }
.wg-zoom-box { background: #fff; border-radius: 20px; padding: 16px; max-width: min(880px, 94vw); max-height: 90vh; display: grid; gap: 12px; }
.wg-zoom-box img { max-height: 75vh; max-width: 88vw; object-fit: contain; border-radius: 12px; background: #f8fafc; }
.wg-zoom-bar { display: flex; justify-content: space-between; align-items: center; gap: 14px; }
</style>
