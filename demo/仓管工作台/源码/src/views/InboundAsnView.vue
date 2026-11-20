<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常标准化 WMS · 采购在途签收 → 验货 → SPU防混赋码 → 智能库位上架</div>
        <h1>到货签收与上架<Q k="asn" /></h1>
        <p class="sub">
          承接上游采购在途单（<code>PO-...</code>）：门口扫码核验<b>顺丰收件手机后 4 位</b>签收、登记卖家漏填单号无主快件、按<b>标准 SPU 商品库防混匹配</b>打印一物一码机身贴纸，并双扫码绑定具体 WMS 格口上架入账。
        </p>
      </div>
      <div class="acts">
        <span class="tag amb">演示 · 热敏条码与 UHF 写签为本机模拟</span>
        <button class="btn" :disabled="locked" @click="unclaimedOpen = true">
          <Icon name="inbound" />登记无主/漏填单号包裹
        </button>
        <button class="btn" @click="openHelp('asn')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 四步标准入库流程进度条 -->
    <ol class="clean-steps" aria-label="标准入库上架四步流程">
      <li :class="curStage >= 1 ? (curStage > 1 ? 'passed' : 'current') : ''">
        <span>1</span><div><b>门口扫码签收</b><p>核手机尾号暂存 C 区</p></div>
      </li>
      <li :class="curStage >= 2 ? (curStage > 2 ? 'passed' : 'current') : ''">
        <span>2</span><div><b>拆封全检联动</b><p>高拍仪录像逐项实测</p></div>
      </li>
      <li :class="curStage >= 3 ? (curStage > 3 ? 'passed' : 'current') : ''">
        <span>3</span><div><b>SPU匹配与赋码</b><p>防近似款混绑 · 打机身标</p></div>
      </li>
      <li :class="curStage >= 4 ? (selAsn?.status === 'PUTAWAY_DONE' ? 'passed' : 'current') : ''">
        <span>4</span><div><b>双扫码上架入位</b><p>扫商品码 + 扫货架库位码</p></div>
      </li>
    </ol>

    <div class="cols-split">
      <!-- 左侧：采购在途与到货包裹队列 -->
      <div class="asn-list">
        <div class="seg" style="width:100%;margin-bottom:10px">
          <button :class="{ on: flt === 'ALL' }" @click="flt = 'ALL'">全部<em>{{ store.data.inboundAsns.length }}</em></button>
          <button :class="{ on: flt === 'WAIT_SIGN' }" @click="flt = 'WAIT_SIGN'"><i class="dot amb"></i>待签收<em>{{ waitSignCount }}</em></button>
          <button :class="{ on: flt === 'WAIT_PUT' }" @click="flt = 'WAIT_PUT'"><i class="dot red"></i>待赋码上架<em>{{ waitPutCount }}</em></button>
          <button :class="{ on: flt === 'HOLD' }" @click="flt = 'HOLD'">无主/待检</button>
        </div>

        <article
          v-for="a in filteredAsns"
          :key="a.id"
          class="asn-card"
          :class="[asnCls(a), { sel: selAsn?.id === a.id }]"
          @click="pickAsn(a)"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
            <span class="tag" :class="asnBadge(a).cls">{{ asnBadge(a).text }}</span>
            <span class="mono muted" style="font-size:12px">{{ a.trackingNo }}</span>
          </div>
          <h3 style="font-size:14.5px;margin-top:6px">{{ a.declaredBrand }} {{ a.declaredModel }}</h3>
          <p class="muted" style="font-size:12px;margin-top:3px">
            {{ a.poNo }} · {{ a.carrier }}（尾号 {{ a.phoneSuffix }}）· 采购 {{ a.purchaser }}
          </p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px">
            <span v-if="a.skuCode" class="tag dark">#{{ a.skuCode }}</span>
            <span v-if="a.spuCode" class="tag">{{ a.spuCode }}</span>
            <span v-if="a.putawayBin" class="tag grn">已入 {{ a.putawayBin }}</span>
            <span v-else-if="a.recommendedBin" class="tag acc">推荐库位 {{ a.recommendedBin }}</span>
          </div>
        </article>
      </div>

      <!-- 右侧：当前选中包裹四步操作工作台 -->
      <section v-if="selAsn" class="card asn-work">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span class="badge-l" :class="asnBadge(selAsn).lvl">{{ asnBadge(selAsn).text }}</span>
              <span class="tag">{{ selAsn.poNo }}</span>
              <span class="tag mono">运单 {{ selAsn.trackingNo }}</span>
              <span v-if="selAsn.skuCode" class="tag dark">一物一码 #{{ selAsn.skuCode }}</span>
            </div>
            <h2 style="font-size:21px;margin:8px 0 4px">{{ selAsn.declaredBrand }} · {{ selAsn.declaredModel }}</h2>
            <p class="muted" style="font-size:13px">
              卖家申报：{{ selAsn.declaredSpec }} · 采购进价：<b>¥{{ selAsn.declaredPrice }}</b>（{{ selAsn.purchaser }}）
            </p>
          </div>
        </div>

        <!-- 特殊分支：无主快件认领面板 -->
        <div v-if="selAsn.status === 'UNCLAIMED_HOLD'" class="step-box warn" style="margin-top:14px">
          <h4>无主包裹异常暂存（库位 C-03 · 未关联采购单严禁无录像私拆）</h4>
          <p class="muted" style="font-size:13px">{{ selAsn.declaredSpec }} · {{ selAsn.sellerNick }}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1.4fr 0.8fr;gap:8px;margin-top:8px">
            <input v-model="claimForm.poNo" class="inp" placeholder="补绑采购单号 PO-20261114-22" />
            <input v-model="claimForm.declaredBrand" class="inp" placeholder="品牌 如 HKC" />
            <input v-model="claimForm.declaredModel" class="inp" placeholder="申报型号 如 G24H2 24寸180Hz" />
            <input v-model="claimForm.declaredPrice" type="number" class="inp" placeholder="进价" />
          </div>
          <Lock
            :ok="Boolean(claimForm.poNo.trim() && claimForm.declaredBrand.trim() && claimForm.declaredModel.trim()) && !locked"
            reason="请由采购核实卖家后填写采购单号、品牌与型号完成认领"
            kind="pri"
            @go="claimUnclaimedParcel(selAsn, claimForm)"
          >确认采购认领 · 转标准签收待检</Lock>
        </div>

        <div v-else class="stage-grid">
          <!-- 第 1 步：门口扫码签收 -->
          <div class="step-box" :class="{ done: selAsn.status !== 'IN_TRANSIT' }">
            <div class="sb-head">
              <b>第 1 步 · 快递面单核验签收</b>
              <span v-if="selAsn.status !== 'IN_TRANSIT'" class="tag grn">✓ {{ selAsn.signedAt }} 已签收入 {{ selAsn.stagingBin }}</span>
            </div>
            <template v-if="selAsn.status === 'IN_TRANSIT'">
              <p class="muted" style="font-size:12.5px">
                承运商：<b>{{ selAsn.carrier }}</b> · 请核对面单收件人手机后 4 位（采购登记尾号：<b>{{ selAsn.phoneSuffix }}</b>）防止错签隔壁档口快件。
              </p>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <input v-model="signForm.inputSuffix" class="inp" style="width:170px" placeholder="输收件手机后4位" />
                <button class="btn sm" @click="signForm.inputSuffix = selAsn.phoneSuffix">填入正确尾号 {{ selAsn.phoneSuffix }}</button>
                <input v-model="signForm.cartonNote" class="inp" style="flex:1;min-width:180px" placeholder="外箱封口状况（如 顺丰封箱完好）" />
              </div>
              <Lock
                :ok="(!selAsn.carrier.includes('顺丰') || signForm.inputSuffix.trim() === selAsn.phoneSuffix) && !locked"
                :reason="locked ? '先完成练习' : `顺丰快件防错签：请输入采购单登记的收件手机后 4 位「${selAsn.phoneSuffix}」核验一致后再签收`"
                kind="pri"
                @go="signInboundAsn(selAsn, signForm)"
              >扫码签收包裹 · 暂存入 {{ selAsn.stagingBin }}</Lock>
            </template>
            <p v-else class="muted" style="font-size:12.5px">外箱状态：{{ selAsn.outerCartonStatus }} · 暂存格：{{ selAsn.stagingBin }}</p>
          </div>

          <!-- 第 2 步：拆封全检联动 -->
          <div class="step-box" :class="{ done: selAsn.status === 'INSPECTED_WAIT_PUTAWAY' || selAsn.status === 'PUTAWAY_DONE' }">
            <div class="sb-head">
              <b>第 2 步 · 高拍仪拆封录像与全量验货</b>
              <span v-if="selAsn.status === 'INSPECTED_WAIT_PUTAWAY' || selAsn.status === 'PUTAWAY_DONE'" class="tag grn">✓ 全检已通过</span>
              <span v-else-if="selAsn.status === 'SIGNED_IN_INSPECT'" class="tag amb">待完成验货</span>
            </div>
            <p style="font-size:13px">{{ selAsn.inspectSummary }}</p>
            <div v-if="selAsn.status === 'SIGNED_IN_INSPECT'" style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn sm pri" @click="go('inspect', selAsn.inspectId)">去收货验货台逐项全检 ({{ selAsn.inspectId }}) ›</button>
              <button
                v-if="!selAsn.inspectSummary.includes('碎裂')"
                class="btn sm"
                :disabled="locked"
                @click="fastPassAsnInspectionForDemo(selAsn)"
              >演示：同步验货台全项 PASS 结论</button>
            </div>
          </div>

          <!-- 第 3 步：演示员工甲 SPU 标准型号匹配防呆 + 一物一码贴纸打印 -->
          <div class="step-box" :class="{ done: Boolean(selAsn.spuCode && selAsn.labelPrinted) }">
            <div class="sb-head">
              <b>第 3 步 · SPU 标准商品库防混匹配与一物一码打标</b>
              <span v-if="selAsn.spuCode && selAsn.labelPrinted" class="tag grn">✓ 已绑 {{ selAsn.spuCode }} 并出标</span>
            </div>
            <div style="display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,.9fr) minmax(0,.9fr);gap:8px">
              <label style="font-size:12.5px;font-weight:600;display:grid;gap:4px;min-width:0">
                选择标准 SPU 型号（核对尾缀/容量/刷新率）
                <select v-model="spuForm.spuCode" class="inp" style="width:100%;min-width:0" :disabled="selAsn.status === 'PUTAWAY_DONE'">
                  <option value="">-- 请选择标准 SPU 编码 --</option>
                  <option v-for="sp in store.data.spuCatalog" :key="sp.spuCode" :value="sp.spuCode">
                    {{ sp.brand }} · {{ sp.model }}（{{ sp.spec.slice(0, 18) }}）
                  </option>
                </select>
              </label>
              <label style="font-size:12.5px;font-weight:600;display:grid;gap:4px;min-width:0">
                评定成色档位
                <select v-model="spuForm.conditionGrade" class="inp" style="width:100%;min-width:0" :disabled="selAsn.status === 'PUTAWAY_DONE'">
                  <option value="99新·充新">99新·充新</option>
                  <option value="98新·准新">98新·准新</option>
                  <option value="98新·全检完美">98新·全检完美</option>
                  <option value="95新·全原无修">95新·全原无修</option>
                  <option value="9成新·轻微使用痕">9成新·轻微使用痕</option>
                </select>
              </label>
              <label style="font-size:12.5px;font-weight:600;display:grid;gap:4px;min-width:0">
                专用编号附件袋号
                <input v-model="spuForm.bagCode" class="inp" style="width:100%;min-width:0" placeholder="如 BAG-A06-01" :disabled="selAsn.status === 'PUTAWAY_DONE'" />
              </label>
            </div>

            <!-- 近似型号防混绑黄框警示 -->
            <div v-if="pickedSpuObj" class="why-box amb">
              <b>SPU 匹配防呆核对：</b><code>{{ pickedSpuObj.spuCode }}</code> · {{ pickedSpuObj.spec }}<br />
              <span>⚠ {{ pickedSpuObj.confuseWarn }}</span>
            </div>

            <!-- 一物一码机身贴纸预览 + 打印按钮 -->
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <div v-if="selAsn.skuCode" class="sku-sticker">
                <div style="font-size:11px;color:var(--mute);font-weight:700">泛亚一物一码机身贴 · UHF抗金属签</div>
                <div class="mono" style="font-size:16px;font-weight:800">#{{ selAsn.skuCode }}</div>
                <div style="font-size:11.5px">{{ spuForm.spuCode || selAsn.spuCode || '待绑SPU' }} · {{ spuForm.conditionGrade }}</div>
              </div>
              <Lock
                v-if="selAsn.status !== 'PUTAWAY_DONE'"
                :ok="Boolean(spuForm.spuCode) && selAsn.status !== 'IN_TRANSIT' && !locked"
                :reason="locked ? '先完成练习' : selAsn.status === 'IN_TRANSIT' ? '请先完成第 1 步包裹扫码签收' : '请从下拉列表选择精确匹配的 SPU 标准编码'"
                kind="sm pri"
                @go="doBindSpu"
              >
                <Icon name="printer" />校验 SPU 防呆并打印一物一码标
              </Lock>
            </div>
          </div>

          <!-- 第 4 步：智能推荐库位与双扫码上架 -->
          <div class="step-box" :class="{ done: selAsn.status === 'PUTAWAY_DONE' }">
            <div class="sb-head">
              <b>第 4 步 · 智能推荐空库位与双扫码上架入账</b>
              <span v-if="selAsn.status === 'PUTAWAY_DONE'" class="tag grn">✓ 已上架至库位 {{ selAsn.putawayBin }}</span>
            </div>

            <template v-if="selAsn.status !== 'PUTAWAY_DONE'">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px">
                <span class="muted">系统按品类与库容智能推荐空闲可售位：</span>
                <button
                  v-for="rb in recommendedBins"
                  :key="rb.code"
                  class="btn sm"
                  :class="{ pri: putForm.scannedBin === rb.code }"
                  @click="putForm.scannedBin = rb.code"
                >
                  {{ rb.code }}（已占 {{ occupiedSkusOfBin(rb.code).length }}/{{ rb.capacity }}）
                </button>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center">
                <input v-model="putForm.scannedSku" class="inp mono" placeholder="1. 扫描机身一物一码贴纸" />
                <input v-model="putForm.scannedBin" class="inp mono" placeholder="2. 扫描货架横梁库位码 (如 A-06)" />
                <button class="btn sm" @click="fillPutawayScan">模拟双扫码一致</button>
              </div>

              <Lock
                :ok="putawayCheck.ok"
                :reason="putawayCheck.why"
                kind="ok"
                @go="completeAsnPutaway(selAsn, putForm)"
              >确认绑定库位 · 完成标准上架入总账</Lock>
            </template>

            <div v-else class="why-box grn">
              ✓ 单件 <b>#{{ selAsn.skuCode }}</b>（<code>{{ selAsn.spuCode }}</code>）已正式上架至 <b>{{ selAsn.putawayBin }}</b>，可前往「WMS 库位管理」或「库存总账与流水」实时查看。
              <div style="margin-top:8px;display:flex;gap:8px">
                <button class="btn sm" @click="go('locations')">去库位矩阵查看 ›</button>
                <button class="btn sm" @click="go('ledger')">去库存总账核对流水 ›</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 登记无主包裹弹窗 -->
    <div v-if="unclaimedOpen" class="mask" @click.self="unclaimedOpen = false">
      <div class="modal" role="dialog" aria-label="登记无主异常包裹">
        <h3>登记无主 / 卖家漏填单号快件</h3>
        <p class="muted" style="font-size:13px">
          门口收到快递但 ERP 采购在途单搜不到该运单号时，先登记入 <b>C-03 无主待认领专格</b>，推送采购群认领后再拆封录像，严禁乱堆或无单私拆。
        </p>
        <label>快递运单号<input v-model="uncForm.trackingNo" placeholder="如 DEMO-SF-020" /></label>
        <label>承运快递<input v-model="uncForm.carrier" placeholder="顺丰速运 / 京东 / 圆通" /></label>
        <label>面单寄件人线索（省市/姓氏/尾号）<input v-model="uncForm.senderHint" placeholder="如 江苏苏州 李* 尾号3309" /></label>
        <label>外包装状态备注<input v-model="uncForm.cartonNote" placeholder="如 27寸显示器黄纸箱封口完好" /></label>
        <div class="mfoot">
          <button class="btn" @click="unclaimedOpen = false">取消</button>
          <button class="btn pri" @click="submitUnclaimed">贴黄牌入 C-03 并推采购认领</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  go,
  openHelp,
  occupiedSkusOfBin,
  signInboundAsn,
  fastPassAsnInspectionForDemo,
  registerUnclaimedParcel,
  claimUnclaimedParcel,
  bindAsnSpuAndPrintTag,
  completeAsnPutaway
} from '../store/warehouseStore.js'

const flt = ref('ALL')
const selectedAsnId = ref(store.routeParam?.startsWith('ADEMO-SN-017') ? store.routeParam : 'ADEMO-SN-017261114-02')
const unclaimedOpen = ref(false)
const locked = computed(() => !currentUser.value.practiceDone)

const waitSignCount = computed(() => (store.data.inboundAsns || []).filter(a => a.status === 'IN_TRANSIT').length)
const waitPutCount = computed(() => (store.data.inboundAsns || []).filter(a => a.status === 'INSPECTED_WAIT_PUTAWAY').length)

const filteredAsns = computed(() =>
  (store.data.inboundAsns || []).filter(a => {
    if (flt.value === 'WAIT_SIGN') return a.status === 'IN_TRANSIT'
    if (flt.value === 'WAIT_PUT') return a.status === 'INSPECTED_WAIT_PUTAWAY'
    if (flt.value === 'HOLD') return a.status === 'UNCLAIMED_HOLD' || a.status === 'SIGNED_IN_INSPECT'
    return true
  })
)

const selAsn = computed(() =>
  (store.data.inboundAsns || []).find(a => a.id === selectedAsnId.value) || filteredAsns.value[0] || store.data.inboundAsns[0]
)

const curStage = computed(() => {
  const a = selAsn.value
  if (!a || a.status === 'IN_TRANSIT' || a.status === 'UNCLAIMED_HOLD') return 1
  if (a.status === 'SIGNED_IN_INSPECT') return 2
  if (a.status === 'INSPECTED_WAIT_PUTAWAY' && (!a.spuCode || !a.labelPrinted)) return 3
  return 4
})

const signForm = reactive({ inputSuffix: '8836', cartonNote: '外箱封口完好' })
const spuForm = reactive({ spuCode: '', conditionGrade: '98新·准新', bagCode: '' })
const putForm = reactive({ scannedSku: '', scannedBin: '' })
const claimForm = reactive({ poNo: 'PO-20261114-22', purchaser: '张敏（采购一组）', declaredBrand: 'AOC', declaredModel: '24G10ZNE 24寸显示器', declaredPrice: 515 })
const uncForm = reactive({ trackingNo: 'DEMO-SF-020', carrier: '顺丰速运', senderHint: '浙江宁波 陈* 尾号1092', cartonNote: '原装纸箱完好' })

function syncForms(a) {
  if (!a) return
  signForm.inputSuffix = a.phoneSuffix || ''
  signForm.cartonNote = a.outerCartonStatus || '外箱完好'
  spuForm.spuCode = a.spuCode || ''
  spuForm.conditionGrade = a.conditionGrade || '98新·准新'
  spuForm.bagCode = a.bagCode || ''
  putForm.scannedSku = a.skuCode || ''
  putForm.scannedBin = a.recommendedBin || 'A-01'
}

watch(selAsn, (a) => syncForms(a), { immediate: true })

function pickAsn(a) {
  selectedAsnId.value = a.id
  syncForms(a)
}

const pickedSpuObj = computed(() =>
  (store.data.spuCatalog || []).find(s => s.spuCode === spuForm.spuCode)
)

const recommendedBins = computed(() =>
  (store.data.locations || []).filter(l =>
    l.enabled && l.binType === 'SALEABLE' && occupiedSkusOfBin(l.code).length < l.capacity
  ).slice(0, 5)
)

function doBindSpu() {
  bindAsnSpuAndPrintTag(selAsn.value, spuForm)
  putForm.scannedSku = selAsn.value.skuCode
}

function fillPutawayScan() {
  if (!selAsn.value) return
  putForm.scannedSku = selAsn.value.skuCode
  putForm.scannedBin = selAsn.value.recommendedBin || recommendedBins.value[0]?.code || 'A-01'
}

const putawayCheck = computed(() => {
  const a = selAsn.value
  if (!a) return { ok: false, why: '未选择到货单' }
  if (locked.value) return { ok: false, why: '先完成首日 3 个练习' }
  if (a.status === 'IN_TRANSIT') return { ok: false, why: '请先完成第 1 步包裹扫码签收' }
  if (a.status !== 'INSPECTED_WAIT_PUTAWAY') {
    return { ok: false, why: '步进式防呆拦截：该件尚未完成高拍仪全检（或检出碎屏异常未闭环），严禁跳过验货直接上架可售货架！' }
  }
  if (!a.spuCode || !a.labelPrinted) {
    return { ok: false, why: '请先完成第 3 步「校验 SPU 标准型号并打印一物一码标」' }
  }
  if (putForm.scannedSku.trim() !== a.skuCode) {
    return { ok: false, why: `请扫描或核对机身一物一码贴纸「${a.skuCode}」` }
  }
  if (!putForm.scannedBin.trim()) {
    return { ok: false, why: '请扫描或点选目标货架库位编码' }
  }
  return { ok: true, why: '' }
})

function asnBadge(a) {
  switch (a.status) {
    case 'IN_TRANSIT': return { cls: 'amb', lvl: 'amb', text: '! 门口到件待签收' }
    case 'SIGNED_IN_INSPECT': return { cls: 'red', lvl: 'red', text: '✕ 已签收 · 待全检' }
    case 'INSPECTED_WAIT_PUTAWAY': return { cls: 'red', lvl: 'red', text: '✕ 过检待赋码上架' }
    case 'PUTAWAY_DONE': return { cls: 'grn', lvl: 'grn', text: '✓ 已扫码上架入账' }
    default: return { cls: 'amb', lvl: 'amb', text: '! C-03 无主待认领' }
  }
}

function asnCls(a) {
  if (a.status === 'PUTAWAY_DONE') return 'grn'
  if (a.status === 'INSPECTED_WAIT_PUTAWAY' || a.status === 'SIGNED_IN_INSPECT') return 'red'
  return 'amb'
}

function submitUnclaimed() {
  if (registerUnclaimedParcel(uncForm)) {
    unclaimedOpen.value = false
    selectedAsnId.value = store.data.inboundAsns[0].id
  }
}
</script>

<style scoped>
.asn-list { display: grid; gap: 10px; align-content: start; min-width: 0; }
.asn-work { min-width: 0; }
.asn-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 4px solid var(--amb);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
}
.asn-card.red { border-left-color: var(--red); }
.asn-card.grn { border-left-color: var(--grn); }
.asn-card.sel { box-shadow: 0 0 0 2px var(--acc); background: #fafcff; }

.stage-grid { display: grid; gap: 12px; margin-top: 14px; }
.step-box {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 13px 15px;
  display: grid;
  gap: 9px;
}
.step-box.done { background: #f7fcf9; border-color: #bfead3; }
.step-box.warn { background: var(--amb-soft); border-color: #f5d8bc; }
.sb-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }

.sku-sticker {
  padding: 8px 12px;
  border: 1px dashed #94a3b8;
  border-radius: 7px;
  background: #fff;
}
</style>
