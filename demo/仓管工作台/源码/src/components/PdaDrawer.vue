<template>
  <!-- 1. 顶部全局激光扫码声光反馈横条（任何页面扫枪触发即闪现） -->
  <div v-if="scanFeedback.flashType && scanFeedback.lastScan" class="laser-toast" :class="scanFeedback.flashType">
    <b>{{ scanFeedback.flashType === 'err' ? '🚨 嘟嘟嘟 · 扫码拦截' : '🔫 滴！激光秒扫识别' }}</b>
    <span class="mono">[{{ scanFeedback.lastScan.kind }}] {{ scanFeedback.lastScan.code }}</span>
    <span>{{ scanFeedback.lastScan.msg }}</span>
  </div>

  <!-- 2. 📱 iData PDA / 手机蓝牙指环枪「巷道走动作业手持 H5 模式」右侧机身模拟器 -->
  <div v-if="store.pdaOpen" class="pda-mask" @click.self="store.pdaOpen = false">
    <div class="pda-device" role="dialog" aria-label="PDA走动扫码手持H5">
      <header class="pda-top">
        <div>
          <span class="pda-pill">iData 50 · 巷道走动 H5 端</span>
          <h3>泛亚移动仓管 · {{ currentUser.name }}</h3>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button
            class="pda-snd"
            :class="{ on: scanFeedback.soundEnabled }"
            @click="scanFeedback.soundEnabled = !scanFeedback.soundEnabled"
            title="切换扫码蜂鸣声"
          >
            {{ scanFeedback.soundEnabled ? '🔊 蜂鸣开' : '🔇 静音' }}
          </button>
          <button class="pda-x" @click="store.pdaOpen = false">✕</button>
        </div>
      </header>

      <!-- 5 大高频走动单手动作切换 -->
      <nav class="pda-tabs">
        <button v-for="m in MODES" :key="m.k" :class="{ on: mode === m.k }" @click="mode = m.k">
          <b>{{ m.short }}</b>
          <small>{{ m.sub }}</small>
        </button>
      </nav>

      <!-- 统一硬件激光楔入输入栏（免手点，按侧边黄键即扫） -->
      <div class="pda-wedge">
        <input
          v-model="wedgeCode"
          class="mono"
          :placeholder="placeholderText"
          @keydown.enter="fireScan"
        />
        <button class="pda-trig" @click="fireScan">扣扳机扫</button>
      </div>

      <div class="pda-body">
        <!-- ① 门口快递扫单签收进 C 区 -->
        <div v-if="mode === 'rcv'" class="pda-card">
          <h4>① 卸货门口扫快递面单 → 落 C 区待检框</h4>
          <p class="pda-sub">解决几百票快递堆地上、客服不知道到没到货的黑盒问题</p>
          <div v-for="a in waitSignAsns" :key="a.id" class="pda-item">
            <div>
              <b class="mono">{{ a.trackingNo }}</b> · 尾号 <b>{{ a.phoneSuffix }}</b>
              <div class="pda-muted">{{ a.declaredBrand }} {{ a.declaredModel }}</div>
            </div>
            <button class="pda-act" @click="pdaSignAsn(a)">扫入 {{ a.stagingBin }}</button>
          </div>
          <p v-if="!waitSignAsns.length" class="pda-ok">✓ 门口在途包裹已全部扫入 C 区暂存框！</p>
        </div>

        <!-- ② 双扫码上架（扫物 + 扫货架位） -->
        <div v-else-if="mode === 'put'" class="pda-card">
          <h4>② 过检商品双扫码上架（扫机身码 + 扫库位码）</h4>
          <p class="pda-sub">异常或未全检商品若错扫进 A/B 可售架，直接红屏蜂鸣阻断</p>
          <div v-for="a in waitPutAsns" :key="a.id" class="pda-item">
            <div>
              <b class="mono">#{{ a.skuCode }}</b> · {{ a.declaredBrand }} {{ a.declaredModel }}
              <div class="pda-muted">系统推荐空储位：<b>LOC-{{ a.recommendedBin }}</b></div>
            </div>
            <button class="pda-act ok" @click="pdaPutaway(a)">双扫入 {{ a.recommendedBin }}</button>
          </div>
          <p v-if="!waitPutAsns.length" class="pda-ok">✓ 当前待上架队列已全部入位！</p>
        </div>

        <!-- ③ 波次顺路拣货 -->
        <div v-else-if="mode === 'pick'" class="pda-card">
          <h4>③ 按 A区→B区→E区 最短路径走动拣货</h4>
          <template v-if="curWave">
            <p class="pda-sub">{{ curWave.waveNo }} · 共 {{ curWave.routeStops.length }} 站顺路指引</p>
            <div v-for="st in curWave.routeStops" :key="st.seq + st.skuCode" class="pda-item">
              <div>
                <span class="pda-seq">{{ st.seq }}</span>
                <b class="mono">库位 {{ st.loc }}</b> → <span class="mono">#{{ st.skuCode }}</span>
                <div class="pda-muted">{{ st.model }}</div>
              </div>
              <button class="pda-act" :class="{ ok: !st.picked }" @click="pdaTogglePick(st)">
                {{ st.picked ? '✓ 已拣' : '扫码拣下' }}
              </button>
            </div>
          </template>
        </div>

        <!-- ④ 货架盲盘 -->
        <div v-else-if="mode === 'blind'" class="pda-card">
          <h4>④ 单排货架 10 分钟盲盘（隐藏账面数）</h4>
          <template v-if="curBlind">
            <p class="pda-sub">{{ curBlind.id }} · 当前储位 <b>{{ curBlind.currentBin }}</b> · 账面：🔒隐藏</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
              <button
                v-for="b in curBlind.targetBins"
                :key="b"
                class="pda-chip"
                :class="{ on: curBlind.currentBin === b }"
                @click="scanBlindBinOrSku(curBlind, 'LOC-' + b)"
              >
                LOC-{{ b }} ({{ (curBlind.scannedByBin[b] || []).length }})
              </button>
            </div>
            <button v-if="curBlind.phase === 'BLIND_SCANNING'" class="pda-wide" @click="simulateScanShelfA04WithMisplaced(curBlind)">
              🔫 模拟激光扫入 A-04 两台实物（含1台串位件）
            </button>
            <button v-if="curBlind.phase === 'BLIND_SCANNING'" class="pda-wide ok" style="margin-top:8px" @click="submitBlindSessionAndCompare(curBlind); store.pdaOpen = false; go('stocktake')">
              提交盲盘并在宽屏查看串位纠偏 ›
            </button>
            <p v-else class="pda-ok">✓ 本单盲扫已提交，已识别串位待纠偏！</p>
          </template>
        </div>

        <!-- ⑤ WIP 工位借出与归架 -->
        <div v-else class="pda-card">
          <h4>⑤ 库内 WIP 工位借出 / 归架（货动码必动）</h4>
          <p class="pda-sub">客服/摄影拿走机器必扫工位码挂名，杜绝货架空位扯皮</p>
          <div v-for="b in activeBorrows" :key="b.id" class="pda-item">
            <div>
              <b class="mono">#{{ b.skuCode }}</b> @ <code>{{ b.wipCode }}</code>
              <div class="pda-muted">{{ b.borrower }} · 原位 {{ b.fromBin }}</div>
            </div>
            <button class="pda-act ok" @click="returnSkuFromWip(b, b.fromBin)">扫回 {{ b.fromBin }}</button>
          </div>
          <button class="pda-wide" style="margin-top:8px" @click="quickBorrowDemo">
            🔫 模拟借出 #910000000003 → WIP-PHOTO-01
          </button>
        </div>
      </div>

      <footer class="pda-foot">
        <span>一套原生 Vue3 H5 同时适配「固定电脑宽屏」与「iData 激光手持端」</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { scanFeedback, triggerScanFeedback, onGlobalBarcodeScan, installGlobalWedgeScanner } from '../utils/scannerAudio.js'
import {
  store,
  currentUser,
  go,
  signInboundAsn,
  completeAsnPutaway,
  scanBlindBinOrSku,
  simulateScanShelfA04WithMisplaced,
  submitBlindSessionAndCompare,
  checkoutSkuToWip,
  returnSkuFromWip,
  scanOutboundMultiCode
} from '../store/warehouseStore.js'

const mode = ref('pick')
const wedgeCode = ref('')

const MODES = [
  { k: 'rcv', short: '1.收货', sub: '进C区' },
  { k: 'put', short: '2.上架', sub: '双扫码' },
  { k: 'pick', short: '3.拣货', sub: '顺路单' },
  { k: 'blind', short: '4.盲盘', sub: '藏账数' },
  { k: 'wip', short: '5.借还', sub: '工位码' }
]

const placeholderText = computed(() => {
  if (mode.value === 'rcv') return '扫快递运单号 SF142...'
  if (mode.value === 'put') return '扫机身码或货架码 LOC-A-06...'
  if (mode.value === 'blind') return '先扫 LOC-A-04 再扫实物码...'
  return '扣激光扳机秒扫任意条码...'
})

const waitSignAsns = computed(() => (store.data.inboundAsns || []).filter(a => a.status === 'IN_TRANSIT'))
const waitPutAsns = computed(() => (store.data.inboundAsns || []).filter(a => a.status === 'INSPECTED_WAIT_PUTAWAY'))
const curWave = computed(() => store.data.pickingWaves?.[0] || null)
const curBlind = computed(() => store.data.blindCycleSessions?.[0] || null)
const activeBorrows = computed(() => (store.data.wipBorrows || []).filter(b => b.status === 'BORROWED'))

function pdaSignAsn(a) {
  signInboundAsn(a, { inputSuffix: a.phoneSuffix, cartonNote: 'PDA门口快扫完好' })
  triggerScanFeedback({ code: a.trackingNo, kind: '门口签收', ok: true, msg: `已落 ${a.stagingBin}` })
}

function pdaPutaway(a) {
  completeAsnPutaway(a, { scannedSku: a.skuCode, scannedBin: a.recommendedBin })
  triggerScanFeedback({ code: `${a.skuCode}@${a.recommendedBin}`, kind: '双扫上架', ok: true, msg: '已入可售架' })
}

function pdaTogglePick(st) {
  st.picked = !st.picked
  triggerScanFeedback({ code: `${st.skuCode}@${st.loc}`, kind: '波次拣货', ok: true, msg: st.picked ? '已核对拣下' : '取消拣货' })
}

function quickBorrowDemo() {
  checkoutSkuToWip({
    skuCode: '910000000003',
    wipCode: 'WIP-PHOTO-01',
    borrower: currentUser.value.name,
    purpose: 'PDA扫码借至1号摄影台补拍细节'
  })
}

function handleUniversalCode(raw) {
  const code = String(raw || '').trim()
  if (!code) return
  if (store.route === 'outbound' && store.data.outbounds?.[0]) {
    scanOutboundMultiCode(store.data.outbounds[0], code)
    return
  }
  if ((store.route === 'stocktake' || mode.value === 'blind') && curBlind.value?.phase === 'BLIND_SCANNING') {
    scanBlindBinOrSku(curBlind.value, code)
    return
  }
  if (/^LOC-/i.test(code)) {
    const bin = code.toUpperCase().replace(/^LOC-/, '')
    triggerScanFeedback({ code: `LOC-${bin}`, kind: '库位码', ok: true, msg: `定位库位 ${bin}` })
    go('locations', bin)
    return
  }
  const hitSku = (store.data.skus || []).find(s => s.code === code || s.sn === code)
  if (hitSku) {
    triggerScanFeedback({ code: hitSku.code, kind: '一物一码', ok: true, msg: `${hitSku.brand} ${hitSku.model} (${hitSku.location})` })
    return
  }
  triggerScanFeedback({ code, kind: '未知条码', ok: false, msg: '未匹配到在库单件或标准库位码' })
}

function fireScan() {
  if (!wedgeCode.value.trim()) return
  handleUniversalCode(wedgeCode.value)
  wedgeCode.value = ''
}

let offScan = null
onMounted(() => {
  installGlobalWedgeScanner()
  offScan = onGlobalBarcodeScan(handleUniversalCode)
})
onUnmounted(() => {
  if (offScan) offScan()
})
</script>

<style scoped>
.laser-toast {
  position: fixed;
  top: 66px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 140;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13.5px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.25);
  color: #fff;
}
.laser-toast.ok { background: #13794b; border: 2px solid #86efac; }
.laser-toast.warn { background: #b45309; border: 2px solid #fde68a; }
.laser-toast.err { background: #b91c1c; border: 2px solid #fca5a5; }

.pda-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.48);
  z-index: 95;
  display: flex;
  justify-content: flex-end;
  padding: 18px 24px;
}
.pda-device {
  width: 416px;
  max-width: 100%;
  height: 100%;
  background: #0f172a;
  border: 6px solid #334155;
  border-radius: 26px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #f8fafc;
}
.pda-top {
  padding: 14px 16px 12px;
  background: #1e293b;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #334155;
}
.pda-pill {
  font-size: 11px;
  font-weight: 700;
  color: #93c5fd;
  display: block;
}
.pda-top h3 { font-size: 16px; margin-top: 2px; color: #fff; }
.pda-snd {
  padding: 4px 9px;
  border-radius: 7px;
  background: #334155;
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 700;
}
.pda-snd.on { background: #1d4ed8; color: #fff; }
.pda-x {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: #334155;
  color: #fff;
  font-weight: 700;
}

.pda-tabs {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  padding: 8px 10px;
  background: #0f172a;
}
.pda-tabs button {
  padding: 7px 4px;
  border-radius: 9px;
  background: #1e293b;
  color: #94a3b8;
  text-align: center;
}
.pda-tabs button.on {
  background: #2563eb;
  color: #fff;
}
.pda-tabs b { display: block; font-size: 13px; }
.pda-tabs small { display: block; font-size: 10.5px; opacity: 0.85; }

.pda-wedge {
  display: flex;
  gap: 6px;
  padding: 6px 12px 10px;
  border-bottom: 1px solid #1e293b;
}
.pda-wedge input {
  flex: 1;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid #475569;
  background: #1e293b;
  color: #fff;
  font-size: 13.5px;
}
.pda-trig {
  padding: 0 13px;
  border-radius: 8px;
  background: #f59e0b;
  color: #111827;
  font-weight: 800;
  font-size: 13px;
}

.pda-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  background: #f8fafc;
  color: #0f172a;
}
.pda-card { display: grid; gap: 8px; }
.pda-card h4 { font-size: 15px; font-weight: 800; }
.pda-sub { font-size: 12px; color: #475569; }
.pda-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #cbd5e1;
  font-size: 13px;
}
.pda-muted { font-size: 11.5px; color: #64748b; margin-top: 2px; }
.pda-act {
  padding: 7px 11px;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-weight: 700;
  font-size: 12.5px;
  flex: none;
}
.pda-act.ok { background: #16a34a; }
.pda-seq {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #0f172a;
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  margin-right: 4px;
}
.pda-chip {
  padding: 6px 10px;
  border-radius: 8px;
  background: #e2e8f0;
  font-weight: 700;
  font-size: 12.5px;
}
.pda-chip.on { background: #2563eb; color: #fff; }
.pda-wide {
  width: 100%;
  padding: 11px;
  border-radius: 10px;
  background: #2563eb;
  color: #fff;
  font-weight: 800;
  font-size: 13.5px;
  text-align: center;
}
.pda-wide.ok { background: #16a34a; }
.pda-ok {
  padding: 14px;
  border-radius: 10px;
  background: #dcfce7;
  color: #166534;
  font-weight: 700;
  font-size: 13px;
  text-align: center;
}
.pda-foot {
  padding: 9px 12px;
  background: #1e293b;
  color: #94a3b8;
  font-size: 11.5px;
  text-align: center;
}
</style>
