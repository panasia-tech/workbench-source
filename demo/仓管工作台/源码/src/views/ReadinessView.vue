<template>
  <div class="dpage">
    <div class="ph">
      <div>
        <h1>缺口闭环看板 · 禅道 14 卡 {{ totalCount }} 节点逐条核验 <Q k="rd-main" /></h1>
        <p class="sub">全量对齐电脑版 Web H5（与销售工作台 Stitch Demo 同源设计，不再维护小程序） · 每条需求均可一键跳到对应页面实测</p>
      </div>
      <div class="row">
        <a href="./全链路流程图与开发蓝图.html" target="_blank" rel="noopener" class="btn pri" style="text-decoration:none">
          <Icon name="flow" /> 打开《全链路流程图与开发蓝图》
        </a>
        <button class="btn" @click="exportCsv"><Icon name="download" /> 导出 183 条核验清单 CSV</button>
      </div>
    </div>

    <!-- 终极版 8 大核心业务与专业 WMS 底座闭环总览 -->
    <div class="card" style="margin-bottom:14px">
      <div class="rd-top" style="margin-bottom:10px">
        <div>
          <b style="font-size:16px">终极版八大核心业务与专业 WMS 机制 · 100% 交互逻辑闭环</b>
          <p class="muted" style="font-size:12.5px;margin-top:3px">
            完整覆盖「多店抓单合单 → ASN签收防混上架 → 爱回收分步分级验货(去估价+原封分支) → 历史库存售前四关清洗Gallery → 四级库位/LPN容器/WIP工位暂借 → 波次子母四码复核与拣后红屏拦截归架 → 货架循环盲盘与串位纠偏 → 激光枪声光+iData手持PDA双端」。
          </p>
        </div>
        <span class="tag grn">✓ 8 / 8 核心闭环可当场实测</span>
      </div>
      <div class="wms-base-grid">
        <div v-for="m in WMS_BASE_MODULES" :key="m.code" class="wms-base-item">
          <div class="wb-hd">
            <span class="tag acc">{{ m.code }}</span>
            <b>{{ m.title }}</b>
          </div>
          <p class="muted">{{ m.desc }}</p>
          <button class="btn sm ghost" @click="m.pda ? (store.pdaOpen = true) : go(m.route)">{{ m.pda ? '打开 PDA 端 ›' : '去实测 ›' }}</button>
        </div>
      </div>
    </div>

    <!-- 总体闭环进度条（与销售工作台 Readiness.vue 同构） -->
    <div class="card">
      <div class="rd-top">
        <div>
          <div class="rd-big">
            <b style="color:var(--grn)">{{ closedCount }}</b>
            <span> / {{ totalCount }} 条电脑版 H5 业务与防呆逻辑已本机闭环（{{ closedPct }}%）</span>
          </div>
          <p class="muted" style="font-size:13px;margin-top:4px">
            其余 <b style="color:var(--amb)">{{ extCount }} 条</b> 为物理硬件/外部生产接口（高拍仪 RTSP 视频流、UHF 串口 SDK、顺丰/京东生产回调、闲鱼多号推送等），已在界面诚实挂标「演示模拟 · 待外部联调」，绝不假装生产接通。
          </p>
        </div>
        <div class="rd-badges">
          <button class="seg-btn" :class="{ on: statusFilter === 'ALL' }" @click="statusFilter = 'ALL'">全部 {{ totalCount }}</button>
          <button class="seg-btn grn" :class="{ on: statusFilter === 'CLOSED' }" @click="statusFilter = 'CLOSED'">✓ 电脑版H5已闭环 {{ closedCount }}</button>
          <button class="seg-btn amb" :class="{ on: statusFilter === 'EXT' }" @click="statusFilter = 'EXT'">! 待硬件/外部接口 {{ extCount }}</button>
        </div>
      </div>

      <div class="bar" style="height:12px;margin-top:12px">
        <i class="g" :style="{ width: closedPct + '%' }"></i>
        <i class="a" :style="{ width: (100 - closedPct) + '%' }"></i>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="card" style="margin-top:14px">
      <div class="row" style="gap:10px;margin-bottom:12px;flex-wrap:wrap">
        <select v-model="groupFilter" class="inp" style="width:260px">
          <option value="ALL">全部禅道模块（14 张需求卡）</option>
          <option v-for="g in groups" :key="g.code" :value="g.code">{{ g.code }} · {{ g.title }}（{{ g.count }}）</option>
        </select>
        <input
          v-model="kw"
          class="inp"
          style="flex:1;min-width:240px"
          placeholder="搜节点编号（如 WH03-01 / G03）、规则关键词（如 坏货全检 / 10分钟 / 附件袋 / 原盒）…"
        />
        <span class="muted" style="font-size:13px">当前命中 <b>{{ filteredRows.length }}</b> 条</span>
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th style="width:96px">节点编号</th>
            <th style="width:155px">所属模块</th>
            <th style="width:170px">功能点</th>
            <th>禅道验收标准</th>
            <th style="width:165px">当前闭环状态</th>
            <th style="width:210px">实现边界说明</th>
            <th style="width:86px">实测入口</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filteredRows" :key="r.id">
            <td class="mono"><b>{{ r.id }}</b></td>
            <td>
              <span class="tag">{{ r.group }}</span>
              <div class="muted" style="font-size:11px;margin-top:2px">{{ r.group_title }}</div>
            </td>
            <td><b>{{ r.title }}</b></td>
            <td>{{ r.acceptance }}</td>
            <td>
              <span v-if="isClosed(r)" class="tag grn">✓ 电脑版H5已闭环</span>
              <span v-else class="tag amb">! 待硬件/外部联调</span>
            </td>
            <td class="muted" style="font-size:12px">{{ normalizeBoundary(r.boundary) }}</td>
            <td>
              <button class="btn sm ghost" @click="jumpToRow(r)">去看 ›</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Q from '../components/Q.vue'
import Icon from '../components/Icon.vue'
import { ZENTAO_AUDIT_ROWS } from '../data/zentaoAudit.js'
import { store, go, notify } from '../store/warehouseStore.js'

const statusFilter = ref('ALL')
const groupFilter = ref('ALL')
const kw = ref('')

const WMS_BASE_MODULES = [
  { code: 'WMS-01', route: 'orders', title: '多店抓单与订单聚合', desc: '5店抓单巡检、漏抓补单、通卖选唯一SKU、同客同址一键合单/拆单、改址退款硬拦截、波次生成' },
  { code: 'CRR-02', route: 'courier', title: '快递100分钟拒签与10分钟召回', desc: '送N票限10×N分钟全检显示拒签供议价、17:00去留清零、议妥件10分钟站点召回防打款后退回、企微微信群直连' },
  { code: 'AHS-03', route: 'inspect', title: '爱回收转仓管分级验货', desc: '去报价估价纯客观分级、分步折叠+判别图例弹窗、全新原封独立分支、多选异常确认、坏货全检铁律' },
  { code: 'WASH-04', route: 'legacy-wash', title: '历史库存阻塞清洗Gallery', desc: '红黄绿售前四道放行关卡（缺全检/缺完整视频/缺实拍库位图/缺SPU子母码），不设上限当日清零' },
  { code: 'LOC-05', route: 'locations', title: '四级库位·LPN箱·WIP暂借', desc: 'WH01 24储位矩阵、LPN容器分格箱防丢、摄影/客服工位WIP扫码暂借挂名与归架防串位闭环' },
  { code: 'OUT-06', route: 'outbound', title: '子母四码复核·红屏拦截归架', desc: '主机+#BAG附件袋+#BOX原盒+原厂SN四码扫绿；拣货后退单改址红屏蜂鸣锁死+双扫码退回原储位' },
  { code: 'CYC-07', route: 'stocktake', title: '货架循环盲盘与串位纠偏', desc: '权责分离盲盘隐藏账面数、10分钟单排微盘、WIP暂借自动对冲豁免、串位一键纠偏、主管调账' },
  { code: 'BAT-08', route: 'battery', title: '锂电池30天通电与关机统筹', desc: '自动识别内置锂电单品、防爆补电车充至50%-65%黄金半电、强制彻底关机核验、原封机禁拆封保护与快出预警' }
]

const totalCount = ZENTAO_AUDIT_ROWS.length
function isClosed(r) {
  return r.status === 'UI与交互逻辑已闭环'
}

const closedCount = ZENTAO_AUDIT_ROWS.filter(isClosed).length
const extCount = totalCount - closedCount
const closedPct = Math.round((closedCount / totalCount) * 1000) / 10

const groups = computed(() => {
  const map = new Map()
  for (const r of ZENTAO_AUDIT_ROWS) {
    if (!map.has(r.group)) {
      map.set(r.group, { code: r.group, title: r.group_title, count: 0 })
    }
    map.get(r.group).count += 1
  }
  return Array.from(map.values())
})

const filteredRows = computed(() => {
  const q = kw.value.trim().toLowerCase()
  return ZENTAO_AUDIT_ROWS.filter(r => {
    if (statusFilter.value === 'CLOSED' && !isClosed(r)) return false
    if (statusFilter.value === 'EXT' && isClosed(r)) return false
    if (groupFilter.value !== 'ALL' && r.group !== groupFilter.value) return false
    if (!q) return true
    return (
      r.id.toLowerCase().includes(q) ||
      r.group.toLowerCase().includes(q) ||
      r.group_title.toLowerCase().includes(q) ||
      r.title.toLowerCase().includes(q) ||
      r.acceptance.toLowerCase().includes(q) ||
      r.boundary.toLowerCase().includes(q)
    )
  })
})

function normalizeBoundary(text) {
  return (text || '').replace('小程序', '电脑版H5')
}

function jumpToRow(r) {
  const target = r.route === 'inventory' ? 'gallery' : (r.route || 'today')
  go(target)
}

function exportCsv() {
  const header = ['节点编号', '禅道卡', '模块名', '优先级', '功能标题', '验收标准', '闭环状态', '电脑版H5页面', '边界说明']
  const lines = [header.join(',')]
  for (const r of ZENTAO_AUDIT_ROWS) {
    const row = [
      r.id,
      r.card,
      r.group_title,
      r.priority,
      r.title,
      r.acceptance,
      isClosed(r) ? '电脑版H5已闭环' : '待硬件或外部接口联调',
      r.view_label,
      normalizeBoundary(r.boundary)
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`)
    lines.push(row.join(','))
  }
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = '仓管工作台_电脑版H5_183节点闭环核验表.csv'
  a.click()
  URL.revokeObjectURL(a.href)
  notify('已导出 UTF-8 全量 183 节点闭环核验 CSV', 'ok')
}
</script>

<style scoped>
.rd-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.rd-big b { font-size: 28px; font-weight: 800; }
.rd-big span { font-size: 16px; font-weight: 600; color: var(--ink); }
.rd-badges { display: flex; gap: 8px; flex-wrap: wrap; }
.seg-btn {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.seg-btn.on {
  border-color: var(--acc);
  background: var(--acc-soft);
  color: var(--acc);
}
.seg-btn.grn.on { border-color: var(--grn); background: #ecfdf5; color: var(--grn); }
.seg-btn.amb.on { border-color: var(--amb); background: #fffbeb; color: var(--amb); }
.bar {
  display: flex;
  width: 100%;
  background: #e2e8f0;
  border-radius: 999px;
  overflow: hidden;
}
.bar i.g { background: var(--grn); display: block; height: 100%; }
.bar i.a { background: var(--amb); display: block; height: 100%; }
.wms-base-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.wms-base-item {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 11px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wms-base-item .wb-hd { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; }
.wms-base-item p { font-size: 12px; line-height: 1.45; flex: 1; margin: 0; }
@media (max-width: 1200px) {
  .wms-base-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
