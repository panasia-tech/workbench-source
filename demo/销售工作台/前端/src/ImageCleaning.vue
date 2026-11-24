<template>
  <div class="ic-page">
    <!-- 顶部全流程向导导航条（一步一个独立大页面） -->
    <nav class="wizard-bar card">
      <button class="btn sm" @click="goGallery">← 返回 Gallery</button>

      <div class="wiz-steps">
        <button class="wstep done" @click="goGallery">
          <i>☷</i><span>Gallery 选品</span>
        </button>
        <span class="wsep">→</span>
        <button class="wstep" :class="{ done: priceConfirmed }" @click="goPriceStep">
          <i>{{ priceConfirmed ? '✓' : '1' }}</i>
          <span>① 洗价格{{ unifiedPrice ? `（¥${unifiedPrice}）` : '' }}</span>
        </button>
        <span class="wsep">→</span>
        <button class="wstep cur">
          <i>2</i><span>② 洗图片（三栏选图）并直接上架</span>
        </button>
      </div>

      <div class="wiz-switch" v-if="skuQueue.length">
        <select class="sku-sel" :value="currentCode" @change="pickCode($event.target.value)" aria-label="切换待洗商品">
          <option v-for="it in skuQueue" :key="it.code" :value="it.code">
            {{ it.imageDone ? '✓ ' : it.priceDone ? '② ' : '① ' }}{{ it.brand ? it.brand + ' ' : '' }}{{ it.model }} ({{ it.code }})
          </option>
        </select>
      </div>
    </nav>

    <div v-if="loading && !lib" class="card ic-loading">正在从大库图库拉取机器首轮筛图结果…</div>

    <template v-else-if="lib">
      <!-- 发布成功横幅（支持 60 秒撤回 + 查看 AdsPower 错峰队列 + 一键处理下一件） -->
      <section v-if="justPublished || undoLeft > 0" class="card pub-done-banner">
        <div class="pdb-left">
          <span class="done-badge">✓ 已排入 AdsPower 群控</span>
          <div>
            <b>{{ lib.brand ? lib.brand + ' ' : '' }}{{ lib.model }} 已按统一售价 ¥{{ lastPublishedPrice || unifiedPrice }} 下发 AdsPower 群控上架！</b>
            <p class="muted">
              机器初审 + 人工二次确认已完成闭环（零主管审批）。
              <template v-if="lastGcJobs.length">
                共生成 {{ lastGcJobs.length }} 条群控作业（第 1 票立即走 CDP 上传，同号后续票按 25 分钟防限流错峰排期）。
              </template>
              <template v-if="undoLeft > 0">（{{ undoLeft }} 秒内可一键撤回）</template>
            </p>
          </div>
        </div>
        <div class="pdb-acts">
          <button v-if="undoLeft > 0" class="btn sm" @click="undoPublish">撤回本次发布 ({{ undoLeft }}s)</button>
          <button class="btn sm" @click="goGcQueue">🚀 去 AdsPower 队列看回读 ›</button>
          <button v-if="nextPendingSku" class="btn pri" @click="goNextPending">
            处理下一件待洗商品：{{ nextPendingSku.brand }} {{ nextPendingSku.model }} →
          </button>
          <button class="btn" @click="goGallery">返回待洗 Gallery</button>
        </div>
      </section>

      <!-- 若第 1 步尚未人工确认价格，给出清晰紧凑引导条 -->
      <section v-if="!priceConfirmed" class="card step1-remind">
        <div class="sr-left">
          <span class="tag amb">第 1 步待确认</span>
          <span v-if="ps.recommendedPrice">
            暂显初筛均价 <b>¥{{ ps.recommendedPrice }}</b>（{{ ps.validCount }} 条有效挂牌）
          </span>
          <span v-else>尚未抓取闲鱼快照，请先去第 1 步确认统一售价。</span>
        </div>
        <button class="btn pri sm" @click="goPriceStep">← 去第 1 步：洗价格</button>
      </section>

      <!-- 顶部商品摘要 + 大库搜索与档位控制条（只读展示第1步确认好的统一售价，绝无逐店填价框） -->
      <section class="card top-summary-card">
        <div class="tsc-main">
          <div class="tsc-info">
            <div class="tsc-badges">
              <span class="tag acc">货号 {{ lib.code }}</span>
              <span v-if="lib.spuCode" class="tag">SPU {{ lib.spuCode }}</span>
              <span class="tag">大库共抓 {{ lib.totalCrawled }} 张</span>
              <span class="tag" :class="lib.imageLane === 'bad' ? 'amb' : 'grn'">
                {{ lib.imageLane === 'bad' ? `⚠ 坏图列表（正式池仅 ${lib.formalPoolCount || 18} 张 ≤30）` : `✓ 好图列表（正式池 ${lib.formalPoolCount || 36} 张达标）` }}
              </span>
              <button v-if="lib.imageLane === 'bad'" class="btn sm pri" :disabled="busy" @click="refillImageLane">
                🔄 一键扩搜补满36张转好图列表
              </button>
              <span class="tag" :class="lib.collisionCheck?.ok ? 'grn' : 'red'">
                {{ lib.collisionCheck?.ok ? `✓ 各号共选 ${lib.collisionCheck.totalSelected} 张 · 互不重图` : lib.collisionCheck?.warnings?.[0] }}
              </span>
            </div>
            <h1>{{ lib.brand ? lib.brand + ' ' : '' }}{{ lib.model }} <small>{{ lib.name }}</small></h1>
          </div>

          <!-- 右侧：第 1 步已锁定的统一售价徽章 + 快捷操作（检索/档位面板默认折叠，三栏照片区上移首屏） -->
          <div class="unified-price-box">
            <div class="up-item">
              <span>采购成本</span>
              <b>¥{{ money(ps.cost) }}</b>
            </div>
            <div class="up-sep"></div>
            <div class="up-item main">
              <span>{{ priceConfirmed ? '已确认统一售价' : '初筛推荐售价' }}</span>
              <b>{{ unifiedPrice ? `¥${unifiedPrice}` : '待定' }}</b>
            </div>
            <button class="btn sm" @click="goPriceStep">改价</button>
            <button class="btn sm" :class="{ pri: libToolsOpen }" @click="libToolsOpen = !libToolsOpen">
              ⚙ 重搜/档位 {{ libToolsOpen ? '▴' : '▾' }}
            </button>
            <button class="btn sm pri" :disabled="busy" @click="autoAssignImages">
              ⚡ 自动配图
            </button>
          </div>
        </div>

        <!-- 大库图库检索词与过滤档位工具条（默认折叠，点右侧按钮展开） -->
        <div v-if="libToolsOpen" class="lib-toolbar">
          <div class="lt-left">
            <span class="lt-label">大库检索型号：<b>{{ lib.query }}</b></span>
            <div class="search-box">
              <input v-model="customQuery" placeholder="改型号词重新抓大库图…" @keyup.enter="reSearchLib" />
              <button class="btn sm" :disabled="busy" @click="reSearchLib">重搜大库</button>
            </div>
          </div>

          <div class="lt-right">
            <span class="lt-label">电脑初筛档位：</span>
            <div class="tier-seg">
              <button
                v-for="t in TIER_OPTIONS"
                :key="t.key"
                :class="{ on: lib.searchTier === t.key }"
                :disabled="busy"
                :title="t.desc"
                @click="changeTier(t.key)"
              >{{ t.label }}</button>
            </div>
          </div>
        </div>
      </section>

      <!-- 整屏核心区：大库图库三栏制（1. 推荐可使用  2. 不推荐使用  3. 已经被选定的图片） -->
      <section class="three-cols-board">
        <!-- ==================== 第 1 栏：推荐可使用 ==================== -->
        <div class="lib-col col-rec">
          <header class="col-head">
            <div>
              <div class="col-title">
                <span class="wdot grn"></span>
                <h2>1. 推荐可使用</h2>
                <span class="cnt-pill grn">{{ lib.recommended.length }} 张</span>
              </div>
              <p>本件验货实拍 + 大库机器初筛通过净图 · 点击图片高清放大看细节，点下方按钮选入「<b>{{ activeShopLabel }}</b>」</p>
            </div>
          </header>

          <div v-if="lib.recommended.length" class="photo-grid">
            <article
              v-for="im in lib.recommended"
              :key="im.id"
              class="pcard"
              :class="{
                'picked-cur': im.selectedShopId === activeShopId,
                'picked-other': im.selectedShopId && im.selectedShopId !== activeShopId
              }"
            >
              <div class="pcard-img" style="cursor:zoom-in" title="点击放大查看高清大图" @click="openPreview(im, lib.recommended)">
                <img :src="im.thumb" :alt="im.sourceLabel" loading="lazy" />
                <span class="src-tag" :class="{ real: im.sourceType === 'warehouse_real' }">{{ im.sourceLabel }}</span>
                <button class="zoom-ic" title="放大查看原图" @click.stop="openPreview(im, lib.recommended)">🔍</button>
                <span v-if="im.selectedShopLabel" class="picked-tag" :class="im.selectedShopId === activeShopId ? 'cur' : 'oth'">
                  ✓ 已选入 {{ im.selectedShopLabel }}
                </span>
              </div>

              <div class="pcard-body">
                <div class="pcard-meta">
                  <span>{{ im.resolution }}</span>
                  <span>匹配 {{ Math.round(im.confidence * 100) }}%</span>
                </div>
                <p class="pcard-rsn" :title="im.reason">{{ im.reason }}</p>
                <div class="pcard-btns">
                  <button
                    class="cbtn pick"
                    :class="{ active: im.selectedShopId === activeShopId }"
                    :disabled="busy"
                    @click="toggleSelectForActiveShop(im)"
                  >
                    {{ im.selectedShopId === activeShopId ? '✓ 取消选定' : '+ 选入当前号' }}
                  </button>
                  <button class="cbtn mute" :disabled="busy" title="标记为脏图移入第2栏" @click="moveWave(im, 'not_recommended')">
                    移入不推荐
                  </button>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="col-empty">
            当前档位下暂无推荐图片，可切换上方「宽松档」或从中间「不推荐使用」栏恢复图片。
          </div>
        </div>

        <!-- ==================== 第 2 栏：不推荐使用 ==================== -->
        <div class="lib-col col-notrec">
          <header class="col-head">
            <div>
              <div class="col-title">
                <span class="wdot amb"></span>
                <h2>2. 不推荐使用</h2>
                <span class="cnt-pill amb">{{ lib.notRecommended.length }} 张</span>
              </div>
              <p>电脑首轮过滤出的水印海报、串型号模糊图、低清图与瑕疵留底照 · 误杀可移回推荐或破格选用</p>
            </div>
          </header>

          <div v-if="lib.notRecommended.length" class="photo-grid">
            <article v-for="im in lib.notRecommended" :key="im.id" class="pcard filtered">
              <div class="pcard-img" style="cursor:zoom-in" @click="openPreview(im, lib.notRecommended)">
                <img :src="im.thumb" :alt="im.sourceLabel" loading="lazy" />
                <span class="src-tag bad">{{ filterShortLabel(im) }}</span>
                <button class="zoom-ic" title="放大核对细节" @click.stop="openPreview(im, lib.notRecommended)">🔍</button>
              </div>

              <div class="bad-reason">{{ im.reason }}</div>

              <div class="pcard-body">
                <div class="pcard-meta">
                  <span>{{ im.resolution }}</span>
                  <span>置信度 {{ Math.round(im.confidence * 100) }}%</span>
                </div>
                <div class="pcard-btns">
                  <button class="cbtn" :disabled="busy" @click="moveWave(im, 'recommended')">← 移入推荐</button>
                  <button class="cbtn pick" :disabled="busy" @click="forcePickFromNotRec(im)">破格选用</button>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="col-empty">
            本轮没有被过滤的图片。
          </div>
        </div>

        <!-- ==================== 第 3 栏：已经被选定的图片 ==================== -->
        <div class="lib-col col-sel">
          <header class="col-head">
            <div>
              <div class="col-title">
                <span class="wdot acc"></span>
                <h2>3. 已经被选定的图片</h2>
                <span class="cnt-pill acc">共 {{ lib.collisionCheck?.totalSelected || 0 }} 张</span>
              </div>
              <p>点选下方闲鱼号切换选图目标；各号图片互不重复防铺货判罚，统一按第 1 步确认价上架</p>
            </div>
          </header>

          <div class="shop-boxes">
            <div
              v-for="sh in lib.selectedByShop"
              :key="sh.shopId"
              class="sbox"
              :class="{ active: activeShopId === sh.shopId, unpicked: !publishPick[sh.shopId] }"
              @click="activeShopId = sh.shopId"
            >
              <div class="sbox-hd">
                <div class="sbox-left">
                  <input
                    type="checkbox"
                    v-model="publishPick[sh.shopId]"
                    title="勾选后参与本次一键上架"
                    @click.stop
                  />
                  <span class="target-dot" :class="{ on: activeShopId === sh.shopId }"></span>
                  <b>{{ sh.label }}</b>
                  <span class="tag" :class="sh.listed ? 'grn' : sh.images.length ? 'acc' : 'amb'">
                    {{ sh.statusLabel }}
                  </span>
                </div>

                <div class="sbox-right" @click.stop>
                  <span class="price-pill">统一价 ¥{{ unifiedPrice || '—' }}</span>
                  <span class="cnt-txt">{{ sh.images.length }}/9 张</span>
                  <button
                    v-if="sh.images.length"
                    class="clear-link"
                    :disabled="busy"
                    @click="clearShopImages(sh.shopId)"
                  >清空</button>
                </div>
              </div>

              <div v-if="sh.images.length" class="sel-thumbs">
                <div v-for="(img, idx) in sh.images" :key="img.url" class="sthumb" @click.stop>
                  <img :src="img.thumb" alt="" style="cursor:zoom-in" title="点击放大查看" @click="openPreview(img, sh.images)" />
                  <span v-if="idx === 0" class="m-badge">首图主图</span>
                  <button v-else class="setm-btn" :disabled="busy" @click="setMainImage(sh.shopId, img.url)">设为主图</button>
                  <button class="rm-x" title="移出已选" :disabled="busy" @click="removeSelected(sh.shopId, img.url)">✕</button>
                </div>
              </div>
              <div v-else class="sbox-empty">
                <span v-if="activeShopId === sh.shopId">👈 当前正在给「{{ sh.label }}」选图，请点击第 1 栏推荐图加入</span>
                <span v-else>点此切换到「{{ sh.label }}」并从第 1 栏选几张图</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 底部吸底确认上架栏（一步直接洗净上架，无任何提审/主管确认环节） -->
      <footer class="card publish-footer">
        <div class="pf-left">
          <div class="pf-stat">
            <span>统一上架售价：<b>{{ unifiedPrice ? `¥${unifiedPrice}` : '未定' }}</b></span>
            <span>·</span>
            <span>本次发布账号：<b>{{ pickedCount }}</b> 个</span>
            <span>·</span>
            <span>已选净图：<b>{{ pickedImageCount }}</b> 张（互不重复）</span>
          </div>
          <div v-if="needsOverrideReason" class="pf-override">
            <span>⚠ 售价低于采购成本 ¥{{ money(ps.cost) }}，请注明清仓/折价原因：</span>
            <input v-model="overrideReason" placeholder="必填原因（如：满4周期滞销清仓）" />
          </div>
          <p v-else-if="!canPublish.ok" class="pf-warn">{{ canPublish.why }}</p>
          <p v-else class="pf-ok">✓ 价格与图片均已核对就绪，点击右侧按钮即刻洗净并同步上架到闲鱼（无需主管审批）。</p>
        </div>

        <div class="pf-right">
          <button class="btn" @click="goPriceStep">← 上一步：看闲鱼价格</button>
          <Lock
            :ok="canPublish.ok && !practiceLocked && !busy"
            :reason="practiceLocked ? '请先在「学」里完成 3 个新手练习' : canPublish.why"
            penalty="机器初审 + 人工第 2 次确认选图后直接洗净上架，不走提审与主管确认。"
            @go="publishDirectly"
          >
            🚀 完成选图 · 按 ¥{{ unifiedPrice || '—' }} 直接洗净上架（{{ pickedCount }} 个号）
          </Lock>
        </div>
      </footer>
    </template>

    <!-- 高清大图预览弹窗（支持左右切换 + 弹窗内直接选入当前闲鱼号） -->
    <div v-if="previewItem" class="zoom-modal" @click="previewItem = null">
      <div class="zm-box" @click.stop>
        <img :src="previewItem.url" alt="" />
        <div class="zm-bar">
          <div>
            <b>{{ previewItem.sourceLabel || '商品图片高清预览' }}</b>
            <span v-if="previewList.length > 1" class="muted" style="margin-left:8px">（{{ previewIdx + 1 }} / {{ previewList.length }}）</span>
            <span v-if="previewItem.resolution" class="muted" style="margin-left:10px">{{ previewItem.resolution }}</span>
            <span v-if="previewItem.reason" class="muted" style="margin-left:10px">{{ previewItem.reason }}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button v-if="previewList.length > 1" class="btn sm" @click="stepPreview(-1)">← 上一张</button>
            <button v-if="previewList.length > 1" class="btn sm" @click="stepPreview(1)">下一张 →</button>
            <button v-if="activeShopId" class="btn sm pri" :disabled="busy" @click="toggleSelectForActiveShop(previewItem)">
              {{ previewItem.selectedShopId === activeShopId ? '✓ 取消选定' : `+ 选入「${activeShopLabel}」` }}
            </button>
            <button class="btn sm" @click="previewItem = null">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import Lock from './Lock.vue'
import { api, post } from './api.js'
import { state, loadAll, money } from './store.js'
import { toast } from './ui.js'
import { TIER_OPTIONS } from './priceCleaning.js'

const props = defineProps({ caseId: { type: String, default: '' } })

const skuQueue = ref([])
const currentCode = ref('')
const lib = ref(null)
const activeShopId = ref('')
const customQuery = ref('')
const publishPick = reactive({})
const overrideReason = ref('')
const previewItem = ref(null)
const previewList = ref([])
const previewIdx = ref(0)
function openPreview(item, list = []) {
  const arr = Array.isArray(list) && list.length ? list : [item]
  previewList.value = arr
  const idx = arr.findIndex((x) => x.url === item.url)
  previewIdx.value = idx >= 0 ? idx : 0
  previewItem.value = arr[previewIdx.value] || item
}
function stepPreview(delta) {
  if (!previewList.value.length) return
  previewIdx.value = (previewIdx.value + delta + previewList.value.length) % previewList.value.length
  previewItem.value = previewList.value[previewIdx.value]
}
async function refillImageLane() {
  if (!currentCode.value) return
  busy.value = true
  try {
    const res = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/refill-lane`, {})
    lib.value = res
    toast(res.msg || '已扩搜补满正式图池，转入好图列表！')
    refreshQueue()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}
const loading = ref(false)
const libToolsOpen = ref(false)
const busy = ref(false)
const justPublished = ref(false)
const lastPublishedPrice = ref(0)
const undoLeft = ref(0)
const undoShopIds = ref([])
let undoTimer = null

const practiceLocked = computed(() => state.me && !state.me.practice_done)
const ps = computed(() => lib.value?.priceSummary || {})
const priceConfirmed = computed(() => ps.value.step === 'active' && Number(ps.value.confirmedPrice) > 0)
const unifiedPrice = computed(() => {
  if (Number(ps.value.confirmedPrice) > 0) return Math.round(Number(ps.value.confirmedPrice))
  if (Number(ps.value.recommendedPrice) > 0) return Math.round(Number(ps.value.recommendedPrice))
  return 0
})

const activeShopLabel = computed(() => {
  const hit = (lib.value?.selectedByShop || []).find((s) => s.shopId === activeShopId.value)
  return hit ? hit.label : '当前闲鱼号'
})

const nextPendingSku = computed(() =>
  skuQueue.value.find((it) => it.code !== currentCode.value && it.overallStage !== 'published') || null
)

function syncShopsFromLib(data) {
  if (!data) return
  customQuery.value = data.query || ''
  const shops = data.selectedByShop || []
  if (!activeShopId.value || !shops.some((s) => s.shopId === activeShopId.value)) {
    const firstTodo = shops.find((s) => !s.listed || s.needsFix)
    activeShopId.value = (firstTodo || shops[0] || {}).shopId || ''
  }
  for (const sh of shops) {
    if (!(sh.shopId in publishPick)) {
      publishPick[sh.shopId] = !sh.listed || sh.needsFix
    }
  }
  if (shops.length && !shops.some((s) => publishPick[s.shopId])) {
    for (const sh of shops) publishPick[sh.shopId] = true
  }
}

async function refreshQueue() {
  try {
    const res = await api('/wash-workflow/skus')
    skuQueue.value = res.items || []
  } catch {
    skuQueue.value = []
  }
}

async function loadCase(code) {
  if (!code) return
  currentCode.value = code
  loading.value = true
  try {
    const data = await api(`/image-library/skus/${encodeURIComponent(code)}`)
    lib.value = data
    syncShopsFromLib(data)
  } catch (e) {
    toast('读取大库图库失败：' + e.message)
  } finally {
    loading.value = false
  }
}

async function bootstrap() {
  await refreshQueue()
  const target =
    props.caseId ||
    skuQueue.value.find((x) => x.overallStage === 'step2_image')?.code ||
    skuQueue.value[0]?.code ||
    '513211549229'
  await loadCase(target)
}

function pickCode(code) {
  if (!code || code === currentCode.value) return
  location.hash = '#/image-cleaning/' + encodeURIComponent(code)
}

function goGallery() {
  location.hash = '#/wash'
}

function goPriceStep() {
  if (!currentCode.value) return goGallery()
  location.hash = '#/price-cleaning/' + encodeURIComponent(currentCode.value)
}

function goNextPending() {
  if (!nextPendingSku.value) return goGallery()
  const nxt = nextPendingSku.value
  if (nxt.overallStage === 'step2_image') {
    location.hash = '#/image-cleaning/' + encodeURIComponent(nxt.code)
  } else {
    location.hash = '#/price-cleaning/' + encodeURIComponent(nxt.code)
  }
}

function filterShortLabel(im) {
  const map = {
    watermark: '促销水印/海报字',
    low_confidence: '近邻型号模糊',
    low_res: '分辨率偏低',
    aspect_ratio: '手机长图/截图',
    defect_photo: '本件瑕疵留底照'
  }
  return map[im.filterCode] || (im.humanMoved ? '人工移入不推荐' : '机器初筛过滤')
}

async function changeTier(tier) {
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/search`, { searchTier: tier })
    toast(`已按「${tier === 'strict' ? '严格档' : tier === 'broad' ? '宽松档' : '平衡档'}」重筛大库图片`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function reSearchLib() {
  if (!customQuery.value.trim()) return
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/search`, {
      query: customQuery.value.trim()
    })
    toast(`已按检索词「${lib.value.query}」更新大库图库`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function autoAssignImages() {
  busy.value = true
  try {
    const targetIds = (lib.value?.selectedByShop || []).filter((s) => publishPick[s.shopId]).map((s) => s.shopId)
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'auto_assign',
      shopIds: targetIds.length ? targetIds : undefined,
      perShop: 3
    })
    toast('已从「推荐可使用」自动为各闲鱼号分配互不重复图片')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function toggleSelectForActiveShop(im) {
  if (!activeShopId.value) return
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'toggle',
      shopId: activeShopId.value,
      url: im.url
    })
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function forcePickFromNotRec(im) {
  if (!activeShopId.value) return
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'add',
      shopId: activeShopId.value,
      url: im.url
    })
    toast(`已破格选入「${activeShopLabel.value}」`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function moveWave(im, targetWave) {
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/move`, {
      url: im.url,
      targetWave
    })
    toast(targetWave === 'recommended' ? '已恢复至「推荐可使用」' : '已移入「不推荐使用」并从已选移除')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function removeSelected(shopId, url) {
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'remove',
      shopId,
      url
    })
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function clearShopImages(shopId) {
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'clear_shop',
      shopId
    })
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function setMainImage(shopId, url) {
  busy.value = true
  try {
    lib.value = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/select`, {
      action: 'set_main',
      shopId,
      url
    })
    toast('已设为该账号首张主图')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

const pickedShops = computed(() => (lib.value?.selectedByShop || []).filter((s) => publishPick[s.shopId]))
const pickedCount = computed(() => pickedShops.value.length)
const pickedImageCount = computed(() => pickedShops.value.reduce((acc, s) => acc + (s.images?.length || 0), 0))

const needsOverrideReason = computed(() => {
  const c = Number(ps.value.cost || 0)
  return c > 0 && unifiedPrice.value > 0 && unifiedPrice.value < c
})

const canPublish = computed(() => {
  if (!unifiedPrice.value || unifiedPrice.value <= 0) {
    return { ok: false, why: '请先去「第 1 步：洗价格」抓取闲鱼快照并确认统一售价' }
  }
  if (!pickedShops.value.length) {
    return { ok: false, why: '请在右侧「已经被选定的图片」栏至少勾选 1 个要发布的闲鱼号' }
  }
  if (!lib.value?.collisionCheck?.ok) {
    return { ok: false, why: lib.value.collisionCheck.warnings?.[0] || '各账号选图存在重复，请去重后再上架' }
  }
  for (const sh of pickedShops.value) {
    if (!sh.images?.length) {
      return { ok: false, why: `「${sh.label}」还没有选定图片，请在左栏点选几张推荐图` }
    }
  }
  if (needsOverrideReason.value && overrideReason.value.trim().length < 2) {
    return { ok: false, why: '当前售价低于采购成本，请填写清仓/折价原因后再上架' }
  }
  return { ok: true, why: '' }
})

async function publishDirectly() {
  busy.value = true
  try {
    const payload = {
      price: unifiedPrice.value,
      shops: pickedShops.value.map((sh) => ({
        shopId: sh.shopId,
        price: unifiedPrice.value,
        images: sh.images.map((i) => i.url)
      })),
      overrideReason: overrideReason.value.trim()
    }
    const res = await post(`/image-library/skus/${encodeURIComponent(currentCode.value)}/publish`, payload)
    lib.value = res.library
    syncShopsFromLib(res.library)
    lastPublishedPrice.value = unifiedPrice.value
    lastGcJobs.value = res.gcJobs || []
    justPublished.value = true
    undoShopIds.value = payload.shops.map((x) => x.shopId)
    undoLeft.value = res.undo_sec || 60
    startUndoCountdown()
    toast(res.msg || '已直接洗净并发布上架！')
    await Promise.all([refreshQueue(), loadAll()])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

function startUndoCountdown() {
  clearInterval(undoTimer)
  undoTimer = setInterval(() => {
    undoLeft.value = Math.max(0, undoLeft.value - 1)
    if (!undoLeft.value) clearInterval(undoTimer)
  }, 1000)
}

const lastGcJobs = ref([])
function goGcQueue() {
  location.hash = '#/gc-queue'
}

async function undoPublish() {
  busy.value = true
  try {
    for (const sid of undoShopIds.value) {
      await post('/demo/unpublish', { sku_code: currentCode.value, shop_id: sid })
    }
    undoLeft.value = 0
    justPublished.value = false
    toast('已撤回刚刚发布的链接')
    await Promise.all([loadCase(currentCode.value), refreshQueue(), loadAll()])
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(bootstrap)
watch(
  () => props.caseId,
  (nv) => {
    justPublished.value = false
    activeShopId.value = ''
    Object.keys(publishPick).forEach((k) => delete publishPick[k])
    if (nv && nv !== currentCode.value) loadCase(nv)
  }
)
onUnmounted(() => clearInterval(undoTimer))
</script>

<style scoped>
.ic-page { padding: 10px 24px 80px; max-width: 1780px; display: grid; gap: 7px; }
.ic-loading { padding: 64px 20px; text-align: center; color: var(--mute); font-weight: 600; }

/* 顶部步骤向导条（与第 1 步 PriceCleaning 完全统一） */
.wizard-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 12px; flex-wrap: nowrap; }
.wiz-steps { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
.wstep { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 10px; background: var(--soft); color: var(--mute); font-weight: 700; font-size: 12px; border: 1.5px solid transparent; white-space: nowrap; }
.wstep i { width: 18px; height: 18px; border-radius: 50%; background: var(--panel); display: grid; place-items: center; font-style: normal; font-size: 11px; font-weight: 800; }
.wstep.cur { background: var(--acc); color: #fff; box-shadow: 0 4px 12px rgba(37,99,235,.22); }
.wstep.cur i { background: rgba(255,255,255,.22); color: #fff; }
.wstep.done { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.wstep.done i { background: #10b981; color: #fff; }
.wsep { color: var(--mute); font-weight: 800; }
.sku-sel { height: 30px; border-radius: 9px; border: 1px solid var(--line); background: var(--soft); padding: 0 9px; font-weight: 700; font-size: 12px; color: var(--ink); max-width: 220px; }

/* 上架完成横幅 */
.pub-done-banner { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; background: #ecfdf5; border: 2px solid #34d399; padding: 12px 18px; }
.pdb-left { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.done-badge { background: #059669; color: #fff; font-weight: 800; font-size: 13.5px; padding: 6px 14px; border-radius: 999px; }
.pdb-left b { font-size: 16px; color: #064e3b; display: block; }
.pdb-left p { margin: 3px 0 0; font-size: 13px; }
.pdb-acts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

/* 第1步未确认提醒 */
.step1-remind { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; background: #fffbeb; border: 1px solid #fcd34d; padding: 6px 14px; font-size: 12.5px; }
.sr-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 顶部商品信息 + 已锁定统一售价 + 大库工具条 */
.top-summary-card { padding: 10px 16px; display: grid; gap: 8px; }
.tsc-main { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.tsc-badges { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 3px; }
.tsc-info h1 { font-size: 20px; font-weight: 800; margin: 0; letter-spacing: -.01em; }
.tsc-info h1 small { font-size: 13px; font-weight: 500; color: var(--mute); margin-left: 8px; }

.unified-price-box { display: flex; align-items: center; gap: 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 12px; padding: 6px 12px; flex-wrap: wrap; }
.up-item { display: grid; gap: 1px; }
.up-item span { font-size: 11px; color: var(--mute); font-weight: 600; }
.up-item b { font-size: 16px; font-weight: 800; color: var(--ink); }
.up-item.main b { font-size: 19px; color: #059669; }
.up-sep { width: 1px; height: 26px; background: #cbd5e1; }

.lib-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid var(--line); }
.lt-left, .lt-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lt-label { font-size: 13px; color: var(--mute); }
.lt-label b { color: var(--ink); }
.search-box { display: inline-flex; gap: 6px; }
.search-box input { height: 34px; width: 190px; border: 1px solid var(--line); border-radius: 9px; padding: 0 11px; font-size: 13px; background: var(--soft); color: var(--ink); }
.tier-seg { display: inline-flex; gap: 4px; background: var(--soft); padding: 3px; border-radius: 10px; }
.tier-seg button { height: 30px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; font-weight: 700; color: var(--ink2); }
.tier-seg button.on { background: var(--ink); color: var(--bg); }

/* 整屏大库图库三栏看板 */
.three-cols-board { display: grid; grid-template-columns: 1.22fr 1fr 1.05fr; gap: 16px; align-items: start; }

.lib-col { border-radius: 20px; padding: 16px; border: 2px solid var(--line); background: var(--panel); display: grid; gap: 14px; box-shadow: var(--sh); }
.col-rec { border-color: #86efac; background: linear-gradient(180deg, #f3fdf6 0%, #ffffff 140px); }
.col-notrec { border-color: #fde68a; background: linear-gradient(180deg, #fffdf4 0%, #ffffff 140px); }
.col-sel { border-color: #93c5fd; background: linear-gradient(180deg, #f3f8ff 0%, #ffffff 140px); position: sticky; top: 14px; }

.col-head h2 { font-size: 17px; font-weight: 800; margin: 0; }
.col-title { display: flex; align-items: center; gap: 8px; }
.col-head p { font-size: 12.5px; color: var(--mute); margin: 5px 0 0; line-height: 1.45; }
.col-head p b { color: #1d4ed8; }
.wdot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.wdot.grn { background: #16a34a; }
.wdot.amb { background: #d97706; }
.wdot.acc { background: #2563eb; }
.cnt-pill { margin-left: auto; font-size: 12.5px; font-weight: 800; padding: 3px 10px; border-radius: 999px; }
.cnt-pill.grn { background: #dcfce7; color: #15803d; }
.cnt-pill.amb { background: #fef3c7; color: #b45309; }
.cnt-pill.acc { background: #dbeafe; color: #1d4ed8; }

.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(154px, 1fr)); gap: 12px; }
.pcard { background: #fff; border-radius: 14px; border: 2px solid #e2e8f0; overflow: hidden; display: flex; flex-direction: column; transition: transform .13s ease, border-color .13s ease, box-shadow .13s ease; }
.pcard:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(15,23,42,.08); }
.pcard.picked-cur { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.18); }
.pcard.picked-other { border-color: #16a34a; }
.pcard.filtered { border-color: #fcd34d; }

.pcard-img { position: relative; aspect-ratio: 1 / 1; background: #f1f5f9; cursor: pointer; overflow: hidden; }
.pcard-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.src-tag { position: absolute; left: 7px; top: 7px; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 7px; background: rgba(15,23,42,.74); color: #fff; max-width: calc(100% - 42px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.src-tag.real { background: #0f766e; }
.src-tag.bad { background: #dc2626; }
.zoom-ic { position: absolute; right: 7px; top: 7px; width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,.88); font-size: 13px; display: grid; place-items: center; box-shadow: 0 2px 6px rgba(0,0,0,.15); }
.picked-tag { position: absolute; left: 7px; right: 7px; bottom: 7px; text-align: center; font-size: 11.5px; font-weight: 800; padding: 4px 8px; border-radius: 8px; }
.picked-tag.cur { background: #2563eb; color: #fff; }
.picked-tag.oth { background: #16a34a; color: #fff; }

.bad-reason { background: #fef2f2; color: #991b1b; font-size: 11.5px; font-weight: 700; padding: 6px 9px; line-height: 1.35; border-bottom: 1px solid #fee2e2; }
.pcard-body { padding: 9px 10px 10px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.pcard-meta { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; font-weight: 600; }
.pcard-rsn { font-size: 11.5px; color: #475569; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
.pcard-btns { display: flex; gap: 6px; margin-top: auto; padding-top: 4px; }
.cbtn { flex: 1; height: 28px; border-radius: 8px; font-size: 11.5px; font-weight: 700; background: #f1f5f9; color: #334155; padding: 0 6px; white-space: nowrap; }
.cbtn:hover { background: #e2e8f0; }
.cbtn.pick { background: #dbeafe; color: #1d4ed8; }
.cbtn.pick.active { background: #2563eb; color: #fff; }
.cbtn.mute { color: #64748b; }
.col-empty { padding: 36px 14px; text-align: center; color: var(--mute); font-size: 13.5px; background: var(--soft); border-radius: 14px; }

/* 第 3 栏：按闲鱼号分组的已选定图片盒 */
.shop-boxes { display: grid; gap: 12px; }
.sbox { background: #fff; border: 2px solid #dbeafe; border-radius: 16px; padding: 13px 14px; cursor: pointer; transition: border-color .13s ease, box-shadow .13s ease; }
.sbox.active { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.sbox.unpicked { opacity: .68; }
.sbox-hd { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.sbox-left { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sbox-left input[type="checkbox"] { width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer; }
.target-dot { width: 11px; height: 11px; border-radius: 50%; border: 2px solid #94a3b8; display: inline-block; }
.target-dot.on { border-color: #2563eb; background: #2563eb; box-shadow: inset 0 0 0 2px #fff; }
.sbox-right { display: flex; align-items: center; gap: 8px; }
.price-pill { font-size: 12px; font-weight: 800; color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 2px 8px; border-radius: 999px; }
.cnt-txt { font-size: 12px; color: var(--mute); font-weight: 700; }
.clear-link { font-size: 12px; color: #dc2626; background: none; padding: 2px 4px; font-weight: 700; }

.sel-thumbs { display: flex; gap: 9px; flex-wrap: wrap; }
.sthumb { position: relative; width: 82px; height: 82px; border-radius: 12px; overflow: hidden; border: 2px solid #cbd5e1; background: #f8fafc; }
.sthumb img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.m-badge { position: absolute; left: 4px; bottom: 4px; background: #2563eb; color: #fff; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 6px; }
.setm-btn { position: absolute; left: 4px; bottom: 4px; background: rgba(15,23,42,.78); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px; opacity: 0; transition: opacity .12s; }
.sthumb:hover .setm-btn { opacity: 1; }
.rm-x { position: absolute; right: 4px; top: 4px; width: 20px; height: 20px; border-radius: 50%; background: rgba(220,38,38,.9); color: #fff; font-size: 11px; font-weight: 800; display: grid; place-items: center; }
.sbox-empty { padding: 14px 10px; border: 1.5 dashed #cbd5e1; border-style: dashed; border-radius: 12px; text-align: center; font-size: 12.5px; color: #64748b; background: #f8fafc; }

/* 底部吸底直接上架栏 */
.publish-footer { position: sticky; bottom: 14px; z-index: 25; display: flex; justify-content: space-between; align-items: center; gap: 18px; flex-wrap: wrap; padding: 16px 22px; background: rgba(255,255,255,.96); backdrop-filter: blur(10px); border: 2px solid #93c5fd; box-shadow: 0 12px 32px rgba(15,23,42,.14); }
.pf-left { display: grid; gap: 5px; flex: 1; min-width: 280px; }
.pf-stat { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14.5px; }
.pf-stat b { font-size: 17px; color: var(--ink); }
.pf-warn { margin: 0; font-size: 13px; color: #dc2626; font-weight: 700; }
.pf-ok { margin: 0; font-size: 13px; color: #059669; font-weight: 700; }
.pf-override { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: #b45309; font-weight: 700; }
.pf-override input { height: 34px; min-width: 260px; border: 1.5px solid #f59e0b; border-radius: 8px; padding: 0 10px; background: #fffbeb; }
.pf-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* 放大看图 Modal */
.zoom-modal { position: fixed; inset: 0; z-index: 95; background: rgba(15,23,42,.76); display: grid; place-items: center; padding: 24px; }
.zm-box { background: var(--panel); border-radius: 20px; padding: 16px; max-width: min(880px, 94vw); max-height: 90vh; display: grid; gap: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
.zm-box img { max-width: 100%; max-height: 74vh; object-fit: contain; border-radius: 12px; margin: 0 auto; display: block; background: #0f172a; }
.zm-bar { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 14px; }
</style>
