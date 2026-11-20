<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常标准化 WMS · WH01 深圳龙华主仓四级储位体系</div>
        <h1>WMS 库位管理<Q k="locations" /></h1>
        <p class="sub">
          按<b>「仓库 → 6 大标准库区（A~F） → 排架 → 层格位」</b>可视化管控每一格容量、在库单件、条码标签与扫码移库；执行<b>带货禁停防呆</b>与<b>隔离件禁入可售架硬拦截</b>。
        </p>
      </div>
      <div class="acts">
        <button class="btn pri" :disabled="locked" @click="createModal = true">
          <Icon name="pin" />+ 新建 / 批量生成货架库位
        </button>
        <button class="btn" @click="openHelp('locations')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 1. 六大标准库区容量与占用汇总卡片 -->
    <section class="zone-strip" aria-label="六大库区概览">
      <button
        v-for="z in zoneCards"
        :key="z.zone"
        class="zone-card"
        :class="{ on: zoneFlt === z.zone }"
        @click="zoneFlt = zoneFlt === z.zone ? 'ALL' : z.zone"
      >
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>{{ z.zone }} · {{ z.shortName }}</b>
          <span class="tag" :class="z.zone === 'D区' ? 'red' : 'acc'">{{ z.binCount }} 格</span>
        </div>
        <div class="bar" style="margin:8px 0 6px;height:7px">
          <i :style="{ width: z.pct + '%', background: z.zone === 'D区' ? 'var(--red)' : 'var(--acc)' }"></i>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px" class="muted">
          <span>在库 <b>{{ z.used }}</b> / 容量 {{ z.cap }}</span>
          <span>空余 {{ Math.max(0, z.cap - z.used) }} 位</span>
        </div>
      </button>
    </section>

    <!-- 2. 一机多码 LPN 配件分格周转箱 + 库内 WIP 工位暂借挂名台（货动码必动，消灭三岗拆分找货扯皮） -->
    <section class="lpn-wip-grid">
      <div class="card" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <b>📦 一机多码 · 容器分格周转箱 LPN（存 #BAG 附件袋副码）</b>
          <span class="tag acc">主机放层架 · 电源配件入分格箱</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div v-for="c in store.data.containerLpns" :key="c.lpnCode" class="lpn-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b class="mono">{{ c.lpnCode }}</b>
              <span class="tag">母储位 {{ c.parentBin }} · {{ c.items.length }}/{{ c.capacity }}</span>
            </div>
            <p class="muted" style="font-size:11.5px;margin:3px 0 6px">{{ c.name }}</p>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <span v-for="sub in c.items.slice(0, 4)" :key="sub" class="tag mono" style="font-size:11px">{{ sub }}</span>
              <span v-if="c.items.length > 4" class="muted" style="font-size:11px">+{{ c.items.length - 4 }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="padding:14px 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <b>⚙ 库内 WIP 工位借出 / 暂离挂名（货动码必动 · 在借 {{ activeBorrows.length }} 台）</b>
          <button class="btn sm pri" :disabled="locked" @click="wipModal = true">+ 扫码借出至拍照/复测工位</button>
        </div>
        <div v-if="activeBorrows.length" style="display:grid;gap:7px">
          <div v-for="brw in activeBorrows" :key="brw.id" class="wip-row">
            <div>
              <b class="mono">#{{ brw.skuCode }}</b> · {{ brw.model }}
              <div class="muted" style="font-size:12px">
                原储位 <b>{{ brw.fromBin }}</b> → 暂借至 <code>{{ brw.wipCode }}</code> · 借用人：<b>{{ brw.borrower }}</b>（{{ brw.borrowedAt }} · {{ brw.purpose }}）
              </div>
            </div>
            <button class="btn sm ok" :disabled="locked" @click="returnSkuFromWip(brw, brw.fromBin)">
              🔫 扫码归架回 {{ brw.fromBin }}
            </button>
          </div>
        </div>
        <p v-else class="muted" style="font-size:12.5px">当前无工位暂借在外商品，全部实物均在货架原位。</p>
      </div>
    </section>

    <!-- 3. 筛选栏 -->
    <div class="bar-row">
      <div class="seg">
        <button :class="{ on: stateFlt === 'ALL' }" @click="stateFlt = 'ALL'">全部库位<em>{{ store.data.locations.length }}</em></button>
        <button :class="{ on: stateFlt === 'EMPTY' }" @click="stateFlt = 'EMPTY'">空闲可上架<em>{{ emptyBinCount }}</em></button>
        <button :class="{ on: stateFlt === 'OCCUPIED' }" @click="stateFlt = 'OCCUPIED'">有货在位<em>{{ occupiedBinCount }}</em></button>
        <button :class="{ on: stateFlt === 'LOCKED' }" @click="stateFlt = 'LOCKED'"><i class="dot amb"></i>含锁单待拣<em>{{ lockedBinCount }}</em></button>
        <button :class="{ on: stateFlt === 'QUARANTINE' }" @click="stateFlt = 'QUARANTINE'"><i class="dot red"></i>D区隔离锁柜<em>{{ quarantineBinCount }}</em></button>
        <button :class="{ on: stateFlt === 'DISABLED' }" @click="stateFlt = 'DISABLED'">停用维护<em>{{ disabledBinCount }}</em></button>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button v-if="zoneFlt !== 'ALL'" class="btn sm" @click="zoneFlt = 'ALL'">显示全部库区</button>
        <input v-model="kw" class="inp" style="width:240px" placeholder="搜库位号 (如 A-05) 或货号…" />
      </div>
    </div>

    <!-- 3. 左：可视化货架格口矩阵  右：选中库位工作台（条码打印 / 扫码移库 / 启停防呆） -->
    <div class="loc-layout">
      <div class="bin-matrix">
        <article
          v-for="b in filteredBins"
          :key="b.code"
          class="bin-cell"
          :class="[binVisualCls(b), { sel: curBin?.code === b.code }]"
          @click="selectBin(b.code)"
        >
          <div class="bc-top">
            <b class="mono" style="font-size:15.5px">{{ b.code }}</b>
            <span class="tag" :class="binBadge(b).cls">{{ binBadge(b).text }}</span>
          </div>
          <div class="muted" style="font-size:11.5px;margin-top:2px">
            {{ b.zone }} · {{ b.rack }} {{ b.level }} · 容量 {{ binSkus(b.code).length }}/{{ b.capacity }}
          </div>
          <div class="bar" style="height:6px;margin:7px 0">
            <i :style="{ width: Math.min(100, (binSkus(b.code).length / b.capacity) * 100) + '%', background: binBarColor(b) }"></i>
          </div>

          <div v-if="binSkus(b.code).length" class="bc-skus">
            <div v-for="s in binSkus(b.code)" :key="s.code" class="mini-sku">
              <span class="mono">#{{ s.code }}</span>
              <span v-if="activeWipBorrowOfSku(s.code)" class="tag amb" style="font-size:10.5px;min-height:18px;padding:0 5px">
                ⇄ 暂借 {{ activeWipBorrowOfSku(s.code).wipCode }}
              </span>
              <span v-else class="muted">{{ s.brand }} {{ s.model.slice(0, 12) }}</span>
            </div>
          </div>
          <div v-else-if="binAux(b.code).length" class="bc-skus">
            <div v-for="ax in binAux(b.code)" :key="ax.id" class="mini-sku">
              <span class="mono">{{ ax.id }}</span>
              <span class="muted">×{{ ax.qty }}</span>
            </div>
          </div>
          <p v-else class="muted" style="font-size:12px;margin-top:4px">{{ b.note }}</p>
        </article>
      </div>

      <!-- 右侧：库位详情、库位标贴打印、扫码移库调拨与启停防呆 -->
      <aside v-if="curBin" class="card bin-inspector">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <span class="tag dark">{{ curBin.warehouse }}</span>
            <h2 class="mono" style="font-size:24px;margin-top:6px">库位 {{ curBin.code }}</h2>
            <p class="muted" style="font-size:13px">{{ curBin.zoneName }} · {{ curBin.rack }} {{ curBin.level }}</p>
          </div>
          <span class="tag" :class="binBadge(curBin).cls">{{ binBadge(curBin).text }}</span>
        </div>

        <dl class="kv" style="margin:12px 0;padding:10px 12px;background:var(--soft);border-radius:8px">
          <dt>储位属性</dt><dd><b>{{ binTypeLabel(curBin.binType) }}</b></dd>
          <dt>格口容量</dt><dd>已占 <b>{{ curBinSkus.length }}</b> 件 / 上限 <b>{{ curBin.capacity }}</b> 件</dd>
          <dt>作业说明</dt><dd>{{ curBin.note }}</dd>
        </dl>

        <!-- 货架横梁条码贴预览 -->
        <div class="barcode-box">
          <div>
            <div style="font-size:11px;color:var(--mute);font-weight:700">PANASIA WMS · 货架层格条码签</div>
            <div class="mono" style="font-size:18px;font-weight:800;letter-spacing:1px">LOC-{{ curBin.code }}</div>
            <svg viewBox="0 0 210 34" width="190" height="32" aria-hidden="true" style="margin-top:3px">
              <rect v-for="(w, idx) in barcodeBars(curBin.code)" :key="idx" :x="idx * 6" y="2" :width="w" height="28" fill="#17233b" />
            </svg>
          </div>
          <button class="btn sm" @click="notify(`已发送库位条码 LOC-${curBin.code} 至热敏标签机（演示）`, 'ok')">
            <Icon name="printer" />打印库位标
          </button>
        </div>

        <!-- 当前存放实物列表 -->
        <h4 style="font-size:14px;margin:14px 0 8px">当前格口存放实物（{{ curBinSkus.length }} 件）</h4>
        <div v-if="curBinSkus.length" style="display:grid;gap:8px">
          <div v-for="s in curBinSkus" :key="s.code" class="in-sku-row">
            <div>
              <a @click="openItemDetail(s.code)"><b class="mono">#{{ s.code }}</b></a>
              <span class="tag" style="margin-left:6px">{{ s.zone }}</span>
              <div style="font-size:12.5px;margin-top:2px">{{ s.brand }} {{ s.model }}</div>
              <div class="muted" style="font-size:11.5px">附件袋：{{ s.bagCode }} · 库龄 {{ s.ageDays }} 天</div>
            </div>
            <button class="btn sm" @click="prefillTransfer(s.code)">移出 ›</button>
          </div>
        </div>
        <p v-else class="muted" style="font-size:13px;padding:8px 0">该格口当前没有一物一码主机实物，处于空闲可上架状态。</p>

        <!-- 日常扫码移库调拨台 -->
        <div class="transfer-box">
          <h4><Icon name="transfer" style="width:16px;height:16px;vertical-align:-3px" /> 扫码移库 / 并库位调拨</h4>
          <label>
            选择要移库的在库单件
            <select v-model="mvForm.skuCode" class="inp">
              <option value="">-- 扫描或选择单件货号 --</option>
              <option v-for="s in allInStockSkus" :key="s.code" :value="s.code">
                #{{ s.code }}（现居 {{ s.location }} · {{ s.brand }} {{ s.model.slice(0, 14) }} · {{ s.zone }}）
              </option>
            </select>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <label>
              目标新库位
              <select v-model="mvForm.toBinCode" class="inp">
                <option v-for="l in store.data.locations" :key="l.code" :value="l.code">
                  {{ l.code }}（{{ binSkus(l.code).length }}/{{ l.capacity }}{{ !l.enabled ? ' · 停用' : '' }}）
                </option>
              </select>
            </label>
            <label>
              移库原因
              <input v-model="mvForm.reason" class="inp" placeholder="如 理货并位 / 拣货前移" />
            </label>
          </div>
          <Lock
            :ok="transferValidation.ok"
            :reason="transferValidation.why"
            kind="pri"
            @go="doTransfer"
          >确认扫码移库并记入总账流水</Lock>
        </div>

        <!-- 库位启停维护（带货禁停防呆锁） -->
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
          <Lock
            :ok="(!curBin.enabled || curBinSkus.length === 0) && !locked"
            :reason="locked ? '先完成首日练习' : `库位 ${curBin.code} 内当前仍有 ${curBinSkus.length} 件在库实物（#${curBinSkus[0]?.code}），严禁带货停用或冻结库位！请先扫码移库清空后再维护`"
            :kind="curBin.enabled ? 'bad sm' : 'ok sm'"
            @go="toggleWmsLocationEnabled(curBin)"
          >
            {{ curBin.enabled ? '停用冻结此库位（货架检修）' : '恢复启用此库位' }}
          </Lock>
        </div>
      </aside>
    </div>

    <!-- 新建 / 批量生成货架库位弹窗 -->
    <div v-if="createModal" class="mask" @click.self="createModal = false">
      <div class="modal big" role="dialog" aria-label="新建或批量生成WMS库位">
        <h3>新建 / 批量生成标准货架库位</h3>
        <div class="seg" style="justify-self:start">
          <button :class="{ on: createMode === 'single' }" @click="createMode = 'single'">单格精准新建</button>
          <button :class="{ on: createMode === 'batch' }" @click="createMode = 'batch'">整排批量生成</button>
        </div>

        <template v-if="createMode === 'single'">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label>库位编码（格式如 A-12 / B-05）<input v-model="newBin.code" placeholder="A-12" /></label>
            <label>
              所属库区
              <select v-model="newBin.zone">
                <option value="A区">A区 · 主力数码可售区</option>
                <option value="B区">B区 · 大件曲面音频区</option>
                <option value="C区">C区 · 到货签收待检区</option>
                <option value="D区">D区 · 异常隔离红牌柜</option>
                <option value="E区">E区 · 原盒配件包材区</option>
                <option value="F区">F区 · 波次集货交接区</option>
              </select>
            </label>
            <label>排架号<input v-model="newBin.rack" placeholder="A3排" /></label>
            <label>层格上限容量（件）<input v-model="newBin.capacity" type="number" min="1" max="50" /></label>
          </div>
          <label>库位用途备注<input v-model="newBin.note" placeholder="例如：27寸显示器扩充标准储位" /></label>
          <div class="mfoot">
            <button class="btn" @click="createModal = false">取消</button>
            <button class="btn pri" @click="submitSingleBin">创建库位</button>
          </div>
        </template>

        <template v-else>
          <p class="muted" style="font-size:13px">按连续序号一键生成整层货架格口（自动跳过已存在编码防冲突）。</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px">
            <label>
              所属库区
              <select v-model="batchBin.zone" @change="batchBin.prefix = batchBin.zone.slice(0, 1) + '-'">
                <option value="A区">A区</option>
                <option value="B区">B区</option>
                <option value="E区">E区</option>
              </select>
            </label>
            <label>编码前缀<input v-model="batchBin.prefix" placeholder="A-" /></label>
            <label>起始序号<input v-model="batchBin.startNum" type="number" min="1" /></label>
            <label>连续生成格数<input v-model="batchBin.count" type="number" min="1" max="12" /></label>
          </div>
          <div class="mfoot">
            <button class="btn" @click="createModal = false">取消</button>
            <button class="btn pri" @click="submitBatchBins">批量生成货架格口</button>
          </div>
        </template>
      </div>
    </div>

    <!-- WIP 工位扫码暂借弹窗 -->
    <div v-if="wipModal" class="mask" @click.self="wipModal = false">
      <div class="modal" role="dialog" aria-label="库内WIP工位暂借">
        <h3>⚙ 扫码办理库内 WIP 工位借出（挂名防丢）</h3>
        <p class="muted" style="font-size:13px">运营借去补拍、技术借去复测或客服借去拍细节时，必须扫机身码+工位码挂名，盘点时自动豁免不误报盘亏。</p>
        <label>
          扫描/选择在库单件
          <select v-model="wipForm.skuCode">
            <option v-for="s in allInStockSkus" :key="s.code" :value="s.code">
              #{{ s.code }}（{{ s.location }} · {{ s.brand }} {{ s.model }}）
            </option>
          </select>
        </label>
        <label>
          目标 WIP 工位码
          <select v-model="wipForm.wipCode">
            <option v-for="w in store.data.wipStations" :key="w.code" :value="w.code">{{ w.code }} · {{ w.name }}</option>
          </select>
        </label>
        <label>借用人姓名与岗位<input v-model="wipForm.borrower" placeholder="如 陈小满（销售客服）" /></label>
        <label>借用事由<input v-model="wipForm.purpose" placeholder="如 补拍10秒显示器壁纸轮播视频" /></label>
        <div class="mfoot">
          <button class="btn" @click="wipModal = false">取消</button>
          <button class="btn pri" @click="submitWipCheckout">确认双扫码借出挂名</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  currentUser,
  openHelp,
  openItemDetail,
  notify,
  occupiedSkusOfBin,
  createWmsLocation,
  batchCreateWmsLocations,
  toggleWmsLocationEnabled,
  transferSkuBetweenBins,
  activeWipBorrowOfSku,
  checkoutSkuToWip,
  returnSkuFromWip
} from '../store/warehouseStore.js'

const zoneFlt = ref('ALL')
const stateFlt = ref('ALL')
const kw = ref('')
const selectedBinCode = ref('A-05')
const createModal = ref(false)
const createMode = ref('single')
const wipModal = ref(false)
const wipForm = reactive({ skuCode: '910000000002', wipCode: 'WIP-PHOTO-01', borrower: '林强国（摄影补图）', purpose: '补拍显示器10秒轮播切片视频' })
const activeBorrows = computed(() => (store.data.wipBorrows || []).filter(b => b.status === 'BORROWED'))

function submitWipCheckout() {
  if (checkoutSkuToWip(wipForm)) {
    wipModal.value = false
  }
}
const locked = computed(() => !currentUser.value.practiceDone)

const ZONE_META = [
  { zone: 'A区', shortName: '主力可售架' },
  { zone: 'B区', shortName: '大件立体架' },
  { zone: 'C区', shortName: '签收待检区' },
  { zone: 'D区', shortName: '红牌隔离柜' },
  { zone: 'E区', shortName: '原盒包材区' },
  { zone: 'F区', shortName: '波次集货区' }
]

function binSkus(code) {
  return occupiedSkusOfBin(code)
}
function binAux(code) {
  return (store.data.auxiliaryLedger || []).filter(a => a.loc === code && a.qty > 0)
}

const zoneCards = computed(() =>
  ZONE_META.map(zm => {
    const bins = (store.data.locations || []).filter(l => l.zone === zm.zone)
    const cap = bins.reduce((s, b) => s + Number(b.capacity || 0), 0)
    const used = bins.reduce((s, b) => s + binSkus(b.code).length, 0)
    return {
      ...zm,
      binCount: bins.length,
      cap,
      used,
      pct: cap ? Math.min(100, Math.round((used / cap) * 100)) : 0
    }
  })
)

const emptyBinCount = computed(() => (store.data.locations || []).filter(b => b.enabled && binSkus(b.code).length === 0).length)
const occupiedBinCount = computed(() => (store.data.locations || []).filter(b => binSkus(b.code).length > 0).length)
const lockedBinCount = computed(() => (store.data.locations || []).filter(b => binSkus(b.code).some(s => s.zone === '锁单待发')).length)
const quarantineBinCount = computed(() => (store.data.locations || []).filter(b => b.zone === 'D区').length)
const disabledBinCount = computed(() => (store.data.locations || []).filter(b => !b.enabled).length)

const filteredBins = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return (store.data.locations || []).filter(b => {
    if (zoneFlt.value !== 'ALL' && b.zone !== zoneFlt.value) return false
    const sks = binSkus(b.code)
    if (stateFlt.value === 'EMPTY' && (!b.enabled || sks.length > 0)) return false
    if (stateFlt.value === 'OCCUPIED' && sks.length === 0) return false
    if (stateFlt.value === 'LOCKED' && !sks.some(s => s.zone === '锁单待发')) return false
    if (stateFlt.value === 'QUARANTINE' && b.zone !== 'D区') return false
    if (stateFlt.value === 'DISABLED' && b.enabled) return false
    if (!q) return true
    const skuText = sks.map(s => `${s.code} ${s.brand} ${s.model}`).join(' ')
    return `${b.code} ${b.zone} ${b.zoneName} ${b.note} ${skuText}`.toLowerCase().includes(q)
  })
})

const curBin = computed(() =>
  (store.data.locations || []).find(l => l.code === selectedBinCode.value) || filteredBins.value[0] || store.data.locations[0]
)
const curBinSkus = computed(() => (curBin.value ? binSkus(curBin.value.code) : []))
const allInStockSkus = computed(() => (store.data.skus || []).filter(s => s.zone !== '已出库在途'))

const mvForm = reactive({
  skuCode: '910000000003',
  toBinCode: 'A-01',
  reason: 'A-05满载分流至A-01空储位'
})

function selectBin(code) {
  selectedBinCode.value = code
  const sks = binSkus(code)
  if (sks.length) {
    mvForm.skuCode = sks[0].code
  } else {
    mvForm.toBinCode = code
  }
}

function prefillTransfer(skuCode) {
  mvForm.skuCode = skuCode
  mvForm.toBinCode = 'A-01'
}

const transferValidation = computed(() => {
  if (locked.value) return { ok: false, why: '先完成首日 3 个练习' }
  const sku = allInStockSkus.value.find(s => s.code === mvForm.skuCode)
  if (!sku) return { ok: false, why: '请先选择要移库的单件货号' }
  const target = (store.data.locations || []).find(l => l.code === mvForm.toBinCode)
  if (!target) return { ok: false, why: '请选择目标库位' }
  if (sku.location === target.code) return { ok: false, why: `单件 #${sku.code} 已经在 ${target.code} 中，请选择其他目标格口` }
  if (!target.enabled) return { ok: false, why: `目标库位 ${target.code} 当前处于「停用维护」状态，禁止移入！` }
  const occ = binSkus(target.code).length
  if (occ >= target.capacity) return { ok: false, why: `目标库位 ${target.code} 已满载（${occ}/${target.capacity}），防止叠压碎屏请选空闲库位` }
  const isQuarantine = sku.zone.includes('隔离') || sku.zone.includes('待修') || sku.zone.includes('待议价')
  if (isQuarantine && target.binType === 'SALEABLE') {
    return { ok: false, why: `库区属性防呆拦截：#${sku.code} 当前为「${sku.zone}」，严禁移入 ${target.code} 可售货架！只能选 D 区隔离锁柜` }
  }
  return { ok: true, why: '' }
})

function doTransfer() {
  if (transferSkuBetweenBins(mvForm)) {
    selectedBinCode.value = mvForm.toBinCode
  }
}

function binBadge(b) {
  if (!b.enabled) return { cls: '', text: '停用维护' }
  const sks = binSkus(b.code)
  if (b.zone === 'D区' && sks.length) return { cls: 'red', text: `隔离锁存 ${sks.length}` }
  if (sks.some(s => s.zone === '锁单待发')) return { cls: 'amb', text: '含锁单待拣' }
  if (sks.length >= b.capacity) return { cls: 'dark', text: '已满载' }
  if (sks.length > 0) return { cls: 'grn', text: '正常占用' }
  return { cls: 'acc', text: '空闲可入' }
}

function binVisualCls(b) {
  if (!b.enabled) return 'disabled'
  const sks = binSkus(b.code)
  if (b.zone === 'D区' && sks.length) return 'quar'
  if (sks.some(s => s.zone === '锁单待发')) return 'locked'
  if (sks.length > 0) return 'occ'
  return 'empty'
}

function binBarColor(b) {
  if (!b.enabled) return '#94a3b8'
  if (b.zone === 'D区') return 'var(--red)'
  const sks = binSkus(b.code)
  if (sks.some(s => s.zone === '锁单待发')) return 'var(--amb)'
  return 'var(--grn)'
}

function binTypeLabel(t) {
  const m = {
    SALEABLE: '标准可售储位（允许销售锁单配货）',
    STAGING: '签收待检暂存位（未过检禁售）',
    QUARANTINE: '红牌异常隔离锁柜（系统硬锁禁售）',
    AUX_PACK: '原盒附属与包材耗材储位',
    OUTBOUND_STAGE: '波次集货待揽收交接位'
  }
  return m[t] || t
}

function barcodeBars(code) {
  const s = 'LOC-' + code
  const arr = []
  for (let i = 0; i < 32; i++) {
    const ch = s.charCodeAt(i % s.length)
    arr.push(((ch + i * 7) % 3) + 1.5)
  }
  return arr
}

const newBin = reactive({ code: 'A-12', zone: 'A区', rack: 'A3排', level: '4层', binType: 'SALEABLE', capacity: 2, note: '标准显示器扩充格口' })
const batchBin = reactive({ zone: 'A区', prefix: 'A-', startNum: 12, count: 4, capacity: 2 })

function submitSingleBin() {
  if (createWmsLocation(newBin)) {
    selectedBinCode.value = newBin.code.toUpperCase()
    createModal.value = false
  }
}
function submitBatchBins() {
  if (batchCreateWmsLocations(batchBin) > 0) {
    createModal.value = false
  }
}
</script>

<style scoped>
.zone-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}
.lpn-wip-grid {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 12px;
  margin-bottom: 14px;
}
.lpn-card {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
}
.wip-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  font-size: 12.5px;
}
.zone-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 13px;
  text-align: left;
}
.zone-card:hover { background: var(--soft); }
.zone-card.on { border-color: var(--acc); box-shadow: 0 0 0 2px var(--acc-soft); }

.bar-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.loc-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(370px, 1fr);
  gap: 18px;
  align-items: start;
}
.bin-matrix {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 11px;
}
.bin-cell {
  background: var(--panel);
  border: 1.5px solid var(--line);
  border-radius: 10px;
  padding: 12px 13px;
  cursor: pointer;
  transition: transform .12s, box-shadow .12s;
  min-height: 118px;
  display: flex;
  flex-direction: column;
}
.bin-cell:hover { transform: translateY(-2px); box-shadow: var(--sh-up); }
.bin-cell.sel { box-shadow: 0 0 0 2.5px var(--acc); }
.bin-cell.empty { border-style: dashed; border-color: #b7ccf8; background: #fbfdff; }
.bin-cell.occ { border-left: 4px solid var(--grn); }
.bin-cell.locked { border-left: 4px solid var(--amb); background: #fffdf9; }
.bin-cell.quar { border-left: 4px solid var(--red); background: #fff9f9; }
.bin-cell.disabled { opacity: .62; background: #f1f4f8; }
.bc-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.bc-skus { display: grid; gap: 4px; margin-top: 2px; }
.mini-sku {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 11.5px;
  padding: 3px 6px;
  background: var(--soft);
  border-radius: 5px;
  overflow: hidden;
  white-space: nowrap;
}
.barcode-box {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px dashed #b5c4d8;
  border-radius: 8px;
  background: #fcfdff;
}
.in-sku-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--soft);
}
.transfer-box {
  margin-top: 14px;
  padding: 13px 14px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 9px;
  display: grid;
  gap: 9px;
}
.transfer-box label {
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--ink2);
  font-weight: 600;
}
</style>
