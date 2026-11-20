<template>
  <div class="page">
    <header class="head">
      <div>
        <h1>异常双轨<Q k="anomaly" /></h1>
        <p class="sub">首次发现实物与卖家描述不符起算唯一 <b>10 分钟首报</b>；退货盯<b>原发件网点签收</b>，退款盯<b>实到账与运费差额清零</b>，两边都清才算完。</p>
      </div>
      <div class="acts">
        <button class="btn" @click="openHelp('anomaly')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <div class="cols-split">
      <!-- 左侧异常单清单 -->
      <div class="ano-list">
        <article
          v-for="a in store.data.anomalies"
          :key="a.id"
          class="ano-item"
          :class="[anoLvl(a), { sel: ano?.id === a.id }]"
          @click="selectedId = a.id"
        >
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="tag" :class="anoLvl(a)">{{ TYPE_LABEL[a.type] }}</span>
            <span v-if="a.remainingSec > 0 && !a.tracks.purchaserProof.done" class="tag red">⏱ 剩 {{ fmtSec(a.remainingSec) }}</span>
            <span v-else class="muted" style="font-size:12px">{{ a.id }}</span>
          </div>
          <h3>{{ a.title }}</h3>
          <p class="muted" style="font-size:12px;margin-top:4px">货号 <code>{{ a.skuCode }}</code> · 采购 {{ a.purchaser }}</p>
          <p class="why-box" :class="anoLvl(a)" style="margin-top:8px;padding:6px 9px;font-size:12px">{{ anoWhy(a) }}</p>
        </article>
      </div>

      <!-- 右侧异常详情与双轨操作台 -->
      <div v-if="ano" class="ano-detail">
        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span class="badge-l" :class="anoLvl(ano)">{{ LV[anoLvl(ano)].icon }} {{ TYPE_LABEL[ano.type] }}</span>
                <span class="tag dark">{{ ano.isolationLocked ? '异常隔离锁定中（禁上架/禁出库）' : '已解除隔离' }}</span>
                <span class="muted" style="font-size:13px">{{ ano.id }} · 采购单 {{ ano.orderNo }}</span>
              </div>
              <h2 style="font-size:20px;margin:10px 0 6px">{{ ano.title }}</h2>
              <p class="muted" style="font-size:13px">
                首次发现时间：<b>{{ ano.firstFoundAt }}</b>（已重试催办 {{ ano.retryCount }} 次，首次时钟绝不重置） · 承运与目标网点：{{ ano.carrier }} → {{ ano.targetStation }}
              </p>
            </div>

            <Lock
              :ok="ano.type !== 'DEVICE_ONLY' && !locked"
              :reason="locked ? '先去「学」完成 3 个练习' : '制度红线：这单只是二号台高拍仪 USB 掉线 18 秒（纯内部设备/影像缺口），不涉及卖家违约，严禁向采购发起退货退款！'"
              kind=""
              @go="retryAnomalyNotify(ano)"
            >再次发送催办回执（不重置倒计时）</Lock>
          </div>

          <!-- 10分钟内并行三路首报卡片 -->
          <div class="tri-tracks">
            <div class="trk">
              <div class="th"><b>① 承运方原单拒签</b><span class="tag" :class="ano.tracks.courier.done ? 'grn' : 'red'">{{ ano.tracks.courier.done ? '已登记' : '待办理' }}</span></div>
              <p>退回网点：{{ ano.tracks.courier.station }}</p>
              <small class="muted">回执：{{ ano.tracks.courier.receipt }}</small>
            </div>
            <div class="trk">
              <div class="th"><b>② 通知原采购员</b><span class="tag grn">已送达 {{ ano.tracks.notifyPurchaser.deliveredAt }}</span></div>
              <p>{{ ano.tracks.notifyPurchaser.diffSummary }}</p>
              <small class="muted">接收确认：{{ ano.tracks.notifyPurchaser.acceptedAt || '待读' }}</small>
            </div>
            <div class="trk">
              <div class="th">
                <b>③ 原采购 10 分钟首轮凭证</b>
                <span class="tag" :class="ano.tracks.purchaserProof.done ? 'grn' : 'red'">{{ ano.tracks.purchaserProof.done ? '已核验可读' : `待 ${ano.tracks.purchaserProof.assignee} 上传` }}</span>
              </div>
              <template v-if="ano.tracks.purchaserProof.done">
                <p>{{ ano.tracks.purchaserProof.voucher }}</p>
                <small class="muted">归档时间：{{ ano.tracks.purchaserProof.submittedAt }}</small>
              </template>
              <div v-else class="proof-up">
                <input v-model="proofText" placeholder="录入闲鱼申请退货退款截图编号或沟通回执" />
                <Lock
                  :ok="Boolean(proofText.trim()) && !locked"
                  :reason="locked ? '先做完练习' : '先填写首轮联系卖家或申请退款的可核查凭证摘要'"
                  kind="pri sm"
                  @go="doUploadProof"
                >上传首轮凭证</Lock>
              </div>
            </div>
          </div>
        </section>

        <!-- 货钱双轨 5×5 进度（非纯设备事件才显示） -->
        <div v-if="ano.goodsSteps.length" class="rails-grid">
          <section class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
              <h3 style="margin:0">货轨（拒签退回 → 原发件网点签收）</h3>
              <button v-if="!ano.fullInspectDone" class="btn sm pri" :disabled="locked" @click="markAnomalyFullInspectDone(ano)">模拟：补完最后1项全检解锁交件</button>
            </div>
            <p class="muted" style="font-size:12.5px;margin-bottom:10px">当前全检进度：<b>{{ ano.fullInspectProgress }}</b></p>

            <div class="step-list">
              <div v-for="(s, idx) in ano.goodsSteps" :key="s.key" class="st-item" :class="{ done: s.done }">
                <div>
                  <b>{{ s.done ? '✓ ' : '' }}{{ s.label }}</b>
                  <p class="muted" style="font-size:12px">{{ s.note }}</p>
                </div>
                <span v-if="s.done" class="tag grn">已完成</span>
                <Lock
                  v-else
                  :ok="goodsStepCheck(ano, idx, s).ok"
                  :reason="goodsStepCheck(ano, idx, s).why"
                  kind="sm pri"
                  @go="toggleAnomalyTrackStep(ano, 'goods', s.key)"
                >推进此步</Lock>
              </div>
            </div>
          </section>

          <section class="card">
            <h3>钱轨（首轮申请 → 实到账 → 差额核清结案）</h3>
            <p class="muted" style="font-size:12.5px;margin-bottom:10px">规矩：申请退款 ≠ 已到账；存在运费扣款差额未核清前禁止双清结案。</p>

            <div class="step-list">
              <div v-for="(s, idx) in ano.moneySteps" :key="s.key" class="st-item" :class="{ done: s.done }">
                <div>
                  <b>{{ s.done ? '✓ ' : '' }}{{ s.label }}</b>
                  <p class="muted" style="font-size:12px">{{ s.note }}</p>
                </div>
                <span v-if="s.done" class="tag grn">已完成</span>
                <Lock
                  v-else
                  :ok="moneyStepCheck(ano, idx, s).ok"
                  :reason="moneyStepCheck(ano, idx, s).why"
                  kind="sm pri"
                  @go="toggleAnomalyTrackStep(ano, 'money', s.key)"
                >{{ s.key === 'close' ? '货钱双清结案' : '核销此步' }}</Lock>
              </div>
            </div>
          </section>
        </div>

        <!-- 议价成功改留货 · 4项反悔防呆锁 -->
        <section v-if="ano.keepGoodsSwitch" class="card" style="border-top:3px solid var(--amb)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <h3 style="margin:0">采购议价成功「改为留货」 · 4 项反悔防呆锁</h3>
            <span class="tag" :class="ano.keepGoodsSwitch.supervisorApproved ? 'grn' : 'amb'">
              {{ ano.keepGoodsSwitch.supervisorApproved ? `✓ 已由 ${ano.keepGoodsSwitch.approvedBy} 放行转可售` : '待勾齐 4 项并由仓管主管放行' }}
            </span>
          </div>
          <p class="muted" style="font-size:13px;margin-bottom:12px">
            最新核定留货成本：<b>¥{{ ano.keepGoodsSwitch.newCost }}</b>（原进价留痕备查） · 同步销售瑕疵披露：「{{ ano.keepGoodsSwitch.disclosureText }}」
          </p>

          <div class="keep-checks">
            <label><input type="checkbox" v-model="ano.keepGoodsSwitch.refundWithdrawn" :disabled="ano.keepGoodsSwitch.supervisorApproved" />1. 原退货退款申请已在平台撤回（防止一边留货一边退钱）</label>
            <label><input type="checkbox" v-model="ano.keepGoodsSwitch.goodsInWarehouse" :disabled="ano.keepGoodsSwitch.supervisorApproved" />2. 实物核实仍在仓内隔离位，未被快递员顺手揽走</label>
            <label><input type="checkbox" v-model="ano.keepGoodsSwitch.costUpdated" :disabled="ano.keepGoodsSwitch.supervisorApproved" />3. 议价补差已实际到账，最新核定成本已回写台账</label>
            <label><input type="checkbox" v-model="ano.keepGoodsSwitch.disclosureSynced" :disabled="ano.keepGoodsSwitch.supervisorApproved" />4. 最新瑕疵微距照与文字披露已同步至销售工作台</label>
          </div>

          <div v-if="!ano.keepGoodsSwitch.supervisorApproved" style="margin-top:14px">
            <Lock
              :ok="keepCheck.ok"
              :reason="keepCheck.why"
              penalty="放行后单件自动解除异常隔离，转入 A-09 已复核可售库区。"
              @go="approveKeepGoodsBySupervisor(ano)"
            >主管复核通过 · 解除异常隔离转可售</Lock>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import Q from '../components/Q.vue'
import Lock from '../components/Lock.vue'
import {
  store,
  LV,
  currentUser,
  isSupervisor,
  openHelp,
  retryAnomalyNotify,
  uploadPurchaserFirstProof,
  markAnomalyFullInspectDone,
  toggleAnomalyTrackStep,
  approveKeepGoodsBySupervisor
} from '../store/warehouseStore.js'

const TYPE_LABEL = {
  GOODS_DIFF: '货不对版 · 10分钟首报',
  KEEP_NEGOTIATED: '议价改留货 · 待放行',
  REFUND_DIFF: '退件已签 · 差额待清',
  DEVICE_ONLY: '纯工位设备事件（禁发退款）'
}

const selectedId = ref(store.routeParam || store.data.anomalies[0]?.id || '')
watch(() => store.routeParam, (v) => {
  if (v && store.data.anomalies.some(a => a.id === v)) selectedId.value = v
})

const ano = computed(() => store.data.anomalies.find(a => a.id === selectedId.value) || store.data.anomalies[0])
const locked = computed(() => !currentUser.value.practiceDone)
const proofText = ref('')

function fmtSec(sec) {
  const m = String(Math.floor((sec || 0) / 60)).padStart(2, '0')
  const s = String((sec || 0) % 60).padStart(2, '0')
  return `${m}:${s}`
}

function anoLvl(a) {
  if (a.type === 'DEVICE_ONLY') return 'amb'
  if (a.keepGoodsSwitch?.supervisorApproved) return 'grn'
  if (a.moneySteps.length && a.moneySteps[a.moneySteps.length - 1].done) return 'grn'
  if (!a.tracks.purchaserProof.done || !a.fullInspectDone || a.keepGoodsSwitch) return 'red'
  return 'amb'
}

function anoWhy(a) {
  if (a.type === 'DEVICE_ONLY') return '纯高拍仪掉线 18 秒：仅做内部补拍主管复核，严禁向卖家发起采购退款'
  if (!a.tracks.purchaserProof.done) return `10分钟窗口进行中：待原采购 ${a.purchaser} 上传首轮退款凭证，且差 1 项全检未完禁止交件`
  if (a.keepGoodsSwitch && !a.keepGoodsSwitch.supervisorApproved) return '议价减 ¥260 改留货：第 4 项「披露同步销售」待勾选，且须仓管主管放行'
  if (a.moneySteps.some(s => !s.done)) return '退件已签收，但卖家扣了 ¥35 运费差额未核清，结案按钮已锁死'
  return '货钱双轨已结清'
}

function doUploadProof() {
  uploadPurchaserFirstProof(ano.value, proofText.value)
  proofText.value = ''
}

function goodsStepCheck(a, idx, s) {
  if (locked.value) return { ok: false, why: '先做完 3 个练习' }
  if (s.key !== 'full_inspect' && !a.fullInspectDone) {
    return { ok: false, why: '这台货全量验货还没做完（5/6 项），全检留足证据前严禁提前把货交给快递退走！' }
  }
  if (idx > 0 && !a.goodsSteps[idx - 1].done) {
    return { ok: false, why: `请先完成上一步「${a.goodsSteps[idx - 1].label}」` }
  }
  return { ok: true, why: '' }
}

function moneyStepCheck(a, idx, s) {
  if (locked.value) return { ok: false, why: '先做完 3 个练习' }
  if (idx > 0 && !a.moneySteps[idx - 1].done) {
    return { ok: false, why: `请先完成上一步「${a.moneySteps[idx - 1].label}」（如核清 ¥35 运费扣款差额）` }
  }
  if (s.key === 'close') {
    const goodsOk = a.goodsSteps.every(g => g.done)
    if (!goodsOk) return { ok: false, why: '货轨尚未到达「原发件网点签收」，已寄出不算完，不能提前结案！' }
  }
  return { ok: true, why: '' }
}

const keepCheck = computed(() => {
  const sw = ano.value?.keepGoodsSwitch
  if (!sw) return { ok: false, why: '' }
  if (locked.value) return { ok: false, why: '先去「学」完成 3 个练习' }
  const missing = []
  if (!sw.refundWithdrawn) missing.push('①撤回原退款')
  if (!sw.goodsInWarehouse) missing.push('②核实货在仓')
  if (!sw.costUpdated) missing.push('③新成本回写')
  if (!sw.disclosureSynced) missing.push('④披露同步销售')
  if (missing.length) {
    return { ok: false, why: `反悔防呆锁还没勾齐：缺 ${missing.join('、')}` }
  }
  if (!isSupervisor.value) {
    return { ok: false, why: `当前账号是「${currentUser.value.name}」，解除异常隔离必须由「仓管主管（周卫东）」复核放行（点右上角头像可切换体验）` }
  }
  return { ok: true, why: '' }
})
</script>

<style scoped>
.ano-list { display: grid; gap: 10px; }
.ano-item {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 4px solid var(--line);
  border-radius: 10px;
  padding: 13px 15px;
  cursor: pointer;
}
.ano-item.red { border-left-color: var(--red); }
.ano-item.amb { border-left-color: var(--amb); }
.ano-item.grn { border-left-color: var(--grn); }
.ano-item.sel { box-shadow: 0 0 0 2px var(--acc); background: #fafcff; }
.ano-item h3 { font-size: 14.5px; line-height: 1.38; margin-top: 7px; font-weight: 700; }

.ano-detail { display: grid; gap: 14px; }
.tri-tracks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.trk { background: var(--soft); border: 1px solid var(--line); border-radius: 9px; padding: 12px; display: grid; gap: 6px; font-size: 13px; align-content: start; }
.trk .th { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
.proof-up { display: grid; gap: 6px; margin-top: 4px; }
.proof-up input { padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); font-size: 12.5px; }

.rails-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.step-list { display: grid; gap: 8px; }
.st-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--soft);
  font-size: 13px;
}
.st-item.done { background: #f4fbf7; border-color: #bfead3; }

.keep-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.keep-checks label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: var(--soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}
</style>
