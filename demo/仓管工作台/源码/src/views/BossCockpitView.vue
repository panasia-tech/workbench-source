<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">👑 老板专属经营与资损风控舱 · 与《老板全量台账 V3》互补联动 · 只看资金、跌价风险、漏钱黑洞与跨部门卡点</div>
        <h1>老板库存资金与风控舱<Q k="boss" /></h1>
        <p class="sub">
          3 分钟看透仓库真实现状：<b>一共压了多少钱的货？多少被阻塞卖不了？多少面临 28 天滞销跌价或 30 天锂电亏电饿死？有没有未召回就打款的钱货两空风险？采—仓—销—客到底卡在谁手里？</b>
        </p>
      </div>
      <div class="acts">
        <button class="btn" @click="go('supervisor')"><Icon name="shield" />切看主管审批台 ›</button>
        <button class="btn" @click="openHelp('boss')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 第一排：在库总资金四维拆解（钱压在哪了？） -->
    <div class="money-grid">
      <div class="m-card dark">
        <span class="m-lbl">全仓在库实物总成本（{{ totalSkus }} 台）</span>
        <b class="m-val mono">¥{{ totalCost.toLocaleString() }}</b>
        <span class="m-sub">原采购单只读真源汇总 · 零账外黑货</span>
      </div>

      <div class="m-card grn" @click="go('legacy-wash')">
        <span class="m-lbl">🟢 四关齐套 · 随时可卖健康货值（{{ healthySellableSkus.length }} 台）</span>
        <b class="m-val mono" style="color:var(--grn)">¥{{ healthySellableCost.toLocaleString() }}</b>
        <span class="m-sub">全检+可读视频+实拍+子母码齐全（占比 {{ pct(healthySellableCost, totalCost) }}%）</span>
      </div>

      <div class="m-card red" @click="go('legacy-wash')">
        <span class="m-lbl">🔴 售前阻塞压死货值（{{ blockedSkus.length }} 台卖不了）</span>
        <b class="m-val mono" style="color:var(--red)">¥{{ blockedCost.toLocaleString() }}</b>
        <span class="m-sub">因缺全检/缺视频/缺实拍/隔离被锁死禁售 · 点此督办清零 ›</span>
      </div>

      <div class="m-card amb" @click="go('battery')">
        <span class="m-lbl">⚠️ 跌价与电芯饿死高危货值（{{ agingOrBatteryRiskSkus.length }} 台）</span>
        <b class="m-val mono" style="color:var(--amb)">¥{{ agingOrBatteryRiskCost.toLocaleString() }}</b>
        <span class="m-sub">含满28天滞销 + 锂电≥30天未通电/原封满30天快出预警 ›</span>
      </div>
    </div>

    <!-- 第二排：左「四大资损与漏钱红线雷达」 + 右「采-仓-销-客跨部门周转卡点归因」 -->
    <div class="boss-split">
      <section class="card">
        <div class="sec-h">
          <h2>一、四大资损与漏钱红线实时监控（防钱货两空 · 防电芯报废）</h2>
          <span class="tag red">零容忍硬门禁</span>
        </div>

        <div class="risk-list">
          <div class="rk-row" :class="pendingRecalls.length ? 'red' : 'grn'" @click="go('courier')">
            <div>
              <div style="display:flex;gap:8px;align-items:center">
                <span class="tag" :class="pendingRecalls.length ? 'red' : 'grn'">红线 1 · 防打款后卖家操控退回</span>
                <b>站点/待退快件 10 分钟生死召回</b>
              </div>
              <p class="muted">
                {{
                  pendingRecalls.length
                    ? `当前 ${pendingRecalls.length} 票（${pendingRecalls.map(r => r.model).join('、')}）采购已谈妥留货，系统已硬锁死打款开关等待实物回仓！`
                    : '✓ 所有议妥留货快件均已在 10 分钟内物理追回入仓，零钱货两空敞口'
                }}
              </p>
            </div>
            <span class="rk-go">去查 ›</span>
          </div>

          <div class="rk-row" :class="overdueLithiumSkus.length ? 'red' : 'grn'" @click="go('battery')">
            <div>
              <div style="display:flex;gap:8px;align-items:center">
                <span class="tag" :class="overdueLithiumSkus.length ? 'red' : 'grn'">红线 2 · 防高值带电机亏电饿死</span>
                <b>锂电池商品 30 天必通电 + 保持彻底关机</b>
              </div>
              <p class="muted">
                {{
                  overdueLithiumSkus.length
                    ? `当前 ${overdueLithiumSkus.length} 台高值带电机（货值 ¥${overdueLithiumCost.toLocaleString()}）超 30 天未通电或仅合盖休眠未彻底关机，电芯面临锁保护板贬值风险！`
                    : '✓ 全仓带锂电商品均在 30 天安全周期内且已核验彻底关机存放'
                }}
              </p>
            </div>
            <span class="rk-go">去查 ›</span>
          </div>

          <div class="rk-row amb" @click="go('anomaly')">
            <div>
              <div style="display:flex;gap:8px;align-items:center">
                <span class="tag amb">红线 3 · 采购退货货钱双轨差额</span>
                <b>退回卖家快件「未退足货款 / 扣运费差额」追踪</b>
              </div>
              <p class="muted">
                当前在盯异常单 {{ store.data.anomalies.length }} 笔（货已寄出不算完，必须原网点签收 + 采购实收款差额核清双清才允许结案）。
              </p>
            </div>
            <span class="rk-go">去查 ›</span>
          </div>

          <div class="rk-row" :class="!store.data.stocktake.ledgerWrittenBack ? 'amb' : 'grn'" @click="go('stocktake')">
            <div>
              <div style="display:flex;gap:8px;align-items:center">
                <span class="tag" :class="!store.data.stocktake.ledgerWrittenBack ? 'amb' : 'grn'">红线 4 · 账实相符与买家退货归因</span>
                <b>盲盘盘亏核销 & 七天退货究竟怪采购还是怪仓管？</b>
              </div>
              <p class="muted">
                日常 10 分钟货架盲盘串位自动纠偏；买家退回件强制三代影像独立复验，拆清「售出损耗」与「原采购买入隐藏暗病追偿」。
              </p>
            </div>
            <span class="rk-go">去查 ›</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="sec-h">
          <h2>二、采—仓—销—客四端周转卡点归因（开会不听甩锅）</h2>
          <span class="tag acc">客观计时归因</span>
        </div>

        <div class="blame-grid">
          <div class="bl-card">
            <span class="tag">采购端责任卡点</span>
            <b>{{ unclaimedAsnCount }} 件无主包裹 / {{ pendingEodCount }} 票待定去留</b>
            <p class="muted">卖家漏填单号致包裹卡在 C-03 无法拆封，或拒签议价未在 17:00 前拍板去留。</p>
          </div>
          <div class="bl-card">
            <span class="tag red">仓管端责任卡点</span>
            <b>{{ blockedSkus.length }} 件缺全检/视频/实拍 · {{ overdueLithiumSkus.length }} 台锂电超期</b>
            <p class="muted">售前四关未补齐导致销售无法挂链接、客服发不出亮屏视频（要求当日清零）。</p>
          </div>
          <div class="bl-card">
            <span class="tag amb">销售端责任卡点</span>
            <b>{{ over28Skus.length }} 台满28天滞销 · {{ sealedOver30Skus.length }} 台原封满30天待快出</b>
            <p class="muted">仓管四关早已全绿放行，因定价偏高或未刷新多店切片导致压库超 4 周期。</p>
          </div>
          <div class="bl-card">
            <span class="tag acc">客服/订单协同效率</span>
            <b>60秒跨台补拍响应 · 拣货后退单红屏归架</b>
            <p class="muted">买家付款后改址/退款触发打包台红屏锁死并双扫码归回原架，杜绝桌底黑货。</p>
          </div>
        </div>

        <div class="why-box acc" style="margin-top:12px">
          <b>🔗 与《老板全量台账 V3》分工边界：</b>本舱专管「实物货值、锂电/滞销资产贬值、快递钱货风控与四端实物周转」；法人执照、企业支付宝、闲鱼店铺矩阵、10 台 64G Mac Pro（50号/台）算力健康与全司 Wiki/视频/KPI 终审，位于《老板全量台账 V3》，两边零重复造轮子。
        </div>
      </section>
    </div>

    <!-- 第三排：高危动作与服务端不可篡改审计流水预览 -->
    <section class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0;font-size:15.5px">三、最近库存高危变动与防损纠偏流水（最新 8 笔只读审计）</h3>
        <button class="btn sm ghost" @click="go('ledger')">查看全量流水并导出对账 CSV ›</button>
      </div>
      <table class="tbl">
        <thead>
          <tr>
            <th>流水单号</th>
            <th>发生时间</th>
            <th>变动类型</th>
            <th>单件货号</th>
            <th>商品型号</th>
            <th>来源 → 目标储位</th>
            <th>经办人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in (store.data.stockMovements || []).slice(0, 8)" :key="m.movNo">
            <td class="mono">{{ m.movNo }}</td>
            <td class="mono">{{ m.time }}</td>
            <td><span class="tag">{{ m.type }}</span></td>
            <td class="mono"><b>#{{ m.skuCode }}</b></td>
            <td>{{ m.model }}</td>
            <td class="mono">{{ m.fromLoc }} → {{ m.toLoc }}</td>
            <td>{{ m.operator }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import { store, go, openHelp, skuPreSalesGates, skuBatteryStatus } from '../store/warehouseStore.js'

const skus = computed(() => store.data.skus || [])
const totalSkus = computed(() => skus.value.length)
const totalCost = computed(() => skus.value.reduce((s, x) => s + (Number(x.cost) || 0), 0))

const healthySellableSkus = computed(() => skus.value.filter(x => skuPreSalesGates(x).lvl === 'grn'))
const healthySellableCost = computed(() => healthySellableSkus.value.reduce((s, x) => s + (Number(x.cost) || 0), 0))

const blockedSkus = computed(() => skus.value.filter(x => skuPreSalesGates(x).lvl === 'red'))
const blockedCost = computed(() => blockedSkus.value.reduce((s, x) => s + (Number(x.cost) || 0), 0))

const overdueLithiumSkus = computed(() =>
  skus.value.filter(x => {
    const st = skuBatteryStatus(x)
    return st.applicable && !st.isSealed && st.lvl === 'red'
  })
)
const overdueLithiumCost = computed(() => overdueLithiumSkus.value.reduce((s, x) => s + (Number(x.cost) || 0), 0))

const over28Skus = computed(() => skus.value.filter(x => (x.ageDays || 0) >= 28))
const sealedOver30Skus = computed(() => skus.value.filter(x => x.sealBranch === 'SEALED_NEW' && (x.daysSincePowerOn || 0) >= 30))

const agingOrBatteryRiskSkus = computed(() =>
  skus.value.filter(x => {
    const st = skuBatteryStatus(x)
    return (x.ageDays || 0) >= 28 || (st.applicable && (st.lvl === 'red' || (st.isSealed && x.daysSincePowerOn >= 30)))
  })
)
const agingOrBatteryRiskCost = computed(() => agingOrBatteryRiskSkus.value.reduce((s, x) => s + (Number(x.cost) || 0), 0))

const pendingRecalls = computed(() => (store.data.courierCoord?.urgentRecalls || []).filter(r => r.status !== 'RECALLED_SAFE'))
const pendingEodCount = computed(() => (store.data.courierCoord?.eodItems || []).filter(i => i.decision === 'PENDING').length)
const unclaimedAsnCount = computed(() => (store.data.inboundAsns || []).filter(a => a.status === 'UNCLAIMED_HOLD').length)

function pct(part, total) {
  if (!total) return 0
  return Math.round((part / total) * 100)
}
</script>

<style scoped>
.money-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0 16px;
}
.m-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 4px solid var(--acc);
  border-radius: 11px;
  padding: 14px 16px;
  display: grid;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
}
.m-card.dark { border-top-color: #0f172a; background: linear-gradient(135deg, #0f172a, #1e293b); color: #fff; cursor: default; }
.m-card.dark .m-lbl, .m-card.dark .m-sub { color: #cbd5e1; }
.m-card.grn { border-top-color: var(--grn); }
.m-card.red { border-top-color: var(--red); background: #fffafa; }
.m-card.amb { border-top-color: var(--amb); }
.m-lbl { font-size: 12px; font-weight: 700; color: var(--mute); }
.m-val { font-size: 26px; font-weight: 900; letter-spacing: -0.02em; }
.m-sub { font-size: 11.5px; color: var(--mute); }

.boss-split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.sec-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.sec-h h2 { margin: 0; font-size: 16.5px; }

.risk-list { display: grid; gap: 10px; }
.rk-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--acc);
  border-radius: 9px;
  background: var(--soft);
  cursor: pointer;
}
.rk-row.red { border-left-color: var(--red); background: #fff5f5; }
.rk-row.amb { border-left-color: var(--amb); }
.rk-row.grn { border-left-color: var(--grn); }
.rk-row p { margin: 5px 0 0; font-size: 12.5px; line-height: 1.45; }
.rk-go { font-size: 12.5px; font-weight: 700; color: var(--acc); flex-shrink: 0; }

.blame-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.bl-card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 12px;
  background: var(--soft);
  display: grid;
  gap: 5px;
  font-size: 12.5px;
}
.bl-card p { margin: 0; font-size: 12px; line-height: 1.45; }
@media (max-width: 1200px) {
  .money-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .boss-split, .blame-grid { grid-template-columns: 1fr; }
}
</style>
