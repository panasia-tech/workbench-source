<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">日常标准化 WMS · 多渠道销售抓单与集单中枢</div>
        <h1>订单抓取与聚合<Q k="orders" /></h1>
        <p class="sub">
          实时汇聚各闲鱼/闲管家/转转店铺已付款订单：自动按外部单号去重、<b>同买家同地址一客多单自动合单省邮费</b>、通卖链接绑定具体一物一码 SKU、拦截改址/售前退款，并按最短货架路径生成<b>波次拣货单</b>。
        </p>
      </div>
      <div class="acts">
        <span class="tag amb">演示 · 闲管家 Webhook 与 RPA 巡检为本机模拟</span>
        <Lock
          :ok="!locked"
          reason="先去「学」完成 3 个首日防呆练习"
          kind="pri"
          @go="pullAllShopOrders"
        >
          <Icon name="refresh" />立即全渠道抓单巡检
        </Lock>
        <button class="btn" :disabled="locked" @click="manualOpen = true">
          <Icon name="inbox" />手工补录/导单兜底
        </button>
        <button class="btn" @click="openHelp('orders')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 1. 多店铺抓单通道心跳与今日抓单概况（对齐 SaleShops.vue） -->
    <section class="shop-strip" aria-label="多店铺抓单通道状态">
      <div
        v-for="sh in store.data.saleShops"
        :key="sh.code"
        class="shop-card"
        :class="{ warn: sh.status !== 'ONLINE' }"
      >
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
          <b>{{ sh.label }}</b>
          <span class="tag" :class="sh.status === 'ONLINE' ? 'grn' : 'red'">
            {{ sh.status === 'ONLINE' ? '✓ 通道在线' : '✕ 发现漏单预警' }}
          </span>
        </div>
        <p class="muted" style="font-size:12px;margin-top:3px">{{ sh.platform }}（<code>{{ sh.account }}</code>）</p>
        <div class="shop-meta">
          <span>今日已抓 <b>{{ sh.todayGrabbed }}</b> 单</span>
          <span class="muted">同步：{{ sh.lastSyncAt }}</span>
        </div>
      </div>
    </section>

    <!-- 2. 同买家同地址合单提醒横幅（发现 >=2 笔同客同址订单时高亮呈现） -->
    <section v-for="grp in mergeGroups" :key="grp.key" class="merge-banner">
      <div class="mb-left">
        <span class="badge-l amb"><Icon name="merge" style="width:15px;height:15px" /> 发现可合并包裹订单（{{ grp.orders.length }} 单同买家同地址）</span>
        <p style="margin-top:6px;font-size:13.5px">
          买家 <b>{{ grp.buyerName }}（{{ grp.buyerPhone }}）</b> 在「{{ grp.shopName }}」连续拍下
          <b>{{ grp.orders.map(o => o.externalOrderNo).join(' + ') }}</b>，收货地址完全一致：{{ grp.receiverAddr }}
        </p>
        <div class="mb-items">
          <span v-for="o in grp.orders" :key="o.id" class="tag">
            {{ o.externalOrderNo }} · {{ o.itemTitle }}（货号 <b>#{{ o.skuCode }}</b> · 库位 {{ o.locationCode }}）
          </span>
        </div>
      </div>
      <div class="mb-right">
        <Lock
          :ok="!locked"
          reason="先完成首日 3 个练习"
          kind="pri"
          @go="mergeSameBuyerOrders(grp.key)"
        >
          <Icon name="merge" />一键合单（合并为 1 票母单省顺丰首重）
        </Lock>
        <p class="muted" style="font-size:12px">合单后共打 1 张顺丰电子面单，发货后同一运单号自动回写全部子订单。</p>
      </div>
    </section>

    <!-- 3. 订单聚合 6 态分流栏 + 批量组波次操作条 -->
    <div class="bar-row">
      <div class="seg">
        <button :class="{ on: flt === 'ALL' }" @click="flt = 'ALL'">
          全部有效单<em>{{ visibleOrders.length }}</em>
        </button>
        <button :class="{ on: flt === 'ACTION' }" @click="flt = 'ACTION'">
          <i class="dot red"></i>待补抓 / 待配SKU<em>{{ actionCount }}</em>
        </button>
        <button :class="{ on: flt === 'MERGEABLE' }" @click="flt = 'MERGEABLE'">
          <i class="dot amb"></i>可合单<em>{{ mergeableCount }}</em>
        </button>
        <button :class="{ on: flt === 'READY_WAVE' }" @click="flt = 'READY_WAVE'">
          <i class="dot acc"></i>已锁库待组波次<em>{{ readyWaveOrders.length }}</em>
        </button>
        <button :class="{ on: flt === 'HOLD_INTERCEPT' }" @click="flt = 'HOLD_INTERCEPT'">
          <i class="dot red"></i>改址/退款拦截<em>{{ holdCount }}</em>
        </button>
        <button :class="{ on: flt === 'WAVE_SHIP' }" @click="flt = 'WAVE_SHIP'">
          <i class="dot grn"></i>波次拣货中 / 已发回传<em>{{ shippedOrWaveCount }}</em>
        </button>
      </div>

      <div class="wave-bar">
        <input
          v-model="kw"
          class="inp"
          style="width:240px"
          placeholder="搜外部单号 / 买家 / 货号 / 库位…"
        />
        <button v-if="readyWaveOrders.length" class="btn sm" @click="selectAllReady">
          全选待组波次（{{ readyWaveOrders.length }}）
        </button>
        <Lock
          :ok="selectedWaveIds.length > 0 && !locked"
          :reason="locked ? '先完成首日练习' : '请先在下方列表勾选至少 1 笔「已锁库待组波次」的订单（未绑定SKU或处于改址/退款拦截态的订单已防呆禁选）'"
          kind="ok"
          @go="handleCreateWave"
        >
          <Icon name="truck" />生成拣货波次单下发出库台（已选 {{ selectedWaveIds.length }} 单）
        </Lock>
      </div>
    </div>

    <!-- 4. 标准化订单聚合主表 -->
    <section class="card" style="padding:0;overflow:hidden">
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:42px">波次</th>
              <th style="width:185px">平台外部单号 / 店铺来源</th>
              <th style="width:205px">买家与收货地址（自动聚合识别）</th>
              <th>购买商品标题 · SPU 标准型号</th>
              <th style="width:225px">一物一码配货 · WMS 库位</th>
              <th style="width:155px">订单聚合状态</th>
              <th style="width:250px">日常标准处理动作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ord in filteredOrders"
              :key="ord.id"
              :class="rowCls(ord)"
            >
              <td>
                <input
                  type="checkbox"
                  :value="ord.id"
                  v-model="selectedWaveIds"
                  :disabled="ord.aggState !== 'READY_WAVE' || locked"
                  :title="ord.aggState === 'READY_WAVE' ? '勾选加入拣货波次' : '仅已锁库且无拦截的订单可加入波次'"
                />
              </td>
              <td>
                <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
                  <b class="mono">{{ ord.externalOrderNo }}</b>
                  <span v-if="ord.isMergedMaster" class="tag acc">合单母单</span>
                </div>
                <div v-if="ord.isMergedMaster" class="muted" style="font-size:11.5px;margin-top:2px">
                  含子单：{{ ord.subOrderNos.join('、') }}
                </div>
                <div class="muted" style="font-size:12px;margin-top:3px">
                  {{ ord.shopName }} · ¥{{ ord.amount }}
                </div>
                <div class="muted" style="font-size:11.5px">{{ ord.paidAt }} 付款 · {{ ord.captureSource }}</div>
              </td>

              <td>
                <div><b>{{ ord.buyerName }}</b> <span class="mono muted" style="font-size:12px">{{ ord.buyerPhone }}</span></div>
                <div style="font-size:12px;color:var(--ink2);margin-top:3px;line-height:1.45">{{ ord.receiverAddr }}</div>
                <span v-if="ord.aggState === 'MERGEABLE'" class="tag amb" style="margin-top:4px">同买家同地址 · 可合单</span>
              </td>

              <td>
                <div style="font-weight:650;line-height:1.4">{{ ord.itemTitle }}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
                  <span v-if="ord.spuCode" class="tag"><code>{{ ord.spuCode }}</code></span>
                  <span class="tag">{{ ord.carrier }}</span>
                  <span v-if="ord.waveNo" class="tag dark">{{ ord.waveNo }}</span>
                </div>
              </td>

              <td>
                <template v-if="ord.skuCode">
                  <div>
                    <a @click="openItemDetail(ord.skuCode)"><b>#{{ ord.skuCode }}</b></a>
                    <span class="tag" style="margin-left:6px">库位 <b>{{ ord.locationCode }}</b></span>
                  </div>
                  <div v-if="ord.extraItems?.length" style="margin-top:4px;font-size:12px" class="muted">
                    + 同拣配件：<b v-for="ex in ord.extraItems" :key="ex.skuCode">#{{ ex.skuCode }}({{ ex.locationCode }}) </b>
                  </div>
                  <div v-if="ord.waybillNo" class="mono muted" style="font-size:12px;margin-top:3px">
                    运单：{{ ord.waybillNo }}
                  </div>
                </template>
                <template v-else>
                  <span class="tag red">✕ 尚未绑定一物一码实物</span>
                  <div style="margin-top:6px">
                    <select v-model="skuPickMap[ord.id]" class="inp" style="width:100%;min-height:32px;padding:4px 8px;font-size:12.5px">
                      <option value="">-- 选同 SPU 在库可售单件 --</option>
                      <option
                        v-for="cand in candidateSkusForOrder(ord)"
                        :key="cand.code"
                        :value="cand.code"
                        :disabled="cand.zone !== '已复核可售'"
                      >
                        #{{ cand.code }} · 库位 {{ cand.location }} · {{ cand.conditionGrade || cand.zone }}{{ cand.zone !== '已复核可售' ? `（${cand.zone}禁选）` : '' }}
                      </option>
                    </select>
                  </div>
                </template>
              </td>

              <td>
                <span class="tag" :class="stateBadge(ord).cls">{{ stateBadge(ord).text }}</span>
                <p v-if="ord.holdReason" style="font-size:11.5px;color:var(--red-ink);margin-top:4px;line-height:1.4">
                  {{ ord.holdReason }}
                </p>
                <p v-if="ord.syncError" style="font-size:11.5px;color:var(--red-ink);margin-top:4px;line-height:1.4">
                  {{ ord.syncError }}
                </p>
              </td>

              <td>
                <!-- 1. 漏抓补抓 -->
                <div v-if="ord.aggState === 'CAPTURE_MISSED'">
                  <Lock :ok="!locked" reason="先完成练习" kind="sm pri" @go="captureMissedOrder(ord)">
                    一键补抓入池并锁库
                  </Lock>
                </div>

                <!-- 2. 通卖链接绑定具体一物一码SKU -->
                <div v-else-if="ord.aggState === 'UNMATCHED_SKU'">
                  <Lock
                    :ok="Boolean(skuPickMap[ord.id]) && !locked"
                    :reason="locked ? '先完成练习' : '请先在左侧下拉框选定 1 台同型号「已复核可售」实物单件'"
                    kind="sm pri"
                    @go="bindOrderToPhysicalSku(ord, skuPickMap[ord.id])"
                  >
                    绑定单件货号并锁库
                  </Lock>
                </div>

                <!-- 3. 可合单订单 -->
                <div v-else-if="ord.aggState === 'MERGEABLE'" style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="btn sm pri" :disabled="locked" @click="mergeSameBuyerOrders(ord.mergeGroupKey)">
                    一键同址合单
                  </button>
                  <button class="btn sm" :disabled="locked" @click="ord.aggState = 'READY_WAVE'">
                    不合单独立发
                  </button>
                </div>

                <!-- 4. 已锁库待组波次 -->
                <div v-else-if="ord.aggState === 'READY_WAVE'" style="display:flex;gap:6px;flex-wrap:wrap">
                  <button class="btn sm ok" :disabled="locked" @click="quickSingleWave(ord)">
                    单笔直发波次 ›
                  </button>
                  <button v-if="ord.isMergedMaster" class="btn sm" :disabled="locked" @click="splitMergedOrder(ord)">
                    拆回独立单
                  </button>
                </div>

                <!-- 5. 改址或售前退款拦截 -->
                <div v-else-if="ord.aggState === 'HOLD_INTERCEPT'" style="display:flex;gap:6px;flex-wrap:wrap">
                  <button
                    v-if="ord.holdType === 'REFUND_APPLY'"
                    class="btn sm bad"
                    :disabled="locked"
                    @click="resolveInterceptOrder(ord, 'CANCEL_REFUND_RELEASE')"
                  >
                    确认售前退款 · 释放锁库SKU
                  </button>
                  <template v-else>
                    <button class="btn sm" @click="go('outbound')">去出库台核查 ›</button>
                    <button class="btn sm pri" :disabled="locked" @click="resolveInterceptOrder(ord, 'APPROVE_NEW_ADDR')">
                      销售已确认新址 · 放行
                    </button>
                  </template>
                </div>

                <!-- 6. 已在波次拣货中 -->
                <div v-else-if="ord.aggState === 'IN_WAVE'">
                  <button class="btn sm pri" @click="go('outbound')">
                    去波次拣货打单 ({{ ord.waveNo }}) ›
                  </button>
                </div>

                <!-- 7. 已发货与回传 -->
                <div v-else-if="ord.aggState === 'SHIPPED_SYNC'">
                  <button
                    v-if="ord.syncStatus === 'CALLBACK_FAILED'"
                    class="btn sm bad"
                    :disabled="locked"
                    @click="retryOrderPlatformCallback(ord)"
                  >
                    重试回传单号至店铺
                  </button>
                  <span v-else class="tag grn">✓ 已发货并回传平台</span>
                </div>

                <span v-else class="tag">已退款关单释放</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 手工兜底补录订单弹窗（带外部单号唯一防重校验） -->
    <div v-if="manualOpen" class="mask" @click.self="manualOpen = false">
      <div class="modal big" role="dialog" aria-label="手工补录销售订单">
        <h3>手工补录 / 表格口令兜底导单</h3>
        <p class="muted" style="font-size:13px">
          用于线下私域成交、同城急单或渠道 API 临时维护兜底录入。系统强制校验<b>外部单号唯一性</b>，防止重复抓单发重货。
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label>外部平台订单号（必填，自动查重）<input v-model="manForm.externalOrderNo" placeholder="如 DEMO-XY-035（试输 DEMO-XY-027 测防重）" /></label>
          <label>
            归属店铺渠道
            <select v-model="manForm.shopCode">
              <option v-for="s in store.data.saleShops" :key="s.code" :value="s.code">{{ s.label }}</option>
            </select>
          </label>
          <label>买家昵称/姓名<input v-model="manForm.buyerName" placeholder="例如：张先生" /></label>
          <label>联系电话<input v-model="manForm.buyerPhone" placeholder="例如：（演示号码已隐藏）" /></label>
        </div>
        <label>详细收货地址<input v-model="manForm.receiverAddr" placeholder="省市区街道门牌号（同买家同地址将自动提示合单）" /></label>
        <div style="display:grid;grid-template-columns:1fr 1.6fr;gap:10px">
          <label>实付金额（元）<input v-model="manForm.amount" type="number" /></label>
          <label>
            直接指定在库可售单件（选填，不选则进待配SKU队列）
            <select v-model="manForm.skuCode">
              <option value="">-- 暂不绑定（入池后选货） --</option>
              <option v-for="s in saleableSkus" :key="s.code" :value="s.code">
                #{{ s.code }} · {{ s.brand }} {{ s.model }}（{{ s.location }}）
              </option>
            </select>
          </label>
        </div>
        <div class="mfoot">
          <button class="btn" @click="manualOpen = false">取消</button>
          <Lock
            :ok="Boolean(manForm.externalOrderNo.trim() && manForm.buyerName.trim() && manForm.receiverAddr.trim())"
            reason="请填写外部平台订单号、买家姓名与详细收货地址"
            @go="submitManual"
          >校验防重并录入订单池</Lock>
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
  openItemDetail,
  pullAllShopOrders,
  captureMissedOrder,
  bindOrderToPhysicalSku,
  mergeSameBuyerOrders,
  splitMergedOrder,
  resolveInterceptOrder,
  createManualSalesOrder,
  dispatchPickingWave,
  retryOrderPlatformCallback
} from '../store/warehouseStore.js'

const flt = ref('ALL')
const kw = ref('')
const selectedWaveIds = ref([])
const skuPickMap = reactive({ 'ORD-261114-02': '910000000003' })
const manualOpen = ref(false)
const locked = computed(() => !currentUser.value.practiceDone)

const visibleOrders = computed(() =>
  (store.data.salesOrderPool || []).filter(o => o.aggState !== 'MERGED_CHILD')
)

const mergeGroups = computed(() => {
  const map = new Map()
  for (const o of visibleOrders.value) {
    if (o.aggState !== 'MERGEABLE' || !o.mergeGroupKey) continue
    if (!map.has(o.mergeGroupKey)) {
      map.set(o.mergeGroupKey, {
        key: o.mergeGroupKey,
        buyerName: o.buyerName,
        buyerPhone: o.buyerPhone,
        receiverAddr: o.receiverAddr,
        shopName: o.shopName,
        orders: []
      })
    }
    map.get(o.mergeGroupKey).orders.push(o)
  }
  return [...map.values()].filter(g => g.orders.length >= 2)
})

const actionCount = computed(() =>
  visibleOrders.value.filter(o => o.aggState === 'CAPTURE_MISSED' || o.aggState === 'UNMATCHED_SKU').length
)
const mergeableCount = computed(() =>
  visibleOrders.value.filter(o => o.aggState === 'MERGEABLE').length
)
const readyWaveOrders = computed(() =>
  visibleOrders.value.filter(o => o.aggState === 'READY_WAVE')
)
const holdCount = computed(() =>
  visibleOrders.value.filter(o => o.aggState === 'HOLD_INTERCEPT').length
)
const shippedOrWaveCount = computed(() =>
  visibleOrders.value.filter(o => o.aggState === 'IN_WAVE' || o.aggState === 'SHIPPED_SYNC').length
)

watch(readyWaveOrders, (list) => {
  const valid = new Set(list.map(o => o.id))
  selectedWaveIds.value = selectedWaveIds.value.filter(id => valid.has(id))
})

const filteredOrders = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return visibleOrders.value.filter(o => {
    if (flt.value === 'ACTION' && !(o.aggState === 'CAPTURE_MISSED' || o.aggState === 'UNMATCHED_SKU')) return false
    if (flt.value === 'MERGEABLE' && o.aggState !== 'MERGEABLE') return false
    if (flt.value === 'READY_WAVE' && o.aggState !== 'READY_WAVE') return false
    if (flt.value === 'HOLD_INTERCEPT' && o.aggState !== 'HOLD_INTERCEPT') return false
    if (flt.value === 'WAVE_SHIP' && !(o.aggState === 'IN_WAVE' || o.aggState === 'SHIPPED_SYNC')) return false
    if (!q) return true
    const blob = `${o.externalOrderNo} ${(o.subOrderNos || []).join(' ')} ${o.buyerName} ${o.buyerPhone} ${o.itemTitle} ${o.skuCode} ${o.locationCode} ${o.shopName}`.toLowerCase()
    return blob.includes(q)
  })
})

function candidateSkusForOrder(ord) {
  const all = store.data.skus || []
  const exact = all.filter(s => ord.spuCode && s.spuCode === ord.spuCode && s.zone !== '已出库在途')
  return exact.length ? exact : all.filter(s => s.zone === '已复核可售')
}

const saleableSkus = computed(() => (store.data.skus || []).filter(s => s.zone === '已复核可售'))

function stateBadge(ord) {
  switch (ord.aggState) {
    case 'CAPTURE_MISSED': return { cls: 'red', text: '✕ 渠道漏抓待补入' }
    case 'UNMATCHED_SKU': return { cls: 'red', text: '✕ 待选具体SKU配货' }
    case 'MERGEABLE': return { cls: 'amb', text: '! 同买家可合单' }
    case 'READY_WAVE': return { cls: 'acc', text: '已锁库 · 待组波次' }
    case 'HOLD_INTERCEPT': return { cls: 'red', text: ord.holdType === 'REFUND_APPLY' ? '✕ 售前退款拦截' : '✕ 买家改址拦截' }
    case 'IN_WAVE': return { cls: 'dark', text: `波次拣货中` }
    case 'SHIPPED_SYNC':
      return ord.syncStatus === 'CALLBACK_FAILED'
        ? { cls: 'red', text: '✕ 单号回传店铺失败' }
        : { cls: 'grn', text: '✓ 已发货并回传' }
    default: return { cls: '', text: '已取消释放' }
  }
}

function rowCls(ord) {
  if (ord.aggState === 'CAPTURE_MISSED' || ord.aggState === 'UNMATCHED_SKU' || ord.aggState === 'HOLD_INTERCEPT' || ord.syncStatus === 'CALLBACK_FAILED') return 'red'
  if (ord.aggState === 'MERGEABLE') return 'amb'
  return ''
}

function selectAllReady() {
  selectedWaveIds.value = readyWaveOrders.value.map(o => o.id)
}

function handleCreateWave() {
  const waveNo = dispatchPickingWave(selectedWaveIds.value)
  if (waveNo) {
    selectedWaveIds.value = []
    go('outbound')
  }
}

function quickSingleWave(ord) {
  const waveNo = dispatchPickingWave([ord.id])
  if (waveNo) go('outbound')
}

const manForm = reactive({
  externalOrderNo: 'DEMO-XY-034',
  shopCode: 'SHOP-05',
  buyerName: '演示买家08',
  buyerPhone: '（演示号码已隐藏）',
  receiverAddr: '深圳市演示区样本路08号',
  amount: 580,
  spuCode: 'SPU-PHL-27M2N5500',
  skuCode: ''
})

function submitManual() {
  if (createManualSalesOrder(manForm)) {
    manualOpen.value = false
    manForm.externalOrderNo = 'DEMO-XY-MANUAL-' + Math.floor(96 + Math.random() * 90)
  }
}
</script>

<style scoped>
.shop-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}
.shop-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 13px;
}
.shop-card.warn {
  border-color: #f4c6c3;
  background: #fffafa;
}
.shop-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed var(--line);
  font-size: 12px;
}
.merge-banner {
  background: var(--amb-soft);
  border: 1px solid #f5d8bc;
  border-left: 4px solid var(--amb);
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.mb-left { flex: 1; min-width: 320px; }
.mb-items { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.mb-right { display: grid; gap: 5px; justify-items: end; }
.bar-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 14px 0;
}
.wave-bar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
