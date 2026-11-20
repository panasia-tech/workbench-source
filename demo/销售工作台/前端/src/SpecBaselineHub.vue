<template>
  <div class="page sbh">
    <header class="head">
      <div>
        <p class="eyebrow">选品前置工程 · 规格贴标 / 防呆拦截 / 95%走量兜底</p>
        <h1>选品规格与兜底基准台 <Q k="spec-base" /></h1>
        <p class="sub">
          业务员在选品阶段先把复杂品类的规格坑位立好：<b>95% 千元内走量款</b>套用「同档兜底 + 假低价防呆尺 + 大盘反向调优」；
          <b>5% 千元以上高端稀缺款</b>（如 OLED / ROG 旗舰 / 双模）货少无参考，<b>不套公式直接按闲鱼实爬价算</b>；唯独 <b>卓威 ZOWIE</b> 走独立价格体系。
        </p>
      </div>
      <div class="head-acts">
        <button class="btn" @click="goGallery">打开多视角实物选品 Gallery ›</button>
        <button class="btn pri" @click="goErrCase">看「2K240 错爬 ¥200」快照拦截实况 ›</button>
      </div>
    </header>

    <!-- 顶部核心指标条（基于真实 8,044 型号快照实时统计） -->
    <section class="kpi-strip" v-if="overview">
      <div class="kpi-card">
        <span>选品库去重型号</span>
        <b>{{ (stats.totalUniqueModels || 0).toLocaleString() }}</b>
        <small>其中显示器 {{ (stats.monitorsTotal || 0).toLocaleString() }} 款（硬参数已挂接）</small>
      </div>
      <div class="kpi-card grn">
        <span>95% 千元内走量款（≤¥{{ rules.volumeCeilingPrice || 1000 }}）</span>
        <b>{{ (stats.volumeCount || 0).toLocaleString() }} <small>款 ({{ stats.volumeSharePct || 0 }}%)</small></b>
        <small>已为 {{ (stats.volumeFallbackCoveredCount || 0).toLocaleString() }} 款无在售冷门型号生成同档兜底价</small>
      </div>
      <div class="kpi-card acc">
        <span>5% 高端稀缺款（>¥{{ rules.volumeCeilingPrice || 1000 }}）</span>
        <b>{{ (stats.highendCount || 0).toLocaleString() }} <small>款</small></b>
        <small>OLED/双模/高刷旗舰 · 严禁套走量公式，直接按闲鱼实爬算</small>
      </div>
      <div class="kpi-card amb">
        <span>卓威 ZOWIE 独立价格表</span>
        <b>{{ zowieTable.length }} <small>款标准型 ({{ stats.zowieCount || 0 }} 库内命中)</small></b>
        <small>唯一单独核价品牌 · 按 XL/XQ 与 DyAc 代际区分</small>
      </div>
    </section>

    <!-- 四大工作分栏 -->
    <div class="tabs">
      <button v-for="t in TABS" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">
        {{ t.t }}<em v-if="t.badge">{{ t.badge }}</em>
      </button>
    </div>

    <div v-if="loading" class="card pad">正在加载选品规格底座与 8,044 型号分流数据…</div>

    <!-- ==================== TAB 1: 多品类规格坑位预留 & 双口径来源 ==================== -->
    <section v-else-if="tab === 'slots'" class="sec-grid">
      <div class="dual-caliber-grid">
        <article v-for="cal in dualCalibers" :key="cal.caliber" class="card cal-card" :class="cal.caliber">
          <div class="cal-head">
            <span class="tag" :class="cal.caliber === 'macro_outline' ? 'amb' : 'acc'">
              {{ cal.caliber === 'macro_outline' ? '广度大纲层' : '深度型号层' }}
            </span>
            <h3>{{ cal.title }}</h3>
          </div>
          <p class="muted">{{ cal.summary }}</p>
          <div class="cal-list">
            <div v-for="ex in cal.examples" :key="ex.name" class="cal-item">
              <b>{{ ex.name }}</b>
              <span class="tag">{{ ex.scale }}</span>
              <small>{{ ex.role }}</small>
            </div>
          </div>
        </article>
      </div>

      <div class="slot-sec-head">
        <div>
          <h3>六大品类组「规格细分 & 兜底防呆坑位」预留总表</h3>
          <p class="muted">复杂 3C 品类提前把芯片/容量/刷新率/面板坑位全部留好；扫地机、净化器等只有十几个型号的简单品类保持平铺不折腾。</p>
        </div>
        <button class="btn sm" @click="goSources">查看 100 站来源大台账 ›</button>
      </div>

      <div class="slots-grid">
        <article v-for="s in categorySlots" :key="s.id" class="card slot-card" :class="s.status">
          <div class="sc-top">
            <div>
              <span class="tag" :class="s.status === 'active_full' ? 'grn' : s.status === 'reserved_ready' ? 'acc' : ''">
                {{ s.statusLabel }}
              </span>
              <h4>{{ s.name }}</h4>
            </div>
            <button v-if="s.status !== 'simple_keep'" class="btn sm" @click="openEditSlot(s)">配置坑位</button>
          </div>
          <div class="sc-meta"><span>型号规模：</span><b>{{ s.modelScale }}</b></div>
          <div class="sc-meta"><span>垂类型号源：</span><span>{{ (s.verticalSources || []).join(' · ') }}</span></div>
          <div class="sc-fields">
            <span v-for="f in s.specFields" :key="f" class="f-chip">{{ f }}</span>
          </div>
          <div class="sc-rule"><b>分流与兜底逻辑：</b>{{ s.splitRule }}</div>
          <div class="sc-sanity"><b>防呆拦截示例：</b>{{ s.sanityExample }}</div>
        </article>
      </div>
    </section>

    <!-- ==================== TAB 2: 显示器爬价防呆检测 & 走量兜底速算器 ==================== -->
    <section v-else-if="tab === 'sanity'" class="sec-grid">
      <div class="card preset-bar">
        <b>点选典型实战场景一键验证（含「2K 240Hz 错爬 ¥200」防呆反推）：</b>
        <div class="preset-chips">
          <button
            v-for="p in presetCases"
            :key="p.id"
            class="p-chip"
            :class="{ on: activePresetId === p.id }"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="sanity-split">
        <div class="card form-box">
          <h3>输入型号与规格 · 实时跑防呆体检与兜底</h3>
          <p class="muted sm">铁律：刷新率直接填<b>超频最高值（OC Hz）</b>，原生面板多少不管；OLED 与 Mini LED 严格区分。</p>
          <div class="f-grid">
            <label>型号名称（带不带品牌均可识别）
              <input v-model="simForm.name" placeholder="例如：泰坦军团 P2710S / ROG PG27AQDP / XL2546K" />
            </label>
            <label>规格参数标签（尺寸 / 分辨率 / 超频Hz / 面板）
              <input v-model="simForm.note" placeholder="例如：27英寸 / 2560x1440 / 240Hz / Fast IPS" />
            </label>
            <label>模拟闲鱼爬回来的均价 (¥，留空代表没爬到样本)
              <input type="number" v-model="simForm.crawledPrice" placeholder="留空测试冷门无在售兜底；填 200 测试假价拦截" />
            </label>
          </div>
          <div class="f-btns">
            <button class="btn pri" :disabled="busy" @click="runEvaluate">立即执行基准防呆与兜底核验</button>
            <button class="btn" @click="simForm.crawledPrice = 200; runEvaluate()">模拟错爬成 ¥200</button>
            <button class="btn" @click="simForm.crawledPrice = ''; runEvaluate()">模拟闲鱼没爬到价</button>
          </div>
        </div>

        <div class="card res-box" v-if="simResult">
          <div class="rb-head" :class="simResult.sanityBlocked ? 'bad' : simResult.track === 'highend_5' ? 'hi' : 'ok'">
            <span class="tag" :class="simResult.sanityBlocked ? 'red' : simResult.track === 'zowie_independent' ? 'amb' : simResult.track === 'highend_5' ? 'acc' : 'grn'">
              {{ simResult.trackLabel }}
            </span>
            <h3>
              最终采信/参考价：
              <b>{{ simResult.effectivePrice ? `¥${simResult.effectivePrice}` : '不套公式 · 待实爬真机价' }}</b>
            </h3>
            <p>{{ simResult.sanityReason }}</p>
          </div>

          <dl class="rb-kv" v-if="simResult.spec">
            <dt>识别身份</dt>
            <dd><b>{{ simResult.spec.brand || '待补品牌' }}</b> · <code>{{ simResult.spec.model }}</code>（{{ simResult.brandTier }}）</dd>
            <dt>硬参数（按超频算）</dt>
            <dd>{{ simResult.spec.size }}″ · {{ simResult.spec.res }} · <b>{{ simResult.spec.hz }}Hz</b> · {{ simResult.spec.panel }}</dd>
            <dt>归属规格档</dt>
            <dd>{{ simResult.bucketLabel }}</dd>
            <dt>手册收货目标基准</dt>
            <dd>{{ simResult.buyBaseline ? `¥${simResult.buyBaseline}（${simResult.formulaText}）` : simResult.formulaText }}</dd>
            <dt>同档走量实爬中位价</dt>
            <dd>{{ simResult.bucketCrawledMedian ? `¥${simResult.bucketCrawledMedian}` : '高端稀缺款货少，不凑同档大盘均值' }}</dd>
            <dt>价格来源结论</dt>
            <dd><b>{{ simResult.priceSource }}</b></dd>
          </dl>

          <div class="rb-foot">
            <button class="btn sm pri" @click="openInPriceClean(simForm.name)">去第 1 步价格清洗台看闲鱼快照 ›</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ==================== TAB 3: 反向校准拍板决策台（预留给1万型号实跑调优） ==================== -->
    <section v-else-if="tab === 'calibration'" class="sec-grid">
      <div class="cal-layout">
        <div class="card tbl-wrap">
          <div class="tw-head">
            <div>
              <h3>95% 走量款「现行基准 vs 闲鱼实爬大盘」反向校验表</h3>
              <p class="muted sm">等 1 万个型号全量跑起来后，如果某个规格档实爬均价长期偏高或偏低，直接在右侧改基价或品牌倍率拍板升版（当前版本：<code>{{ rules.version }}</code>）。</p>
            </div>
          </div>
          <table class="tbl">
            <thead>
              <tr>
                <th>走量规格档位</th>
                <th>库内型号数</th>
                <th>实爬样本型号</th>
                <th>现行采购目标价</th>
                <th>基准推算售价</th>
                <th>闲鱼实爬中位价</th>
                <th>实爬偏差</th>
                <th>预估毛利空间</th>
                <th>反向校验诊断</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in calibrationRows" :key="r.key">
                <td><b>{{ r.bucketTitle }}</b></td>
                <td>{{ r.catalogModelCount }} 款</td>
                <td>{{ r.crawledSampleModels }} 款</td>
                <td><b>¥{{ r.currentBuyTarget }}</b> <small class="muted">({{ r.baseSpecBuy }}×{{ r.brandMultiplier }})</small></td>
                <td>¥{{ r.expectedFormulaSale }}</td>
                <td class="hi-num"><b>¥{{ r.xianyuCrawledMedian }}</b></td>
                <td>
                  <span class="tag" :class="r.deviationPct < -12 ? 'amb' : r.deviationPct > 12 ? 'grn' : 'acc'">
                    {{ r.deviationPct >= 0 ? '+' : '' }}{{ r.deviationPct }}%
                  </span>
                </td>
                <td>¥{{ r.estimatedGrossMargin }} ({{ r.estimatedGrossMarginPct }}%)</td>
                <td><span class="tag" :class="r.verdictLvl">{{ r.verdict }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <aside class="card decide-panel">
          <h3>人工拍板决策区（预留槽）</h3>
          <p class="muted sm">所有改动留痕生成新版本号，实时同步至防呆尺与无样本兜底计算。</p>

          <div class="dp-group">
            <b>四档走量二线收货基价 (¥)</b>
            <label>1K · 180Hz档 (120~200Hz) <input type="number" v-model.number="calDraft.b_1k_180" /></label>
            <label>2K · 180Hz档 (120~200Hz) <input type="number" v-model.number="calDraft.b_2k_180" /></label>
            <label>1K · 240Hz档 (201~280Hz) <input type="number" v-model.number="calDraft.b_1k_240" /></label>
            <label>2K · 240Hz档 (201~280Hz) <input type="number" v-model.number="calDraft.b_2k_240" /></label>
          </div>

          <div class="dp-group">
            <b>品牌档位倍率</b>
            <label>超一线 (LG / 三星 / ROG) <input type="number" step="0.05" v-model.number="calDraft.m_super" /></label>
            <label>一线成熟品牌 (AOC/华硕等) <input type="number" step="0.05" v-model.number="calDraft.m_t1" /></label>
            <label>二线基准品牌 (HKC/KTC等) <input type="number" step="0.05" v-model.number="calDraft.m_t2" /></label>
            <label>走量/高端分界线 (¥) <input type="number" step="50" v-model.number="calDraft.ceiling" /></label>
          </div>

          <label class="dp-note">拍板备注
            <input v-model="calDraft.note" placeholder="例如：二线 2K240 闲鱼行情坚挺，维持 400 基价" />
          </label>

          <button class="btn pri full" :disabled="busy" @click="saveCalibration">✓ 拍板保存新基准版本</button>

          <div class="log-box" v-if="decisionLogs.length">
            <b>最近决策留痕</b>
            <div v-for="lg in decisionLogs.slice(0, 4)" :key="lg.id" class="lg-row">
              <span><code>{{ lg.id }}</code> · {{ lg.at }} · {{ lg.actor }}</span>
              <p>{{ lg.action }}</p>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <!-- ==================== TAB 4: 卓威独立价格表 & 手册 77 款官方图鉴 ==================== -->
    <section v-else-if="tab === 'handbook'" class="sec-grid">
      <div class="card tbl-wrap">
        <div class="tw-head">
          <div>
            <h3>卓威 ZOWIE 独立价格表（唯一拥有独立保值曲线的品牌 · 共 {{ zowieTable.length }} 款）</h3>
            <p class="muted sm">XL / XQ 全系严格区分无 DyAc / DyAc / DyAc+ / DyAc 2 / DyAc 3 及 K / S / X / X+ 后缀，绝不混入普通 TN 走量公式。</p>
          </div>
          <input class="srch-inp" v-model="hbQuery" placeholder="搜型号 / DyAc / OLED / 240Hz…" />
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>编号</th>
              <th>卓威型号</th>
              <th>尺寸与面板</th>
              <th>刷新率</th>
              <th>DyAc 代际</th>
              <th>独立收货目标价(¥)</th>
              <th>闲鱼保值锚点(¥)</th>
              <th>收货防坑核验要点</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="z in filteredZowie" :key="z.code">
              <td><code>{{ z.code }}</code></td>
              <td><b>{{ z.model }}</b></td>
              <td>{{ z.size }}″ · {{ z.res }} · {{ z.panel }}</td>
              <td><b>{{ z.hz }}Hz</b></td>
              <td><span class="tag" :class="z.dyac.includes('无') ? '' : 'amb'">{{ z.dyac }}</span></td>
              <td><input type="number" class="num-xs" v-model.number="z.buyTarget" @change="patchZowie(z)" /></td>
              <td><input type="number" class="num-xs" v-model.number="z.xianyuAnchor" @change="patchZowie(z)" /></td>
              <td class="muted sm">{{ z.note }}</td>
              <td><button class="btn sm" @click="testHandbookModel({ ...z, brand: '卓威 ZOWIE' })">带入测算</button></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card tbl-wrap">
        <div class="tw-head">
          <div>
            <h3>《电竞显示器采购价格说明（2026.11.05）》全部 {{ handbookModels.length }} 款官方型号索引</h3>
            <p class="muted sm">涵盖日常收货 M01~M26、高端/OLED/双模 P01~P20、卓威 Z01~Z24、1000Hz与多模新品 N01~N07。</p>
          </div>
          <div class="hb-flt">
            <button v-for="f in HB_FILTERS" :key="f.k" class="btn sm" :class="{ pri: hbTrack === f.k }" @click="hbTrack = f.k">{{ f.t }}</button>
          </div>
        </div>
        <div class="hb-grid">
          <article v-for="m in filteredHandbook" :key="m.code" class="hb-card">
            <div class="hbc-top">
              <code>{{ m.code }}</code>
              <span class="tag" :class="m.track === 'volume_95' ? 'grn' : m.track === 'zowie_independent' ? 'amb' : 'acc'">
                {{ m.track === 'volume_95' ? '95%走量款' : m.track === 'zowie_independent' ? '卓威独立表' : '5%高端按实爬' }}
              </span>
            </div>
            <h4>{{ m.brand }} {{ m.model }}</h4>
            <p class="hb-spec">{{ m.size }}″ · {{ m.res }} · <b>{{ m.hz }}Hz</b> · {{ m.panel }}</p>
            <p class="hb-price">
              <span>{{ m.buyTarget ? `手册收货目标 ¥${m.buyTarget}` : '按闲鱼实爬直算' }}</span>
              <small>{{ m.formula }}</small>
            </p>
            <p class="hb-note">{{ m.note }}</p>
            <button class="btn sm" @click="testHandbookModel(m)">防呆测算 ›</button>
          </article>
        </div>
      </div>
    </section>

    <!-- 品类预留规格槽编辑弹窗 -->
    <div v-if="editingSlot" class="mask" @click.self="editingSlot = null">
      <div class="modal">
        <h3>配置选品规格与防呆坑位 · {{ editingSlot.name }}</h3>
        <div class="mform">
          <label>规格细分字段（每行一个硬指标，选品爬虫与业务员按此贴标）
            <textarea rows="4" v-model="slotDraft.fieldsText"></textarea>
          </label>
          <label>走量款兜底 vs 高端款分流规则
            <textarea rows="2" v-model="slotDraft.splitRule"></textarea>
          </label>
          <label>爬价防呆拦截规则示例
            <textarea rows="2" v-model="slotDraft.sanityExample"></textarea>
          </label>
        </div>
        <div class="mfoot">
          <button class="btn" @click="editingSlot = null">取消</button>
          <button class="btn pri" :disabled="busy" @click="saveSlotEdit">保存该品类选品坑位</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import Q from './Q.vue'
import { api, post } from './api.js'
import { toast } from './ui.js'

const tab = ref('slots')
const loading = ref(true)
const busy = ref(false)
const overview = ref(null)
const activePresetId = ref('case_absurd_2k240')
const simForm = reactive({
  name: '泰坦军团 P2710S',
  note: '27英寸 / 2560x1440 / 240Hz / Fast IPS',
  crawledPrice: 200
})
const simResult = ref(null)
const hbQuery = ref('')
const hbTrack = ref('all')
const editingSlot = ref(null)
const slotDraft = reactive({ fieldsText: '', splitRule: '', sanityExample: '' })

const calDraft = reactive({
  b_1k_180: 150,
  b_2k_180: 250,
  b_1k_240: 250,
  b_2k_240: 400,
  m_super: 1.5,
  m_t1: 1.3,
  m_t2: 1.0,
  ceiling: 1000,
  note: ''
})

const TABS = [
  { k: 'slots', t: '① 多品类规格坑位预留（选品前置）', badge: '6大类' },
  { k: 'sanity', t: '② 爬价防呆检测 & 走量兜底速算', badge: '拦200元假价' },
  { k: 'calibration', t: '③ 反向校准拍板决策台', badge: '预留调优' },
  { k: 'handbook', t: '④ 卓威独立表 & 77款手册图鉴', badge: '77款' }
]
const HB_FILTERS = [
  { k: 'all', t: '全部 77 款' },
  { k: 'volume_95', t: '95% 走量款' },
  { k: 'highend_5', t: '5% 高端按实爬' },
  { k: 'zowie_independent', t: '卓威独立表' }
]

const stats = computed(() => overview.value?.catalogStats || {})
const rules = computed(() => overview.value?.monitorRules || {})
const dualCalibers = computed(() => overview.value?.sourceDualCalibers || [])
const categorySlots = computed(() => overview.value?.categorySlots || [])
const calibrationRows = computed(() => overview.value?.calibrationRows || [])
const zowieTable = computed(() => overview.value?.zowieTable || [])
const handbookModels = computed(() => overview.value?.handbookModels || [])
const presetCases = computed(() => overview.value?.presetCases || [])
const decisionLogs = computed(() => overview.value?.decisionLogs || [])

const filteredZowie = computed(() => {
  const q = hbQuery.value.trim().toLowerCase()
  if (!q) return zowieTable.value
  return zowieTable.value.filter((z) => `${z.code} ${z.model} ${z.dyac} ${z.note}`.toLowerCase().includes(q))
})

const filteredHandbook = computed(() => {
  const q = hbQuery.value.trim().toLowerCase()
  return handbookModels.value.filter((m) => {
    if (hbTrack.value !== 'all' && m.track !== hbTrack.value) return false
    if (!q) return true
    return `${m.code} ${m.brand} ${m.model} ${m.res} ${m.hz} ${m.panel} ${m.note}`.toLowerCase().includes(q)
  })
})

function syncDraftFromRules(r) {
  if (!r?.baseSpecPrices) return
  calDraft.b_1k_180 = r.baseSpecPrices['1k_180']?.baseBuy ?? 150
  calDraft.b_2k_180 = r.baseSpecPrices['2k_180']?.baseBuy ?? 250
  calDraft.b_1k_240 = r.baseSpecPrices['1k_240']?.baseBuy ?? 250
  calDraft.b_2k_240 = r.baseSpecPrices['2k_240']?.baseBuy ?? 400
  calDraft.m_super = r.brandTiers?.super_tier1?.multiplier ?? 1.5
  calDraft.m_t1 = r.brandTiers?.tier1?.multiplier ?? 1.3
  calDraft.m_t2 = r.brandTiers?.tier2?.multiplier ?? 1.0
  calDraft.ceiling = r.volumeCeilingPrice ?? 1000
}

async function loadOverview() {
  loading.value = true
  try {
    const res = await api('/spec-baseline/overview')
    overview.value = res
    syncDraftFromRules(res.monitorRules)
    if (res.presetCases?.length) {
      simResult.value = res.presetCases[0].eval
    }
  } catch (e) {
    toast('加载规格基准台失败：' + e.message)
  } finally {
    loading.value = false
  }
}

function applyPreset(p) {
  activePresetId.value = p.id
  simForm.name = p.name
  simForm.note = p.note
  simForm.crawledPrice = p.crawledPrice ?? ''
  simResult.value = p.eval
}

async function runEvaluate() {
  busy.value = true
  try {
    simResult.value = await post('/spec-baseline/evaluate', {
      name: simForm.name,
      note: simForm.note,
      crawledPrice: simForm.crawledPrice === '' ? null : simForm.crawledPrice
    })
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function saveCalibration() {
  busy.value = true
  try {
    const res = await post('/spec-baseline/calibration/decide', {
      baseSpecPrices: {
        '1k_180': calDraft.b_1k_180,
        '2k_180': calDraft.b_2k_180,
        '1k_240': calDraft.b_1k_240,
        '2k_240': calDraft.b_2k_240
      },
      brandMultipliers: {
        super_tier1: calDraft.m_super,
        tier1: calDraft.m_t1,
        tier2: calDraft.m_t2
      },
      volumeCeilingPrice: calDraft.ceiling,
      note: calDraft.note
    })
    overview.value.monitorRules = res.monitorRules
    overview.value.calibrationRows = res.calibrationRows
    overview.value.decisionLogs = res.decisionLogs
    calDraft.note = ''
    toast(`已保存新基准版本 ${res.version}，防呆尺与兜底价已实时联动！`)
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function patchZowie(z) {
  try {
    const res = await post('/spec-baseline/calibration/decide', {
      zowiePatch: { code: z.code, buyTarget: z.buyTarget, xianyuAnchor: z.xianyuAnchor }
    })
    overview.value.decisionLogs = res.decisionLogs
    toast(`卓威 ${z.model} 独立参考价已更新`)
  } catch (e) {
    toast(e.message)
  }
}

function testHandbookModel(m) {
  tab.value = 'sanity'
  activePresetId.value = ''
  simForm.name = `${m.brand || ''} ${m.model}`.trim()
  simForm.note = `${m.size}英寸 / ${m.res === '1K' ? '1920x1080' : m.res === '2K' ? '2560x1440' : '3840x2160'} / ${m.hz}Hz / ${m.panel}`
  simForm.crawledPrice = m.xianyuAnchor || ''
  runEvaluate()
}

function openEditSlot(s) {
  editingSlot.value = s
  slotDraft.fieldsText = (s.specFields || []).join('\n')
  slotDraft.splitRule = s.splitRule || ''
  slotDraft.sanityExample = s.sanityExample || ''
}

async function saveSlotEdit() {
  if (!editingSlot.value) return
  busy.value = true
  try {
    const res = await post(`/spec-baseline/categories/${encodeURIComponent(editingSlot.value.id)}`, {
      specFields: slotDraft.fieldsText.split('\n').map((x) => x.trim()).filter(Boolean),
      splitRule: slotDraft.splitRule,
      sanityExample: slotDraft.sanityExample
    })
    overview.value.categorySlots = res.categorySlots
    editingSlot.value = null
    toast('品类规格坑位已保存')
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

const goGallery = () => { location.hash = '#/selphys?p=' + encodeURIComponent('3C数码/显示器') }
const goSources = () => { location.hash = '#/sources' }
const goErrCase = () => { location.hash = '#/price-cleaning/SEL-2K240-ERR200' }
const openInPriceClean = (name) => {
  const code = String(name || '').trim().split(/\s+/).pop() || 'SEL-2K240-ERR200'
  location.hash = '#/price-cleaning/' + encodeURIComponent(code)
}

onMounted(loadOverview)
</script>

<style scoped>
.sbh { padding: 26px 38px 80px; max-width: 1640px; display: grid; gap: 16px; }
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.head h1 { font-size: 32px; margin: 6px 0; letter-spacing: -.02em; }
.eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); }
.sub { margin: 0; color: var(--mute); max-width: 920px; line-height: 1.65; }
.head-acts { display: flex; gap: 8px; flex-wrap: wrap; }

.kpi-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.kpi-card { background: var(--panel); border-radius: 18px; padding: 16px 18px; box-shadow: var(--sh); display: grid; gap: 4px; border-top: 4px solid var(--line); }
.kpi-card.grn { border-top-color: var(--grn); }
.kpi-card.acc { border-top-color: var(--acc); }
.kpi-card.amb { border-top-color: var(--amb); }
.kpi-card span { font-size: 13px; color: var(--mute); font-weight: 600; }
.kpi-card b { font-size: 28px; line-height: 1.15; }
.kpi-card b small { font-size: 13px; font-weight: 600; color: var(--mute); }
.kpi-card small { font-size: 12px; color: var(--mute); line-height: 1.45; }

.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { height: 40px; padding: 0 16px; border-radius: 12px; background: var(--soft); font-weight: 700; color: var(--ink2); display: inline-flex; align-items: center; gap: 8px; }
.tabs button.on { background: var(--acc); color: #fff; }
.tabs em { font-style: normal; font-size: 11.5px; padding: 2px 7px; border-radius: 999px; background: rgba(255,255,255,.18); }

.sec-grid { display: grid; gap: 16px; }
.dual-caliber-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 14px; }
.cal-card { display: grid; gap: 10px; border-left: 5px solid var(--acc); }
.cal-card.macro_outline { border-left-color: var(--amb); }
.cal-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cal-head h3 { margin: 0; font-size: 18px; }
.cal-list { display: grid; gap: 8px; }
.cal-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 10px; background: var(--soft); font-size: 13px; }
.cal-item small { color: var(--mute); margin-left: auto; }

.slot-sec-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
.slot-sec-head h3 { margin: 0 0 4px; font-size: 20px; }
.slots-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 14px; }
.slot-card { display: grid; gap: 9px; align-content: start; border-top: 4px solid var(--line); }
.slot-card.active_full { border-top-color: var(--grn); }
.slot-card.reserved_ready { border-top-color: var(--acc); }
.sc-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.sc-top h4 { margin: 6px 0 0; font-size: 18px; }
.sc-meta { font-size: 13px; color: var(--ink2); }
.sc-meta span:first-child { color: var(--mute); }
.sc-fields { display: flex; gap: 6px; flex-wrap: wrap; }
.f-chip { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 8px; background: var(--soft); color: var(--ink); }
.sc-rule, .sc-sanity { font-size: 12.8px; line-height: 1.55; padding: 8px 10px; border-radius: 10px; background: var(--soft); }
.sc-sanity { background: var(--amb-soft); color: var(--ink); }

.preset-bar { display: grid; gap: 10px; }
.preset-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.p-chip { padding: 7px 12px; border-radius: 10px; background: var(--soft); font-size: 13px; font-weight: 600; text-align: left; }
.p-chip.on { background: var(--acc); color: #fff; }

.sanity-split { display: grid; grid-template-columns: 1fr 1.15fr; gap: 16px; }
@media (max-width: 980px) { .sanity-split, .cal-layout { grid-template-columns: 1fr !important; } }
.form-box, .res-box { display: grid; gap: 12px; align-content: start; }
.form-box h3, .res-box h3 { margin: 0; }
.f-grid { display: grid; gap: 10px; }
.f-grid label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
.f-grid input { height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--soft); color: var(--ink); font: inherit; }
.f-btns { display: flex; gap: 8px; flex-wrap: wrap; }

.rb-head { padding: 14px 16px; border-radius: 14px; display: grid; gap: 6px; }
.rb-head.ok { background: var(--grn-soft, rgba(22,163,74,.1)); }
.rb-head.bad { background: var(--red-soft, rgba(220,38,38,.12)); border: 1px solid var(--red); }
.rb-head.hi { background: var(--acc-soft); }
.rb-head p { margin: 0; font-size: 13.5px; line-height: 1.6; }
.rb-kv { display: grid; grid-template-columns: 130px 1fr; gap: 8px 12px; margin: 0; font-size: 13.5px; }
.rb-kv dt { color: var(--mute); }
.rb-kv dd { margin: 0; }

.cal-layout { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
.tbl-wrap { overflow-x: auto; display: grid; gap: 12px; }
.tw-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.tw-head h3 { margin: 0 0 4px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 10px 12px; background: var(--soft); color: var(--mute); font-size: 12px; white-space: nowrap; }
.tbl td { padding: 9px 12px; border-top: 1px solid var(--line); white-space: nowrap; }
.hi-num { color: var(--acc); }

.decide-panel { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; align-items: start; }
.decide-panel h3, .decide-panel > p, .decide-panel .dp-note, .decide-panel .full, .decide-panel .log-box { grid-column: 1 / -1; margin: 0; }
.dp-group { display: grid; gap: 7px; padding: 10px 12px; border-radius: 12px; background: var(--soft); font-size: 13px; }
.dp-group label { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dp-group input { width: 86px; height: 30px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--panel); font-weight: 700; text-align: right; }
.dp-note { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
.dp-note input { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; background: var(--soft); }
.full { width: 100%; justify-content: center; }
.log-box { display: grid; gap: 6px; font-size: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.lg-row { padding: 6px 8px; border-radius: 8px; background: var(--soft); }
.lg-row span { color: var(--mute); }
.lg-row p { margin: 3px 0 0; line-height: 1.45; }

.srch-inp { width: 260px; height: 36px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--soft); }
.num-xs { width: 76px; height: 30px; border: 1px solid var(--line); border-radius: 8px; padding: 0 8px; background: var(--soft); font-weight: 700; }
.hb-flt { display: flex; gap: 6px; flex-wrap: wrap; }
.hb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.hb-card { padding: 12px 14px; border-radius: 14px; background: var(--soft); display: grid; gap: 6px; align-content: start; }
.hbc-top { display: flex; justify-content: space-between; align-items: center; }
.hb-card h4 { margin: 0; font-size: 15.5px; }
.hb-spec, .hb-price, .hb-note { margin: 0; font-size: 12.5px; line-height: 1.45; }
.hb-price { display: flex; justify-content: space-between; font-weight: 700; color: var(--acc); }
.hb-price small { color: var(--mute); font-weight: 500; }
.hb-note { color: var(--mute); }

.mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 90; padding: 20px; }
.modal { background: var(--panel); border-radius: 18px; padding: 22px; width: min(560px, 100%); display: grid; gap: 14px; box-shadow: var(--sh); }
.modal h3 { margin: 0; }
.mform { display: grid; gap: 10px; }
.mform label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
.mform textarea { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--soft); color: var(--ink); font: inherit; }
.mfoot { display: flex; justify-content: flex-end; gap: 8px; }
.sm { font-size: 12.5px; }
.pad { padding: 24px; }
</style>
