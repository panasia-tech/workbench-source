<template>
  <div class="gc-page">
    <!-- 群控 4 大独立专页顶部切换导航 -->
    <nav class="gc-nav card">
      <div class="gn-tabs">
        <button class="gn-tab" @click="go('gc-matrix')"><i>1</i><span>群控环境与账号矩阵</span><em v-if="badges['gc-matrix']" class="nb">{{ badges['gc-matrix'] }}</em></button>
        <button class="gn-tab" @click="go('gc-queue')"><i>2</i><span>上下架与联动队列</span><em v-if="badges['gc-queue']" class="nb">{{ badges['gc-queue'] }}</em></button>
        <button class="gn-tab on"><i>3</i><span>在售智能调价复核</span></button>
        <button class="gn-tab" @click="go('gc-metrics')"><i>4</i><span>15:30 小铺数据看板</span><em v-if="badges['gc-metrics']" class="nb">{{ badges['gc-metrics'] }}</em></button>
      </div>
      <div class="gn-acts">
        <button class="btn sm" @click="load">↻ 重新同步行情建议</button>
      </div>
    </nav>

    <header class="card hero-bar">
      <div>
        <div class="hero-top">
          <h1>存量在售商品 · 智能调价与批量复核台</h1>
          <button class="btn sm ghost" @click="showRule = !showRule">📖 改价原则与网页边界 {{ showRule ? '▴' : '▾' }}</button>
        </div>
        <p v-if="showRule" class="sub">{{ data.principle }}</p>
        <p v-if="showRule" class="boundary-tip">💡 <b>AdsPower 网页版改价边界适配：</b>{{ data.web_boundary_note }}</p>
      </div>
    </header>

    <!-- 顶部分类筛选 + 批量复核工具栏 -->
    <section class="card batch-bar">
      <div class="seg">
        <button :class="{ on: flt === 'pending' }" @click="flt = 'pending'">待人工复核 ({{ data.counts?.pending_all || 0 }})</button>
        <button :class="{ on: flt === 'up' }" @click="flt = 'up'">📈 建议涨价 ({{ data.counts?.up || 0 }})</button>
        <button :class="{ on: flt === 'down' }" @click="flt = 'down'">📉 建议降价 ({{ data.counts?.down || 0 }})</button>
        <button :class="{ on: flt === 'watch' }" @click="flt = 'watch'">👀 建议观察 ({{ data.counts?.watch || 0 }})</button>
        <button :class="{ on: flt === 'locked' }" @click="flt = 'locked'">🔒 谈单锁价中 ({{ data.counts?.locked || 0 }})</button>
        <button :class="{ on: flt === 'done' }" @click="flt = 'done'">✓ 本轮已执行 ({{ data.counts?.done || 0 }})</button>
      </div>

      <div class="batch-acts">
        <label class="sel-all">
          <input type="checkbox" :checked="allSelectableChecked" @change="toggleSelectAll($event.target.checked)" />
          <span>全选常规待核项（已选 {{ selectedIds.length }} 条，≥1万高价单防呆不随批量盲勾）</span>
        </label>
        <button class="btn sm pri" :disabled="busy || !selectedIds.length" @click="batchAct('confirm')">
          ✓ 批量确认下发改价 ({{ selectedIds.length }})
        </button>
        <button class="btn sm" :disabled="busy || !selectedIds.length" @click="batchAct('lock')">🔒 锁价 7 天</button>
        <button class="btn sm" :disabled="busy || !selectedIds.length" @click="batchAct('ignore')">本轮忽略</button>
      </div>
    </section>

    <!-- 逐条智能调价卡片列表 -->
    <div class="rp-list">
      <article
        v-for="r in shown"
        :key="r.id"
        class="card rp-card"
        :class="[r.action, { high: isHighVal(r), done: r.state === 'done' }]"
      >
        <div class="rp-left">
          <input
            v-if="r.state === 'pending'"
            type="checkbox"
            :value="r.id"
            v-model="selectedIds"
            :disabled="isHighVal(r)"
            :title="isHighVal(r) ? '≥1万元高价值商品禁止批量勾选，请在右侧单独填写说明确认' : ''"
          />
          <div class="rp-info">
            <div class="rp-badges">
              <span class="tag" :class="actTag(r).cls">{{ actTag(r).text }}</span>
              <span class="tag" :class="isHighVal(r) ? 'red' : ''">{{ r.tier }}</span>
              <span class="tag">{{ r.shop_nick }} (#{{ r.env_id }})</span>
              <span class="tag acc">{{ r.channel }}</span>
              <span class="tag" :class="r.confidence === '高' ? 'grn' : r.confidence === '低' ? 'amb' : ''">
                行情样本 {{ r.sample_count }} 条 · 置信度{{ r.confidence }}
              </span>
            </div>
            <h3>{{ r.name }} <small>{{ r.sku_code }} · {{ r.grade }}</small></h3>
            <p class="rp-reason">{{ r.reason }}</p>
            <p class="rp-meta">
              采购成本：<b>¥{{ r.cost }}</b> ｜ 毛利底线：<b>¥{{ r.floor_price }}</b> ｜ 在库天数：<b :class="{ red: r.stock_days >= 28, amb: r.stock_days >= 14 }">{{ r.stock_days }} 天</b> ｜ 近7日浏览 {{ r.views_7d }} · 询单 <b>{{ r.inquiries_7d }}</b> 人
            </p>
          </div>
        </div>

        <div class="rp-right">
          <div class="price-trio">
            <div>
              <span>当前挂牌价</span>
              <b>¥{{ r.current_price }}</b>
            </div>
            <span class="arr">→</span>
            <div>
              <span>闲鱼清洗中位价</span>
              <b class="acc">¥{{ r.market_median }}</b>
            </div>
            <span class="arr">→</span>
            <div class="edit-box">
              <span>拟下发新售价 (¥)</span>
              <input
                type="number"
                class="inp pr-inp"
                v-model.number="draftPrices[r.id]"
                :disabled="r.state !== 'pending'"
              />
              <small :class="deltaOf(r) > 0 ? 'up' : deltaOf(r) < 0 ? 'dn' : ''">
                {{ deltaOf(r) > 0 ? `+¥${deltaOf(r)}` : deltaOf(r) < 0 ? `-¥${Math.abs(deltaOf(r))}` : '维持原价' }}
                · 预估毛利 ¥{{ (draftPrices[r.id] || r.suggest_price) - r.cost }}
              </small>
            </div>
          </div>

          <!-- 高价值（≥1万）或低于毛利底线时：自动展开原因留痕框（无需主管审批，填因即发） -->
          <div v-if="r.state === 'pending' && needReason(r)" class="reason-box">
            <input
              class="inp"
              v-model="reasons[r.id]"
              :placeholder="isHighVal(r) ? '≥1万高价值单品二次确认说明（≥3字直接生效）' : `低于毛利底线 ¥${r.floor_price} 清仓说明（≥3字）`"
            />
          </div>

          <div v-if="r.state === 'pending'" class="rp-btns">
            <button class="btn sm pri" :disabled="busy" @click="singleAct(r, 'confirm')">
              {{ needReason(r) ? '确认留痕并直接下发' : '确认下发改价' }}
            </button>
            <button class="btn sm" :disabled="busy" @click="singleAct(r, 'lock')">锁价7天</button>
            <button class="btn sm" :disabled="busy" @click="singleAct(r, 'ignore')">忽略</button>
          </div>
          <div v-else-if="r.state === 'locked'" class="done-pill amb">🔒 已锁价保护至 {{ r.locked_until }}</div>
          <div v-else class="done-pill grn">✓ 已下发改价至 ¥{{ r.current_price }}</div>
        </div>
      </article>
      <p v-if="!shown.length" class="card empty-tip">当前分类下没有待处理的在售调价商品。</p>
    </div>

    <!-- 底部：调价审计日志与改后流量追踪 -->
    <section class="card log-sec">
      <h2>📜 调价执行审计日志 &amp; 改后曝光转化回看</h2>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr><th>时间</th><th>复核人</th><th>店铺</th><th>商品</th><th>价格变动</th><th>执行通道</th><th>确认依据 / 备注</th><th>改后效果回看</th></tr>
          </thead>
          <tbody>
            <tr v-for="lg in data.logs" :key="lg.id">
              <td>{{ lg.at }}</td>
              <td><b>{{ lg.who }}</b></td>
              <td>{{ lg.shop_nick }}</td>
              <td>{{ lg.name }} <span class="muted">({{ lg.sku_code }})</span></td>
              <td class="num">¥{{ lg.old_price }} → <b>¥{{ lg.new_price }}</b></td>
              <td><span class="tag">{{ lg.channel }}</span></td>
              <td>{{ lg.reason }}</td>
              <td><span class="tag grn">{{ lg.effect }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api, post } from './api.js'
import { toast } from './ui.js'

const data = reactive({ principle: '', web_boundary_note: '', counts: {}, items: [], logs: [] })
const badges = reactive({})
const flt = ref('pending')
const busy = ref(false)
const showRule = ref(false)
const selectedIds = ref([])
const draftPrices = reactive({})
const reasons = reactive({})

const go = (k) => { location.hash = '#/' + k }

const isHighVal = (r) => r.current_price >= 10000 || (draftPrices[r.id] || r.suggest_price) >= 10000
const needReason = (r) => isHighVal(r) || (draftPrices[r.id] || r.suggest_price) < r.floor_price
const deltaOf = (r) => Math.round((draftPrices[r.id] ?? r.suggest_price) - r.current_price)

const actTag = (r) => {
  if (r.action === 'up') return { text: '📈 建议涨价', cls: 'grn' }
  if (r.action === 'down') return { text: '📉 建议降价', cls: 'amb' }
  if (r.action === 'watch') return { text: '👀 建议观察', cls: '' }
  return { text: '🔒 锁价保护', cls: 'acc' }
}

const shown = computed(() =>
  (data.items || []).filter((r) => {
    if (flt.value === 'pending') return r.state === 'pending'
    if (flt.value === 'up') return r.state === 'pending' && r.action === 'up'
    if (flt.value === 'down') return r.state === 'pending' && r.action === 'down'
    if (flt.value === 'watch') return r.state === 'pending' && r.action === 'watch'
    if (flt.value === 'locked') return r.state === 'locked'
    if (flt.value === 'done') return r.state === 'done'
    return true
  })
)

const selectableItems = computed(() => shown.value.filter((r) => r.state === 'pending' && !isHighVal(r)))
const allSelectableChecked = computed(
  () => selectableItems.value.length > 0 && selectableItems.value.every((r) => selectedIds.value.includes(r.id))
)

function toggleSelectAll(checked) {
  selectedIds.value = checked ? selectableItems.value.map((r) => r.id) : []
}

async function load() {
  try {
    const [res, b] = await Promise.all([api('/gc-hub/reprice'), api('/gc-hub/badges')])
    Object.assign(data, res)
    Object.assign(badges, b)
    for (const r of res.items || []) {
      if (draftPrices[r.id] == null || r.state !== 'pending') {
        draftPrices[r.id] = r.suggest_price
      }
    }
    selectedIds.value = selectedIds.value.filter((id) => res.items.some((x) => x.id === id && x.state === 'pending'))
  } catch (e) {
    toast('读取智能调价清单失败：' + e.message)
  }
}

async function singleAct(r, action) {
  busy.value = true
  try {
    const res = await post('/gc-hub/reprice/act', {
      action,
      ids: [r.id],
      prices: { [r.id]: draftPrices[r.id] },
      reason: reasons[r.id] || ''
    })
    toast(res.msg)
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

async function batchAct(action) {
  busy.value = true
  try {
    const res = await post('/gc-hub/reprice/act', {
      action,
      ids: selectedIds.value,
      prices: { ...draftPrices }
    })
    toast(res.msg)
    selectedIds.value = []
    await load()
  } catch (e) {
    toast(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.gc-page { padding: 18px 32px 64px; max-width: 1720px; display: grid; gap: 12px; }
.gc-nav { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 16px; flex-wrap: wrap; }
.gn-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.gn-tab { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--soft); color: var(--ink2); font-weight: 700; font-size: 14px; }
.gn-tab i { width: 22px; height: 22px; border-radius: 50%; background: var(--panel); display: inline-flex; align-items: center; justify-content: center; font-style: normal; font-size: 12px; font-weight: 800; }
.gn-tab.on { background: var(--acc); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.25); }
.gn-tab.on i { background: rgba(255,255,255,.22); color: #fff; }
.nb { font-style: normal; padding: 1px 7px; border-radius: 999px; background: var(--red); color: #fff; font-size: 11.5px; font-weight: 800; }
.nb.amb { background: var(--amb); color: #2c1d00; }

.hero-bar { padding: 14px 20px; }
.hero-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 800; letter-spacing: .05em; color: var(--acc); }
.hero-bar h1 { margin: 0; font-size: 24px; }
.hero-bar .sub { margin: 8px 0; color: var(--ink2); font-size: 13.5px; line-height: 1.5; }
.boundary-tip { margin: 0; padding: 8px 13px; border-radius: 10px; background: var(--acc-soft); color: var(--ink); font-size: 13px; }

.batch-bar { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
.seg { display: inline-flex; gap: 4px; padding: 4px; background: var(--soft); border-radius: 12px; flex-wrap: wrap; }
.seg button { height: 32px; padding: 0 12px; border-radius: 9px; font-weight: 700; font-size: 13px; color: var(--ink2); }
.seg button.on { background: var(--ink); color: var(--bg); }
.batch-acts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sel-all { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink2); cursor: pointer; }

.rp-list { display: grid; gap: 14px; }
.rp-card { padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; gap: 24px; flex-wrap: wrap; }
.rp-card.high { border: 2px solid var(--red); }
.rp-left { display: flex; gap: 14px; align-items: flex-start; flex: 1; min-width: 340px; }
.rp-left input[type="checkbox"] { width: 18px; height: 18px; margin-top: 4px; flex-shrink: 0; }
.rp-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.rp-info h3 { margin: 0 0 6px; font-size: 18px; }
.rp-info h3 small { font-size: 13px; color: var(--mute); font-weight: 500; margin-left: 8px; }
.rp-reason { margin: 0 0 6px; font-size: 13.5px; color: var(--ink2); line-height: 1.5; }
.rp-meta { margin: 0; font-size: 12.5px; color: var(--mute); }
.rp-meta b.red { color: var(--red); }
.rp-meta b.amb { color: var(--amb-ink); }

.rp-right { display: grid; gap: 10px; justify-items: end; min-width: 380px; }
.price-trio { display: flex; align-items: center; gap: 14px; background: var(--soft); padding: 12px 16px; border-radius: 14px; }
.price-trio span { display: block; font-size: 11.5px; color: var(--mute); }
.price-trio b { font-size: 22px; font-weight: 800; }
.price-trio b.acc { color: var(--acc); }
.arr { color: var(--mute); font-weight: 700; }
.inp { height: 38px; border: 1.5px solid var(--line); border-radius: 10px; padding: 0 10px; background: var(--panel); font: inherit; }
.pr-inp { width: 112px; font-size: 19px; font-weight: 800; color: var(--ink); }
.edit-box small { display: block; font-size: 11.5px; margin-top: 3px; color: var(--mute); }
.edit-box small.up { color: var(--grn-ink); font-weight: 700; }
.edit-box small.dn { color: var(--amb-ink); font-weight: 700; }

.reason-box { width: 100%; }
.reason-box .inp { width: 100%; box-sizing: border-box; border-color: var(--red); font-size: 13px; }
.rp-btns { display: flex; gap: 8px; }
.done-pill { padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; }
.done-pill.grn { background: var(--grn-soft); color: var(--grn-ink); }
.done-pill.amb { background: var(--amb-soft); color: var(--amb-ink); }
.empty-tip { padding: 36px; text-align: center; color: var(--mute); }
.log-sec { padding: 22px 26px; display: grid; gap: 14px; }
.log-sec h2 { margin: 0; font-size: 19px; }
</style>
