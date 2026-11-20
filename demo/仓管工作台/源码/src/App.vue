<template>
  <div class="shell" @click="closePop">
    <!-- 左侧 222px 固定桌面导航栏（与销售工作台 Stitch Demo 1:1 同构，纯电脑版 Web H5） -->
    <nav class="dock" aria-label="仓管工作台主导航">
      <button class="brand" @click="go('today')">
        <span><Icon name="box" /></span>仓管工作台
      </button>

      <div v-for="g in visibleNavGroups" :key="g.label" class="navgroup">
        <p>{{ g.label }}</p>
        <button
          v-for="item in g.items"
          :key="item.key"
          class="di"
          :class="{ on: activeKey === item.key }"
          :aria-current="activeKey === item.key ? 'page' : undefined"
          @click="go(item.key)"
        >
          <Icon :name="item.icon" />
          <span class="lb">{{ item.label }}</span>
          <i v-if="badgeOf(item.key)" class="n" :class="badgeOf(item.key).cls">{{ badgeOf(item.key).text }}</i>
        </button>
      </div>
    </nav>

    <!-- 右侧桌面工作区 -->
    <div class="workspace">
      <header class="topbar">
        <div class="trail" style="white-space:nowrap;flex-shrink:0">
          <span>{{ currentGroupLabel }}</span>
          <span class="slash">/</span>
          <b>{{ currentPageLabel }}</b>
          <span v-if="store.route === 'item' && store.routeParam" class="tag" style="margin-left:6px">#{{ store.routeParam }}</span>
        </div>

        <div class="toptools" style="gap:7px" @click.stop>
          <span class="mode" style="white-space:nowrap">
            <i class="dot" :class="store.backendOnline ? 'grn' : 'amb'"></i>
            {{ store.backendOnline ? 'SQLite联机' : '本地演示' }}
          </span>

          <div class="seg" style="padding:2px;white-space:nowrap">
            <button :class="{ on: currentUser.role === 'WAREHOUSE' || currentUser.role === 'NEWBIE' }" @click="pickAccount('linqg')">员工端</button>
            <button :class="{ on: currentUser.role === 'SUPERVISOR' }" @click="pickAccount('admin')">🧭 主管端</button>
            <button :class="{ on: currentUser.role === 'BOSS' }" @click="pickAccount('boss')">👑 老板端</button>
          </div>

          <a
            href="./全链路流程图与开发蓝图.html"
            target="_blank"
            rel="noopener"
            class="btn sm"
            style="text-decoration:none;white-space:nowrap"
            title="打开全链路流程图与程序员开发蓝图"
          >
            <Icon name="flow" />流程图
          </a>

          <button
            class="btn sm pri"
            style="white-space:nowrap"
            @click="store.pdaOpen = true"
            title="打开 iData 50 巷道走动扫码手持 H5 模式"
          >
            <Icon name="pda" />PDA端
          </button>

          <button class="topsearch" style="white-space:nowrap" @click="openFinder" aria-label="找功能">
            <Icon name="search" />
            <span>搜单/库位</span>
            <kbd>{{ shortcutLabel }}</kbd>
          </button>

          <button class="account" style="white-space:nowrap" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
            <span class="av">{{ currentUser.avatar || currentUser.name.slice(0, 1) }}</span>
            <span>{{ currentUser.name }}</span>
          </button>

          <div v-if="menuOpen" class="pop">
            <button class="di" @click="navFromMenu('me')">
              <Icon name="people" />我的（岗位权限与审计流水）
            </button>
            <p>切换角色视角体验防呆门禁</p>
            <button
              v-for="acc in ACCOUNTS"
              :key="acc.id"
              class="di"
              :class="{ on: currentUser.id === acc.id }"
              @click="pickAccount(acc.id)"
            >
              <span class="av" style="width:22px;height:22px;font-size:11px">{{ acc.avatar }}</span>
              <span>{{ acc.name }} · {{ acc.roleLabel }}</span>
            </button>
            <p>演示数据复位</p>
            <button class="di" @click="handleResetDemo">
              <Icon name="refresh" />恢复初始演示数据
            </button>
          </div>
        </div>
      </header>

      <main ref="mainEl" class="main">
        <!-- 新同事首日门禁提示条（与销售工作台 gatebar 一致） -->
        <div v-if="!currentUser.practiceDone && store.route !== 'learn'" class="gatebar">
          <Icon name="lock" />
          <span>真实任务先锁着：当前「{{ currentUser.name }}」尚未完成首日 3 项防呆练习，真实库存与工单写入已自动保护锁定。</span>
          <button class="btn sm pri" @click="go('learn')">去做沙盒练习</button>
        </div>

        <TodayView v-if="store.route === 'today'" />
        <SupervisorHubView v-else-if="store.route === 'supervisor'" />
        <BossCockpitView v-else-if="store.route === 'boss'" />
        <OrderHubView v-else-if="store.route === 'orders'" />
        <InboundAsnView v-else-if="store.route === 'asn'" />
        <CourierCoordView v-else-if="store.route === 'courier'" />
        <InspectView v-else-if="store.route === 'inspect'" />
        <OutboundView v-else-if="store.route === 'outbound'" />
        <LocationsView v-else-if="store.route === 'locations'" />
        <WmsLedgerView v-else-if="store.route === 'ledger'" />
        <LegacyWashGalleryView v-else-if="store.route === 'legacy-wash'" />
        <BatteryCareView v-else-if="store.route === 'battery'" />
        <GalleryView v-else-if="store.route === 'gallery'" />
        <ItemDetailView v-else-if="store.route === 'item'" :code="store.routeParam" />
        <AuxView v-else-if="store.route === 'aux'" />
        <StocktakeView v-else-if="store.route === 'stocktake'" />
        <AnomalyView v-else-if="store.route === 'anomaly'" />
        <MediaSliceView v-else-if="store.route === 'media'" />
        <StandardsView v-else-if="store.route === 'standards'" />
        <ReadinessView v-else-if="store.route === 'readiness'" />
        <LearnView v-else-if="store.route === 'learn'" />
        <ManualView v-else-if="store.route === 'manual'" />
        <MeView v-else-if="store.route === 'me'" />
        <TodayView v-else />
      </main>
    </div>

    <!-- ⌘K 全局找功能、搜订单、搜库位、搜在库单件弹窗 -->
    <dialog ref="finderEl" class="finder" @close="store.finderOpen = false" @click.self="closeFinder">
      <div class="finder-inner">
        <div class="finder-head">
          <b>找功能 / 搜订单号 / 搜库位 / 搜单件货号</b>
          <button class="btn sm" @click="closeFinder">关闭</button>
        </div>
        <label class="finder-input">
          <Icon name="search" />
          <input
            ref="finderInputEl"
            v-model="finderQuery"
            placeholder="输入订单号（XY2026）、库位（A-02）、运单（SF142）、货号（5132）或功能词（爱回收 / 历史清洗 / 盲盘 / PDA）…"
            aria-label="搜索功能、订单、库位或单件"
            @keydown.enter="onFinderEnter"
          />
        </label>

        <div v-if="matchedOrders.length" class="navgroup">
          <p>匹配到的销售订单（直达订单聚合中心）</p>
          <button
            v-for="o in matchedOrders"
            :key="o.id"
            class="di"
            @click="openRouteFromFinder('orders', o.id)"
          >
            <Icon name="inbox" />
            <span><b>{{ o.externalOrderNo }}</b> · {{ o.buyerName }} · {{ o.itemTitle }}</span>
          </button>
        </div>

        <div v-if="matchedBins.length" class="navgroup">
          <p>匹配到的 WMS 库位格口（直达库位储位矩阵）</p>
          <button
            v-for="b in matchedBins"
            :key="b.code"
            class="di"
            @click="openRouteFromFinder('locations', b.code)"
          >
            <Icon name="pin" />
            <span><b>{{ b.code }}</b> · {{ b.fullCode }} · {{ b.zoneName }}</span>
          </button>
        </div>

        <div v-if="matchedSkus.length" class="navgroup">
          <p>匹配到的在库单件实物（回车直达详情）</p>
          <button
            v-for="s in matchedSkus"
            :key="s.code"
            class="di"
            @click="openSkuFromFinder(s.code)"
          >
            <Icon name="box" />
            <span><b>#{{ s.code }}</b> · {{ s.brand }} {{ s.model }}（{{ s.location }}）</span>
          </button>
        </div>

        <div v-for="g in filteredNavGroups" :key="g.label" class="navgroup">
          <p>{{ g.label }}</p>
          <button
            v-for="d in g.items"
            :key="d.key"
            class="di"
            :class="{ on: activeKey === d.key }"
            @click="navFromMenu(d.key)"
          >
            <Icon :name="d.icon" />
            <span>{{ d.label }}</span>
          </button>
        </div>

        <p v-if="!filteredNavGroups.length && !matchedSkus.length && !matchedOrders.length && !matchedBins.length" class="finder-empty">
          没有找到匹配项。试试「历史清洗」「盲盘」「爱回收」「合单」「波次」或单件货号。
        </p>
      </div>
    </dialog>

    <!-- 全局抽屉、iData PDA 走动端、演练沙盒、聚光灯导览与轻提示 -->
    <HelpDrawer />
    <PdaDrawer />
    <VideoModal />
    <PracticeModal />
    <Tour />
    <div v-if="store.toast" class="toast" :class="store.toast.type">{{ store.toast.msg }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './components/Icon.vue'
import HelpDrawer from './components/HelpDrawer.vue'
import PdaDrawer from './components/PdaDrawer.vue'
import VideoModal from './components/VideoModal.vue'
import PracticeModal from './components/PracticeModal.vue'
import Tour from './components/Tour.vue'
import { installGlobalWedgeScanner } from './utils/scannerAudio.js'

import TodayView from './views/TodayView.vue'
import SupervisorHubView from './views/SupervisorHubView.vue'
import BossCockpitView from './views/BossCockpitView.vue'
import OrderHubView from './views/OrderHubView.vue'
import InboundAsnView from './views/InboundAsnView.vue'
import CourierCoordView from './views/CourierCoordView.vue'
import InspectView from './views/InspectView.vue'
import OutboundView from './views/OutboundView.vue'
import LocationsView from './views/LocationsView.vue'
import WmsLedgerView from './views/WmsLedgerView.vue'
import LegacyWashGalleryView from './views/LegacyWashGalleryView.vue'
import BatteryCareView from './views/BatteryCareView.vue'
import GalleryView from './views/GalleryView.vue'
import ItemDetailView from './views/ItemDetailView.vue'
import AuxView from './views/AuxView.vue'
import StocktakeView from './views/StocktakeView.vue'
import AnomalyView from './views/AnomalyView.vue'
import MediaSliceView from './views/MediaSliceView.vue'
import StandardsView from './views/StandardsView.vue'
import ReadinessView from './views/ReadinessView.vue'
import LearnView from './views/LearnView.vue'
import ManualView from './views/ManualView.vue'
import MeView from './views/MeView.vue'

import {
  store, currentUser, ACCOUNTS, skuLevel, skuPreSalesGates, skuBatteryStatus,
  go, openItemDetail, switchAccount, resetDemoData
} from './store/warehouseStore.js'

const NAV_GROUPS = [
  {
    label: '日常作业',
    items: [
      { key: 'today', label: '今天', icon: 'today', kw: '待办 派工 协同 7态 验收' },
      { key: 'orders', label: '订单抓取与聚合', icon: 'inbox', kw: '抓单 闲鱼 闲管家 转转 合单 拆单 波次 漏抓 改址 退款拦截' },
      { key: 'asn', label: '到货签收与上架', icon: 'inbound', kw: '采购在途 ASN 快递签收 手机尾号 无主包裹 SPU匹配 打标 扫码上架' },
      { key: 'courier', label: '快递协调与企微召回', icon: 'chat', kw: '快递 顺丰 京东 100分钟 10票 拒签 议价 17:00 去留 10分钟 站点 召回 企微 微信群' },
      { key: 'inspect', label: '收货验货', icon: 'scan', kw: '爱回收 分步分级 问卷 原封未拆 高拍仪 录像 坏货全检 子母码' },
      { key: 'outbound', label: '波次拣货与出库', icon: 'truck', kw: '波次 路径拣货 子母四码 热敏面单 包材扣减 紧急拦截归架 自提 退回' }
    ]
  },
  {
    label: '库位与总账',
    items: [
      { key: 'locations', label: 'WMS 库位管理', icon: 'pin', kw: '四级库位 储位矩阵 LPN 容器箱 WIP 工位暂借 归架 移库 条码' },
      { key: 'ledger', label: '库存总账与流水', icon: 'ledger', kw: 'SPU汇总 SKU一物一码 修改货号 出入库流水 移库台账 包材耗材 CSV' },
      { key: 'legacy-wash', label: '历史库存清洗', icon: 'spark', kw: '历史存量 400票 阻塞 当日清零 缺视频 缺实拍 缺全检 红黄绿 售前关卡' },
      { key: 'battery', label: '锂电30天统筹', icon: 'battery', kw: '锂电池 30天 通电 补电 半电 保持关机 彻底关机 防饿死 鼓包 原封防拆' },
      { key: 'gallery', label: '库存实物画廊', icon: 'grid', kw: '在库 画廊 红黄绿 库龄 滞销 单件详情' },
      { key: 'aux', label: '附属与原盒', icon: 'box', kw: '原盒 彩盒 赠品 附件袋 老系统 历史转入' },
      { key: 'stocktake', label: '盲盘与批次盘点', icon: 'layers', kw: '盲盘 循环微盘 串位纠偏 WIP豁免 RFID UHF 调账 主管审批' }
    ]
  },
  {
    label: '非标品控与标准',
    items: [
      { key: 'anomaly', label: '异常双轨', icon: 'alert', kw: '10分钟 拒签 退货 退款 议价 留货 反悔锁' },
      { key: 'media', label: '补图与切片', icon: 'camera', kw: '实拍图 库位图 10秒 显示器 壁纸 切片 多账号' },
      { key: 'standards', label: '验货标准库', icon: 'book', kw: '模板 爱回收 1042 超集 原封分支 升版 防串版' },
      { key: 'readiness', label: '缺口闭环看板', icon: 'skill', kw: '禅道 183 标准化WMS 闭环 CSV 自检 验收 流程图' }
    ]
  },
  {
    label: '帮助',
    items: [
      { key: 'learn', label: '学', icon: 'learn', kw: '新人 沙盒 演练 练习 视频 通关' },
      { key: 'manual', label: '说明书', icon: 'help', kw: 'SOP 术语 防呆矩阵 规则' }
    ]
  }
]

const BOSS_NAV_GROUPS = [
  {
    label: '老板经营与风控舱',
    items: [
      { key: 'boss', label: '库存资金与风控舱', icon: 'chart', kw: '老板 货值 资金 资损 滞销 归因' },
      { key: 'supervisor', label: '主管集中审批台', icon: 'shield', kw: '主管 审批 督战' },
      { key: 'courier', label: '快递10m生死召回', icon: 'chat', kw: '快递 10分钟 召回 企微' },
      { key: 'battery', label: '锂电30天防饿死', icon: 'battery', kw: '锂电 30天 通电 关机' },
      { key: 'legacy-wash', label: '历史阻塞压死货值', icon: 'spark', kw: '历史阻塞 卖不了 清零' },
      { key: 'ledger', label: '总账与高危流水', icon: 'ledger', kw: '总账 流水 CSV' },
      { key: 'readiness', label: '缺口闭环看板', icon: 'skill', kw: '183 闭环 验收' }
    ]
  }
]

const visibleNavGroups = computed(() => {
  if (currentUser.value.role === 'BOSS') return BOSS_NAV_GROUPS
  if (currentUser.value.role === 'SUPERVISOR') {
    return [
      {
        label: '主管总控',
        items: [{ key: 'supervisor', label: '主管审批与督战台', icon: 'shield', kw: '主管 集中审批 五大死线 负载' }]
      },
      ...NAV_GROUPS
    ]
  }
  return NAV_GROUPS
})

const EXTRA_PAGES = [
  { key: 'supervisor', group: '管理视角', label: '主管审批与督战台', icon: 'shield', kw: '主管 审批 督战 五大死线' },
  { key: 'boss', group: '管理视角', label: '老板库存资金与风控舱', icon: 'chart', kw: '老板 资金 资损 滞销 锂电' },
  { key: 'me', group: '账号', label: '我的（权限与审计）', icon: 'people', kw: '字号 角色 SQLite 日志 审计' }
]

const menuOpen = ref(false)
const mainEl = ref(null)
const finderEl = ref(null)
const finderInputEl = ref(null)
const finderQuery = ref('')

const shortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K'

const activeKey = computed(() => (store.route === 'item' ? 'gallery' : store.route))

const currentGroupLabel = computed(() => {
  if (store.route === 'item') return '库位与总账'
  for (const g of NAV_GROUPS) {
    if (g.items.some(i => i.key === store.route)) return g.label
  }
  return '账号'
})

const currentPageLabel = computed(() => {
  if (store.route === 'item') return '单件实物详情'
  for (const g of NAV_GROUPS) {
    const hit = g.items.find(i => i.key === store.route)
    if (hit) return hit.label
  }
  const ex = EXTRA_PAGES.find(i => i.key === store.route)
  return ex ? ex.label : '今天'
})

function badgeOf(key) {
  const d = store.data || {}
  if (key === 'today') {
    const redTasks = (d.tasks || []).filter(t => t.status !== '已验收' && t.urgency === 'red').length
    return redTasks ? { text: String(redTasks), cls: '' } : null
  }
  if (key === 'orders') {
    const pool = (d.salesOrderPool || []).filter(o => o.aggState !== 'MERGED_CHILD')
    const urgent = pool.filter(o =>
      ['CAPTURE_MISSED', 'UNMATCHED_SKU', 'HOLD_INTERCEPT'].includes(o.aggState) ||
      Boolean(o.syncError)
    ).length
    if (urgent) return { text: String(urgent), cls: '' }
    const mergeN = pool.filter(o => o.aggState === 'MERGEABLE').length
    return mergeN ? { text: String(mergeN), cls: 'amb' } : null
  }
  if (key === 'asn') {
    const asns = d.inboundAsns || []
    const unclaimed = asns.filter(a => a.status === 'UNCLAIMED_HOLD').length
    const todo = asns.filter(a => ['IN_TRANSIT', 'INSPECTED_WAIT_PUTAWAY', 'UNCLAIMED_HOLD'].includes(a.status)).length
    if (!todo) return null
    return { text: String(todo), cls: unclaimed ? '' : 'amb' }
  }
  if (key === 'courier') {
    const cc = d.courierCoord || {}
    const recallN = (cc.urgentRecalls || []).filter(r => r.status !== 'RECALLED_SAFE').length
    const eodN = (cc.eodItems || []).filter(i => i.decision === 'PENDING').length
    if (recallN) return { text: String(recallN + eodN), cls: '' }
    return eodN ? { text: String(eodN), cls: 'amb' } : null
  }
  if (key === 'inspect') {
    const n = (d.inspections || []).filter(x => !x.submitted).length
    return n ? { text: String(n), cls: '' } : null
  }
  if (key === 'outbound') {
    const shipN = (d.outbounds || []).filter(o => o.status !== 'SHIPPED' && o.status !== 'RETURNED_TO_SHELF').length
    const retN = (d.returns || []).filter(r => !r.recheckDone).length
    const tot = shipN + retN
    return tot ? { text: String(tot), cls: '' } : null
  }
  if (key === 'legacy-wash') {
    const redWash = (d.skus || []).filter(s => skuPreSalesGates(s).lvl === 'red').length
    const ambWash = (d.skus || []).filter(s => skuPreSalesGates(s).lvl === 'amb').length
    if (redWash) return { text: String(redWash), cls: '' }
    return ambWash ? { text: String(ambWash), cls: 'amb' } : null
  }
  if (key === 'battery') {
    const redBat = (d.skus || []).filter(s => {
      const st = skuBatteryStatus(s)
      return st.applicable && !st.isSealed && st.lvl === 'red'
    }).length
    const ambBat = (d.skus || []).filter(s => {
      const st = skuBatteryStatus(s)
      return st.applicable && st.lvl === 'amb'
    }).length
    if (redBat) return { text: String(redBat), cls: '' }
    return ambBat ? { text: String(ambBat), cls: 'amb' } : null
  }
  if (key === 'supervisor') {
    const keepN = (d.anomalies || []).filter(a => a.keepLocks && a.isolationLocked).length
    const stN = d.stocktake && !d.stocktake.ledgerWrittenBack ? 1 : 0
    const drN = (d.standardDrafts || []).filter(x => !x.published).length
    const tot = keepN + stN + drN
    return tot ? { text: String(tot), cls: '' } : null
  }
  if (key === 'ledger') {
    const unmapped = (d.skus || []).filter(s => !s.spuCode).length
    const lowPack = (d.packingMaterials || []).filter(p => p.stock <= p.warnBelow).length
    const tot = unmapped + lowPack
    return tot ? { text: String(tot), cls: 'amb' } : null
  }
  if (key === 'gallery') {
    const redSku = (d.skus || []).filter(s => skuLevel(s) === 'red').length
    return redSku ? { text: String(redSku), cls: '' } : null
  }
  if (key === 'anomaly') {
    const n = (d.anomalies || []).filter(a => a.type === 'GOODS_DIFF' && a.isolationLocked).length
    return n ? { text: String(n), cls: '' } : null
  }
  if (key === 'media') {
    const n = (d.mediaTasks || []).filter(m => !m.done).length
    return n ? { text: String(n), cls: 'amb' } : null
  }
  if (key === 'stocktake') {
    const openBlind = (d.blindCycleSessions || []).filter(s => s.phase !== 'CLOSED').length
    const openRfid = d.stocktake && !d.stocktake.ledgerWrittenBack ? 1 : 0
    const tot = openBlind + openRfid
    return tot ? { text: String(tot), cls: 'amb' } : null
  }
  if (key === 'learn' && !currentUser.value.practiceDone) {
    const s = currentUser.value.steps || {}
    const left = [s.case1, s.case2, s.case3].filter(v => (v || 0) < 3).length
    return left ? { text: `${left}`, cls: 'amb' } : null
  }
  return null
}

function syncFromHash() {
  const raw = (location.hash || '#/today').replace(/^#\/?/, '')
  const [seg1, ...rest] = raw.split('/')
  let r = seg1 || 'today'
  if (r === 'inventory') r = 'gallery'
  const param = rest.length ? decodeURIComponent(rest.join('/')) : (r === 'gallery' ? 'all' : '')
  store.route = r
  store.routeParam = param
  if (mainEl.value) mainEl.value.scrollTop = 0
}

function closePop() {
  menuOpen.value = false
}

function navFromMenu(key) {
  menuOpen.value = false
  closeFinder()
  go(key)
}

function pickAccount(id) {
  menuOpen.value = false
  switchAccount(id)
}

function handleResetDemo() {
  menuOpen.value = false
  resetDemoData()
}

function openFinder() {
  finderQuery.value = ''
  store.finderOpen = true
  if (finderEl.value && !finderEl.value.open) {
    finderEl.value.showModal()
  }
  nextTick(() => finderInputEl.value && finderInputEl.value.focus())
}

function closeFinder() {
  store.finderOpen = false
  if (finderEl.value && finderEl.value.open) {
    finderEl.value.close()
  }
}

const filteredNavGroups = computed(() => {
  const q = finderQuery.value.trim().toLowerCase()
  const base = [
    ...NAV_GROUPS,
    { label: '账号与设置', items: EXTRA_PAGES }
  ]
  if (!q) return base
  return base
    .map(g => ({
      label: g.label,
      items: g.items.filter(i => i.label.toLowerCase().includes(q) || (i.kw || '').toLowerCase().includes(q) || i.key.includes(q))
    }))
    .filter(g => g.items.length > 0)
})

const matchedOrders = computed(() => {
  const q = finderQuery.value.trim().toLowerCase()
  if (!q) return []
  return (store.data.salesOrderPool || []).filter(o =>
    o.aggState !== 'MERGED_CHILD' && (
      (o.externalOrderNo || '').toLowerCase().includes(q) ||
      (o.buyerName || '').toLowerCase().includes(q) ||
      (o.itemTitle || '').toLowerCase().includes(q)
    )
  ).slice(0, 4)
})

const matchedBins = computed(() => {
  const q = finderQuery.value.trim().toLowerCase()
  if (!q) return []
  return (store.data.locations || []).filter(b =>
    b.code.toLowerCase().includes(q) ||
    (b.fullCode || '').toLowerCase().includes(q) ||
    (b.zoneName || '').toLowerCase().includes(q)
  ).slice(0, 4)
})

const matchedSkus = computed(() => {
  const q = finderQuery.value.trim().toLowerCase()
  if (!q) return []
  return (store.data.skus || []).filter(s =>
    s.code.toLowerCase().includes(q) ||
    s.model.toLowerCase().includes(q) ||
    s.brand.toLowerCase().includes(q) ||
    s.location.toLowerCase().includes(q)
  ).slice(0, 5)
})

function openSkuFromFinder(code) {
  closeFinder()
  openItemDetail(code)
}

function openRouteFromFinder(routeKey, param = '') {
  closeFinder()
  go(routeKey, param)
}

function onFinderEnter() {
  if (matchedOrders.value.length) {
    openRouteFromFinder('orders', matchedOrders.value[0].id)
    return
  }
  if (matchedBins.value.length) {
    openRouteFromFinder('locations', matchedBins.value[0].code)
    return
  }
  if (matchedSkus.value.length) {
    openSkuFromFinder(matchedSkus.value[0].code)
    return
  }
  if (filteredNavGroups.value.length && filteredNavGroups.value[0].items.length) {
    navFromMenu(filteredNavGroups.value[0].items[0].key)
  }
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (finderEl.value && finderEl.value.open) closeFinder()
    else openFinder()
  }
}

watch(() => store.route + ':' + store.routeParam, () => {
  if (mainEl.value) mainEl.value.scrollTop = 0
})

onMounted(() => {
  installGlobalWedgeScanner()
  syncFromHash()
  window.addEventListener('hashchange', syncFromHash)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', syncFromHash)
  window.removeEventListener('keydown', onKeydown)
})
</script>
