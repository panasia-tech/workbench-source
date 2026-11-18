<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">🧭 仓管主管专属总控端 · 五合一集中审批箱 · 五大硬死线实时督战 · 人效与三要素改派</div>
        <h1>主管审批与督战台<Q k="supervisor" /></h1>
        <p class="sub">
          把原本散落在 5 个业务菜单里的<b>特例审批、盲盘调账、留货放行、标准升版与新情况定规则</b>收拢一屏秒批；同屏盯死<b>站点10分钟召回、锂电30天通电关机、历史阻塞当日清零、17:00快件去留与波次出库</b>五大死线。
        </p>
      </div>
      <div class="acts">
        <span v-if="!isSupervisor" class="tag amb">当前为员工只读预览 · 点右上角切「周卫东」解锁审批</span>
        <button class="btn" @click="go('today')">切回工单队列视图 ›</button>
        <button class="btn" @click="openHelp('supervisor')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 顶部五大硬死线实时督战雷达 -->
    <div class="sup-radar">
      <div class="sr-card" :class="pendingRecallCount ? 'red' : 'grn'" @click="go('courier')">
        <span class="tag" :class="pendingRecallCount ? 'red' : 'grn'">① 快递10分钟生死召回</span>
        <b>{{ pendingRecallCount }} 票待追回 · 17:00待定 {{ pendingEodCount }} 票</b>
        <small>点击直达企微快递互通群督战 ›</small>
      </div>
      <div class="sr-card" :class="overdueBatteryCount ? 'red' : 'grn'" @click="go('battery')">
        <span class="tag" :class="overdueBatteryCount ? 'red' : 'grn'">② 锂电30天通电关机</span>
        <b>{{ overdueBatteryCount }} 台超期/未真关机</b>
        <small>防过放饿死锁保护板 · 去统筹 ›</small>
      </div>
      <div class="sr-card" :class="blockedWashCount ? 'red' : 'grn'" @click="go('legacy-wash')">
        <span class="tag" :class="blockedWashCount ? 'red' : 'grn'">③ 历史阻塞当日清零</span>
        <b>{{ blockedWashCount }} 件红灯卡住客服售前</b>
        <small>不设每日上限 · 去清洗画廊 ›</small>
      </div>
      <div class="sr-card" :class="openBlindCount ? 'amb' : 'grn'" @click="go('stocktake')">
        <span class="tag" :class="openBlindCount ? 'amb' : 'grn'">④ 货架盲盘与串位纠偏</span>
        <b>{{ openBlindCount }} 批微盘进行中 · {{ unapprovedDiffCount }} 条待批</b>
        <small>权责分离盲盘 · 去复核 ›</small>
      </div>
      <div class="sr-card" :class="pendingOutboundCount ? 'red' : 'grn'" @click="go('outbound')">
        <span class="tag" :class="pendingOutboundCount ? 'red' : 'grn'">⑤ 17:00 波次四码出库</span>
        <b>{{ pendingOutboundCount }} 单待四码复核/拦截归架</b>
        <small>防漏发附件袋与桌底积压 ›</small>
      </div>
    </div>

    <!-- 主体双栏：左五合一集中审批箱 + 右在岗负载均衡与三要素改派 -->
    <div class="sup-main">
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <h2 style="margin:0;font-size:17.5px">五合一集中审批箱（共 {{ totalPendingApprovals }} 项待主管拍板）</h2>
            <p class="muted" style="font-size:12.5px;margin-top:2px">无需翻遍 5 个菜单，同屏核对现场证据照片/条件锁一键批复（服务端同步校验主管权限）</p>
          </div>
          <span class="tag" :class="totalPendingApprovals ? 'red' : 'grn'">
            {{ totalPendingApprovals ? `待批 ${totalPendingApprovals} 项` : '✓ 当前审批已全部清零' }}
          </span>
        </div>

        <div class="appr-list">
          <!-- 1. 折价改留货 4 项反悔防呆锁放行 -->
          <div v-for="ano in keepGoodsAnomalies" :key="ano.id" class="appr-card">
            <div class="ac-top">
              <span class="tag red">留货隔离放行审单</span>
              <b>{{ ano.title }}（<code>#{{ ano.skuCode }}</code>）</b>
              <button class="btn sm ghost" style="margin-left:auto" @click="go('anomaly', ano.id)">看完整证据链 ›</button>
            </div>
            <p class="muted" style="font-size:12.5px">
              4 项反悔防呆锁核对：撤回退款({{ ano.keepLocks.refundWithdrawn ? '✓' : '✕' }}) · 实物在仓({{ ano.keepLocks.goodsInHouse ? '✓' : '✕' }}) · 成本回写({{ ano.keepLocks.costUpdated ? '✓' : '✕' }}) · 披露同步销售({{ ano.keepLocks.disclosureSynced ? '✓' : '✕' }})
            </p>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn sm" @click="checkAllKeepLocks(ano)">一键核清 4 项防呆锁</button>
              <Lock
                :ok="isSupervisor && ano.keepLocks.refundWithdrawn && ano.keepLocks.goodsInHouse && ano.keepLocks.costUpdated && ano.keepLocks.disclosureSynced"
                :reason="!isSupervisor ? '请切换右上角「周卫东（主管）」执行审批' : '须先核清上方 4 项反悔防呆锁才允许解除隔离'"
                kind="sm pri"
                @go="approveKeepGoodsBySupervisor(ano)"
              >批准解除隔离转可售</Lock>
            </div>
          </div>

          <!-- 2. 全仓盘点差异审批与调账回写 -->
          <div v-if="!st.ledgerWrittenBack" class="appr-card">
            <div class="ac-top">
              <span class="tag amb">盘点差异与调账审批</span>
              <b>{{ st.batchNo }} · 共 {{ st.discrepancies.length }} 条盘点差异（未批 {{ unapprovedDiffCount }} 条）</b>
              <button class="btn sm ghost" style="margin-left:auto" @click="go('stocktake')">看微距留证照 ›</button>
            </div>
            <div style="display:grid;gap:6px;margin:4px 0">
              <div v-for="d in st.discrepancies" :key="d.id" style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;background:#fff;padding:6px 10px;border-radius:6px;border:1px solid var(--line)">
                <span><b>#{{ d.skuCode }}</b> {{ d.model }} · {{ d.diffType }}（{{ d.evidence }}）</span>
                <span v-if="d.approved" class="tag grn">✓ 已批</span>
                <button v-else class="btn sm pri" :disabled="!isSupervisor" @click="approveStocktakeDiffBySupervisor(d)">批准此差异</button>
              </div>
            </div>
            <Lock
              :ok="isSupervisor && unapprovedDiffCount === 0"
              :reason="!isSupervisor ? '仅仓管主管可执行调账回写' : `还有 ${unapprovedDiffCount} 条差异未逐条批准`"
              kind="sm ok"
              @go="commitStocktakeWriteback"
            >全部已核准 · 执行库存账面调账回写</Lock>
          </div>

          <!-- 3. 爱回收 1,042 标准增量草稿发布 -->
          <div v-for="dr in pendingDrafts" :key="dr.id" class="appr-card">
            <div class="ac-top">
              <span class="tag acc">1,042 验货标准升版审核</span>
              <b>{{ dr.changeTitle }}（{{ dr.currentVer }} → {{ dr.nextVer }}）</b>
              <button class="btn sm ghost" style="margin-left:auto" @click="go('standards')">对照超集树 ›</button>
            </div>
            <p class="muted" style="font-size:12.5px">来源：{{ dr.crawlSource }} · 影响当前在库同品类 <b>{{ dr.impactedInStock }} 件</b>（在办验货单锁定旧版绝不串版）</p>
            <Lock
              :ok="isSupervisor"
              reason="仅仓管主管可审核发布验货标准新版本"
              kind="sm pri"
              @go="publishStandardDraft(dr)"
            >审核通过并升版至 {{ dr.nextVer }}</Lock>
          </div>

          <!-- 4. 一线工单待验收 & 员工上报「没见过的情况」定规则 -->
          <div v-for="t in reviewTasks" :key="t.id" class="appr-card">
            <div class="ac-top">
              <span class="tag amb">工单完工待验收</span>
              <b>{{ t.id }} · {{ t.title }}（经办：{{ t.assigneeName }}）</b>
            </div>
            <p class="muted" style="font-size:12.5px">提交回执：{{ t.evidence || '现场已完成留证' }}</p>
            <div style="display:flex;gap:8px">
              <button class="btn sm ok" :disabled="!isSupervisor" @click="reviewTaskBySupervisor(t.id, true, '主管集中台核验通过')">验收通过结单</button>
              <button class="btn sm bad" :disabled="!isSupervisor" @click="reviewTaskBySupervisor(t.id, false, '请补充库位同框特写')">退回补正</button>
            </div>
          </div>

          <div v-for="ex in pendingExceptions" :key="ex.id" class="appr-card">
            <div class="ac-top">
              <span class="tag red">一线新边界情况待定规则</span>
              <b>{{ ex.who }} 上报（{{ ex.t }}）</b>
            </div>
            <p style="font-size:13px;margin:2px 0">{{ ex.text }}</p>
            <button class="btn sm pri" :disabled="!isSupervisor" @click="ruleException(ex)">定案并写入全员《说明书》补充规则</button>
          </div>

          <p v-if="totalPendingApprovals === 0" class="why-box grn">
            ✓ 太棒了！当前所有留货放行、盘点调账、标准升版、完工验收与新情况规则已全部批复清零！
          </p>
        </div>
      </section>

      <!-- 右栏：团队实时负载 + 对接老板全量台账V3软基建槽位 -->
      <aside style="display:grid;gap:14px">
        <section class="card">
          <h3 style="margin:0 0 10px;font-size:15.5px">在岗仓管员实时红黄单负载</h3>
          <div v-for="w in WORKERS" :key="w.id" class="wk-box">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>{{ w.name }} <small class="muted">（{{ w.shift }}）</small></b>
              <span style="font-size:12px">
                <b style="color:var(--red)">红 {{ workerCount(w.id, 'red') }}</b> ·
                <b style="color:var(--amb)">黄 {{ workerCount(w.id, 'amb') }}</b>
              </span>
            </div>
            <div class="bar" style="height:7px;margin-top:6px">
              <i :style="{ width: Math.min(100, (workerCount(w.id, 'red') * 22 + workerCount(w.id, 'amb') * 12)) + '%', background: workerCount(w.id, 'red') > 3 ? 'var(--red)' : 'var(--acc)' }"></i>
            </div>
          </div>
          <p class="muted" style="font-size:12px;margin-top:8px">
            员工请假或临时抽调时，可在「今天」队列填「已完成 / 未完成 / 下一步」三要素改派，原经办人自动失权防撞单。
          </p>
        </section>

        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <h3 style="margin:0;font-size:15px">本部门制度/视频/KPI 治理衔接</h3>
            <span class="tag acc">对齐全量台账 V3</span>
          </div>
          <p class="muted" style="font-size:12.5px">
            与《老板全量台账 V3 · 12 工作台基建》同源挂载，总经办初审、老板终审通过后自动点亮各页 <code>?</code> 帮助视频与 KPI 口径：
          </p>
          <div style="display:grid;gap:7px;margin-top:8px;font-size:12.5px">
            <div class="gov-row"><span class="tag grn">已上线</span><span>Wiki · 钉钉《工作台日志 01/02》快递与锂电规范</span></div>
            <div class="gov-row"><span class="tag grn">已上线</span><span>KPI · 站点10m召回率100% / 锂电30d超期=0</span></div>
            <div class="gov-row"><span class="tag amb">待补录</span><span>视频 · 防爆补电车55%半电与彻底关机实拍微课</span></div>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  ACCOUNTS,
  isSupervisor,
  go,
  openHelp,
  skuPreSalesGates,
  skuBatteryStatus,
  approveKeepGoodsBySupervisor,
  approveStocktakeDiffBySupervisor,
  commitStocktakeWriteback,
  publishStandardDraft,
  reviewTaskBySupervisor,
  ruleException
} from '../store/warehouseStore.js'

const WORKERS = ACCOUNTS.filter(a => a.role === 'WAREHOUSE')

const pendingRecallCount = computed(() => (store.data.courierCoord?.urgentRecalls || []).filter(r => r.status !== 'RECALLED_SAFE').length)
const pendingEodCount = computed(() => (store.data.courierCoord?.eodItems || []).filter(i => i.decision === 'PENDING').length)
const overdueBatteryCount = computed(() =>
  (store.data.skus || []).filter(s => {
    const st = skuBatteryStatus(s)
    return st.applicable && !st.isSealed && st.lvl === 'red'
  }).length
)
const blockedWashCount = computed(() => (store.data.skus || []).filter(s => skuPreSalesGates(s).lvl === 'red').length)
const openBlindCount = computed(() => (store.data.blindCycleSessions || []).filter(b => b.phase !== 'CLOSED').length)
const st = computed(() => store.data.stocktake || { batchNo: '', ledgerWrittenBack: true, discrepancies: [] })
const unapprovedDiffCount = computed(() => (st.value.discrepancies || []).filter(d => !d.approved).length)
const pendingOutboundCount = computed(() => (store.data.outbounds || []).filter(o => o.status !== 'SHIPPED' && o.status !== 'RETURNED_TO_SHELF').length)

const keepGoodsAnomalies = computed(() => (store.data.anomalies || []).filter(a => a.keepLocks && a.isolationLocked))
const pendingDrafts = computed(() => (store.data.standardDrafts || []).filter(d => d.status !== 'PUBLISHED'))
const reviewTasks = computed(() => (store.data.tasks || []).filter(t => t.status === '待验收'))
const pendingExceptions = computed(() => (store.data.exceptions || []).filter(e => !e.ruled))

const totalPendingApprovals = computed(() =>
  keepGoodsAnomalies.value.length +
  (st.value.ledgerWrittenBack ? 0 : 1) +
  pendingDrafts.value.length +
  reviewTasks.value.length +
  pendingExceptions.value.length
)

function checkAllKeepLocks(ano) {
  ano.keepLocks.refundWithdrawn = true
  ano.keepLocks.goodsInHouse = true
  ano.keepLocks.costUpdated = true
  ano.keepLocks.disclosureSynced = true
}

function workerCount(uid, lvl) {
  return (store.data.tasks || []).filter(t => t.status !== '已验收' && t.assignee === uid && (lvl === 'red' ? t.urgency === 'red' : t.urgency !== 'red')).length
}
</script>

<style scoped>
.sup-radar {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0 16px;
}
.sr-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 3px solid var(--acc);
  border-radius: 10px;
  padding: 11px 13px;
  display: grid;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
}
.sr-card.red { border-top-color: var(--red); background: #fffafa; }
.sr-card.amb { border-top-color: var(--amb); }
.sr-card.grn { border-top-color: var(--grn); }
.sr-card b { font-size: 13.5px; }
.sr-card small { color: var(--acc); font-size: 11.5px; font-weight: 600; }

.sup-main {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.85fr);
  gap: 16px;
  align-items: start;
}
.appr-list { display: grid; gap: 11px; }
.appr-card {
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}
.ac-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; }
.wk-box { padding: 9px 0; border-bottom: 1px dashed var(--line); font-size: 13px; }
.gov-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--soft); border-radius: 7px; }
@media (max-width: 1200px) {
  .sup-radar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sup-main { grid-template-columns: 1fr; }
}
</style>
