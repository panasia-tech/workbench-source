<template>
  <div class="page">
    <header class="head">
      <div>
        <div class="eyebrow">三岗拆分内控 · 权责分离盲盘 + 10分钟循环微盘 + 串位一键纠偏 + 主管调账</div>
        <h1>批次与循环盲盘<Q k="stocktake" /></h1>
        <p class="sub">
          破 1,000 件不再动辄停业大盘点：日常执行<b>单排货架 10 分钟循环微盘（仓管端盲盘隐藏账面数，防看着数字假打勾）</b>，自动识别<b>串位一键移库纠偏</b>与 <b>WIP 工位借出豁免</b>；真盘亏须经仓管主管复核证据调账。
        </p>
      </div>
      <div class="acts">
        <button class="btn pri" :disabled="locked" @click="newModal = true">
          + 发起单货架 10 分钟循环盲盘
        </button>
        <button class="btn" @click="openHelp('stocktake')"><Icon name="help" />怎么用</button>
      </div>
    </header>

    <!-- 盘点模式切换：1. 日常货架循环盲盘（真交互）  2. 全仓 UHF RFID 批次调账（主管审批） -->
    <div class="seg" style="margin:16px 0">
      <button :class="{ on: modeTab === 'blind' }" @click="modeTab = 'blind'">
        <i class="dot acc"></i>1. 货架循环微盘与盲盘实操（串位纠偏）<em>{{ sessions.length }}</em>
      </button>
      <button :class="{ on: modeTab === 'rfid' }" @click="modeTab = 'rfid'">
        <i class="dot" :class="st.ledgerWrittenBack ? 'grn' : 'amb'"></i>2. 全仓 UHF RFID 批次差异复核与主管调账<em>{{ st.discrepancies.length }}</em>
      </button>
    </div>

    <!-- ================= TAB 1：权责分离「货架盲盘 + 串位一键纠偏」 ================= -->
    <template v-if="modeTab === 'blind'">
      <div class="cols-split">
        <!-- 左侧：循环微盘任务队列 -->
        <div style="display:grid;gap:10px;align-content:start">
          <article
            v-for="s in sessions"
            :key="s.id"
            class="sess-card"
            :class="{ sel: curSess?.id === s.id, done: s.phase === 'CLOSED' }"
            @click="selectedSessId = s.id"
          >
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span class="tag" :class="s.phase === 'CLOSED' ? 'grn' : s.phase === 'DIFF_RECONCILE' ? 'amb' : 'acc'">
                {{ s.phase === 'BLIND_SCANNING' ? '● 盲盘扫码中' : s.phase === 'DIFF_RECONCILE' ? '! 待串位纠偏/复核' : '✓ 已对齐结案' }}
              </span>
              <span class="mono muted" style="font-size:12px">{{ s.id }}</span>
            </div>
            <h3 style="font-size:14.5px;margin-top:6px">{{ s.title }}</h3>
            <p class="muted" style="font-size:12px;margin-top:3px">
              范围：{{ s.targetBins.join('、') }} · 盘点人：{{ s.executor }}
            </p>
          </article>
        </div>

        <!-- 右侧：盲盘操作台 / 差异纠偏台 -->
        <section v-if="curSess" class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <span class="tag dark">{{ curSess.targetRack }}</span>
                <span class="tag acc">{{ curSess.mode }}</span>
                <span class="tag" :class="curSess.phase === 'BLIND_SCANNING' ? 'red' : 'grn'">
                  {{ curSess.phase === 'BLIND_SCANNING' ? '🔒 盲盘保护：账面应有明细已隐藏' : '✓ 实扫已锁定 · 账面快照已揭晓' }}
                </span>
              </div>
              <h2 style="font-size:20px;margin:8px 0 4px">{{ curSess.title }}</h2>
            </div>
          </div>

          <!-- 阶段 A：盲盘扫码进行中（对仓管员彻底隐藏账面数量！） -->
          <div v-if="curSess.phase === 'BLIND_SCANNING'" style="margin-top:14px;display:grid;gap:14px">
            <div class="why-box amb">
              <b>权责分离盲盘规则：</b>提交实扫结果前，界面不显示货架账面应有数量（<code>? 件</code>），仓管员必须「先扫货架横梁库位码 → 再逐台扫格口内实物机身码」，杜绝看着账面列表直接打勾应付！
            </div>

            <!-- 目标格口选择与盲扫计数 -->
            <div class="blind-bins">
              <button
                v-for="b in curSess.targetBins"
                :key="b"
                class="bb-card"
                :class="{ cur: curSess.currentBin === b }"
                @click="curSess.currentBin = b"
              >
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <b class="mono" style="font-size:16px">库位 {{ b }}</b>
                  <span class="tag" :class="curSess.currentBin === b ? 'acc' : ''">
                    {{ curSess.currentBin === b ? '当前正扫' : '点此切格' }}
                  </span>
                </div>
                <div style="margin-top:6px;font-size:12.5px" class="muted">
                  账面应有：<b>{{ isSupervisor ? bookCountOfBin(b) + ' 件(主管可见)' : '🔒 盲盘隐藏' }}</b>
                </div>
                <div style="margin-top:4px;font-size:13px">
                  现场已扫：<b style="color:var(--acc)">{{ (curSess.scannedByBin[b] || []).length }} 件</b>
                </div>
                <div v-if="(curSess.scannedByBin[b] || []).length" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">
                  <span v-for="code in curSess.scannedByBin[b]" :key="code" class="tag mono">#{{ code }}</span>
                </div>
              </button>
            </div>

            <!-- 激光扫码框 + 一键模拟 A-04 扫出串位件 -->
            <div class="scan-box">
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <input
                  v-model="blindScanInput"
                  class="inp mono"
                  style="flex:1;min-width:240px"
                  placeholder="扫库位码 (如 LOC-A-04) 或扫机身一物一码回车录入…"
                  @keydown.enter="doBlindInputScan"
                />
                <button class="btn pri" :disabled="locked" @click="doBlindInputScan">激光扫入</button>
                <button class="btn" :disabled="locked" @click="simulateScanShelfA04WithMisplaced(curSess)">
                  🔫 演示：模拟扫完 A-04 实物（含1台从 A-08 串位过来的显示器）
                </button>
              </div>
            </div>

            <div style="display:flex;justify-content:flex-end">
              <Lock
                :ok="totalBlindScanned > 0 && !locked"
                :reason="locked ? '先完成首日练习' : '请先扫描至少 1 件货架实物（可点上方「模拟扫完 A-04 实物」快速体验）'"
                kind="ok"
                @go="submitBlindSessionAndCompare(curSess)"
              >提交盲盘实扫结果（共扫 {{ totalBlindScanned }} 件） · 揭晓账实比对</Lock>
            </div>
          </div>

          <!-- 阶段 B / C：账面快照已揭晓 · 自动识别串位一键纠偏 / WIP暂借豁免 / 盘亏审批 -->
          <div v-else style="margin-top:14px;display:grid;gap:12px">
            <div class="diff-list">
              <div
                v-for="item in curSess.diffItems"
                :key="item.id"
                class="diff-card"
                :class="item.resolved ? 'ok' : item.kind === 'MISPLACED' ? 'amb' : 'red'"
              >
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span class="tag" :class="diffTag(item).cls">{{ diffTag(item).text }}</span>
                    <b class="mono">#{{ item.skuCode }}</b>
                    <b>{{ item.model }}</b>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <span class="muted" style="font-size:12.5px">
                      账面：<b>{{ item.bookBin }}</b> → 实盘：<b>{{ item.actualBin }}</b>
                    </span>
                    <button
                      v-if="item.kind === 'MISPLACED' && !item.resolved"
                      class="btn sm pri"
                      :disabled="locked"
                      @click="fixMisplacedSkuOneClick(curSess, item)"
                    >⇄ 一键扫码纠偏库位至 {{ item.actualBin }}（不计盘亏）</button>
                  </div>
                </div>
                <p class="muted" style="font-size:12.5px;margin-top:6px">{{ item.note }}</p>
              </div>
            </div>

            <div v-if="curSess.phase === 'CLOSED'" class="why-box grn">
              ✓ 本次货架微盘点已全部对齐归档（结案人：{{ curSess.closedBy }}），串位库位已同步更新至总账！
            </div>
            <div v-else style="display:flex;justify-content:flex-end">
              <Lock
                :ok="canCloseBlind.ok"
                :reason="canCloseBlind.why"
                kind="pri"
                @go="approveAndCloseBlindSession(curSess)"
              >确认差异处理完毕 · 归档本次循环微盘</Lock>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- ================= TAB 2：全仓 UHF RFID 批次差异复核与主管调账（保留完整5步） ================= -->
    <template v-else>
      <ol class="clean-steps five">
        <li class="done"><span class="num">✓</span><div><b>1. 冻结账面快照</b><p class="muted">{{ st.frozenAt }} · 锁定 {{ st.bookCount }} 件</p></div></li>
        <li class="done"><span class="num">✓</span><div><b>2. UHF 读取器预检</b><p class="muted">电量 {{ st.readerPrecheck.battery }} · 样签试读通过</p></div></li>
        <li class="done"><span class="num">✓</span><div><b>3. 实盘扫描与在途单列</b><p class="muted">正常 {{ st.scannedNormal }} · 在途单列 {{ st.inTransitExcluded }}</p></div></li>
        <li :class="unapprovedCount === 0 ? 'done' : 'cur'"><span class="num">{{ unapprovedCount === 0 ? '✓' : '4' }}</span><div><b>4. 差异证据逐条复核</b><p class="muted">待批 {{ unapprovedCount }} 条</p></div></li>
        <li :class="st.ledgerWrittenBack ? 'done' : (unapprovedCount === 0 ? 'cur' : '')"><span class="num">{{ st.ledgerWrittenBack ? '✓' : '5' }}</span><div><b>5. 主管调账回写留痕</b><p class="muted">仅仓管主管可回写</p></div></li>
      </ol>

      <div class="cols-main-aside">
        <div class="card">
          <div class="ch">
            <h2>第 4 步 · UHF 批次差异举证与主管复核（{{ st.discrepancies.length }} 条）</h2>
            <span class="muted" style="font-size:12px">严禁无原始日志或现场照片直接抹平账面</span>
          </div>

          <div class="diff-list">
            <div v-for="d in st.discrepancies" :key="d.id" class="diff-card" :class="{ ok: d.approved }">
              <div class="row" style="justify-content:space-between;align-items:flex-start">
                <div>
                  <div class="row" style="gap:8px;margin-bottom:4px">
                    <span class="tag" :class="d.approved ? 'grn' : 'red'">{{ d.approved ? '✓ 已复核批准' : '✕ 待主管复核' }}</span>
                    <span class="tag">{{ d.type }}</span>
                    <b class="mono">#{{ d.skuCode }}</b>
                    <b>{{ d.model }}</b>
                  </div>
                  <p class="muted" style="font-size:13px"><b>账面快照：</b>{{ d.bookVal }} &nbsp;|&nbsp; <b>实盘结果：</b>{{ d.actualVal }}</p>
                </div>
                <button v-if="hasSku(d.skuCode)" class="btn sm ghost" @click="openItemDetail(d.skuCode)">看单件档案 ›</button>
              </div>
              <div class="ev-box">
                <div><b>现场原始凭证：</b>{{ d.evidence }}</div>
                <div><b>拟处置与调账方案：</b>{{ d.proposal }}</div>
              </div>
              <div class="row" style="justify-content:space-between;margin-top:8px">
                <span class="muted" style="font-size:12px">{{ d.approved ? '已签批：' + d.approvedBy : '需核对日志或照片后批准' }}</span>
                <Lock
                  v-if="!d.approved"
                  :ok="isSupervisor && !locked"
                  :reason="locked ? '新同事未完成练习前禁止操作' : '盘点差异须由「仓管主管」复核原始证据后批准（右上角可切换周卫东体验）'"
                  @go="approveStocktakeDiffBySupervisor(d)"
                >批准此条差异方案</Lock>
              </div>
            </div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:14px">
          <div class="card">
            <h2>账实快照核对摘要</h2>
            <div class="kv" style="margin-top:10px">
              <span class="k">冻结快照时间</span><span>{{ st.frozenAt }}</span>
              <span class="k">本批账面总数</span><span><b>{{ st.bookCount }} 件</b></span>
              <span class="k">UHF 实扫正常</span><span style="color:var(--grn);font-weight:700">{{ st.scannedNormal }} 件</span>
              <span class="k">在途/隔离单列</span><span>{{ st.inTransitExcluded }} 件（不误判盘亏）</span>
            </div>
            <Fold :model-value="foldOpen" @update:model-value="foldOpen = $event" title="UHF 读取器预检与金属屏蔽兜底" style="margin-top:12px">
              <div class="kv">
                <span class="k">设备编号</span><span class="mono">{{ st.readerPrecheck.deviceModel }}</span>
                <span class="k">漏读兜底</span><span>{{ st.readerPrecheck.fallbackNote }}</span>
              </div>
            </Fold>
          </div>

          <div class="card">
            <h2>第 5 步 · 主管执行调账回写</h2>
            <p class="muted" style="font-size:13px;margin:6px 0 12px">所有差异获批后，由仓管主管一键执行账面回写并永久留痕。</p>
            <div v-if="st.ledgerWrittenBack" class="why-box grn">
              ✓ 批次 {{ st.batchNo }} 已完成调账回写！赠品线台账已同步更正为 17 条。
            </div>
            <Lock
              v-else
              :ok="isSupervisor && unapprovedCount === 0 && !locked"
              :reason="writebackLockReason"
              @go="commitStocktakeWriteback"
            >执行账面调账回写并归档</Lock>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建 10 分钟单排货架循环盲盘弹窗 -->
    <div v-if="newModal" class="mask" @click.self="newModal = false">
      <div class="modal" role="dialog" aria-label="发起单货架循环微盘">
        <h3>发起单排货架 10 分钟循环微盘（盲盘）</h3>
        <p class="muted" style="font-size:13px">每天下班前轮盘 1～2 排货架，1 周即可把 1,000+ 件在库单品全覆盖一遍，无需停业封仓。</p>
        <label>
          选择盘点排架
          <select v-model="newForm.rack">
            <option value="A1排">A1排（主力显示器 1-4层）</option>
            <option value="A2排">A2排（高频进出动碰货架）</option>
            <option value="A3排">A3排（手机/微单/小家电架）</option>
            <option value="B1排">B1排（曲面大件/蓝牙音响架）</option>
          </select>
        </label>
        <label>
          盘点触发类型
          <select v-model="newForm.mode">
            <option value="动碰货架10分钟微盘">动碰货架 10 分钟微盘（推荐）</option>
            <option value="高值数码每日轮盘">高值数码每日例行轮盘</option>
          </select>
        </label>
        <div class="mfoot">
          <button class="btn" @click="newModal = false">取消</button>
          <button class="btn pri" @click="handleCreateBlind">立即下发盲盘单</button>
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
import Fold from '../components/Fold.vue'
import {
  store, currentUser, isSupervisor, openHelp, openItemDetail,
  approveStocktakeDiffBySupervisor, commitStocktakeWriteback,
  createShelfBlindSession, scanBlindBinOrSku,
  simulateScanShelfA04WithMisplaced, submitBlindSessionAndCompare,
  fixMisplacedSkuOneClick, approveAndCloseBlindSession
} from '../store/warehouseStore.js'

const modeTab = ref('blind')
const foldOpen = ref(false)
const blindScanInput = ref('')
const newModal = ref(false)
const newForm = reactive({ rack: 'A2排', mode: '动碰货架10分钟微盘' })

const sessions = computed(() => store.data.blindCycleSessions || [])
const selectedSessId = ref(sessions.value[0]?.id || '')
const curSess = computed(() => sessions.value.find(s => s.id === selectedSessId.value) || sessions.value[0])

const st = computed(() => store.data.stocktake)
const locked = computed(() => !currentUser.value.practiceDone)
const unapprovedCount = computed(() => st.value.discrepancies.filter(d => !d.approved).length)

function bookCountOfBin(binCode) {
  return (store.data.skus || []).filter(s => s.location === binCode && s.zone !== '已出库在途').length
}

const totalBlindScanned = computed(() => {
  if (!curSess.value) return 0
  return Object.values(curSess.value.scannedByBin || {}).reduce((s, arr) => s + (arr?.length || 0), 0)
})

function doBlindInputScan() {
  if (!curSess.value || !blindScanInput.value.trim()) return
  scanBlindBinOrSku(curSess.value, blindScanInput.value)
  blindScanInput.value = ''
}

function diffTag(item) {
  if (item.kind === 'MATCH') return { cls: 'grn', text: '✓ 账位一致' }
  if (item.kind === 'WIP_EXEMPT') return { cls: 'acc', text: '⚙ WIP工位暂借豁免' }
  if (item.kind === 'MISPLACED') return item.resolved ? { cls: 'grn', text: '✓ 串位已纠偏' } : { cls: 'amb', text: '⇄ 发现库位串位' }
  if (item.kind === 'SURPLUS') return { cls: 'red', text: '+ 账外盘盈' }
  return { cls: 'red', text: '✕ 疑似盘亏短少' }
}

const canCloseBlind = computed(() => {
  const s = curSess.value
  if (!s) return { ok: false, why: '未选择盘点单' }
  if (locked.value) return { ok: false, why: '先完成首日练习' }
  const mis = (s.diffItems || []).find(d => d.kind === 'MISPLACED' && !d.resolved)
  if (mis) return { ok: false, why: `请先点「一键扫码纠偏库位」把串位商品 #${mis.skuCode} 对齐到实盘库位 ${mis.actualBin}` }
  const short = (s.diffItems || []).find(d => (d.kind === 'SHORTAGE' || d.kind === 'SURPLUS') && !d.resolved)
  if (short && !isSupervisor.value) {
    return { ok: false, why: `存在 ${short.kind === 'SHORTAGE' ? '疑似盘亏' : '盘盈'}（#${short.skuCode}），权责分离要求切换「周卫东（仓管主管）」复核后结案` }
  }
  return { ok: true, why: '' }
})

function handleCreateBlind() {
  const created = createShelfBlindSession(newForm)
  if (created) {
    selectedSessId.value = created.id
    newModal.value = false
  }
}

function hasSku(code) {
  return store.data.skus.some(s => s.code === code)
}

const writebackLockReason = computed(() => {
  if (locked.value) return '新同事尚未完成 3 项上岗沙盒演练，真实盘点调账已锁定'
  if (!isSupervisor.value) return '仓管业务员无权直接调平库存账面，须由「仓管主管」执行回写（右上角可切周卫东体验）'
  if (unapprovedCount.value > 0) return `还有 ${unapprovedCount.value} 条盘点差异未完成证据复核批准，全部批准后才允许回写账面`
  return ''
})
</script>

<style scoped>
.sess-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-left: 4px solid var(--acc);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
}
.sess-card.done { border-left-color: var(--grn); }
.sess-card.sel { box-shadow: 0 0 0 2px var(--acc); background: #fafcff; }

.blind-bins {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.bb-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 13px;
  background: var(--soft);
  text-align: left;
}
.bb-card.cur {
  border-color: var(--acc);
  background: #f4f8ff;
  box-shadow: 0 0 0 1px var(--acc);
}
.scan-box {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--soft);
  border: 1px solid var(--line);
}

.diff-list { display: flex; flex-direction: column; gap: 10px; }
.diff-card {
  border: 1px solid var(--line);
  border-left: 4px solid var(--red);
  border-radius: 10px;
  padding: 12px 14px;
  background: #fff;
}
.diff-card.amb { border-left-color: var(--amb); background: #fffdf8; }
.diff-card.ok { border-left-color: var(--grn); background: #f8fdfb; }
.ev-box {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
