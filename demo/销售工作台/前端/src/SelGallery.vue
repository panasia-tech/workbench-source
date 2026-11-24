<template>
  <div class="page sg">
    <header class="head">
      <div>
        <h1>{{ isPhys ? '实物选品 Gallery' : '虚拟选品 Gallery' }}<Q :k="isPhys ? 'sel-phys' : 'sel-virt'" /></h1>
        <p class="sub">{{ isPhys ? '按品牌与规格视觉下钻选品，支持多视角切换。' : '大类 → 细分 → 子类 → 产品卡逐层视觉选品。' }}</p>
      </div>
      <div class="srch">
        <button class="btn" @click="showRules = !showRules">📊 {{ showRules ? '收起覆盖与规则' : '覆盖与分流规则 ▾' }}</button>
        <button v-if="isPhys" class="btn" @click="goBaselineHub">⚙ 规格与兜底基准台</button>
        <button v-if="isPhys" class="btn" @click="exportCsv">导出 CSV</button>
        <button v-if="!isPhys" class="btn" @click="goVirtIntel">外部情报与同题赛马中心 →</button>
        <button v-if="!isPhys" class="btn pri" @click="goVirtNew">+ 新增虚拟商品卡</button>
        <input v-model="q" :placeholder="isPhys ? '搜型号 / 品牌 / OLED / 240Hz（全库）' : '搜产品名 / 品牌'" @input="page = 1" />
      </div>
    </header>

    <section v-if="showRules" class="gaps" :class="{ hot: isPhys }">
      <div class="gh"><b>这一块现在覆盖与缺口实况</b><span class="muted">（95%千元内走量款自动同档兜底+防呆；5%高端款直接按实爬算；卓威独立表）</span></div>
      <div class="gc"><span v-for="g in gapChips" :key="g.t" class="gp" :class="g.cls"><b>{{ g.n }}</b>{{ g.t }}<small>{{ g.who }}</small></span></div>
    </section>

    <!-- 实物选品多视角切换栏（默认：品牌 + 规格） -->
    <section v-if="isPhys" class="persp-bar">
      <span class="p-lbl">视角：</span>
      <button v-for="pv in PERSPECTIVES" :key="pv.k" class="p-btn" :class="{ on: perspective === pv.k }" @click="setPerspective(pv.k)">
        {{ pv.t }}
      </button>
      <button v-if="path[1] !== '显示器'" class="p-jump" @click="jumpMonitors">直达显示器 7,790+ 款 ›</button>
    </section>

    <!-- 当前品类预留规格坑位提示条（随规则面板按需展开） -->
    <section v-if="showRules && isPhys && curCatSlot" class="cat-slot-banner" :class="curCatSlot.mode">
      <div>
        <span class="tag" :class="curCatSlot.mode === 'reserved' ? 'acc' : 'grn'">
          {{ curCatSlot.mode === 'reserved' ? '复杂品类 · 规格坑位已预留' : '简单标品 · 极简直爬不折腾' }}
        </span>
        <b>{{ curCatSlot.title }}</b>
        <span class="muted">{{ curCatSlot.desc }}</span>
      </div>
      <button v-if="curCatSlot.mode === 'reserved'" class="btn sm" @click="goBaselineHub">去配置该品类规格槽 ›</button>
    </section>

    <nav class="crumb">
      <button @click="go([])">全部</button>
      <template v-for="(s, i) in path" :key="i"><span>›</span><button @click="go(path.slice(0, i + 1))">{{ s }}</button></template>
      <button v-if="isPhys && groups.length && path.length >= 2 && !flatHere" class="btn sm flat-btn" @click="flatHere = true">同屏平铺本层全部型号</button>
      <button v-else-if="flatHere" class="btn sm flat-btn" @click="flatHere = false">恢复分组卡片视图</button>
    </nav>

    <!-- 中间层：大类 / 品类 / 品牌 / 规格档 / 面板 / 分流轨道 -->
    <div v-if="!searched && !flatHere && groups.length" class="grid g">
      <article v-for="g in groups" :key="g.key" class="gcard" :class="{ warn: g.key === UN || g.key.includes('拦截') }" @click="go([...path, g.key])">
        <div class="gbig">{{ g.n.toLocaleString() }}<small>{{ isPhys ? '个型号' : '张产品卡' }}</small></div>
        <h3>{{ g.key }}</h3>
        <div class="gst">
          <template v-if="isPhys">
            <span class="tag" :class="g.priced ? 'grn' : ''">实爬价 {{ g.priced }}</span>
            <span v-if="g.fallback" class="tag acc">走量兜底 {{ g.fallback }}</span>
            <span v-if="g.blocked" class="tag red">防呆拦截 {{ g.blocked }}</span>
            <span v-if="g.inStock" class="tag grn">在库 {{ g.inStock }}</span>
            <span v-if="g.noBrand && path.length < 2" class="tag amb">待补品牌 {{ g.noBrand }}</span>
          </template>
          <template v-else>
            <span class="tag">已上架 {{ g.live }}</span>
            <span class="tag amb">阶段中 {{ g.n - g.live - g.clue }}</span>
            <span v-if="g.clue" class="tag">线索 / 缺口 {{ g.clue }}</span>
          </template>
        </div>
        <p class="sub2">{{ g.sub }}</p>
      </article>
    </div>

    <!-- 最后一层：型号 / SKU 卡片 -->
    <template v-if="searched || flatHere || leafModels.length">
      <div v-if="isPhys && (path[1] === '显示器' || searched)" class="facets">
        <span class="lb">快筛：</span>
        <button v-for="f in SIZES" :key="f" :class="{ on: fs === f }" @click="fs = fs === f ? '' : f; page = 1">{{ f }}英寸</button>
        <button v-for="f in RES" :key="f" :class="{ on: fr === f }" @click="fr = fr === f ? '' : f; page = 1">{{ f }}</button>
        <button v-for="hz in HZS" :key="hz.k" :class="{ on: fhz === hz.k }" @click="fhz = fhz === hz.k ? '' : hz.k; page = 1">{{ hz.t }}</button>
        <button :class="{ on: ftrack === 'volume_95' }" @click="ftrack = ftrack === 'volume_95' ? '' : 'volume_95'; page = 1">只看95%走量款</button>
        <button :class="{ on: ftrack === 'highend_5' }" @click="ftrack = ftrack === 'highend_5' ? '' : 'highend_5'; page = 1">只看5%高端款</button>
        <button :class="{ on: ftrack === 'zowie' }" @click="ftrack = ftrack === 'zowie' ? '' : 'zowie'; page = 1">只看卓威ZOWIE</button>
        <button :class="{ on: onlyGap }" @click="onlyGap = !onlyGap; page = 1">只看无实爬(看兜底)</button>
      </div>
      <div v-if="!isPhys" class="facets"><span class="lb">口径：</span><button v-for="f in VFILTERS" :key="f.k" :class="{ on: vf === f.k }" @click="vf = vf === f.k ? '' : f.k">{{ f.t }}</button></div>
      <p class="muted cnt">共 {{ models.length.toLocaleString() }} {{ isPhys ? '个型号' : '张产品卡' }}<template v-if="models.length > shown.length">，先显示 {{ shown.length }}</template></p>
      <div class="grid m">
        <article v-for="m in shown" :key="m.key" class="mcard" :class="{ 'warn-card': m.mev?.priceState === '异常低价拦截' }" @click="open(m)">
          <div class="mimg" :class="{ ph: !m.img, lg: m.logo && m.img }">
            <img v-if="m.img" :src="m.img" alt="" />
            <template v-else><b>{{ m.brand || '品牌待补' }}</b><span>{{ m.model }}</span></template>
            <i v-if="isPhys && m.inStock" class="tag grn ib">在库 {{ m.inStock }}</i>
            <i v-else-if="isPhys && m.mev?.priceState === '异常低价拦截'" class="tag red ib">🚨 假价已拦</i>
            <i v-if="!isPhys && m.kind !== 'game' && m.kind !== 'gap'" class="tag ib" :class="m.live ? 'grn' : 'amb'">{{ m.live ? '已上架' : '第 ' + m.step + '/8 步' }}</i>
            <i v-if="m.kind === 'game'" class="tag ib" :class="m.pid ? 'grn' : 'amb'">{{ m.pid ? '已有服务' : '线索' }}</i>
            <i v-if="m.kind === 'gap'" class="tag ib red">缺口</i>
          </div>
          <div class="mbody">
            <h3>{{ m.brand && !m.name.startsWith(m.brand) ? `${m.brand} ${m.name}` : m.name }}</h3>
            <div v-if="isPhys" class="mst">
              <span v-if="m.spec" class="tag">{{ m.spec.size }}″ · {{ m.spec.res }} · {{ m.spec.hz }}Hz · {{ m.spec.panel }}</span>
              <!-- 价格与兜底状态签 -->
              <span v-if="m.mev?.priceState === '异常低价拦截'" class="tag red">
                错爬¥{{ m.price }}已拦 → 兜底¥{{ m.mev.fallbackPrice }}
              </span>
              <span v-else-if="m.price" class="tag grn">实爬 ¥{{ m.price }}</span>
              <span v-else-if="m.mev?.track === 'volume_95' && m.mev?.fallbackPrice" class="tag acc">
                走量兜底 ¥{{ m.mev.fallbackPrice }}
              </span>
              <span v-else-if="m.mev?.track === 'zowie' && m.mev?.fallbackPrice" class="tag amb">
                卓威参考 ¥{{ m.mev.fallbackPrice }}
              </span>
              <span v-else-if="m.mev?.track === 'highend_5'" class="tag amb">高端待实爬(不套公式)</span>
              <span v-else class="tag red">无行情</span>

              <span v-if="m.cat === '显示器' && m.mev" class="tag" :class="m.mev.track === 'volume_95' ? '' : m.mev.track === 'zowie' ? 'amb' : m.mev.track === 'highend_5' ? 'acc' : 'amb'">
                {{ m.mev.track === 'volume_95' ? '95%走量' : m.mev.track === 'zowie' ? '卓威专表' : m.mev.track === 'highend_5' ? '5%高端' : '规格待补' }}
              </span>
              <span v-if="!m.brand" class="tag amb">待补品牌</span>
              <span v-if="m.spu" class="tag acc">有 SPU</span>
            </div>
            <div v-else-if="m.kind === 'game' || m.kind === 'gap'" class="mst"><span class="tag" :class="m.kind === 'gap' ? 'red' : m.pid ? 'grn' : 'amb'">{{ m.note }}</span></div>
            <div v-else class="mst"><span class="tag">¥{{ m.price }}</span><span class="tag" :class="m.lt === 'follow' ? 'acc' : 'amb'">{{ m.lt === 'follow' ? '跟卖型' : m.lt === 'route' ? '路测型' : '试经营' }}</span><span class="tag">榜单信号：未采集</span></div>
          </div>
        </article>
      </div>
      <p v-if="!shown.length" class="muted pad">这一层没有符合筛选条件的型号。</p>
      <div v-if="models.length > shown.length" class="more"><button class="btn" @click="page++">再显示 {{ Math.min(PAGE, models.length - shown.length) }} 个</button></div>
    </template>

    <!-- 型号详情（右侧抽屉，实物） -->
    <div v-if="sel && isPhys" class="mask" @click.self="sel = null"><aside class="drawer">
      <div class="dh"><div><p class="eyebrow">{{ sel.big }} › {{ sel.cat }}<template v-if="sel.brand"> › {{ sel.brand }}</template></p><h2>{{ sel.brand && !sel.name.startsWith(sel.brand) ? `${sel.brand} ${sel.name}` : sel.name }}</h2></div><button class="btn sm" @click="sel = null">关闭</button></div>
      <div v-if="sel.img" style="margin:10px 0 14px;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--soft);max-height:220px;display:flex;align-items:center;justify-content:center">
        <img :src="sel.img" alt="" style="max-height:220px;width:100%;object-fit:contain" />
      </div>
      <h4>身份与硬参数（刷新率直接按超频最高值归档）</h4>
      <dl class="kv">
        <dt>品牌</dt><dd>{{ sel.brand || '缺品牌（模糊短码未硬猜，待从垂类厂商库补）' }}</dd>
        <dt>型号</dt><dd>{{ sel.model }}</dd>
        <dt>规格</dt><dd>{{ sel.spec ? `${sel.spec.size}英寸 / ${sel.spec.res} / ${sel.spec.hz}Hz / ${sel.spec.panel}` : (sel.specText || '—') }}</dd>
        <dt>SPU 码</dt><dd>{{ sel.spu ? sel.spu.c : '没有（还没进 WMS 的 SPU 对照表）' }}</dd>
        <dt>在库</dt><dd>{{ sel.inStock ? sel.inStock + ' 件' : '没有库存（目录有记录不等于有库存）' }}</dd>
      </dl>

      <!-- 显示器三路分流 + 防呆尺 + 走量兜底核验卡 -->
      <template v-if="sel.cat === '显示器' && sel.mev">
        <h4>规格分流 · 防呆尺 · 兜底策略 <button class="btn sm" @click="goBaselineHub">调基准系数 ›</button></h4>
        <div class="base-eval-box" :class="sel.mev.priceState === '异常低价拦截' ? 'bad' : sel.mev.track === 'highend_5' ? 'hi' : 'ok'">
          <div class="beb-top">
            <span class="tag" :class="sel.mev.track === 'volume_95' ? 'grn' : sel.mev.track === 'zowie' ? 'amb' : 'acc'">{{ sel.mev.trackShort }}</span>
            <span class="tag">{{ sel.mev.specBucketLabel }}</span>
          </div>
          <p v-if="sel.mev.sanityWarn" class="beb-warn">🚨 {{ sel.mev.sanityWarn }}</p>
          <div class="beb-nums">
            <div><span>手册收货底价</span><b>{{ sel.mev.buyBaseline ? `¥${sel.mev.buyBaseline}` : '按实爬单议' }}</b></div>
            <div><span>同档走量兜底价</span><b>{{ sel.mev.fallbackPrice ? `¥${sel.mev.fallbackPrice}` : '高端不套公式' }}</b></div>
            <div><span>最终采信参考价</span><b>{{ sel.mev.effectivePrice ? `¥${sel.mev.effectivePrice}` : '待实爬' }}</b></div>
          </div>
        </div>
      </template>

      <h4>闲鱼实爬行情与快照清洗<Q k="sel-price" /> <button class="btn sm pri" @click="goClean(sel)">🔍 价格清洗(看闲鱼快照)</button></h4>
      <div class="pbox" :class="sel.mev?.priceState === '异常低价拦截' ? 'none' : sel.price ? '' : 'none'">
        <template v-if="sel.mev?.priceState === '异常低价拦截'">
          <b>¥{{ sel.price }}（假低价已阻断）</b>
          <span>基准防呆尺判定该实爬价混入坏屏/支架/老后缀，已拦截直接填入，暂改显同档兜底 ¥{{ sel.mev.fallbackPrice }}。点右上「价格清洗」核查快照！</span>
        </template>
        <template v-else-if="sel.price">
          <b>¥{{ sel.price }}</b>
          <span>{{ sel.priceDate }}　口径：关键词搜索第 1 页、剔除诱饵及配件噪声并通过基准防呆尺核验后的<b>闲鱼实爬均价</b></span>
        </template>
        <template v-else-if="sel.mev?.track === 'volume_95' && sel.mev?.fallbackPrice">
          <b style="color:var(--acc)">闲鱼无样本 → 走量同档兜底 ¥{{ sel.mev.fallbackPrice }}</b>
          <span style="color:var(--ink2)">属 95% 千元内走量款，已按同品牌档+分辨率+超频刷新率实爬中位价与手册基准兜底。</span>
        </template>
        <template v-else>
          <b>暂无闲鱼实爬价</b>
          <span>{{ sel.mev?.track === 'highend_5' ? '属 5% 千元以上高端稀缺款（货少无同档参考），严格不套走量公式编低价，请点「价格清洗」补充别名重爬。' : '爬虫没取到有效在售价。' }}</span>
        </template>
      </div>

      <h4>选品状态</h4>
      <div class="steps"><button v-for="s in STAGES" :key="s" :class="{ on: state2 === s }" @click="setStage(s)">{{ s }}</button></div>
      <p class="muted sm">未选 → 调研中 → 开采决定 → 采购观察 → 复盘（禅道 B07）。状态已保存在本浏览器（演示）；真环境写 WMS。</p>
      <h4>身份补充<Q k="sel-id" /></h4>
      <div class="idf"><label>系列<input v-model="selMeta.series" placeholder="例如 飞利浦 Evnia 系列" /></label><label>配置<input v-model="selMeta.config" placeholder="芯片 / 内存 / 存储 / 超频Hz" /></label><label>地区 / 后缀<input v-model="selMeta.region" placeholder="国行 / 日版 / 型号后缀" /></label><label>EAN / UPC<input v-model="selMeta.ean" placeholder="条码" /></label></div>
      <button class="btn sm" @click="saveMeta">存身份补充</button>
      <h4>本周主题 / 开采决定</h4>
      <div class="thm"><span class="tag">{{ curTheme ? curTheme.week + ' · ' + curTheme.theme : '本周还没排主题' }}</span><button class="btn sm" :disabled="!curTheme" @click="joinTheme">加入本周主题</button><span v-if="selMeta.theme" class="tag grn">已加入 {{ selMeta.theme }}</span></div>
      <div class="mine"><label>采购员<input v-model="mineForm.by" placeholder="派给谁采购" /></label><label>预算<input v-model.number="mineForm.budget" type="number" /></label><label>报价规则<input v-model="mineForm.rule" placeholder="例如 行情 70%" /></label><label>有效期<input v-model="mineForm.valid" placeholder="11-20" /></label><label>观察周期<input v-model="mineForm.observe" placeholder="7 天" /></label></div>
      <p v-if="pbMatch(sel)" class="sm" :style="{ color: mineForm.budget && mineForm.budget > pbMatch(sel).limit ? 'var(--red-ink)' : 'var(--grn-ink)', fontWeight: 700, margin: '6px 0' }">{{ mineForm.budget && mineForm.budget > pbMatch(sel).limit ? '⚠ 预算 ¥' + mineForm.budget + ' 已超出采购价格表授权上限 ¥' + pbMatch(sel).limit : '✓ 采购价格表联动：建议报价 ¥' + pbMatch(sel).suggest + ' ｜ 授权上限 ¥' + pbMatch(sel).limit }}</p>
      <button class="btn sm pri" @click="saveMining">存开采决定</button><span v-if="finalDb.mining[sel.key]" class="tag grn">已存 {{ finalDb.mining[sel.key].at }}</span>
      <h4>派给业务员</h4>
      <div class="asg"><select v-model="to"><option v-for="(n, u) in TEAM" :key="u" :value="u">{{ n }}</option></select><button class="btn pri" :disabled="REAL" @click="assign">加入今天的调研</button><span v-if="REAL" class="muted">真实环境只读</span></div>
      <h4>这个型号还缺什么</h4>
      <ul class="miss"><li v-for="g in missing(sel)" :key="g.t"><span class="tag" :class="g.cls">{{ g.who }}</span>{{ g.t }}</li></ul>
    </aside></div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import Q from './Q.vue'
import { api, post, REAL } from './api.js'
import { state } from './store.js'
import { toast } from './ui.js'
import { TAX, UNCLS, classify, parseSpec, evalMonitorModel, PRE_RESERVED_CATEGORY_SLOTS } from './selTax.js'
import { finalDb, selectionOf } from './demoFinal.js'

const props = defineProps({ kind: String })
const isPhys = computed(() => props.kind === 'phys')
const UN = UNCLS, PAGE = 48
const q = ref(''), page = ref(1), sel = ref(null), fs = ref(''), fr = ref(''), fhz = ref(''), ftrack = ref(''), onlyGap = ref(false), state2 = ref('未选'), to = ref('chenxm')
const vf = ref('')
const flatHere = ref(false)
const showRules = ref(false)

// 多视角切换（A6：默认按「品牌 + 规格」）
const perspective = ref('brand_spec')
const PERSPECTIVES = [
  { k: 'brand_spec', t: '按品牌 + 规格（默认）' },
  { k: 'track_split', t: '按走量/高端分流（95% vs 5% vs 卓威）' },
  { k: 'spec_bucket', t: '按规格档位（1K180 · 2K240 · 4K…）' },
  { k: 'panel_type', t: '按面板类型（IPS · OLED · MiniLED · TN）' },
  { k: 'price_state', t: '按价格状态（实爬 · 防呆拦截 · 同档兜底）' }
]

const VFILTERS = [{ k: 'card', t: '卡密' }, { k: 'topup', t: '代充' }, { k: 'manual', t: '人工' }, { k: 'selfserve', t: '自助' }]
const selMeta = reactive({ series: '', config: '', region: '', ean: '', theme: '' })
const mineForm = reactive({ by: '', budget: null, rule: '', valid: '', observe: '' })
const curTheme = computed(() => finalDb.themes.find((t) => t.state === '进行中'))
const STAGES = ['未选', '调研中', '开采决定', '采购观察', '复盘']
const SIZES = ['22', '24', '27', '32', '34']
const RES = ['1080P', '2K', '4K', '带鱼超宽']
const HZS = [
  { k: 'office', t: '办公≤100Hz' },
  { k: '180', t: '180档(120~200Hz)' },
  { k: '240', t: '240档(201~280Hz)' },
  { k: '300+', t: '300Hz+超高刷' }
]
const TEAM = computed(() => (Object.keys(state.pool || {}).length ? state.pool : { chenxm: '陈小满', zhoubb: '周小北' }))
const all = ref([]), snapDate = ref(''), loading = ref(true), dupN = ref(0)

const parsePath = () => { const m = /[?&]p=([^&]*)/.exec(location.hash); return m ? decodeURIComponent(m[1]).split('/').filter(Boolean) : [] }
const path = ref(parsePath())
window.addEventListener('hashchange', () => { path.value = parsePath(); page.value = 1; flatHere.value = false })
const go = (p) => { const base = location.hash.split('?')[0]; location.hash = base + (p.length ? '?p=' + encodeURIComponent(p.join('/')) : ''); sel.value = null; flatHere.value = false }

function setPerspective(k) {
  perspective.value = k
  page.value = 1
  flatHere.value = false
  // 若当前已深入到第3层以下，回到品类层（如 3C数码/显示器）以便立刻看到新视角分组
  if (path.value.length > 2) go(path.value.slice(0, 2))
}

function jumpMonitors() {
  go(['3C数码', '显示器'])
}

const curCatSlot = computed(() => {
  const cat = path.value[1]
  return cat && PRE_RESERVED_CATEGORY_SLOTS[cat] ? PRE_RESERVED_CATEGORY_SLOTS[cat] : null
})

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
function physThumbOf(name, brand, model, idxSeed = 1) {
  const u = `${brand || ''} ${model || ''} ${name || ''}`.toUpperCase()
  let pfx = 'MON1'
  if (u.includes('净化器') || u.includes('ACM') || u.includes('4LITE')) pfx = 'PUR'
  else if (u.includes('SONOS') || u.includes('哈曼') || u.includes('琉璃') || u.includes('音箱') || u.includes('音响')) pfx = 'SPK'
  else if (u.includes('云鲸') || u.includes('石头') || u.includes('追觅') || u.includes('YJCC')) pfx = 'ROB'
  else if (u.includes('戴森') || u.includes('DYSON') || u.includes('HT01') || u.includes('HD08') || u.includes('ULIKE') || u.includes('脱毛')) pfx = 'DYS'
  else if (u.includes('IPAD')) pfx = 'IPAD9'
  else if (u.includes('MAC') || u.includes('BOOK') || u.includes('笔记本')) pfx = 'MBA'
  else if (u.includes('AIRPODS')) pfx = 'APP2'
  else if (u.includes('IPHONE') || u.includes('APPLE') || u.includes('苹果')) pfx = 'IP14'
  else if (u.includes('飓风') || u.includes('HYPERX') || u.includes('耳机') || u.includes('XM4')) pfx = 'XM4'
  else if (u.includes('SWITCH') || u.includes('佳明') || u.includes('GARMIN')) pfx = 'SW'
  else if (u.includes('索尼') || u.includes('相机') || u.includes('镜头')) pfx = 'Z30'
  else if (u.includes('AOC')) pfx = 'MON_AOC'
  else if (u.includes('LG')) pfx = 'MON_LG'
  else if (u.includes('华硕') || u.includes('ASUS') || u.includes('ROG') || u.includes('VG27') || u.includes('XG27') || u.includes('PG2')) pfx = 'MON_ROG'
  else if (u.includes('宏碁') || u.includes('ACER')) pfx = 'MON_ACER'
  else if (u.includes('24') || u.includes('25') || u.includes('XL2')) pfx = 'MON2'
  const n = (Math.abs(idxSeed) % 8) + 1
  return `/api/demo-img/library/${pfx}-lib-${n}.jpg`
}

async function loadPhys() {
  const snap = await (await fetch('/data/catalog-snapshot.json')).json()
  snapDate.value = snap.date
  const bySpu = new Map(snap.spu.map((s) => [norm(`${s.b || ''}${s.m || ''}`), s]))
  const items = state.items.filter((i) => i.kind === 'phys')
  const codes = new Map(); for (const s of snap.spu) for (const k of s.k || []) codes.set(k, s)
  const stock = new Map(); for (const it of items) { const s = codes.get(it.code); if (s) stock.set(s.c, (stock.get(s.c) || 0) + 1) }
  const out = [], seen = new Set(), byN = new Map()
  for (const m of snap.mk) { const k = norm(m.n), o = byN.get(k); if (!o || (!o.p && m.p) || (o.p && m.p && (m.d || '') > (o.d || ''))) byN.set(k, m) }
  dupN.value = snap.mk.length - byN.size
  let seq = 0
  for (const m of byN.values()) {
    seq += 1
    const c = classify(m.n, m.s), sp = bySpu.get(norm(m.n)), key = 'm:' + m.i
    if (sp) seen.add(sp.c)
    const br = c.brand || (sp?.b || '')
    const spObj = parseSpec(m.s, c.model)
    // 典型防呆样板同步：P2710S 演示 2K 240Hz 错爬成 ¥200 被基准防呆尺标红拦截
    const isErrDemo = norm(c.model) === 'p2710s' && !m.p
    const rawPrice = isErrDemo ? 200 : (m.p ? Math.round(+m.p) : null)
    const mev = c.cat === '显示器' ? evalMonitorModel(br, c.model, spObj, rawPrice) : null
    out.push({
      key,
      cleanCode: isErrDemo ? 'SEL-2K240-ERR200' : (c.model || m.n),
      name: m.n,
      brand: br,
      model: c.model,
      big: c.big,
      cat: c.cat,
      spec: spObj,
      specText: spObj ? `${spObj.size}″/${spObj.res}/${spObj.hz}Hz/${spObj.panel}` : '',
      price: rawPrice,
      priceDate: m.d || (isErrDemo ? '2026-11-18' : ''),
      enabled: m.e,
      spu: sp || null,
      inStock: sp ? stock.get(sp.c) || 0 : 0,
      mev,
      img: physThumbOf(m.n, br, c.model, seq)
    })
  }
  for (const s of snap.spu) {
    if (!seen.has(s.c)) {
      seq += 1
      const nm = `${s.b || ''} ${s.m || ''}`.trim(), c = classify(nm, ''), br = s.b || c.brand
      const spObj = parseSpec('', s.m || c.model)
      const mev = c.cat === '显示器' ? evalMonitorModel(br, s.m || c.model, spObj, null) : null
      out.push({
        key: 's:' + s.c,
        cleanCode: s.m || nm || s.c,
        name: nm || s.c,
        brand: br,
        model: s.m || '',
        big: c.big,
        cat: c.cat,
        spec: spObj,
        specText: '',
        price: null,
        priceDate: '',
        enabled: false,
        spu: s,
        inStock: stock.get(s.c) || 0,
        mev,
        img: physThumbOf(nm, br, s.m, seq)
      })
    }
  }
  all.value = out
}

async function loadVirt() {
  const r = await api('/virtual/products')
  all.value = (r.items || []).map((p) => ({ key: 'v:' + p.id, id: p.id, kind: p.kind, name: p.name, brand: p.brand, model: p.face, path: p.path.slice(0, -1), price: p.price, step: p.step, live: p.step >= 8, lt: p.listing_type, delivery: p.delivery || p.delivery_label || '', region: p.region || '', platforms: p.platforms || [], img: `/api/demo-img/V-${p.cover}.jpg` }))
  try {
    const gs = await (await fetch('/data/games.json')).json(), im = await (await fetch('/data/source-images.json')).json()
    for (const g of gs) all.value.push({ key: 'game:' + g.id, kind: 'game', id: g.id, pid: g.pid || '', name: g.name, brand: '游戏', model: '', path: ['D 游戏', 'D1 游戏技术服务'], price: null, step: 0, live: false, lt: 'game', note: g.note, logo: true, img: im[g.img.replace(/\.\w+$/, '')] ? '/img/sources/' + im[g.img.replace(/\.\w+$/, '')].file : '' })
    all.value.push({ key: 'game:cards', kind: 'gap', id: 'cards', name: '游戏卡榜（闲鱼 60002）', brand: '游戏', model: '', path: ['D 游戏', 'D2 游戏卡'], price: null, step: 0, live: false, lt: 'gap', note: '榜单还没采集：要程序员接（B11）', logo: true, img: im.xianyu ? '/img/sources/' + im.xianyu.file : '' })
  } catch { /* 没有游戏数据就不显示这个大类 */ }
}

onMounted(async () => { try { if (!state.items.length) await import('./store.js').then((m) => m.loadAll()); await (isPhys.value ? loadPhys() : loadVirt()) } catch (e) { toast('读不到：' + e.message) } finally { loading.value = false } })
watch(() => props.kind, async () => { loading.value = true; all.value = []; path.value = parsePath(); await (isPhys.value ? loadPhys() : loadVirt()); loading.value = false })

// 多视角动态层级树！简单标品（扫地机器人/净化器等）始终保持干净的「大类 → 品类 → 品牌」，显示器支持 5 大专业视角！
function levels(m) {
  if (!isPhys.value) return m.path || []
  if (m.cat !== '显示器') return [m.big, m.cat, m.brand || '品牌待补']
  const br = m.brand || '品牌待补'
  const mv = m.mev || {}
  if (perspective.value === 'track_split') return [m.big, m.cat, mv.trackShort || '规格待补', br]
  if (perspective.value === 'spec_bucket') return [m.big, m.cat, mv.specBucketLabel || '规格待补', br]
  if (perspective.value === 'panel_type') return [m.big, m.cat, mv.panelGroup || '未知面板', br]
  if (perspective.value === 'price_state') return [m.big, m.cat, mv.priceState || '无行情']
  // 默认视角：品牌 + 规格（大类 → 显示器 → 品牌 → 规格档）
  return [m.big, m.cat, br, mv.specBucketLabel || '常规规格']
}

const inPath = (m) => path.value.every((s, i) => levels(m)[i] === s)
const searched = computed(() => {
  const t = norm(q.value)
  if (!t) return null
  return all.value.filter((m) => norm(`${m.name}${m.brand || ''}${m.model || ''}${m.specText || ''}${m.mev?.trackShort || ''}`).includes(t))
})

const groups = computed(() => {
  const d = path.value.length, map = new Map()
  for (const m of all.value) {
    if (!inPath(m)) continue
    const k = levels(m)[d]; if (k == null) continue
    if (!map.has(k)) map.set(k, { key: k, n: 0, priced: 0, fallback: 0, blocked: 0, inStock: 0, noBrand: 0, live: 0, clue: 0, sub: new Set() })
    const g = map.get(k)
    g.n++
    if (m.mev?.priceState === '异常低价拦截') g.blocked++
    else if (m.price) g.priced++
    else if (m.mev?.fallbackPrice) g.fallback++
    if (m.inStock) g.inStock++
    if (!m.brand) g.noBrand++
    if (m.live) g.live++
    if ((m.kind === 'game' && !m.pid) || m.kind === 'gap') g.clue++
    const nx = levels(m)[d + 1]; if (nx != null && g.sub.size < 4) g.sub.add(nx)
  }
  const order = isPhys.value && d === 0 ? TAX.map((t) => t.big).concat(UN) : null
  return [...map.values()].map((g) => ({ ...g, sub: g.sub.size ? [...g.sub].join('、') + (g.n > 4 ? ' …' : '') : '' })).sort((a, b) => {
    if (order) return order.indexOf(a.key) - order.indexOf(b.key)
    if (a.key === '品牌待补') return 1
    if (b.key === '品牌待补') return -1
    return b.n - a.n
  })
})

const leafModels = computed(() => all.value.filter((m) => inPath(m) && (flatHere.value || levels(m).length === path.value.length)))
const bucket = (sz) => SIZES.reduce((a, b) => (Math.abs(+b - sz) < Math.abs(+a - sz) ? b : a))
const models = computed(() => {
  let l = searched.value || leafModels.value
  if (fs.value) l = l.filter((m) => m.spec && bucket(m.spec.size) === fs.value)
  if (fr.value) l = l.filter((m) => m.spec?.res === fr.value)
  if (fhz.value) {
    l = l.filter((m) => {
      const hz = m.spec?.hz || 0
      if (fhz.value === 'office') return hz > 0 && hz <= 110
      if (fhz.value === '180') return hz > 110 && hz <= 200
      if (fhz.value === '240') return hz > 200 && hz <= 280
      return hz >= 300
    })
  }
  if (ftrack.value) l = l.filter((m) => m.mev?.track === ftrack.value)
  if (onlyGap.value) l = l.filter((m) => !m.price)
  if (!isPhys.value && vf.value) l = l.filter((m) => String(m.delivery || m.lt || '').toLowerCase().includes(vf.value))
  return l.slice().sort((a, b) => ((b.inStock || 0) - (a.inStock || 0)) || ((b.mev?.priceState === '异常低价拦截') - (a.mev?.priceState === '异常低价拦截')) || (!!b.price - !!a.price) || (a.name < b.name ? -1 : 1))
})
const shown = computed(() => models.value.slice(0, page.value * PAGE))

const gapChips = computed(() => {
  if (!isPhys.value) {
    const n = all.value.filter((m) => m.kind !== 'game' && m.kind !== 'gap').length
    return [{ n, t: '张产品卡（演示 + 草稿）', who: '真 ERP 里没有虚拟线', cls: '' }, { n: 0, t: '榜单需求信号', who: '要程序员（B11）', cls: 'red' }, { n: 0, t: '线索池（智能体长跑产物）', who: '要程序员（B12）', cls: 'red' }, { n: 0, t: '供货同行 / 群台账', who: '见 CRM（C02）', cls: 'amb' }]
  }
  const a = all.value
  const mons = a.filter((m) => m.cat === '显示器')
  const volN = mons.filter((m) => m.mev?.track === 'volume_95').length
  const fbN = mons.filter((m) => !m.price && m.mev?.fallbackPrice).length
  const hiN = mons.filter((m) => m.mev?.track === 'highend_5').length
  const zowN = mons.filter((m) => m.mev?.track === 'zowie').length
  return [
    { n: a.length, t: '个去重型号（双格式规格已全解）', who: '垂类站+在库SPU', cls: 'grn' },
    { n: volN, t: '款 95%千元内走量屏', who: `已同档兜底 ${fbN} 款无样本`, cls: 'acc' },
    { n: hiN, t: '款 5%千元上高端屏', who: '不套公式·直接按闲鱼实爬算', cls: 'amb' },
    { n: zowN, t: '款 卓威 ZOWIE', who: '独立保值价格表', cls: 'amb' },
    { n: a.filter((m) => m.price && m.mev?.priceState !== '异常低价拦截').length, t: '有实爬真价', who: '通过防呆核验', cls: 'grn' },
    { n: a.filter((m) => m.inStock).length, t: '在库型号', who: '真 WMS', cls: 'grn' },
    { n: a.filter((m) => !m.brand).length, t: '模糊短码待补品牌', who: '不硬猜·从垂类厂商库补', cls: 'amb' }
  ]
})

const missing = (m) => [
  !m.brand && { t: '品牌缺失：模糊短码未硬猜，待从垂类厂商库补齐', who: '程序员', cls: 'amb' },
  (!m.price && m.mev?.track === 'highend_5') && { t: '5%高端稀缺款暂无闲鱼在售（严格不套走量公式，需多词重爬或人工单议）', who: '业务员 / 爬虫', cls: 'red' },
  (!m.price && m.mev?.track === 'volume_95') && { t: `暂无闲鱼实爬样本（当前使用 95% 走量同档兜底价 ¥${m.mev.fallbackPrice}）`, who: '系统已兜底', cls: 'acc' },
  !m.spu && { t: '没有 SPU：不在 WMS 的 SPU 对照表里（要进库才有）', who: '仓管 / 采购', cls: '' },
  !m.spec && { t: '规格缺失', who: '程序员', cls: 'amb' }
].filter(Boolean)

const open = (m) => { if (isPhys.value) { sel.value = m; state2.value = selectionOf(m.key).stage || '未选'; Object.assign(selMeta, { series: selectionOf(m.key).series || '', config: selectionOf(m.key).config || '', region: selectionOf(m.key).region || '', ean: selectionOf(m.key).ean || '', theme: selectionOf(m.key).theme || '' }); Object.assign(mineForm, finalDb.mining[m.key] || { by: '', budget: null, rule: '', valid: '', observe: '' }) } else if (m.kind === 'gap') { toast(m.note) } else if (m.kind === 'game' && !m.pid) { toast('这款游戏还没立项：去「Skill 台账」立项（游戏报错处理）'); location.hash = '#/skills' } else if (m.kind === 'game') location.hash = `#/item/svc/${encodeURIComponent(m.pid)}`; else location.hash = `#/item/${m.kind}/${encodeURIComponent(m.id)}` }
function setStage(s) { state2.value = s; const r = selectionOf(sel.value.key); r.stage = s; r.at = new Date().toISOString().slice(5, 10); toast('选品状态已存：' + s) }
function saveMeta() { Object.assign(selectionOf(sel.value.key), { series: selMeta.series, config: selMeta.config, region: selMeta.region, ean: selMeta.ean }); toast('身份补充已存（演示）') }
function joinTheme() { if (!curTheme.value) return; const r = selectionOf(sel.value.key); r.theme = curTheme.value.week; selMeta.theme = curTheme.value.week; toast('已加入本周主题：' + curTheme.value.theme) }
function saveMining() { if (!mineForm.by.trim()) return toast('先写派给谁采购'); finalDb.mining[sel.value.key] = { ...mineForm, at: new Date().toISOString().slice(5, 10) }; toast('开采决定已存（等 OA 批）') }
function exportCsv() {
  const head = '型号,品牌,大类,品类,规格,分流轨道,闲鱼实爬价,同档兜底价,手册收货底价,在库,选品状态\n'
  const body = models.value.map((m) => [m.name, m.brand, m.big, m.cat, m.specText, m.mev?.trackShort || '', m.price || '', m.mev?.fallbackPrice || '', m.mev?.buyBaseline || '', m.inStock || 0, selectionOf(m.key).stage || '未选'].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + head + body], { type: 'text/csv;charset=utf-8' })); a.download = '实物选品清单_含规格兜底.csv'; a.click(); toast('已导出当前清单（含分流与兜底价）')
}
async function assign() { try { const r = await post('/demo/tasks', { cat: sel.value.cat === '显示器' ? '显示器' : '手机', req: `调研 ${sel.value.name}：找卖家、核行情、判断能不能采购`, to: to.value, files: [] }); toast(r.tb || '已加入') } catch (e) { toast(e.message) } }
const pbRows = ref([])
fetch('/api/demo/pricebook', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('erp_token') || '') } })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d?.items) pbRows.value = d.items })
  .catch(() => {})
function pbMatch(m) {
  if (!m) return null
  const key = (m.model || m.name || '').toLowerCase()
  return pbRows.value.find((r) => r.model && (key.includes(r.model.toLowerCase()) || r.model.toLowerCase().includes(key))) || null
}
function goClean(m) {
  const code = m?.cleanCode || m?.model || m?.name || m?.key
  if (code) location.hash = '#/price-cleaning/' + encodeURIComponent(code)
}
function goBaselineHub() { location.hash = '#/spec-baseline' }
function goVirtNew() { location.hash = '#/virt-new' }
function goVirtIntel() { location.hash = '#/virt-intel' }
</script>

<style scoped>
.sg { padding: 12px 28px 56px; max-width: 1640px; } .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; flex-wrap: wrap; } .sg h1 { font-size: 26px; margin: 0 0 2px; letter-spacing: -.02em; } .eyebrow { margin: 0; font-size: 13px; font-weight: 700; color: var(--acc); } .sub { margin: 0; color: var(--mute); max-width: 820px; line-height: 1.45; font-size: 13px; }
.srch { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.srch input { width: 240px; height: 34px; border: 1px solid var(--line); border-radius: 10px; padding: 0 12px; background: var(--panel); color: var(--ink); font: inherit; }
.gaps { margin: 10px 0 6px; padding: 12px 16px; border-radius: 16px; background: var(--soft); } .gaps.hot { background: var(--amb-soft); } .gh { display: flex; gap: 10px; align-items: baseline; font-size: 14px; flex-wrap: wrap; } .gc { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.gp { display: inline-flex; align-items: baseline; gap: 6px; padding: 5px 12px; border-radius: 12px; background: var(--panel); font-size: 13px; } .gp b { font-size: 18px; } .gp small { color: var(--mute); font-size: 11.5px; } .gp.red b { color: var(--red); } .gp.grn b { color: var(--grn); } .gp.amb b { color: var(--amb); } .gp.acc b { color: var(--acc); }

.persp-bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 12px; border-radius: 12px; background: var(--panel); box-shadow: var(--sh); margin: 6px 0; }
.p-lbl { font-size: 12.5px; font-weight: 700; color: var(--mute); margin-right: 4px; }
.p-btn { height: 30px; padding: 0 11px; border-radius: 9px; background: var(--soft); font-size: 12.5px; font-weight: 700; color: var(--ink2); }
.p-btn.on { background: var(--acc); color: #fff; }
.p-jump { margin-left: auto; font-size: 12.5px; font-weight: 700; color: var(--acc); background: var(--acc-soft); padding: 4px 10px; border-radius: 999px; }

.cat-slot-banner { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 16px; border-radius: 14px; background: var(--acc-soft); margin-bottom: 10px; font-size: 13.5px; }
.cat-slot-banner.simple { background: var(--soft); }
.cat-slot-banner div { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.crumb { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0 8px; font-size: 14px; } .crumb button { font-weight: 700; color: var(--acc); padding: 3px 8px; border-radius: 8px; } .crumb button:hover { background: var(--acc-soft); } .crumb span { color: var(--mute); } .dict { margin-left: auto; } .flat-btn { margin-left: 8px; color: var(--ink) !important; }
.grid.g { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; } .gcard { background: var(--panel); border-radius: 22px; padding: 22px 22px 18px; cursor: pointer; box-shadow: var(--sh); transition: transform .12s; border-top: 6px solid var(--acc); } .gcard:hover { transform: translateY(-3px); } .gcard.warn { border-top-color: var(--red); }
.gbig { font-size: 46px; font-weight: 800; letter-spacing: -.03em; line-height: 1; } .gbig small { font-size: 14px; font-weight: 600; color: var(--mute); margin-left: 8px; letter-spacing: 0; } .gcard h3 { margin: 10px 0 8px; font-size: 20px; } .gst { display: flex; gap: 6px; flex-wrap: wrap; } .sub2 { margin: 10px 0 0; font-size: 13px; color: var(--mute); }
.facets { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0 10px; } .facets .lb { color: var(--mute); font-size: 13px; } .facets button { height: 30px; padding: 0 12px; border-radius: 999px; background: var(--soft); font-weight: 600; font-size: 13px; color: var(--ink2); } .facets button.on { background: var(--acc); color: #fff; }
.cnt { margin: 0 0 10px; font-size: 13.5px; } .grid.m { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; } .mcard { background: var(--panel); border-radius: 18px; overflow: hidden; cursor: pointer; box-shadow: var(--sh); transition: transform .12s; } .mcard:hover { transform: translateY(-3px); }
.mcard.warn-card { outline: 2px solid var(--red); }
.mimg { position: relative; aspect-ratio: 4 / 3; background: var(--soft); } .mimg img { width: 100%; height: 100%; object-fit: cover; display: block; } .mimg.ph { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; background: linear-gradient(135deg, var(--soft), var(--acc-soft)); text-align: center; padding: 10px; } .mimg.ph b { font-size: 13px; color: var(--mute); } .mimg.ph span { font-size: 22px; font-weight: 800; letter-spacing: -.02em; word-break: break-all; } .ib { position: absolute; right: 10px; top: 10px; } .mimg.lg { background: linear-gradient(135deg, #f3f4f8, #dfe3ee); display: flex; align-items: center; justify-content: center; } .mimg.lg img { width: 38%; height: auto; object-fit: contain; filter: drop-shadow(0 3px 8px rgba(0, 0, 0, .2)); }
.mbody { padding: 12px 14px 14px; } .mbody h3 { margin: 0 0 8px; font-size: 15.5px; line-height: 1.35; } .mst { display: flex; gap: 5px; flex-wrap: wrap; } .more { text-align: center; margin: 20px 0; } .pad { padding: 20px; }
.mask { position: fixed; inset: 0; z-index: 70; background: rgba(8, 12, 22, .5); display: flex; justify-content: flex-end; } .drawer { width: min(580px, 100%); height: 100%; overflow-y: auto; background: var(--panel); padding: 24px 26px 60px; box-shadow: var(--sh-up); } .dh { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; } .dh h2 { margin: 4px 0 8px; font-size: 24px; } .drawer h4 { margin: 20px 0 8px; font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
.kv { display: grid; grid-template-columns: 78px 1fr; gap: 6px 12px; font-size: 14px; margin: 0; } .kv dt { color: var(--mute); } .kv dd { margin: 0; }
.base-eval-box { padding: 12px 14px; border-radius: 14px; background: var(--soft); display: grid; gap: 8px; }
.base-eval-box.bad { background: var(--red-soft); border: 1px solid var(--red); }
.base-eval-box.hi { background: var(--acc-soft); }
.beb-top { display: flex; gap: 6px; flex-wrap: wrap; }
.beb-warn { margin: 0; font-size: 13px; font-weight: 700; color: var(--red-ink); line-height: 1.5; }
.beb-nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.beb-nums div { padding: 8px 10px; border-radius: 10px; background: var(--panel); display: grid; gap: 2px; }
.beb-nums span { font-size: 11.5px; color: var(--mute); }
.beb-nums b { font-size: 16px; }
.pbox { padding: 12px 16px; border-radius: 14px; background: var(--grn-soft); color: var(--grn-ink); display: grid; gap: 4px; } .pbox > b { font-size: 24px; } .pbox span { font-size: 13px; line-height: 1.5; } .pbox.none { background: var(--red-soft); color: var(--red-ink); } .sm { font-size: 12.5px; }
.idf, .mine { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
.idf label, .mine label { display: grid; gap: 4px; font-size: 12.5px; color: var(--mute); }
.idf input, .mine input { height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; background: var(--soft); color: var(--ink); }
.steps { display: flex; gap: 6px; flex-wrap: wrap; } .steps button { height: 34px; padding: 0 14px; border-radius: 10px; background: var(--soft); font-weight: 700; font-size: 13.5px; } .steps button.on { background: var(--acc); color: #fff; } .asg { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .asg select { height: 38px; border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--soft); color: var(--ink); }
.miss { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-size: 13.5px; } .miss li { display: flex; gap: 8px; align-items: baseline; }
</style>
