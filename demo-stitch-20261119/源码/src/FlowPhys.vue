<template>
  <section id="flow-panel" class="flow card">
    <div class="flow-hd">
      <div>
        <h3>分步清洗直发流程 <small>一步一个独立大页面：先在闲鱼挂牌页洗价格，再去大库三栏洗图片并直接上架（无主管审批）</small></h3>
      </div>
      <div class="hb">
        <button class="btn sm" @click="goWashGallery">前往待洗商品 Gallery</button>
      </div>
    </div>

    <ol class="steps">
      <li :class="priceDone ? 'done' : cur === 1 ? 'cur' : 'cur'">
        <i>{{ priceDone ? '✓' : '1' }}</i>
        <span>第 1 步：洗价格（独立大页）</span>
      </li>
      <li :class="allListed ? 'done' : priceDone ? 'cur' : 'todo'">
        <i>{{ allListed ? '✓' : '2' }}</i>
        <span>第 2 步：洗图片并直接上架（独立大页）</span>
      </li>
      <li :class="lockedSku ? 'done' : allListed ? 'cur' : 'todo'">
        <i>{{ lockedSku ? '✓' : '3' }}</i>
        <span>在架销售</span>
      </li>
      <li :class="lockedSku ? 'cur' : 'todo'">
        <i>4</i>
        <span>锁单发货出库</span>
      </li>
    </ol>

    <p v-if="locked" class="gate"><Icon name="lock" />真实操作先锁着：请先在「学」里完成 3 个新手演练。</p>

    <!-- 异常缺成本或型号无法解析 -->
    <div v-if="cur === 1" class="pn">
      <h4>先补齐基础主数据缺口</h4>
      <ul class="gl"><li v-for="(g, i) in hardGaps" :key="i"><i class="dot red"></i>{{ g.text }}</li></ul>
      <p class="muted">采购成本或 SPU 型号缺失时无法自动计算成本围栏；可点击下方催办，或直接打开闲鱼洗价格大页面现抓参考价。</p>
      <div class="act-row">
        <button class="btn pri" @click="goCleanPrice">打开第 1 步：洗价格大页面 →</button>
        <button class="btn" @click="report">催仓管 / 采购补齐</button>
      </div>
    </div>

    <!-- 已锁单待发货 -->
    <div v-else-if="cur === 4" class="pn">
      <h4>买家已拍下锁单 · 待发货出库</h4>
      <div v-if="myOrders.length">
        <div v-for="o in myOrders" :key="o.id" class="rv">
          <b>{{ o.title }}</b> · {{ o.buyer }} · ¥{{ o.amount }}
          <p class="why" :class="o.lvl">{{ o.gap_label }}{{ o.why ? '：' + o.why : '' }}</p>
          <button class="btn pri" @click="goOrder(o)">去订单页核对单号发货</button>
        </div>
      </div>
      <p v-else class="muted">该单件已被锁单，请前往订单页核对运单与扫码出库。</p>
      <p v-if="conflict" class="why red">注意：其他闲鱼号仍有同件商品在架，系统正在执行联动下架。</p>
      <div class="delist">
        <b>多店联动下架回执</b>
        <div v-for="(x, i) in delist" :key="x.acc" class="dl">
          <span>{{ x.acc }}</span>
          <span class="tag" :class="x.state === '已下架' ? 'grn' : x.state === '失败' ? 'red' : 'amb'">{{ x.state }}</span>
          <span class="muted">{{ x.note }}</span>
          <button v-if="x.state === '失败'" class="btn sm" @click="retryDelist(i)">重试</button>
        </div>
      </div>
    </div>

    <!-- 正常两步独立大页面入口看板（绝不在单品台账里把价格表和三栏图库挤在一起） -->
    <div v-else class="two-step-cards">
      <!-- 第 1 步大页面入口 -->
      <article class="step-card" :class="priceDone ? 'done' : 'active'">
        <div class="sc-head">
          <span class="step-num">{{ priceDone ? '✓ 第 1 步已完成' : '① 第 1 步' }}</span>
          <span class="tag" :class="priceDone ? 'grn' : ps.cleanedAverage ? 'amb' : 'red'">
            {{ priceDone ? `已确认统一售价 ¥${ps.confirmedPrice}` : ps.cleanedAverage ? `机器初筛均价 ¥${ps.recommendedPrice}` : '待抓取闲鱼页' }}
          </span>
        </div>
        <h4>洗价格（闲鱼挂牌页去噪确认）</h4>
        <p class="sc-desc">
          整屏展示闲鱼当时搜出来的三四十个在售商品快照，电脑已自动筛掉配件/回收/引流低价，算好平均价；人工扫一眼确认、微调或作废重爬。
        </p>
        <div class="sc-metrics" v-if="lib">
          <div><span>有效同款</span><b>{{ ps.validCount || 0 }} 条</b></div>
          <div><span>已去不合理</span><b>{{ ps.rejectedCount || 0 }} 条</b></div>
          <div><span>采购成本</span><b>¥{{ money(ps.cost) }}</b></div>
        </div>
        <button class="btn" :class="priceDone ? '' : 'pri'" @click="goCleanPrice">
          {{ priceDone ? '查看 / 修改第 1 步闲鱼价格 →' : '进入第 1 步：洗价格大页面 →' }}
        </button>
      </article>

      <!-- 第 2 步大页面入口 -->
      <article class="step-card" :class="allListed ? 'done' : priceDone ? 'active' : ''">
        <div class="sc-head">
          <span class="step-num">{{ allListed ? '✓ 第 2 步已上架' : '② 第 2 步' }}</span>
          <span class="tag" :class="allListed ? 'grn' : 'acc'">
            {{ allListed ? `全部 ${shopCount} 个号已在架` : `已选 ${totalSelectedImgs} 张互不重图` }}
          </span>
        </div>
        <h4>洗图片并直接上架（大库图库三栏制）</h4>
        <p class="sc-desc">
          独立全屏展示大库图库三栏：「推荐可使用」「不推荐使用」「已经被选定的图片」。选几张净图后按第 1 步确认好的统一售价一键洗净上架。
        </p>
        <div class="sc-metrics" v-if="lib">
          <div><span>推荐可使用</span><b>{{ lib.recommended?.length || 0 }} 张</b></div>
          <div><span>不推荐使用</span><b>{{ lib.notRecommended?.length || 0 }} 张</b></div>
          <div><span>已选定上架图</span><b>{{ totalSelectedImgs }} 张</b></div>
        </div>
        <button class="btn" :class="!priceDone ? '' : 'pri'" @click="goCleanImage">
          {{ allListed ? '打开大库三栏图库 / 调整选图 →' : '进入第 2 步：洗图片并直接上架 →' }}
        </button>
      </article>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { api, post } from './api.js'
import { state, money } from './store.js'
import { toast } from './ui.js'

const props = defineProps({ code: String, item: Object, market: [Number, String] })

const lib = ref(null)

const delist = reactive([
  { acc: '果果数码', state: '已下架', note: '锁单后 3 秒自动下架' },
  { acc: '小满优选', state: '失败', note: '接口限流，可点重试' },
  { acc: '周周二手', state: '已下架', note: '锁单后 4 秒自动下架' }
])
function retryDelist(i) {
  delist[i].state = '下架中'
  delist[i].note = '正在重试…'
  setTimeout(() => { delist[i].state = '已下架'; delist[i].note = '重试下架成功' }, 700)
}

const locked = computed(() => !state.me?.practice_done)
const lockedSku = computed(() => props.item?.locked)
const myOrders = computed(() => state.orders.filter((o) => o.sku === props.code))
const conflict = computed(() => (state.plan?.conflicts || []).some((c) => c.sku === props.code))

const hardGaps = computed(() =>
  (props.item?.issues || []).filter((i) => i.lvl === 'red' && (i.text.includes('缺成本') || i.text.includes('SPU 解析不出')))
)

const ps = computed(() => lib.value?.priceSummary || {})
const priceDone = computed(() => ps.value.step === 'active' && Number(ps.value.confirmedPrice) > 0)
const shopCount = computed(() => (lib.value?.selectedByShop || []).length)
const totalSelectedImgs = computed(() => lib.value?.collisionCheck?.totalSelected || 0)
const allListed = computed(() => {
  const arr = lib.value?.selectedByShop || []
  return arr.length > 0 && arr.every((s) => s.listed && !s.needsFix && s.images.length > 0) && priceDone.value
})

const cur = computed(() => {
  if (lockedSku.value) return 4
  if (hardGaps.value.length) return 1
  if (allListed.value) return 3
  return 2
})

async function load() {
  if (!props.code) return
  try {
    lib.value = await api(`/image-library/skus/${encodeURIComponent(props.code)}`)
  } catch {
    lib.value = null
  }
}

function goWashGallery() {
  location.hash = '#/wash'
}

function goCleanPrice() {
  location.hash = '#/price-cleaning/' + encodeURIComponent(props.code)
}

function goCleanImage() {
  location.hash = '#/image-cleaning/' + encodeURIComponent(props.code)
}

async function report() {
  await post('/demo/exceptions', { text: `${props.code} 缺基础信息：${hardGaps.value.map((g) => g.text).join('；')}` })
  toast('已提报催办')
}

const goOrder = (o) => { location.hash = '#/orders?oid=' + encodeURIComponent(o.id) }

onMounted(load)
watch(() => props.code, load)
</script>

<style scoped>
.flow { margin-bottom: 20px; }
.flow-hd { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.flow-hd h3 { margin: 0; }
.hb { display: inline-flex; gap: 8px; align-items: center; }

.steps { list-style: none; display: flex; padding: 0; margin: 6px 0 18px; }
.steps li { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; position: relative; font-size: 13px; font-weight: 700; color: var(--mute); text-align: center; }
.steps li::before { content: ''; position: absolute; top: 16px; left: -50%; width: 100%; height: 3px; background: var(--line); }
.steps li:first-child::before { display: none; }
.steps i { position: relative; z-index: 1; width: 34px; height: 34px; border-radius: 50%; background: var(--soft); border: 3px solid var(--line); display: flex; align-items: center; justify-content: center; font-style: normal; font-weight: 800; }
.steps .done { color: var(--grn-ink); }
.steps .done i { background: var(--grn); border-color: var(--grn); color: #fff; }
.steps .done::before { background: var(--grn); }
.steps .cur { color: var(--acc); }
.steps .cur i { background: var(--acc); border-color: var(--acc); color: #fff; box-shadow: 0 0 0 5px var(--acc-soft); }

.gate { display: flex; gap: 10px; align-items: center; background: var(--amb-soft); color: var(--amb-ink); border-radius: 14px; padding: 10px 16px; margin-bottom: 14px; font-weight: 600; }
.gate svg { width: 18px; height: 18px; }
.pn { background: var(--soft); border-radius: 20px; padding: 18px 20px; display: grid; gap: 14px; }
.pn h4 { font-size: 18px; margin: 0; }
.gl { margin: 4px 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.gl li { display: flex; gap: 10px; align-items: center; }
.act-row { display: flex; gap: 10px; flex-wrap: wrap; }

.two-step-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 960px) {
  .two-step-cards { grid-template-columns: 1fr; }
}
.step-card { background: var(--soft); border: 2px solid var(--line); border-radius: 20px; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; }
.step-card.active { background: #f8fbff; border-color: #60a5fa; box-shadow: 0 8px 24px rgba(37,99,235,.08); }
.step-card.done { background: #f4fdf8; border-color: #86efac; }
.sc-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.step-num { font-size: 13px; font-weight: 800; color: var(--ink); }
.step-card h4 { font-size: 19px; font-weight: 800; margin: 0; }
.sc-desc { font-size: 13.5px; color: var(--mute); line-height: 1.5; margin: 0; }
.sc-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; background: var(--panel); border-radius: 14px; padding: 10px 12px; border: 1px solid var(--line); margin-top: auto; }
.sc-metrics div { display: grid; gap: 2px; }
.sc-metrics span { font-size: 11.5px; color: var(--mute); }
.sc-metrics b { font-size: 15px; font-weight: 800; }

.rv { background: var(--panel); border-radius: 14px; padding: 14px 16px; display: grid; gap: 8px; }
.delist { background: var(--panel); border-radius: 14px; padding: 12px 16px; display: grid; gap: 8px; }
.dl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 6px; border-top: 1px solid var(--line); }
</style>
