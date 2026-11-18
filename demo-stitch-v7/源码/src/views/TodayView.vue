<template>
  <div class="page work-today">
    <header class="head" data-tour="today-head">
      <div>
        <h1>今天</h1>
        <p class="sub">{{ currentUser.name }} · {{ currentUser.roleLabel }} · {{ isSupervisor ? '全队任务' : '我的任务' }}</p>
      </div>
      <div class="acts">
        <button class="btn" @click="openHelp('today')"><Icon name="help" />怎么用</button>
        <button class="btn" @click="excOpen = true">遇到没见过的情况</button><Q k="d-exc" />
        <button class="btn" @click="devOpen = true">提给开发</button><Q k="d-dev" />
      </div>
    </header>

    <section class="task-summary" data-tour="today-count" aria-label="任务筛选">
      <span>任务状态<Q k="d-count" /></span>
      <button :class="{ selected: filter === 'all' }" @click="filter = 'all'">全部 <b>{{ isSupervisor ? allReds.length : mineList.length }}</b></button>
      <button v-if="!isSupervisor" :class="{ selected: filter === 'red' }" @click="filter = 'red'"><i class="dot red"></i>要处理 <b>{{ reds.length }}</b></button>
      <button v-if="!isSupervisor" :class="{ selected: filter === 'amb' }" @click="filter = 'amb'"><i class="dot amb"></i>注意 <b>{{ ambs.length }}</b></button>
      <button class="btn sm task-refresh" @click="bootstrapBackend"><Icon name="refresh" />刷新</button>
    </section>

    <div class="today-layout">
      <!-- 右栏（aside）：日常标准化WMS四线脉搏 + 跨台协同 + 10分钟首报雷达 + 历史库存清洗 + 当班指标 -->
      <aside class="today-aside">
        <section class="card wms-pulse-card">
          <div class="pk-h">
            <h3>日常标准化 WMS 四线脉搏<Q k="orders" /></h3>
            <span class="tag acc">实时联机</span>
          </div>
          <div class="wms-pulse-list">
            <button class="wms-pulse-row" @click="go('courier')">
              <span class="wp-lb"><Icon name="chat" />快递协调与企微召回</span>
              <span class="wp-val">
                <b :class="courierRecallPending ? 'red-txt' : ''">{{ courierRecallPending }} 票10分钟召回</b>
                <small> · 17:00待定 {{ courierEodPending }} 票</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('battery')">
              <span class="wp-lb"><Icon name="battery" />锂电池30天通电关机</span>
              <span class="wp-val">
                <b :class="overdueBatCount ? 'red-txt' : ''">{{ overdueBatCount }} 台超期必补电</b>
                <small> · 保持关机防饿死</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('legacy-wash')">
              <span class="wp-lb"><Icon name="spark" />历史库存阻塞清零</span>
              <span class="wp-val">
                <b :class="legacyBlockedRedCount ? 'red-txt' : ''">{{ legacyBlockedRedCount }} 件红灯卡售</b>
                <small> · 当日必清</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('orders')">
              <span class="wp-lb"><Icon name="inbox" />订单抓取与聚合</span>
              <span class="wp-val">
                <b :class="wmsOrderUrgentCount ? 'red-txt' : ''">{{ wmsOrderUrgentCount }} 待处理</b>
                <small> · 可合单 {{ wmsMergeableCount }} 单</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('asn')">
              <span class="wp-lb"><Icon name="inbound" />到货签收与上架</span>
              <span class="wp-val">
                <b>待签 {{ wmsWaitSignCount }}</b>
                <small> · 待上架 {{ wmsWaitPutawayCount }} 件</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('locations')">
              <span class="wp-lb"><Icon name="pin" />库位·LPN·WIP暂借</span>
              <span class="wp-val">
                <b>空余 {{ wmsFreeSellBins }} 格</b>
                <small> · 暂借 {{ activeWipCount }} 件</small>
              </span>
            </button>
            <button class="wms-pulse-row" @click="go('stocktake')">
              <span class="wp-lb"><Icon name="layers" />循环盲盘与总账</span>
              <span class="wp-val">
                <b>{{ (store.data.skus || []).length }} 件在库</b>
                <small> · 微盘 {{ (store.data.blindCycleSessions || []).length }} 批</small>
              </span>
            </button>
          </div>
        </section>

        <section v-if="collab && collab.state !== 'taken'" data-tour="today-collab" class="card collab-card" :class="collab.state">
          <div class="cl-top">
            <span class="tag" :class="collab.state === 'open' ? 'amb' : 'red'">协同请求</span><Q k="d-collab" />
            <span class="muted" style="font-size:12px">{{ collab.from }}</span>
          </div>
          <h4 class="cl-ttl">{{ collab.title }}</h4>
          <p v-if="collab.state === 'open'" class="cd"><b>{{ collab.left }}</b> 秒内没人接，自动转给在岗同事 {{ collab.peer }}</p>
          <p v-else-if="collab.state === 'peer'" class="cd"><b>{{ collab.left }}</b> 秒内没人接，转主管。已转给 {{ collab.peer }}</p>
          <p v-else class="cd red-txt">两轮 60 秒都没人接，已经升级弹给仓管主管周卫东。</p>
          <div class="cl-acts">
            <Lock :ok="!locked" reason="先去「学」做完 3 个练习" @go="takeCollab">我来接</Lock>
            <button class="btn sm" @click="resetCollab">演示：重新计时</button>
          </div>
        </section>

        <section v-else-if="collab && collab.state === 'taken'" class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span class="tag grn">✓ 协同已接单</span>
            <button class="btn sm" @click="resetCollab">再演示一次</button>
          </div>
          <p class="muted" style="font-size:13px;margin-top:8px">{{ collab.takenBy }} 已接下接待台补拍特写请求，拍完自动回传陈小满会话窗。</p>
        </section>

        <section v-if="urgentAnomaly" class="card radar-card">
          <div class="pk-h">
            <h3>10分钟实物异常首报<Q k="anomaly" /></h3>
            <span class="tag red">倒计时 {{ fmtSec(urgentAnomaly.remainingSec) }}</span>
          </div>
          <p style="font-size:13.5px;font-weight:650;margin:6px 0 4px">{{ urgentAnomaly.title }}</p>
          <p class="muted" style="font-size:12.5px">首次发现 {{ urgentAnomaly.firstFoundAt.slice(11) }}（重试催办绝不重置时钟）· 待采购 {{ urgentAnomaly.purchaser }} 传首轮凭证</p>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn sm pri" @click="go('anomaly', urgentAnomaly.id)">去盯货钱双轨 ›</button>
          </div>
        </section>

        <section class="card">
          <div class="pk-h">
            <h3>历史库存阻塞与缺图清洗<Q k="legacy-wash" /></h3>
            <span class="tag" :class="legacyBlockedRedCount === 0 ? 'grn' : 'red'">{{ legacyBlockedRedCount === 0 ? '今日阻塞已清零' : '红灯阻塞 ' + legacyBlockedRedCount + ' 件' }}</span>
          </div>
          <div class="bar" style="margin:10px 0 8px"><i :style="{ width: mediaDonePct + '%', background: legacyBlockedRedCount === 0 ? 'var(--grn)' : 'var(--acc)' }"></i></div>
          <p class="muted" style="font-size:12.5px">缺爱回收全检、缺完整视频、缺本机实拍图、缺子母码均会卡死客服售前（不设每日上限，当日清完）；满 28 天滞销 {{ over28Count }} 件。</p>
          <div style="margin-top:8px">
            <button class="btn sm pri" @click="go('legacy-wash')">进入历史阻塞清洗 Gallery ›</button>
          </div>
        </section>

        <section class="card">
          <p class="muted" style="font-size:12.5px">今日履约与防呆达成<Q k="today" /></p>
          <p style="font-size:28px;font-weight:800;margin:4px 0">{{ doneTaskCount }} / {{ store.data.tasks.length }} <small style="font-size:13px;font-weight:500;color:var(--mute)">单已闭环</small></p>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">
            <span class="tag grn">防呆零串件</span>
            <span class="tag acc">17:00 顺丰待发 {{ pendingShipCount }} 单</span>
          </div>
          <p class="muted" style="font-size:12px">只显示团队整体履约进度，不搞公开个人排名。</p>
        </section>
      </aside>

      <!-- 左主栏（queue）：业务员看我的红黄任务；主管看全队红灯 + 自动派图 + 进度 + 加派 + 新情况 + 开发需求 -->
      <div class="today-queue">
        <!-- 业务员视角 -->
        <section v-if="!isSupervisor" class="grp" data-tour="today-list">
          <h2 class="queue-title">待办任务</h2>

          <div v-show="filter !== 'amb'" class="queue-section">
            <h2><i class="dot red"></i>要处理<em>{{ reds.length }}</em><Q k="d-list" /></h2>
            <div v-for="t in reds" :key="t.id">
              <TaskRow :t="t" :locked="locked" @go="runTask(t)" />
              <AssignedFlow :task="t" :locked="locked" />
            </div>
            <p v-if="locked" class="empty-line">先去左侧「学」做完 3 个防呆练习，真实任务就会解锁。</p>
            <p v-else-if="!reds.length" class="empty-line">太好了，你手头现在没有红灯急单。</p>
          </div>

          <div v-show="filter !== 'red'" class="queue-section">
            <h2><i class="dot amb"></i>注意<em>{{ ambs.length }}</em></h2>
            <div v-for="t in ambs" :key="t.id">
              <TaskRow :t="t" :locked="locked" @go="runTask(t)" />
              <AssignedFlow :task="t" :locked="locked" />
            </div>
            <p v-if="!ambs.length" class="empty-line">当前没有黄灯提醒事项。</p>
          </div>
        </section>

        <!-- 主管视角 -->
        <section v-else class="grp" data-tour="today-list">
          <h2 style="display:flex;align-items:center;gap:8px;font-size:16px;margin-bottom:12px">
            <i class="dot red"></i>全队红灯与待办清单<em>{{ activeTeamTasks.length }}</em><Q k="d-list" />
          </h2>
          <div v-for="t in activeTeamTasks" :key="t.id" class="sup-row">
            <TaskRow :t="t" :locked="false" @go="runTask(t)" />
            <AssignedFlow :task="t" :locked="false" />
            <div class="re-bar">
              <span class="muted">
                {{ isImgTask(t) ? '系统自动派给 ' : '当前负责人：' }}<b>{{ t.assigneeName }}</b>
              </span>
              <template v-if="!isImgTask(t) || swapOpen[t.id]">
                <select v-model="reassignTarget[t.id]">
                  <option v-for="w in WORKERS" :key="w.id" :value="w.id">{{ w.name }}（{{ w.shift.split(' · ')[1] || '仓管' }}）</option>
                </select>
                <button class="btn sm" @click="openReassign(t)">{{ isImgTask(t) ? '确认例外换人' : '改派（填三要素）' }}</button>
              </template>
              <button v-else class="btn sm ghost" @click="swapOpen[t.id] = true">换人（请假等例外）</button>
            </div>
          </div>

          <div class="sup-grid">
            <div class="card">
              <h3>图片任务自动派发<Q k="d-imgtask" /> <small>缺实拍/缺库位归仓管，不设每日上限</small></h3>
              <div v-for="w in WORKERS" :key="w.id" class="who-row">
                <b>{{ w.name }}</b>
                <span class="muted">待补图 {{ mediaCountOf(w.id) }} 件</span>
                <div class="bar"><i :style="{ width: Math.min(100, mediaCountOf(w.id) * 40) + '%', background: 'var(--acc)' }"></i></div>
              </div>
              <p class="muted" style="font-size:12.5px;margin-top:8px">
                规矩：缺本件实拍图、缺库位图 → 系统自动按库龄长短派给在岗仓管，主管不用手动分；只有员工请假等例外才点上方「换人」。上架展示图由销售核对。
              </p>
            </div>

            <div class="card">
              <h3>每个人今天的进度<Q k="d-progress" /></h3>
              <div v-for="w in WORKERS" :key="w.id" class="who-row">
                <b>{{ w.name }}</b>
                <span class="muted">红 {{ workerCount(w.id, 'red') }} · 黄 {{ workerCount(w.id, 'amb') }}</span>
                <div class="bar"><i :style="{ width: workerDonePct(w.id) + '%', background: 'var(--grn)' }"></i></div>
              </div>
              <p class="muted" style="font-size:12.5px;margin-top:8px">改派必须填清「已做 / 未完成 / 下一步」，原经办人自动失权，避免两人撞单。</p>
            </div>
          </div>

          <div class="card" style="margin-top:16px">
            <h3>加派任务<Q k="d-assign" /> <small>软件里立项留痕，后续可接钉钉 TB 提醒</small></h3>
            <div class="assign-form">
              <input v-model="newTask.title" placeholder="任务要求，例如：把 A 区飞利浦显示器附件袋编号复查一遍" />
              <input v-model="newTask.skuCode" placeholder="关联货号/库区（如 513211540026 或 A区）" />
              <input v-model="newTask.deadline" placeholder="交付时间，例如 今日 18:00" />
              <select v-model="newTask.assigneeId">
                <option v-for="w in WORKERS" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
              <input v-model="newTask.scope" class="wide" placeholder="交付范围与合格标准：例如 每袋拍清外贴纸，账实一致率 100%" />
              <button class="btn pri" @click="doAssign">派出去</button>
            </div>
          </div>

          <div class="card" style="margin-top:16px">
            <h3>员工上报的「没见过的情况」<Q k="d-exc" /></h3>
            <p v-if="!store.data.exceptions?.length" class="muted">暂时没有新上报的边界情况。</p>
            <div v-for="e in store.data.exceptions" :key="e.id" class="exc-row">
              <span class="tag" :class="e.ruled ? 'grn' : 'red'">{{ e.ruled ? '已记规则' : '新情况' }}</span>
              <div class="exc-mid"><b>{{ e.who }}</b> <span class="muted">{{ e.t }}</span><br />{{ e.text }}</div>
              <button v-if="!e.ruled" class="btn sm pri" @click="ruleException(e)">记成规则</button>
              <span v-else class="tag grn">已写入说明书规则草案</span>
            </div>
          </div>
        </section>

        <!-- 提给开发的需求（全员可见本人/主管可见全部，谁提谁验收） -->
        <section v-if="shownDevs.length" class="card">
          <h3>{{ isSupervisor ? '员工提给开发的需求' : '我提给开发的需求' }}<Q k="d-dev" /> <small>谁提的谁验收，不私发程序员；正式环境一条对应禅道一条</small></h3>
          <div v-for="r in shownDevs" :key="r.id" class="exc-row">
            <span class="tag" :class="r.kind === 'bug' ? 'red' : 'acc'">{{ r.kind === 'bug' ? '软件问题' : '想要新功能' }}</span>
            <div class="exc-mid">
              <b>{{ r.id }} · {{ r.title }}</b>
              <span class="muted"> · {{ r.who }} · {{ r.t }}<template v-if="r.page"> · {{ r.page }}</template></span>
              <br />{{ r.text }}
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <span class="tag" :class="r.status === '已验收' ? 'grn' : r.status === '打回重改' ? 'red' : 'amb'">{{ r.status }}</span>
              <button v-if="isSupervisor && r.status === '待评审'" class="btn sm" @click="advanceDevRequest(r, '开发中')">评审通过 · 转开发</button>
              <button v-if="isSupervisor && r.status === '开发中'" class="btn sm" @click="advanceDevRequest(r, '待提需求的人验收')">开发好了 · 请他验收</button>
              <template v-if="(r.by === currentUser.id || isSupervisor) && r.status === '待提需求的人验收'">
                <button class="btn sm ok" @click="advanceDevRequest(r, '已验收')">验收通过</button>
                <button class="btn sm" @click="advanceDevRequest(r, '打回重改')">打回重改</button>
              </template>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 主管改派三要素弹窗 -->
    <div v-if="handoff" class="mask" @click.self="handoff = null">
      <div class="modal big" role="dialog" aria-label="任务转交三要素">
        <h3>改派给 {{ workerName(handoff.toId) }}</h3>
        <p class="muted">{{ handoff.task.title }}（改派后原负责人 {{ handoff.task.assigneeName }} 自动失权）</p>
        <label>已完成内容（必填）<input v-model.trim="handoff.donePart" placeholder="例如：已完成拆封录像与前 6 项外观屏幕检测" /></label>
        <label>未完成内容（必填）<input v-model.trim="handoff.todoPart" placeholder="例如：P07–P10 摄像头与尾插功率尚未实测" /></label>
        <label>下一步动作（必填）<input v-model.trim="handoff.nextStep" placeholder="例如：接手后测完剩余 4 项并拍库位图入 C-01 隔离格" /></label>
        <div class="mfoot">
          <button class="btn" @click="handoff = null">取消</button>
          <Lock
            :ok="Boolean(handoff.donePart && handoff.todoPart && handoff.nextStep)"
            reason="改派防呆：必须把「已完成、未完成、下一步」三项都写清楚，接手同事才能无缝往下做"
            @go="confirmHandoff"
          >确认改派交接</Lock>
        </div>
      </div>
    </div>

    <!-- 遇到没见过的情况 -->
    <div v-if="excOpen" class="mask" @click.self="excOpen = false">
      <div class="modal">
        <h3>遇到没见过的情况</h3>
        <p class="muted">用大白话写一句发生了什么。仓管主管会立刻在清单里看到，处理完会记成大家都看得到的规则。</p>
        <textarea v-model="excText" placeholder="例如：卖家寄来的显示器里塞了一张手写纸条说底座明天补寄，现在算缺件异常还是先入待补测？"></textarea>
        <div class="mfoot">
          <button class="btn" @click="excOpen = false">取消</button>
          <button class="btn pri" @click="sendExc">发给主管</button>
        </div>
      </div>
    </div>

    <!-- 提给开发 -->
    <div v-if="devOpen" class="mask" @click.self="devOpen = false">
      <div class="modal big">
        <h3>提给开发</h3>
        <p class="muted"><b>不要私发给程序员</b>：私下发的需求没人评审、容易改错。在这里提，对应禅道工单，<b>谁提的谁验收</b>。</p>
        <div style="display:flex;gap:16px">
          <label class="ck"><input type="radio" value="bug" v-model="dv.kind" />软件问题（用着不对）</label>
          <label class="ck"><input type="radio" value="feature" v-model="dv.kind" />想要新功能</label>
        </div>
        <label>标题<input v-model="dv.title" placeholder="哪一页的什么事，例如：出库扫码框希望能回车直接触发校验" /></label>
        <label>所在页面（选填）<input v-model="dv.page" placeholder="例如：出库与退回" /></label>
        <label>具体说明<textarea v-model="dv.text" placeholder="你在做什么、看到了什么、希望变成什么，不用写技术词。"></textarea></label>
        <div class="mfoot">
          <button class="btn" @click="devOpen = false">取消</button>
          <button class="btn pri" @click="sendDev">提交需求</button>
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
import TaskRow from '../components/TaskRow.vue'
import AssignedFlow from '../components/AssignedFlow.vue'
import {
  store,
  ACCOUNTS,
  currentUser,
  isSupervisor,
  go,
  openHelp,
  notify,
  bootstrapBackend,
  takeCollab,
  resetCollab,
  submitException,
  ruleException,
  submitDevRequest,
  advanceDevRequest,
  reassignTaskBySupervisor,
  createSupervisorTask,
  swapMediaTaskOwner,
  skuPreSalesGates,
  skuBatteryStatus
} from '../store/warehouseStore.js'

const WORKERS = ACCOUNTS.filter(a => a.role === 'WAREHOUSE' || a.role === 'SUPERVISOR')
const filter = ref('all')
const locked = computed(() => !currentUser.value.practiceDone)
const collab = computed(() => store.data.collab)
const legacyBlockedRedCount = computed(() => (store.data.skus || []).filter(s => skuPreSalesGates(s).lvl === 'red').length)
const activeWipCount = computed(() => (store.data.wipBorrows || []).filter(b => b.status === 'BORROWED').length)
const courierRecallPending = computed(() => (store.data.courierCoord?.urgentRecalls || []).filter(r => r.status !== 'RECALLED_SAFE').length)
const courierEodPending = computed(() => (store.data.courierCoord?.eodItems || []).filter(i => i.decision === 'PENDING').length)
const overdueBatCount = computed(() => (store.data.skus || []).filter(s => {
  const st = skuBatteryStatus(s)
  return st.applicable && !st.isSealed && st.lvl === 'red'
}).length)

const mineList = computed(() =>
  store.data.tasks.filter(t => t.status !== '已验收' && (isSupervisor.value || t.assignee === currentUser.value.id))
)
const reds = computed(() => mineList.value.filter(t => t.urgency === 'red'))
const ambs = computed(() => mineList.value.filter(t => t.urgency !== 'red'))
const allReds = computed(() => store.data.tasks.filter(t => t.status !== '已验收' && t.urgency === 'red'))
const activeTeamTasks = computed(() => store.data.tasks.filter(t => t.status !== '已验收'))

const urgentAnomaly = computed(() => store.data.anomalies.find(a => a.type === 'GOODS_DIFF' && !a.tracks.purchaserProof.done))
const pendingMediaCount = computed(() => store.data.mediaTasks.filter(m => !m.done).length)
const mediaDonePct = computed(() => {
  const total = store.data.mediaTasks.length || 1
  const done = store.data.mediaTasks.filter(m => m.done).length
  return Math.round((done / total) * 100)
})
const over28Count = computed(() => store.data.skus.filter(s => s.ageDays >= 28).length)
const doneTaskCount = computed(() => store.data.tasks.filter(t => t.status === '已验收').length)
const pendingShipCount = computed(() => store.data.outbounds.filter(o => o.status !== 'SHIPPED').length)

const wmsOrderUrgentCount = computed(() =>
  (store.data.salesOrderPool || []).filter(o =>
    o.aggState !== 'MERGED_CHILD' && (
      ['CAPTURE_MISSED', 'UNMATCHED_SKU', 'HOLD_INTERCEPT'].includes(o.aggState) ||
      Boolean(o.syncError)
    )
  ).length
)
const wmsMergeableCount = computed(() =>
  (store.data.salesOrderPool || []).filter(o => o.aggState === 'MERGEABLE').length
)
const wmsWaitSignCount = computed(() =>
  (store.data.inboundAsns || []).filter(a => a.status === 'IN_TRANSIT' || a.status === 'UNCLAIMED_HOLD').length
)
const wmsWaitPutawayCount = computed(() =>
  (store.data.inboundAsns || []).filter(a => a.status === 'INSPECTED_WAIT_PUTAWAY').length
)
const wmsFreeSellBins = computed(() => {
  const occupiedCodes = new Set((store.data.skus || []).map(s => s.location))
  return (store.data.locations || []).filter(b => b.enabled && (b.zone === 'A区' || b.zone === 'B区') && !occupiedCodes.has(b.code)).length
})

const shownDevs = computed(() => {
  const all = store.data.devRequests || []
  return isSupervisor.value ? all : all.filter(r => r.by === currentUser.value.id || r.status === '待提需求的人验收')
})

function fmtSec(sec) {
  const m = String(Math.floor((sec || 0) / 60)).padStart(2, '0')
  const s = String((sec || 0) % 60).padStart(2, '0')
  return `${m}:${s}`
}

function runTask(t) {
  if (locked.value) {
    notify('真实任务先锁着：请先点左侧「学」完成 3 个防呆练习', 'err')
    return
  }
  go(t.route || 'today', t.targetId || '')
}

const isImgTask = (t) => t.category.includes('图片')
const swapOpen = reactive({})
const reassignTarget = reactive(Object.fromEntries(store.data.tasks.map(t => [t.id, t.assignee === 'linqg' ? 'zhaojg' : 'linqg'])))
const handoff = ref(null)

function workerName(id) {
  return ACCOUNTS.find(a => a.id === id)?.name || id
}
function mediaCountOf(uid) {
  return store.data.mediaTasks.filter(m => !m.done && m.assignee === uid).length
}
function workerCount(uid, lvl) {
  return store.data.tasks.filter(t => t.status !== '已验收' && t.assignee === uid && (lvl === 'red' ? t.urgency === 'red' : t.urgency !== 'red')).length
}
function workerDonePct(uid) {
  const active = store.data.tasks.filter(t => t.status !== '已验收' && t.assignee === uid).length
  return Math.max(15, 100 - active * 18)
}

function openReassign(t) {
  const toId = reassignTarget[t.id] || 'zhaojg'
  if (isImgTask(t)) {
    const mt = store.data.mediaTasks.find(m => m.skuCode === t.skuCode)
    if (mt) swapMediaTaskOwner(mt.id, toId)
    swapOpen[t.id] = false
    return
  }
  handoff.value = { task: t, toId, donePart: '', todoPart: '', nextStep: '' }
}

function confirmHandoff() {
  if (!handoff.value) return
  reassignTaskBySupervisor(handoff.value.task.id, handoff.value)
  handoff.value = null
}

const newTask = reactive({ title: '', skuCode: '', deadline: '今日 18:00 前', assigneeId: 'linqg', scope: '' })
function doAssign() {
  createSupervisorTask(newTask)
  newTask.title = ''
  newTask.skuCode = ''
  newTask.scope = ''
}

const excOpen = ref(false)
const excText = ref('')
function sendExc() {
  submitException(excText.value)
  excText.value = ''
  excOpen.value = false
}

const devOpen = ref(false)
const dv = reactive({ kind: 'feature', title: '', page: '', text: '' })
function sendDev() {
  submitDevRequest(dv)
  dv.title = ''
  dv.page = ''
  dv.text = ''
  devOpen.value = false
}
</script>

<style scoped>
.collab-card { border-left: 4px solid var(--amb); }
.wms-pulse-card { border-left: 4px solid var(--acc); }
.wms-pulse-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.wms-pulse-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.wms-pulse-row:hover {
  border-color: var(--acc);
  background: var(--acc-soft);
}
.wp-lb { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; color: var(--ink); }
.wp-val { font-size: 12px; color: var(--mute); }
.wp-val b { color: var(--ink); font-weight: 700; }
.collab-card.peer, .collab-card.escalated { border-left-color: var(--red); background: #fffafa; }
.cl-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cl-ttl { font-size: 14px; line-height: 1.45; margin: 8px 0 6px; font-weight: 680; }
.cd { font-size: 12.5px; color: var(--amb-ink); margin-bottom: 10px; }
.cd b { font-size: 16px; color: var(--red); }
.red-txt { color: var(--red-ink); font-weight: 650; }
.cl-acts { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }

.radar-card { border-left: 4px solid var(--red); }
.pk-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.pk-h h3 { font-size: 15px; font-weight: 700; display: flex; align-items: center; }

.empty-line { color: var(--mute); font-size: 13.5px; padding: 14px 4px; }
.sup-row { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px dashed var(--line); }
.re-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.re-bar select { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }

.sup-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
.who-row { display: grid; grid-template-columns: 72px auto 1fr; align-items: center; gap: 10px; font-size: 13px; padding: 6px 0; }
.assign-form { display: grid; grid-template-columns: 1.4fr 1fr .9fr .8fr; gap: 8px; align-items: center; }
.assign-form input, .assign-form select { padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); font-size: 13px; }
.assign-form .wide { grid-column: 1 / 4; }

.exc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
}
.exc-mid { flex: 1; min-width: 0; line-height: 1.5; }
</style>
