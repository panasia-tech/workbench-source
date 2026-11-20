<template>
  <div class="gal">
    <header class="head">
      <div class="ttl">
        <div class="eyebrow" style="font-size:12.5px;font-weight:800;color:var(--acc);margin-bottom:4px">
          与销售工作台待洗 Gallery 1:1 衔接 · 售前四道阻塞关卡 · 不设每日上限当日清零
        </div>
        <h1>历史库存阻塞清洗 Gallery<Q k="legacy-wash" /></h1>
        <p class="sum">
          <button class="big red" @click="flt = flt === 'red' ? 'all' : 'red'">
            <b>{{ counts.red }}</b> 件红灯阻塞（客服卖不了·当日必清）
          </button>
          <button class="big amb" @click="flt = flt === 'amb' ? 'all' : 'amb'">
            <b>{{ counts.amb }}</b> 件黄灯待补（缺库位图/副码/滞销）
          </button>
          <button class="big grn" @click="flt = flt === 'grn' ? 'all' : 'grn'">
            <b>{{ counts.grn }}</b> 件绿灯齐套（销售已可直接开卖）
          </button>
        </p>
      </div>

      <div class="tools">
        <label class="search">
          <Icon name="search" />
          <input v-model="q" placeholder="搜货号、型号、库位、卡点…" />
        </label>
        <button class="btn" @click="onlyLegacy = !onlyLegacy">
          {{ onlyLegacy ? '当前：仅看历史结转存量' : '当前：全量在库售前诊断' }}
        </button>
        <button class="btn" @click="openHelp('legacy-wash')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 售前四道放行关卡流水线引导条（对齐销售工作台 WashGallery .wg-pipeline） -->
    <section class="pipeline-strip" aria-label="售前四道放行关卡">
      <div class="pl-node">
        <i>1</i>
        <div>
          <b>① 爱回收式结构化全检</b>
          <small>补齐屏幕/接口/按键分级结论，禁仅写型号</small>
        </div>
      </div>
      <span class="pl-arr">→</span>
      <div class="pl-node">
        <i>2</i>
        <div>
          <b>② 完整通电/拆封实测视频</b>
          <small>回放3秒核验可读，供客服随时发给买家</small>
        </div>
      </div>
      <span class="pl-arr">→</span>
      <div class="pl-node">
        <i>3</i>
        <div>
          <b>③ 本机实拍与瑕疵微距图</b>
          <small>严禁用网图或老库旧图冒充，支撑洗图上架</small>
        </div>
      </div>
      <span class="pl-arr">→</span>
      <div class="pl-node">
        <i>4</i>
        <div>
          <b>④ 标准SPU · 库位 · 子母副码</b>
          <small>绑SPU、打 #BAG/#BOX 副码入容器，防卖后找不到</small>
        </div>
      </div>
      <div class="pl-prog">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700">
          <span>今日绿灯齐套放行率</span>
          <span style="color:var(--grn)">{{ counts.grn }} / {{ enriched.length }}（{{ clearPct }}%）</span>
        </div>
        <div class="bar" style="height:8px;margin-top:5px">
          <i :style="{ width: clearPct + '%', background: 'var(--grn)' }"></i>
        </div>
      </div>
    </section>

    <!-- 红黄绿筛选条 -->
    <div class="bar2">
      <div class="seg">
        <button :class="{ on: flt === 'all' }" @click="flt = 'all'">全部在库商品 <em>{{ enriched.length }}</em></button>
        <button :class="{ on: flt === 'red' }" @click="flt = 'red'"><i class="dot red"></i>红灯阻塞·卖不了 <em>{{ counts.red }}</em></button>
        <button :class="{ on: flt === 'amb' }" @click="flt = 'amb'"><i class="dot amb"></i>黄灯待完善 <em>{{ counts.amb }}</em></button>
        <button :class="{ on: flt === 'grn' }" @click="flt = 'grn'"><i class="dot grn"></i>绿灯可开卖 <em>{{ counts.grn }}</em></button>
      </div>
      <span class="muted" style="font-size:12.5px">
        规则：红灯商品客服与销售端已自动锁定「不可上架」，仓管员按下方缺失项逐条补齐后立即实时变绿放行。
      </span>
    </div>

    <!-- 视觉诊断大卡片网格 -->
    <div v-if="shown.length" class="lw-grid">
      <article
        v-for="row in shown"
        :key="row.sku.code"
        class="lw-card"
        :class="row.diag.lvl"
      >
        <div class="lw-img" @click="openItemDetail(row.sku.code)">
          <img v-if="row.sku.realImgCount > 0 && row.sku.realThumb" :src="row.sku.realThumb" :alt="row.sku.model" />
          <div v-else class="lw-noimg">
            <b>✕ 缺本机验货实拍图</b>
            <span>历史旧图已隔离作废 · 严禁拿同款网图顶替，请现场补拍</span>
          </div>

          <span class="lvl-pill" :class="row.diag.lvl">
            {{
              row.diag.lvl === 'red'
                ? `✕ 红灯阻塞 · 差 ${row.diag.redCount} 项卖不了`
                : row.diag.lvl === 'amb'
                  ? `! 黄灯待完善 · ${row.diag.ambCount} 项提醒`
                  : '✓ 四关全通 · 销售可直接开卖'
            }}
          </span>

          <span v-if="row.sku.legacySource" class="src-pill">400票历史存量批次</span>
          <span v-else class="src-pill normal">{{ row.sku.zone }}</span>

          <span v-if="row.sku.ageDays >= 15" class="age-pill" :class="{ red: row.sku.ageDays >= 28 }">
            在库 {{ row.sku.ageDays }} 天{{ row.sku.ageDays >= 28 ? '·滞销' : '' }}
          </span>
        </div>

        <div class="lw-body">
          <div class="lw-title">
            <div>
              <h3>{{ row.sku.brand }} {{ row.sku.model }}</h3>
              <p class="muted" style="font-size:12px;margin-top:2px">
                货号 <code>#{{ row.sku.code }}</code> · 库位 <b>{{ row.sku.location }}</b> · 进价 ¥{{ row.sku.cost }}
              </p>
            </div>
          </div>

          <!-- 售前四道放行关卡明细（一眼看清堵在哪、缺什么） -->
          <div class="gate-list">
            <div
              v-for="g in row.diag.gates"
              :key="g.key"
              class="gate-row"
              :class="g.lvl"
            >
              <span class="g-ic">{{ g.lvl === 'grn' ? '✓' : g.lvl === 'amb' ? '!' : '✕' }}</span>
              <div class="g-txt">
                <b>{{ g.title }}</b>
                <span>{{ g.text }}</span>
              </div>
            </div>
          </div>

          <!-- 当日清零直达闭环按钮组 -->
          <div class="lw-acts">
            <button
              v-if="row.sku.zone === '待修/送修中'"
              class="btn sm pri"
              :disabled="locked"
              @click="openItemDetail(row.sku.code)"
            >去填修回专项复检解锁 ›</button>

            <button
              v-else-if="row.sku.zone === '异常隔离（不可售）'"
              class="btn sm bad"
              @click="go('anomaly', 'ANO-2602')"
            >去异常双轨请主管放行 ›</button>

            <template v-else>
              <button
                v-if="row.sku.inspectComplete === false"
                class="btn sm pri"
                :disabled="locked"
                @click="openOrCreateLegacyInspection(row.sku)"
              >① 去补爱回收式全检 →</button>

              <button
                v-if="row.sku.fullVideoReady === false"
                class="btn sm pri"
                :disabled="locked"
                @click="openVideoModal(row.sku)"
              >② 现场补录完整实测视频</button>

              <button
                v-if="row.sku.realImgCount === 0 || row.sku.locImgCount === 0"
                class="btn sm"
                :class="row.sku.realImgCount === 0 ? 'pri' : ''"
                :disabled="locked"
                @click="completeLegacyPhotos(row.sku)"
              >③ 现场补拍{{ row.sku.realImgCount === 0 ? '实拍+库位图' : '库位同框图' }}</button>

              <button
                v-if="!row.sku.spuCode || row.sku.subCodesBound === false"
                class="btn sm"
                :class="!row.sku.spuCode ? 'pri' : ''"
                :disabled="locked"
                @click="openSubcodeModal(row.sku)"
              >④ 绑SPU · 打#BAG子母码</button>
            </template>

            <button class="btn sm ghost" @click="openItemDetail(row.sku.code)">单件档案 ›</button>
          </div>
        </div>
      </article>
    </div>

    <div v-else class="card" style="text-align:center;padding:56px 20px;margin-top:16px">
      <b style="font-size:18px;display:block;margin-bottom:6px">太棒了，当前筛选下没有阻塞商品！</b>
      <p class="muted">可切换上方红/黄/绿筛选标签查看全部在库单件。</p>
      <button class="btn" style="margin-top:12px" @click="flt = 'all'; onlyLegacy = false; q = ''">查看全部商品</button>
    </div>

    <!-- 现场补录完整通电实测视频 + 3秒回放核验弹窗 -->
    <div v-if="vidSku" class="mask" @click.self="vidSku = null">
      <div class="modal big" role="dialog" aria-label="补录完整通电实测视频">
        <h3>🎥 现场补录完整实测视频 · #{{ vidSku.code }}</h3>
        <p class="muted" style="font-size:13px">
          {{ vidSku.brand }} {{ vidSku.model }} —— 客服遇买家询单需发送连续无剪辑亮屏/按键/序列号实测视频，录制完毕必须回放确认非坏片。
        </p>
        <div style="border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#0f172a;padding:18px;color:#fff">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="tag red">● 工位高拍仪 1080P 实录回放核验</span>
            <span class="mono">时长 {{ vidDuration }} · 音频电平正常</span>
          </div>
          <p style="margin-top:12px;font-size:13px;color:#cbd5e1">
            画面包含：① 机身背部铭牌 SN 微距 3 秒 → ② 通电开机/五色纯屏测试 → ③ 接口与实体按键连贯操作。
          </p>
        </div>
        <label class="ck" style="font-weight:650;color:var(--grn-ink)">
          <input type="checkbox" v-model="vidVerified" />
          我已回放抽检首尾 3 秒，确认视频画面对焦清晰、无黑屏中断，可供客服直接发给买家
        </label>
        <div class="mfoot">
          <button class="btn" @click="vidSku = null">取消</button>
          <Lock
            :ok="vidVerified && !locked"
            reason="必须先勾选确认已回放核验视频清晰可读，严禁坏片入库"
            kind="ok"
            @go="confirmVideoSave"
          >确认入库并点亮视频绿灯</Lock>
        </div>
      </div>
    </div>

    <!-- 绑定标准 SPU + 打印 #BAG/#BOX 子母副码入容器箱弹窗 -->
    <div v-if="codeSku" class="mask" @click.self="codeSku = null">
      <div class="modal big" role="dialog" aria-label="绑定SPU与子母副码">
        <h3>🏷 补绑标准 SPU 与一机多码（#BAG / #BOX） · #{{ codeSku.code }}</h3>
        <p class="muted" style="font-size:13px">
          破 1,000 件防丢件规矩：主机贴主码放货架，电源/线材装袋贴 <code>{{ codeSku.code }}#BAG</code> 放进 LPN 分格周转箱，出库打包逐码扫绿。
        </p>
        <label>
          绑定标准 SPU 型号（同品牌强校验）
          <select v-model="codeForm.spuCode">
            <option value="">-- 请选择标准 SPU --</option>
            <option v-for="sp in candidateSpus" :key="sp.spuCode" :value="sp.spuCode">
              {{ sp.spuCode }} · {{ sp.brand }} {{ sp.model }}（{{ sp.spec }}）
            </option>
          </select>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label>
            主机标准库位
            <select v-model="codeForm.binCode">
              <option v-for="b in saleableBins" :key="b.code" :value="b.code">{{ b.code }}（{{ b.zone }} · {{ b.rack }}）</option>
            </select>
          </label>
          <label>
            #BAG 附件袋存入 LPN 分格箱
            <select v-model="codeForm.lpnCode">
              <option v-for="c in store.data.containerLpns" :key="c.lpnCode" :value="c.lpnCode">{{ c.lpnCode }} · {{ c.name }}</option>
            </select>
          </label>
        </div>
        <div class="mfoot">
          <button class="btn" @click="codeSku = null">取消</button>
          <Lock
            :ok="Boolean(codeForm.spuCode) && !locked"
            reason="请选择对应的标准 SPU 编码"
            kind="pri"
            @go="confirmSubcodeSave"
          >打印主副码并完成绑定</Lock>
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
  go,
  openHelp,
  openItemDetail,
  skuPreSalesGates,
  openOrCreateLegacyInspection,
  completeLegacyFullVideo,
  completeLegacyPhotos,
  completeLegacySpuAndSubcodes
} from '../store/warehouseStore.js'

const flt = ref('all')
const q = ref('')
const onlyLegacy = ref(false)
const locked = computed(() => !currentUser.value.practiceDone)

const poolSkus = computed(() =>
  (store.data.skus || []).filter(s => s.zone !== '已出库在途' && (!onlyLegacy.value || s.legacySource))
)

const enriched = computed(() =>
  poolSkus.value.map(sku => ({
    sku,
    diag: skuPreSalesGates(sku)
  }))
)

const counts = computed(() => ({
  red: enriched.value.filter(x => x.diag.lvl === 'red').length,
  amb: enriched.value.filter(x => x.diag.lvl === 'amb').length,
  grn: enriched.value.filter(x => x.diag.lvl === 'grn').length
}))

const clearPct = computed(() => {
  const tot = enriched.value.length || 1
  return Math.round((counts.value.grn / tot) * 100)
})

const shown = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const orderWeight = { red: 0, amb: 1, grn: 2 }
  return enriched.value
    .filter(r => {
      if (flt.value !== 'all' && r.diag.lvl !== flt.value) return false
      if (!kw) return true
      const hay = `${r.sku.code} ${r.sku.brand} ${r.sku.model} ${r.sku.location} ${r.diag.gates.map(g => g.text).join(' ')}`.toLowerCase()
      return hay.includes(kw)
    })
    .sort((a, b) => orderWeight[a.diag.lvl] - orderWeight[b.diag.lvl])
})

// 补录视频弹窗
const vidSku = ref(null)
const vidDuration = ref('01:54')
const vidVerified = ref(true)
function openVideoModal(sku) {
  vidSku.value = sku
  vidVerified.value = true
}
function confirmVideoSave() {
  if (!vidSku.value) return
  completeLegacyFullVideo(vidSku.value, vidDuration.value)
  vidSku.value = null
}

// 绑 SPU + 子母码弹窗
const codeSku = ref(null)
const codeForm = reactive({ spuCode: '', binCode: 'A-08', lpnCode: 'LPN-BOX-01' })
const candidateSpus = computed(() => {
  if (!codeSku.value) return store.data.spuCatalog || []
  const sameBrand = (store.data.spuCatalog || []).filter(s => s.brand.toLowerCase() === codeSku.value.brand.toLowerCase())
  return sameBrand.length ? sameBrand : (store.data.spuCatalog || [])
})
const saleableBins = computed(() => (store.data.locations || []).filter(b => b.enabled && b.binType === 'SALEABLE'))

function openSubcodeModal(sku) {
  codeSku.value = sku
  const match = (store.data.spuCatalog || []).find(s => s.brand.toLowerCase() === sku.brand.toLowerCase())
  codeForm.spuCode = sku.spuCode || match?.spuCode || ''
  codeForm.binCode = sku.location || 'A-08'
  codeForm.lpnCode = 'LPN-BOX-01'
}
function confirmSubcodeSave() {
  if (!codeSku.value) return
  if (completeLegacySpuAndSubcodes(codeSku.value, codeForm)) {
    codeSku.value = null
  }
}
</script>

<style scoped>
.pipeline-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding: 14px 18px;
  background: var(--panel);
  border: 1px solid #cad8ff;
  border-radius: 12px;
  flex-wrap: wrap;
}
.pl-node { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 185px; }
.pl-node i {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--acc-soft);
  color: var(--acc);
  font-style: normal;
  font-weight: 800;
  font-size: 13px;
  display: grid;
  place-items: center;
  flex: none;
}
.pl-node b { display: block; font-size: 13px; }
.pl-node small { display: block; font-size: 11.5px; color: var(--mute); margin-top: 1px; }
.pl-arr { font-weight: 800; color: var(--mute); }
.pl-prog { min-width: 200px; padding-left: 12px; border-left: 1px solid var(--line); }

.lw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
  margin-top: 14px;
}
.lw-card {
  background: var(--panel);
  border-radius: 14px;
  border: 2px solid var(--line);
  box-shadow: var(--sh);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.lw-card.red { border-color: #f4b4b0; }
.lw-card.amb { border-color: #f6d29b; }
.lw-card.grn { border-color: #a7e3c5; }

.lw-img { position: relative; aspect-ratio: 16 / 9; background: var(--soft); cursor: pointer; overflow: hidden; }
.lw-img img { width: 100%; height: 100%; object-fit: cover; }
.lw-noimg {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 16px;
  text-align: center;
  color: var(--red-ink);
  background: repeating-linear-gradient(45deg, var(--red-soft), var(--red-soft) 12px, var(--soft) 12px, var(--soft) 24px);
  font-size: 12px;
}
.lw-noimg b { font-size: 15px; }

.lvl-pill {
  position: absolute;
  left: 10px;
  top: 10px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
}
.lvl-pill.red { background: var(--red); color: #fff; }
.lvl-pill.amb { background: var(--amb); color: #fff; }
.lvl-pill.grn { background: var(--grn); color: #fff; }

.src-pill {
  position: absolute;
  left: 10px;
  bottom: 34px;
  padding: 3px 9px;
  border-radius: 6px;
  background: #17233bd9;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
.age-pill {
  position: absolute;
  right: 10px;
  top: 10px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--amb-soft);
  color: var(--amb-ink);
  font-size: 11.5px;
  font-weight: 700;
}
.age-pill.red { background: var(--red); color: #fff; }

.lw-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
.lw-title h3 { font-size: 16px; font-weight: 750; line-height: 1.3; }

.gate-list {
  display: grid;
  gap: 6px;
  background: var(--soft);
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid var(--line);
}
.gate-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.4; }
.g-ic {
  width: 19px;
  height: 19px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 11px;
  flex: none;
  margin-top: 1px;
}
.gate-row.grn .g-ic { background: var(--grn-soft); color: var(--grn-ink); }
.gate-row.amb .g-ic { background: var(--amb-soft); color: var(--amb-ink); }
.gate-row.red .g-ic { background: var(--red); color: #fff; }
.g-txt b { display: block; color: var(--ink); font-size: 12.5px; }
.gate-row.red .g-txt span { color: var(--red-ink); font-weight: 600; }
.gate-row.amb .g-txt span { color: var(--amb-ink); }
.gate-row.grn .g-txt span { color: var(--mute); }

.lw-acts { margin-top: auto; display: flex; gap: 6px; flex-wrap: wrap; padding-top: 4px; }
</style>
