<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">高值带电资产防损铁律 · 每 30 天必通电补至黄金半电 · 拔线强制彻底关机（严禁仅息屏/合盖休眠）</div>
        <h1>锂电池商品 30 天统筹<Q k="battery" /></h1>
        <p class="sub">
          自动区分内置锂电单品与纯插电设备：每满 <b>30 天必须移至防爆补电车通电一次（充至 50%–65% 半电防过放饿死）</b>，补完拔线后<b>强制执行系统彻底关机断电</b>；全新原封机自动锁死防误拆，改为推销售优先快出。
        </p>
      </div>
      <div class="acts">
        <button class="btn pri" :disabled="locked" @click="batchCheckoutDueBatteriesToCart">
          ⚡ 一键将超期/临期带电件批量扫入防爆补电车
        </button>
        <button class="btn" @click="openHelp('battery')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 顶部 4 张统筹状态卡 -->
    <div class="bat-kpi-grid">
      <div class="bk-card" :class="counts.red ? 'red' : 'grn'" @click="flt = 'red'">
        <div class="bk-top">
          <span class="tag" :class="counts.red ? 'red' : 'grn'">🔴 超30天 / 未真关机</span>
          <b class="mono" style="font-size:20px" :style="{ color: counts.red ? 'var(--red)' : 'var(--grn)' }">{{ counts.red }} 台</b>
        </div>
        <b>{{ counts.red ? `涉及货值 ¥${overdueValue.toLocaleString()} · 今日必补电关机` : '✓ 全仓已拆封锂电 0 超期' }}</b>
        <span class="muted">超期未补电易亏电锁保护板；出库已挂发前通电复测锁</span>
      </div>

      <div class="bk-card" :class="counts.amb ? 'amb' : 'grn'" @click="flt = 'amb'">
        <div class="bk-top">
          <span class="tag" :class="counts.amb ? 'amb' : 'grn'">🟡 25~29天临期预警</span>
          <b class="mono" style="font-size:20px">{{ counts.amb }} 台</b>
        </div>
        <b>距 30 天红线剩 ≤5 天 · 顺路推车集中补电</b>
        <span class="muted">统一扫入 WIP-CHARGE-01 防爆柜，禁货架私拉排插</span>
      </div>

      <div class="bk-card acc" @click="flt = 'sealed'">
        <div class="bk-top">
          <span class="tag acc">📦 全新原封防误拆保护</span>
          <b class="mono" style="font-size:20px">{{ counts.sealed }} 台</b>
        </div>
        <b>硬锁死「禁止撕封条拆封充电」（防贬值 ¥800+）</b>
        <span class="muted">原封满 30 天不拆封，一键推销售主管优先调价快卖</span>
      </div>

      <div class="bk-card grn" @click="flt = 'exempt'">
        <div class="bk-top">
          <span class="tag grn">🟢 半电关机健康 / 免补电</span>
          <b class="mono" style="font-size:20px">{{ counts.grn }} 台健康</b>
        </div>
        <b>50%~65% 黄金半电且已核验彻底关机存放</b>
        <span class="muted">另有 {{ counts.exempt }} 台纯交流供电设备（显示器等）自动豁免</span>
      </div>
    </div>

    <!-- 筛选条 -->
    <div class="seg" style="margin-bottom:14px">
      <button :class="{ on: flt === 'all' }" @click="flt = 'all'">全部带锂电商品 <em>{{ lithiumRows.length }}</em></button>
      <button :class="{ on: flt === 'red' }" @click="flt = 'red'"><i class="dot red"></i>超30天/未真关机必办 <em>{{ counts.red }}</em></button>
      <button :class="{ on: flt === 'amb' }" @click="flt = 'amb'"><i class="dot amb"></i>25~29天临期补电 <em>{{ counts.amb }}</em></button>
      <button :class="{ on: flt === 'sealed' }" @click="flt = 'sealed'">📦 全新原封保护 <em>{{ counts.sealed }}</em></button>
      <button :class="{ on: flt === 'exempt' }" @click="flt = 'exempt'">🔌 纯插电免补电设备 <em>{{ counts.exempt }}</em></button>
    </div>

    <!-- 主工作区：左队列 + 右四步防呆通电关机作业台 -->
    <div class="bat-split">
      <div class="bat-list">
        <article
          v-for="r in filteredRows"
          :key="r.sku.code"
          class="bat-card"
          :class="[r.st.lvl, { sel: selRow?.sku.code === r.sku.code }]"
          @click="selectSku(r.sku.code)"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="tag" :class="r.st.lvl === 'none' ? '' : r.st.lvl">{{ r.st.tag }}</span>
            <span class="mono muted" style="font-size:12px">#{{ r.sku.code }} · 库位 {{ r.sku.location }}</span>
          </div>
          <h3>{{ r.sku.brand }} {{ r.sku.model }}</h3>
          <div class="bat-meta">
            <span>货值：<b>¥{{ r.sku.cost }}</b></span>
            <span v-if="r.st.applicable">上次通电：<b>{{ r.sku.lastPowerOnAt || '未记录' }}</b></span>
            <span v-if="r.st.applicable && !r.st.isSealed">
              关机状态：
              <b :style="{ color: r.sku.powerOffVerified ? 'var(--grn)' : 'var(--red)' }">
                {{ r.sku.powerOffVerified ? '✓ 已彻底关机' : '✕ 仅休眠/未确认关机' }}
              </b>
            </span>
          </div>
          <div v-if="r.st.inChargeWip" style="margin-top:6px">
            <span class="tag acc">⚡ 当前已挂在 WIP-CHARGE-01 防爆补电车</span>
          </div>
          <p class="muted" style="font-size:12px;margin-top:6px">{{ r.st.reason }}</p>
        </article>
      </div>

      <!-- 右侧：单件 30 天通电补电 + 强制彻底关机防呆操作台 -->
      <section v-if="selRow" class="card bat-detail">
        <div class="bd-head">
          <div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span class="tag dark mono">#{{ selRow.sku.code }}</span>
              <span class="tag">原储位 {{ selRow.sku.location }}</span>
              <span class="tag" :class="selRow.st.lvl === 'none' ? '' : selRow.st.lvl">{{ selRow.st.tag }}</span>
              <span v-if="selRow.st.inChargeWip" class="tag acc">⚡ WIP-CHARGE-01 补电中</span>
            </div>
            <h2 style="font-size:20px;margin:8px 0 4px">{{ selRow.sku.brand }} {{ selRow.sku.model }}</h2>
            <p class="muted" style="font-size:13px">
              SN：<code class="mono">{{ selRow.sku.sn }}</code> · 进价 ¥{{ selRow.sku.cost }} ·
              距上次通电：<b>{{ selRow.sku.daysSincePowerOn || 0 }} 天</b>（标准红线：≤ 30 天必通电一次）
            </p>
          </div>
          <button class="btn sm ghost" @click="openItemDetail(selRow.sku.code)">查看单件档案 ›</button>
        </div>

        <!-- 分支 A：纯交流插电设备（自动豁免） -->
        <div v-if="!selRow.st.applicable" class="why-box grn" style="margin-top:14px">
          <b>🔌 纯交流供电设备 · 系统已自动豁免 30 天补电：</b><br />
          该商品（{{ selRow.sku.model }}）无内置锂离子电池，长期断电静置无过放饿死风险，系统不向仓管员派发冗余补电任务。
        </div>

        <!-- 分支 B：全新原封未拆封带锂电设备（硬锁死禁撕封条充电！） -->
        <div v-else-if="selRow.st.isSealed" class="sealed-guard-box">
          <span class="tag amb">📦 全新原封未拆封 · 防误拆硬保护锁已生效</span>
          <h3 style="margin:8px 0 6px;font-size:17px">严禁为执行 30 天通电而撕毁原厂封条！（一旦拆封直接贬值 ¥800 ~ ¥1,500）</h3>
          <p class="muted" style="font-size:13px">
            当前原封在库已 <b>{{ selRow.sku.daysSincePowerOn }} 天</b>。针对全新原封带锂电机器，仓管端物理禁用「拆封补电」，标准动作是<b>保持原封不动并向销售端发出「原封锂电库龄快出预警」优先周转变现</b>。
          </p>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
            <button class="btn" disabled title="全新原封机硬锁禁止拆封充电">🔒 拆封通电补电（原封保护已锁死）</button>
            <button
              class="btn pri"
              :disabled="locked || selRow.sku.fastSellAlertSent"
              @click="pushSealedBatteryFastSellAlert(selRow.sku)"
            >
              {{ selRow.sku.fastSellAlertSent ? '✓ 已推送销售主管优先调价快出' : '📣 一键推送销售主管：原封满30天优先快出' }}
            </button>
          </div>
        </div>

        <!-- 分支 C：已拆封带锂电商品 · 四步通电补至半电 + 强制彻底关机闭环 -->
        <div v-else class="care-steps">
          <div class="why-box" :class="selRow.st.lvl === 'red' ? 'red' : 'amb'">
            <b>两条硬红线：</b>① 严禁在货架纸箱旁私拉插线板充电，必须先扫入 <code>WIP-CHARGE-01</code> 防爆集中补电车；② 充至 <b>50%–65% 半电</b>拔线后，<b>必须长按电源滑块或系统菜单执行「彻底关机」</b>（笔记本严禁只合盖休眠、手机严禁只按侧键息屏，否则后台待机 3 天又会彻底跑干饿死电芯！）。
          </div>

          <div class="cs-grid">
            <!-- Step 1 -->
            <div class="cs-box" :class="{ ok: selRow.st.inChargeWip }">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>第 1 步 · 移入防爆集中补电车</b>
                <span class="tag" :class="selRow.st.inChargeWip ? 'grn' : 'acc'">{{ selRow.st.inChargeWip ? '✓ 已挂补电车' : '货动码必动' }}</span>
              </div>
              <p class="muted">从原储位 {{ selRow.sku.location }} 取出机器，挂入 <code>WIP-CHARGE-01</code>，防盘点/找货误判丢件。</p>
              <button
                v-if="!selRow.st.inChargeWip"
                class="btn sm pri"
                :disabled="locked"
                @click="checkoutBatteryToChargeCart(selRow.sku)"
              >🔫 扫码挂入 WIP-CHARGE-01 防爆补电车</button>
              <span v-else class="tag grn">已在 4号防爆补电车充电工位</span>
            </div>

            <!-- Step 2 -->
            <div class="cs-box">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>第 2 步 · 通电唤醒与黄金半电（50%~65%）</b>
                <span class="tag" :class="pctValid ? 'grn' : 'red'">{{ pctValid ? '✓ 半电合规' : '须 45%~80%' }}</span>
              </div>
              <div class="pct-inputs">
                <label>补电前余电(%)<input v-model.number="form.beforePct" type="number" min="0" max="100" class="inp mono" /></label>
                <label>充后存储电量(%)<input v-model.number="form.afterPct" type="number" min="0" max="100" class="inp mono" /></label>
                <label>电池健康度(%)<input v-model.number="form.healthPct" type="number" min="50" max="100" class="inp mono" /></label>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn sm ghost" @click="form.afterPct = 58">设为推荐 58% 半电</button>
                <button class="btn sm ghost" @click="form.afterPct = 98">演示误充 98%（触发防鼓包锁）</button>
                <button
                  class="btn sm bad"
                  :disabled="locked"
                  @click="reportBatterySwellingOrDeadToRepair(selRow.sku, '通电实测0%锁保护板无法唤醒/机身微鼓包')"
                >🚨 检出饿死/鼓包转待修</button>
              </div>
            </div>

            <!-- Step 3：核心铁律——保持彻底关机状态！ -->
            <div class="cs-box span2" :class="{ ok: form.powerOffChecked && form.noSwellingChecked }">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
                <b>第 3 步 · 拔线并强制核验「保持彻底关机状态」（核心防跑干铁律）</b>
                <span class="tag" :class="form.powerOffChecked && form.noSwellingChecked ? 'grn' : 'red'">
                  {{ form.powerOffChecked && form.noSwellingChecked ? '✓ 彻底关机与安全已双核' : '! 待勾选彻底关机确认' }}
                </span>
              </div>
              <label class="ck-row">
                <input type="checkbox" v-model="form.powerOffChecked" />
                <span>
                  <b>已拔除充电器，并执行系统级「彻底关机」</b>（手机已滑动关机 / MacBook 已点左上角菜单「关机…」待屏幕全黑后再合盖；静置 10 秒短按电源键确认<b>不亮屏、非息屏锁屏待机</b>！）
                </span>
              </label>
              <label class="ck-row">
                <input type="checkbox" v-model="form.noSwellingChecked" />
                <span>
                  <b>已手触复检机身背部无异常余温，侧视屏幕边缘与后盖无任何微鼓包顶起</b>
                </span>
              </label>
            </div>

            <!-- Step 4 -->
            <div class="cs-box span2">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1">
                  <b>第 4 步 · 双扫码归回原储位并重置 30 天时钟：</b>
                  <input
                    v-model="form.scannedReturnBin"
                    class="inp mono"
                    style="width:170px;min-height:34px;padding:5px 10px"
                    :placeholder="`扫原储位 LOC-${selRow.sku.location}`"
                  />
                  <button class="btn sm" @click="form.scannedReturnBin = `LOC-${selRow.sku.location}`">
                    🔫 扫原库位 LOC-{{ selRow.sku.location }}
                  </button>
                </div>

                <Lock
                  :ok="submitCheck.ok"
                  :reason="submitCheck.why"
                  penalty="提交后自动销账防爆补电车暂借、将本机距上次通电天数归零（下次必通电 +30 天），并解除出库发前通电锁。"
                  kind="pri"
                  @go="doSubmitCare(selRow.sku)"
                >完成通电补电与彻底关机 · 归架重置 30 天周期</Lock>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 底部：锂电池 30 天通电与关机核验历史台账 -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:15.5px">全仓锂电池 30 天周期通电与彻底关机审计台账（{{ (store.data.batteryCareLogs || []).length }} 笔）</h3>
        <span class="muted" style="font-size:12px">每次补电前后水位、健康度与关机复核人不可篡改留痕</span>
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>完成时间</th>
            <th>单件货号</th>
            <th>商品名称</th>
            <th>归位格口</th>
            <th>电量变化（黄金半电）</th>
            <th>健康度</th>
            <th>彻底关机 & 防鼓包核验</th>
            <th>经办人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lg in store.data.batteryCareLogs || []" :key="lg.id">
            <td class="mono">{{ lg.time }}</td>
            <td class="mono"><b>#{{ lg.skuCode }}</b></td>
            <td>{{ lg.model }}</td>
            <td class="mono">{{ lg.bin }}</td>
            <td><b>{{ lg.beforePct }}% → {{ lg.afterPct }}%</b></td>
            <td>{{ lg.healthPct }}%</td>
            <td><span class="tag grn">✓ 已拔线彻底关机 · 无鼓包</span></td>
            <td>{{ lg.operator }}</td>
          </tr>
        </tbody>
      </table>
    </section>
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
  openHelp,
  openItemDetail,
  skuBatteryStatus,
  checkoutBatteryToChargeCart,
  batchCheckoutDueBatteriesToCart,
  completeBatteryPowerCycleAndShutdown,
  reportBatterySwellingOrDeadToRepair,
  pushSealedBatteryFastSellAlert
} from '../store/warehouseStore.js'

const locked = computed(() => !currentUser.value.practiceDone)
const flt = ref('all')

const allRows = computed(() =>
  (store.data.skus || []).map(sku => ({ sku, st: skuBatteryStatus(sku) }))
)

const lithiumRows = computed(() =>
  allRows.value
    .filter(r => r.st.applicable)
    .sort((a, b) => {
      const order = { red: 0, amb: 1, grn: 2 }
      return (order[a.st.lvl] ?? 3) - (order[b.st.lvl] ?? 3) || b.st.days - a.st.days
    })
)

const counts = computed(() => ({
  red: lithiumRows.value.filter(r => !r.st.isSealed && r.st.lvl === 'red').length,
  amb: lithiumRows.value.filter(r => !r.st.isSealed && r.st.lvl === 'amb').length,
  sealed: lithiumRows.value.filter(r => r.st.isSealed).length,
  grn: lithiumRows.value.filter(r => !r.st.isSealed && r.st.lvl === 'grn').length,
  exempt: allRows.value.filter(r => !r.st.applicable).length
}))

const overdueValue = computed(() =>
  lithiumRows.value
    .filter(r => !r.st.isSealed && r.st.lvl === 'red')
    .reduce((sum, r) => sum + (Number(r.sku.cost) || 0), 0)
)

const filteredRows = computed(() => {
  if (flt.value === 'red') return lithiumRows.value.filter(r => !r.st.isSealed && r.st.lvl === 'red')
  if (flt.value === 'amb') return lithiumRows.value.filter(r => !r.st.isSealed && r.st.lvl === 'amb')
  if (flt.value === 'sealed') return lithiumRows.value.filter(r => r.st.isSealed)
  if (flt.value === 'exempt') return allRows.value.filter(r => !r.st.applicable)
  return lithiumRows.value
})

const selectedCode = ref(store.routeParam || lithiumRows.value[0]?.sku.code || '')
const selRow = computed(() =>
  allRows.value.find(r => r.sku.code === selectedCode.value) || filteredRows.value[0] || allRows.value[0] || null
)

const form = reactive({
  beforePct: 9,
  afterPct: 58,
  healthPct: 96,
  powerOffChecked: false,
  noSwellingChecked: false,
  scannedReturnBin: ''
})

function syncFormWithSku(sku) {
  if (!sku) return
  form.beforePct = sku.batteryPct ?? 12
  form.afterPct = 58
  form.healthPct = sku.batteryHealthPct ?? 93
  form.powerOffChecked = false
  form.noSwellingChecked = false
  form.scannedReturnBin = `LOC-${sku.location}`
}

watch(() => selRow.value?.sku.code, () => syncFormWithSku(selRow.value?.sku), { immediate: true })
watch(() => store.routeParam, (v) => { if (v) selectedCode.value = v })

function selectSku(code) {
  selectedCode.value = code
}

const pctValid = computed(() => Number(form.afterPct) >= 45 && Number(form.afterPct) <= 80)

const submitCheck = computed(() => {
  if (!selRow.value) return { ok: false, why: '未选择商品' }
  if (locked.value) return { ok: false, why: '请先去左侧「学」完成首日 3 项练习' }
  if (!pctValid.value) {
    return { ok: false, why: `充后电量（当前 ${form.afterPct}%）须处于 45%–80% 半电存储区间（推荐 50%–65%），过低易饿死、满电长期静置易鼓包！` }
  }
  if (!form.powerOffChecked) {
    return { ok: false, why: '还没勾选第 3 步「已拔除充电器并执行系统彻底关机（非息屏/非合盖待机）」——不彻底关机放回货架 3 天就跑干了！' }
  }
  if (!form.noSwellingChecked) {
    return { ok: false, why: '请勾选确认机身背部无异常余温、屏幕与后盖无微鼓包' }
  }
  if (!form.scannedReturnBin.trim()) {
    return { ok: false, why: `请扫描原储位条码 LOC-${selRow.value.sku.location} 归架` }
  }
  return { ok: true, why: '' }
})

function doSubmitCare(sku) {
  if (completeBatteryPowerCycleAndShutdown(sku, form)) {
    const nextRed = lithiumRows.value.find(r => !r.st.isSealed && r.st.lvl === 'red')
    if (nextRed) selectedCode.value = nextRed.sku.code
  }
}
</script>

<style scoped>
.bat-kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0 16px;
}
.bk-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 3px solid var(--acc);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
}
.bk-card.red { border-top-color: var(--red); background: #fffafa; }
.bk-card.amb { border-top-color: var(--amb); }
.bk-card.grn { border-top-color: var(--grn); }
.bk-card b { font-size: 13.5px; }
.bk-card .muted { font-size: 11.5px; line-height: 1.4; }
.bk-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }

.bat-split {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.28fr);
  gap: 16px;
  align-items: start;
}
.bat-list { display: grid; gap: 10px; }
.bat-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 4px solid var(--acc);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  min-width: 0;
}
.bat-card.red { border-left-color: var(--red); background: #fffdfd; }
.bat-card.amb { border-left-color: var(--amb); }
.bat-card.grn { border-left-color: var(--grn); }
.bat-card.none { border-left-color: #94a3b8; }
.bat-card.sel { box-shadow: 0 0 0 2px var(--acc); background: #f8fbff; }
.bat-card h3 { font-size: 14.5px; margin: 6px 0 4px; font-weight: 700; }
.bat-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--mute); }
.bat-meta b { color: var(--ink); }

.bd-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.sealed-guard-box {
  margin-top: 14px;
  padding: 16px 18px;
  border-radius: 11px;
  background: #fffbeb;
  border: 1.5px solid #f59e0b;
}
.care-steps { margin-top: 14px; display: grid; gap: 12px; }
.cs-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.cs-box {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  align-content: start;
  font-size: 12.5px;
  min-width: 0;
}
.cs-box.ok { background: #f4fbf7; border-color: #bfead3; }
.cs-box.span2 { grid-column: 1 / -1; }
.pct-inputs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.pct-inputs label { display: grid; gap: 4px; font-size: 11.5px; font-weight: 600; min-width: 0; }
.pct-inputs .inp { min-height: 32px; padding: 4px 8px; font-size: 13px; min-width: 0; }
.ck-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  line-height: 1.5;
}
@media (max-width: 1180px) {
  .bat-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bat-split, .cs-grid { grid-template-columns: 1fr; }
}
</style>
