<template>
  <div class="dpage">
    <div class="dbar">
      <button class="btn" @click="goBack"><Icon name="back" />返回库存实物</button>
      <span class="crumb">库存实物 / {{ sku ? `${sku.brand} ${sku.model}` : code }}</span>
      <button class="btn" style="margin-left:auto" @click="openHelp('detail')"><Icon name="help" />怎么用</button>
    </div>

    <div v-if="!sku" class="card" style="padding:48px;text-align:center">
      <b>没有找到货号「{{ code }}」</b>
      <p class="muted" style="margin-top:6px">可能还未完成入库归档，或货号输入有误。</p>
      <button class="btn pri" style="margin-top:14px" @click="go('gallery', 'all')">回到库存实物</button>
    </div>

    <template v-else>
      <!-- 顶部主图 + 红黄绿结论 + 只读真源核心指标 -->
      <section class="hero" :class="{ zoom }">
        <div class="pic" data-tour="dt-pic">
          <div class="big" :class="lvl" :title="galleryImgs.length ? '点一下放大/缩小核查细节' : ''" @click="galleryImgs.length && (zoom = !zoom)">
            <img v-if="galleryImgs.length" :src="galleryImgs[curImg].src" :alt="galleryImgs[curImg].label" />
            <span v-if="galleryImgs.length" class="hk" :class="{ soft: galleryImgs[curImg].kind !== 'real' }">{{ galleryImgs[curImg].label }}</span>
            <div v-else class="noimg">
              <b>待补实拍图</b>
              <span>这件货还没有本件验货实拍图，绝不拿同款网图或库位图冒充</span>
            </div>
          </div>
          <div v-if="galleryImgs.length" class="thumbs">
            <button v-for="(im, i) in galleryImgs" :key="i" :class="{ on: i === curImg }" @click="curImg = i">
              <img :src="im.src" :alt="im.label" />
            </button>
          </div>
        </div>

        <div class="info">
          <div class="row1">
            <span class="badge-l" :class="lvl">{{ LV[lvl].icon }} {{ LV[lvl].text }}</span>
            <span class="tag dark">{{ sku.zone }}</span>
            <span class="tag">{{ sku.brand }}</span>
            <span v-if="sku.boxCode" class="tag acc">含独立原盒 {{ sku.boxCode }}</span>
          </div>
          <h1>{{ sku.brand }} {{ sku.model }}</h1>
          <p class="codes">
            <span>货号 <b>{{ sku.code }}</b></span>
            <span>序列号 <b>{{ sku.sn }}</b></span>
            <span>库位 <b>{{ sku.location }}</b></span>
            <span>编号附件袋 <b>{{ sku.bagCode || '—' }}</b></span>
          </p>

          <div class="issuebox" data-tour="dt-issues" :class="lvl">
            <div class="t">
              {{ issues.length ? `现在有 ${issues.length} 件事要看` : '这件货没有要处理的事' }}<Q k="p-issues" />
            </div>
            <ul v-if="issues.length">
              <li v-for="(it, i) in issues" :key="i">
                <i class="dot" :class="it.lvl"></i>
                <span>{{ it.text }}</span>
                <a v-if="it.go" @click="jumpTo(it.go)">去看 ›</a>
              </li>
            </ul>
            <p v-else class="okline">实拍图、库位图、编号附件袋、分位状态与库龄都在正常范围。</p>
          </div>

          <p class="qrow">原采购成本（只读真源） / 库位 / 库龄周期 / 原盒与维修成本<Q k="p-facts" /></p>
          <div class="facts">
            <div>
              <span>原采购进价（只读）</span>
              <b>¥{{ sku.cost }}</b>
              <small>采购单 {{ sku.purchaseOrder }}</small>
            </div>
            <div>
              <span>当前分位与库位</span>
              <b>{{ sku.location }}</b>
              <small>{{ sku.zone }}</small>
            </div>
            <div>
              <span>在库天数与周期</span>
              <b>{{ sku.ageDays }} 天</b>
              <small>{{ age.long }}</small>
            </div>
            <div>
              <span>原盒 / 外修附加费</span>
              <b>{{ sku.repairCost ? `+¥${sku.repairCost} 外修` : (sku.boxCode ? '有原盒' : '无原盒') }}</b>
              <small>{{ sku.boxStatus }}</small>
            </div>
          </div>
        </div>
      </section>

      <!-- 折叠 1：三种图严格分离 -->
      <Fold v-model="imgOpen" id="imgs" title="三种图（本件实拍 · 库位同框 · 瑕疵微距严格分离）" help="p-imgs">
        <template #chips>
          <span class="chip" :class="sku.realImgCount ? 'grn' : 'red'">本件实拍图 {{ sku.realImgCount }} 张</span>
          <span class="chip" :class="sku.locImgCount ? 'grn' : 'amb'">库位同框图 {{ sku.locImgCount }} 张</span>
          <span class="chip">瑕疵微距图 {{ sku.defectImgCount }} 张</span>
        </template>
        <div class="img-slots">
          <div class="slot-card">
            <div class="sh"><b>① 本件验货实拍图</b><span class="tag" :class="sku.realImgCount ? 'grn' : 'red'">{{ sku.realImgCount ? `已存 ${sku.realImgCount} 张` : '缺图 · 禁止拿同款图顶替' }}</span></div>
            <div class="sbox">
              <img v-if="sku.realThumb" :src="sku.realThumb" alt="本件实拍图" />
              <p v-else class="muted">空槽位：历史迁移未继承老图，请现场新拍本机实拍图</p>
            </div>
            <Lock :ok="!locked" reason="先去「学」完成 3 个练习" kind="" @go="captureSkuPhotoDirect(sku, 'real')">+ 现场补拍本件实拍图</Lock>
          </div>

          <div class="slot-card">
            <div class="sh"><b>② 库位与附件袋同框图</b><span class="tag" :class="sku.locImgCount ? 'grn' : 'amb'">{{ sku.locImgCount ? `已存 ${sku.locImgCount} 张` : '缺库位图 · 已自动派单' }}</span></div>
            <div class="sbox">
              <img v-if="sku.locThumb" :src="sku.locThumb" alt="库位同框图" />
              <p v-else class="muted">空槽位：需拍清层板编码 {{ sku.location }} 与附件袋 {{ sku.bagCode }}</p>
            </div>
            <Lock :ok="!locked" reason="先去「学」完成 3 个练习" kind="" @go="captureSkuPhotoDirect(sku, 'loc')">+ 现场补拍库位同框照</Lock>
          </div>

          <div class="slot-card">
            <div class="sh"><b>③ 瑕疵特写证据（不自动进展示主图）</b><span class="tag">{{ sku.defectImgCount }} 张</span></div>
            <div class="sbox">
              <img :src="sampleDefect" alt="瑕疵披露留证" />
            </div>
            <p class="muted" style="font-size:12px">{{ sku.defectNote }}</p>
          </div>
        </div>
      </Fold>

      <!-- 折叠 2：屏幕类 10 秒录屏切片 -->
      <Fold v-if="sku.kind === 'monitor'" v-model="sliceOpen" title="显示器壁纸轮播 · 10秒实拍切片（多号不雷同）" help="media">
        <template #chips>
          <span class="chip grn">内置壁纸轮播 · 手机拍10秒</span>
          <span class="chip">分给 3 个闲鱼号仍共用本件库存</span>
        </template>
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
          <div>
            <b>多账号防铺货展示图切片工作台</b>
            <p class="muted" style="font-size:13px;margin-top:4px">壁纸展示图保留真实边框细节，仅用于各闲鱼店铺差异化配图，绝不代替纯色屏坏点验货证据。</p>
          </div>
          <button class="btn pri" @click="go('media', sku.code)">去切片台处理这台显示器 ›</button>
        </div>
      </Fold>

      <!-- 折叠 3：更多详情（库龄4周期、单号反查、流转记录） -->
      <Fold v-model="moreOpen" id="age" title="更多详情（库龄 4 周期 · 关联单号一键反查 · 流转日志）" help="p-more">
        <template #chips>
          <span class="chip" :class="age.lvl">库龄：{{ age.short }}</span>
          <span class="chip">附件袋：{{ sku.bagCode || '无' }}</span>
          <span class="chip">流转 {{ sku.history.length }} 条</span>
        </template>
        <div class="secs">
          <section class="card">
            <h3>库龄与 4 周期刻度 <small>7 天一个周期，满 28 天触发滞销预警</small></h3>
            <p style="font-size:24px;font-weight:800;margin-bottom:10px">{{ sku.ageDays }} 天 <span class="tag" :class="age.lvl">{{ age.long }}</span></p>
            <div class="cycles">
              <div v-for="n in 4" :key="n" class="cy" :class="n <= 2 ? 'grn' : 'amb'">
                <i :style="{ width: cyFill(n) + '%' }"></i>
                <span>第 {{ n }} 周期 <em>{{ (n - 1) * 7 }}–{{ n * 7 }}天</em></span>
              </div>
            </div>
            <p class="muted" style="font-size:12.5px;margin-top:10px">
              <i class="dot grn"></i> 0–14 天正常在售　<i class="dot amb"></i> 15–27 天清仓调价期　<i class="dot red"></i> ≥28 天滞销复盘（需主管授权清仓方案）
            </p>
          </section>

          <section class="card">
            <h3>全链路单号反查（一机一码贯通）</h3>
            <dl class="kv">
              <dt>唯一货号</dt><dd><code>{{ sku.code }}</code>（SN：{{ sku.sn }}）</dd>
              <dt>原采购单</dt><dd>{{ sku.purchaseOrder }}（原进价 ¥{{ sku.cost }} 只读不可篡改）</dd>
              <dt>入库验货单</dt><dd>{{ sku.inspectId }} <a @click="go('inspect')">查看验货标准记录 ›</a></dd>
              <dt>专用附件袋</dt><dd>{{ sku.bagCode || '无独立附件袋' }}</dd>
              <dt>独立原盒状态</dt><dd>{{ sku.boxStatus }} <a v-if="sku.boxCode" @click="go('aux')">去附属与原盒台账 ›</a></dd>
            </dl>
          </section>

          <section class="card wide">
            <h3>仓内全生命周期流转记录</h3>
            <ul class="tl">
              <li v-for="(line, idx) in sku.history" :key="idx">{{ line }}</li>
            </ul>
          </section>
        </div>
      </Fold>

      <!-- 底部核心：下一步（一步一步来，灰色的按钮会告诉你为什么） -->
      <section id="flow-panel" class="card flow-panel" data-tour="dt-flow">
        <div class="fp-head">
          <h3>下一步 <small>一步一步来，灰色的按钮会直接告诉你为什么不能点</small></h3>
          <span class="tag acc">当前分位：{{ sku.zone }}</span>
        </div>

        <!-- 场景 A：异常隔离待主管放行 -->
        <div v-if="sku.zone === '异常隔离（不可售）'" class="fp-body">
          <h4>这件货处于「异常隔离区」：采购议价减 ¥260 改留货待核验</h4>
          <p class="muted">解除异常隔离前，必须核清「撤回原退款、实物在仓、成本回写、披露同步销售」4 项防呆锁，并由仓管主管点放行。</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
            <button class="btn pri" @click="go('anomaly', relatedAnomaly?.id || '')">去「异常双轨」核对 4 项防呆锁 ›</button>
            <Lock
              :ok="isSupervisor && relatedAnomaly?.keepGoodsSwitch?.disclosureSynced && !locked"
              :reason="locked ? '先做完 3 个练习' : !relatedAnomaly?.keepGoodsSwitch?.disclosureSynced ? '第 4 项「最新瑕疵披露同步销售端」还没在异常双轨页勾选确认' : '只有「仓管主管」角色可点解除异常隔离（右上角可切换周卫东体验）'"
              @go="approveKeepGoodsBySupervisor(relatedAnomaly)"
            >主管一键解除隔离转可售</Lock>
          </div>
        </div>

        <!-- 场景 B：外修取回待专项复检 -->
        <div v-else-if="sku.zone === '待修/送修中'" class="fp-body">
          <h4>外修已取回仓内：必须完成受影响功能复检后才能恢复可售</h4>
          <p class="muted">{{ sku.repairNote || '外修费用已登记，请通电实测原故障部位并如实录入复检结果（严禁无依据直接改完好）。' }}</p>
          <label class="fp-field">
            本次修回受影响功能实测结论（必填）
            <input v-model="retestNote" placeholder="例如：连续通电烤机 40 分钟高压板无闪烁黑屏，HDMI/DP 全亮，外壳拆修细痕已拍微距" />
          </label>
          <Lock
            :ok="Boolean(retestNote.trim().length >= 6) && !locked"
            :reason="locked ? '先做完 3 个练习' : '还没填写修回受影响功能的复检实测结论（至少 6 个字），未复检严禁恢复可售！'"
            penalty="恢复可售后保留历史送修记录与 ¥65 维修成本，供销售重核披露与底价。"
            @go="doRetest"
          >确认修回复检通过 · 转入可售库区</Lock>
        </div>

        <!-- 场景 C：锁单待发 / 自提待交接 -->
        <div v-else-if="sku.zone === '锁单待发' || relatedOutbound" class="fp-body">
          <h4>这件货已被买家订单锁住：请前往「出库与退回」执行齐套扫码复核</h4>
          <p class="muted">
            {{ relatedOutbound ? `关联订单 ${relatedOutbound.orderNo}（${relatedOutbound.buyer}） · ${relatedOutbound.deadline}` : '关联同城自提预约单，请在1楼独立接待区出示实物由客户自验。' }}
          </p>
          <button class="btn pri" style="margin-top:8px" @click="go('outbound', relatedOutbound?.id || '')">去「出库与退回」处理这单 ›</button>
        </div>

        <!-- 场景 D：常规在库（缺图补拍 + 库位移位留痕） -->
        <div v-else class="fp-body">
          <h4>在库常规操作：补齐缺图 / 仓内库位移位留痕</h4>
          <div v-if="sku.realImgCount === 0 || sku.locImgCount === 0" class="why-box amb" style="margin-bottom:12px">
            当前缺图提醒：
            <b v-if="sku.realImgCount === 0">缺本件验货实拍图</b>
            <b v-if="sku.locImgCount === 0">{{ sku.realImgCount === 0 ? ' + ' : '' }}缺库位同框图</b>
            —— 可直接在上方「三种图」折叠栏点补拍，立刻消除红黄灯。
          </div>
          <div class="move-row">
            <label>新库位编码<input v-model="newLoc" placeholder="例如 A-07" /></label>
            <label>移位原因<input v-model="moveReason" placeholder="例如 同尺寸显示器归拢整理" /></label>
            <Lock
              :ok="Boolean(newLoc.trim()) && !locked"
              :reason="locked ? '先做完 3 个练习' : '先填写目标新库位编码，移位后系统会自动保留原库位并重生成库位图'"
              @go="doMove"
            >确认移位并留痕</Lock>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Fold from '../components/Fold.vue'
import Lock from '../components/Lock.vue'
import { makeDefectPhoto } from '../data/mediaSvg.js'
import {
  store,
  LV,
  ageOf,
  skuIssues,
  skuLevel,
  currentUser,
  isSupervisor,
  go,
  openHelp,
  captureSkuPhotoDirect,
  moveSkuLocation,
  completeSkuRepairRetest,
  approveKeepGoodsBySupervisor
} from '../store/warehouseStore.js'

const props = defineProps({ code: String })
const activeCode = computed(() => props.code || store.routeParam || '')

const sku = computed(() => store.data.skus.find(s => s.code === activeCode.value))
const issues = computed(() => skuIssues(sku.value))
const lvl = computed(() => skuLevel(sku.value))
const age = computed(() => ageOf(sku.value?.ageDays || 0))
const locked = computed(() => !currentUser.value.practiceDone)

const zoom = ref(false)
const curImg = ref(0)
const imgOpen = ref(false)
const sliceOpen = ref(false)
const moreOpen = ref(false)
const newLoc = ref('')
const moveReason = ref('仓内分位整理')
const retestNote = ref('')

watch(() => props.code, () => {
  curImg.value = 0
  imgOpen.value = sku.value ? (sku.value.realImgCount === 0 || sku.value.locImgCount === 0) : false
})

const sampleDefect = computed(() =>
  makeDefectPhoto({
    title: '本件细节披露存档',
    ts: '00:01:22',
    code: props.code || 'SKU',
    detail: sku.value?.defectNote || '无外观功能异常'
  })
)

const galleryImgs = computed(() => {
  if (!sku.value) return []
  const arr = []
  if (sku.value.realImgCount > 0 && sku.value.realThumb) arr.push({ kind: 'real', label: '本件实拍图', src: sku.value.realThumb })
  if (sku.value.locImgCount > 0 && sku.value.locThumb) arr.push({ kind: 'loc', label: `库位图 (${sku.value.location})`, src: sku.value.locThumb })
  if (sku.value.defectImgCount > 0) arr.push({ kind: 'defect', label: '瑕疵微距留证（不作主图）', src: sampleDefect.value })
  return arr
})

const relatedAnomaly = computed(() => store.data.anomalies.find(a => a.skuCode === props.code))
const relatedOutbound = computed(() => store.data.outbounds.find(o => o.skuCode === props.code && o.status !== 'SHIPPED'))

const cyFill = (n) => Math.max(0, Math.min(100, (((sku.value?.ageDays || 0) - (n - 1) * 7) / 7) * 100))

function jumpTo(id) {
  if (id === 'imgs') imgOpen.value = true
  if (id === 'age') moreOpen.value = true
  nextTick(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function goBack() {
  location.hash = store.lastGalleryHash && !store.lastGalleryHash.startsWith('#/item') ? store.lastGalleryHash : '#/gallery/all'
}

function doMove() {
  if (!sku.value) return
  moveSkuLocation(sku.value, newLoc.value, moveReason.value)
  newLoc.value = ''
}

function doRetest() {
  if (!sku.value) return
  completeSkuRepairRetest(sku.value, retestNote.value)
  retestNote.value = ''
}
</script>

<style scoped>
.img-slots { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.slot-card { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 13px; display: grid; gap: 10px; align-content: start; }
.sh { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13.5px; }
.sbox {
  aspect-ratio: 16 / 10;
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
  border: 1px dashed var(--line);
  display: grid;
  place-items: center;
  padding: 6px;
  text-align: center;
}
.sbox img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }

.cycles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.cy { position: relative; height: 34px; border-radius: 7px; background: var(--panel); border: 1px solid var(--line); overflow: hidden; display: flex; align-items: center; padding: 0 10px; }
.cy i { position: absolute; left: 0; top: 0; bottom: 0; opacity: .22; }
.cy.grn i { background: var(--grn); }
.cy.amb i { background: var(--amb); }
.cy span { position: relative; font-size: 12px; font-weight: 650; display: flex; justify-content: space-between; width: 100%; }
.cy em { font-style: normal; color: var(--mute); font-weight: 450; }

.tl { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 13.5px; color: var(--ink2); }

.flow-panel { margin-top: 18px; border-top: 3px solid var(--acc); }
.fp-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.fp-head h3 { margin: 0; font-size: 18px; }
.fp-head h3 small { color: var(--mute); font-size: 13px; font-weight: 450; margin-left: 6px; }
.fp-body h4 { font-size: 15.5px; margin-bottom: 5px; }
.fp-field { display: grid; gap: 6px; margin: 12px 0; font-size: 13px; font-weight: 600; max-width: 680px; }
.fp-field input { padding: 8px 11px; border: 1px solid var(--line); border-radius: 7px; }
.move-row { display: grid; grid-template-columns: 180px 280px auto; gap: 10px; align-items: start; }
.move-row label { display: grid; gap: 5px; font-size: 12.5px; color: var(--mute); font-weight: 600; }
.move-row input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; }
</style>
