<!--
  爬虫开关：两个爬虫分别在哪台电脑上跑。

  一个账号可以在多台电脑上登录，而同一个爬虫同时只能有一台在跑——两台一起跑会
  去抢同一批浏览器环境、重复采集、重复写库。所以这页显示的不是"本机开没开"，
  而是"全公司现在归谁"，判归属的是服务端。

  这页只有管理员看得到（menu.js 里 roles: ['ADMIN']）。
-->
<template>
  <div class="crawlers page">
    <div class="head">
      <div>
        <h2>爬虫开关</h2>
        <p class="sub">同一个爬虫同时只能有一台电脑在跑。这里是全公司的现状，不是本机设置。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert v-if="error" :title="error" type="warning" show-icon :closable="false" class="alert" />

    <div class="page-head">
    <div class="cards">
      <section v-for="lease in leases" :key="lease.feature" class="card" :class="{ off: !lease.available }">
        <div class="card-top">
          <div>
            <div class="name">{{ lease.label }}</div>
            <div class="where">
              <template v-if="!lease.available">这个爬虫还没接入，开不了</template>
              <template v-else-if="lease.held">
                正在 <b>{{ lease.device_name || lease.device_id }}</b> 上跑
                <span v-if="lease.staff_name">· {{ lease.staff_name }} 开的</span>
              </template>
              <template v-else>没有电脑在跑</template>
            </div>
            <div v-if="lease.handoff_to" class="handoff">
              已请求转给 {{ lease.handoff_to_name || lease.handoff_to }}，等这一轮采集跑完自动交接
            </div>
          </div>
          <el-switch
            :model-value="lease.mine"
            :disabled="!lease.available || busy === lease.feature || (lease.held && !lease.mine)"
            :loading="busy === lease.feature"
            @change="(on) => toggle(lease, on)"
          />
        </div>

        <div v-if="lease.available" class="card-foot">
          <template v-if="lease.held && !lease.mine">
            <span class="hint">它不在这台电脑上。要挪过来：</span>
            <el-button size="small" :loading="busy === lease.feature" @click="transfer(lease, me.deviceId)">
              转到本机
            </el-button>
          </template>
          <template v-else-if="lease.held && lease.mine">
            <span class="hint">归本机。要挪到别处：</span>
            <el-select
              v-model="target[lease.feature]"
              size="small"
              placeholder="选一台电脑"
              style="width: 190px"
              @change="(id) => id && transfer(lease, id)"
            >
              <el-option
                v-for="d in otherDevices"
                :key="d.id"
                :value="d.id"
                :label="`${d.name}${d.online ? '' : '（离线）'}`"
                :disabled="!d.online"
              />
            </el-select>
          </template>
          <span v-else class="hint">打开右上角的开关，就由这台电脑来跑。</span>
          <!-- 「跑一轮」只对行情爬虫有意义：图片爬虫还没接入，没有可派的活 -->
          <el-button
            v-if="lease.feature === 'market' && lease.held"
            size="small" type="primary" plain :loading="runningNow" @click="runNow"
          >跑一轮</el-button>
        </div>
      </section>
    </div>

    </div>

    <!-- 两张表放标签里，不上下堆：堆起来这页又会长到要滚，而那正是刚治过的毛病。
         开关卡片留在页头永远看得见——人来这页十有八九是为了开关，不是为了看表。 -->
    <div class="page-body">
    <el-tabs v-model="tab" class="page-tabs">
      <el-tab-pane name="runs">
        <template #label>最近几轮采集</template>
        <p class="lead">采集在电脑上跑，这里只记「谁跑的、跑得怎么样」。</p>
      <el-table :data="runs" size="small" border empty-text="还没有跑过">
        <el-table-column label="状态" width="104">
          <template #default="{ row }">
            <el-tag size="small" :type="runType(row.status)" effect="plain">{{ runLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="在哪台" min-width="150">
          <template #default="{ row }">
            {{ row.device_name || row.device_id || '—' }}
            <el-tag v-if="row.offline_started" size="small" type="info" effect="plain" class="tag">离线起的</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="怎么触发的" width="120">
          <template #default="{ row }">
            {{ row.trigger === 'manual' ? '有人点的' : '到点自动' }}
            <div v-if="row.staff_name" class="sub">{{ row.staff_name }}</div>
          </template>
        </el-table-column>
        <el-table-column label="结果" min-width="210">
          <template #default="{ row }">
            <template v-if="row.status === 'SUCCESS' || row.status === 'FAILED'">
              <span class="ok">{{ row.success }}/{{ row.total }}</span>
              <!-- 风控单独拎出来红着：它不是「失败多少条」的一部分，
                   它意味着账号正在被盯上，该停手等冷却而不是重试。 -->
              <el-tag v-if="row.risk_control" size="small" type="danger" effect="dark" class="tag">
                风控 {{ row.risk_control }}
              </el-tag>
              <span v-if="row.empty" class="why">搜不到 {{ row.empty }}</span>
              <span v-if="row.invalid_price" class="why">价格读不出 {{ row.invalid_price }}</span>
              <span v-if="failedOther(row)" class="why">其它失败 {{ failedOther(row) }}</span>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="用时" width="90">
          <template #default="{ row }"><span class="muted">{{ elapsed(row) }}</span></template>
        </el-table-column>
        <el-table-column label="开始时间" width="170">
          <template #default="{ row }">{{ formatTime(row.started_at || row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="130">
          <template #default="{ row }"><span class="reason">{{ row.reason || '' }}</span></template>
        </el-table-column>
        <el-table-column label="现场" width="132">
          <template #default="{ row }">
            <!-- 快照默认不传：整页 DOM，一轮最多十几份，绝大多数永远没人看。
                 出了事才取，取回来是个限时下载地址。 -->
            <el-link v-if="row.snapshot?.download_url" type="primary" :href="row.snapshot.download_url" target="_blank">
              下载（{{ mb(row.snapshot.bytes) }}）
            </el-link>
            <el-tooltip v-else-if="row.snapshot?.status === 'CANCELLED'" placement="top" :content="row.snapshot.reason || '取不到'">
              <span class="muted">取不到</span>
            </el-tooltip>
            <span v-else-if="row.snapshot?.status === 'PENDING'" class="why">等那台电脑上线</span>
            <el-button v-else link type="primary" :loading="snapBusy === row.id" @click="fetchSnapshot(row)">取回现场</el-button>
          </template>
        </el-table-column>
      </el-table>
      </el-tab-pane>

      <el-tab-pane name="pcs">
        <template #label>登录过的电脑</template>
        <p class="lead">{{ ttlText }}</p>
      <el-table :data="devices" size="small" border>
        <el-table-column label="电脑" min-width="200">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <el-tag v-if="row.id === me.deviceId" size="small" type="success" effect="plain" class="tag">本机</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.online ? 'success' : 'info'" effect="plain">
              {{ row.online ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近使用的人" width="140">
          <template #default="{ row }">{{ row.last_staff_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="最近一次心跳" width="180">
          <template #default="{ row }">{{ formatTime(row.last_seen_at) }}</template>
        </el-table-column>
        <el-table-column label="挂了几个浏览器环境" width="160">
          <template #default="{ row }">
            <span v-if="row.ads_env_count" class="envs">{{ row.ads_env_count }} 个</span>
            <el-tooltip v-else placement="top" content="这台电脑的本机代理没起，或者还没建过环境——不是「一个都没有」，是这一拍问不到">
              <span class="muted">—</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="系统" min-width="150">
          <template #default="{ row }"><span class="muted">{{ row.os || '—' }}</span></template>
        </el-table-column>
      </el-table>

      <div class="rename">
        <span class="hint">本机在这张表里叫</span>
        <el-input v-model="pcName" size="small" maxlength="64" style="width: 220px" @keyup.enter="rename" />
        <el-button size="small" @click="rename">改名</el-button>
      </div>
      </el-tab-pane>
    </el-tabs>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const busy = ref('')
const error = ref('')
const leases = ref([])
const devices = ref([])
const ttlSec = ref(90)
const me = ref({ deviceId: '', deviceName: '' })
const pcName = ref('')
const target = reactive({})
const runs = ref([])
const runningNow = ref(false)
const tab = ref('runs')
const snapBusy = ref('')
let stopWatch = null

const otherDevices = computed(() => devices.value.filter((d) => d.id !== me.value.deviceId))
const ttlText = computed(() => `超过 ${ttlSec.value} 秒没有心跳就算离线，爬虫会自动让给别的电脑`)

function formatTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [state, res] = await Promise.all([
      window.erp.getCrawlerState(),
      window.erp.listCrawlerLeases()
    ])
    // 主进程回 {ok, data|reason}：reason 是已经翻成人话的那句（谁被拒、该换什么账号），
    // 原样端上来，不要在这里改写成"读不到爬虫现状"——那等于把刚说清楚的话又抹掉。
    if (!res?.ok) throw new Error(res?.reason || '读不到爬虫现状')
    const data = res.data
    me.value = { deviceId: state?.deviceId || '', deviceName: state?.deviceName || '' }
    if (!pcName.value) pcName.value = state?.deviceName || ''
    ttlSec.value = Number(data?.ttl_sec) || 90
    devices.value = Array.isArray(data?.devices) ? data.devices : []
    // 服务端不知道"本机"是哪台，mine 在这里补：它决定开关的开合状态
    await loadRuns()
    leases.value = (Array.isArray(data?.leases) ? data.leases : []).map((l) => ({
      ...l,
      mine: Boolean(l.held && l.device_id && l.device_id === me.value.deviceId)
    }))
  } catch (e) {
    error.value = e?.message || '读不到爬虫现状'
  } finally {
    loading.value = false
  }
}

async function toggle(lease, on) {
  busy.value = lease.feature
  try {
    const res = await window.erp.setCrawler(lease.feature, on)
    if (!res?.ok) return ElMessage.warning(res?.reason || '操作失败')
    ElMessage.success(on ? `${lease.label}已由本机接管` : `${lease.label}已停`)
    await load()
  } finally {
    busy.value = ''
  }
}

async function transfer(lease, toDeviceId) {
  if (!toDeviceId) return
  const name = devices.value.find((d) => d.id === toDeviceId)?.name || toDeviceId
  try {
    await ElMessageBox.confirm(
      `把${lease.label}转给「${name}」。正在跑的这一轮不会被打断——等它跑完才交接。`,
      '转移爬虫',
      { type: 'warning', confirmButtonText: '转移' }
    )
  } catch {
    target[lease.feature] = ''
    return
  }
  busy.value = lease.feature
  try {
    const res = await window.erp.transferCrawler(lease.feature, toDeviceId)
    if (!res?.ok) return ElMessage.warning(res?.reason || '转移失败')
    ElMessage.success(res.lease?.handoff_to ? '已排队，等当前这轮跑完自动交接' : `已转给${name}`)
    target[lease.feature] = ''
    await load()
  } finally {
    busy.value = ''
  }
}

/** 没归入三类的那部分失败。全归类了就不显示，免得一行里堆四个数。 */
function failedOther(row) {
  return Math.max(0, (row.failed || 0) - (row.empty || 0) - (row.invalid_price || 0) - (row.risk_control || 0))
}

function runLabel(v) {
  return { PENDING: '等认领', RUNNING: '跑着呢', SUCCESS: '跑完了', FAILED: '失败' }[v] || v
}
function runType(v) {
  return { SUCCESS: 'success', FAILED: 'danger', RUNNING: 'warning' }[v] || 'info'
}

/** 用时。没跑完就按「到现在」算——一轮几十分钟，跑着的时候人最想知道的就是这个。 */
function elapsed(row) {
  const from = row.started_at && new Date(row.started_at)
  if (!from || Number.isNaN(from.getTime())) return '—'
  const to = row.finished_at ? new Date(row.finished_at) : new Date()
  const sec = Math.max(0, Math.round((to - from) / 1000))
  if (sec < 60) return `${sec} 秒`
  return `${Math.floor(sec / 60)} 分${sec % 60 ? ` ${sec % 60} 秒` : ''}`
}

function mb(bytes) {
  const n = Number(bytes) || 0
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

async function loadRuns() {
  const data = await window.erp.getCrawlRuns(20)
  runs.value = Array.isArray(data?.runs) ? data.runs : []
}

async function fetchSnapshot(row) {
  snapBusy.value = row.id
  try {
    const res = await window.erp.fetchRunSnapshot(row.id)
    if (!res?.ok) return ElMessage.warning(res?.reason || '取回失败')
    // 不是「马上就有」：那台电脑得先收到这条待办。在线的话下一拍心跳就传，
    // 不在线就等它下次开机——所以提示要说清楚在等什么。
    row.snapshot = res.req
    ElMessage.success(res.req?.download_url ? '现场已在服务端，点下载' : '已通知那台电脑回传，它在线的话下一拍心跳就传')
  } finally {
    snapBusy.value = ''
  }
}

async function runNow() {
  runningNow.value = true
  try {
    const res = await window.erp.runCrawlNow()
    if (!res?.ok) return ElMessage.warning(res?.reason || '发起失败')
    // 只登记，不在这里开跑——开跑由持有租约的那台电脑在下一拍心跳里认领后自己起。
    // 所以提示要说清楚「派出去了」，而不是「开始了」。
    ElMessage.success(`已派给「${res.run?.device_name || '持有爬虫的那台电脑'}」，它下一拍心跳就会开跑`)
    await loadRuns()
  } finally {
    runningNow.value = false
  }
}

async function rename() {
  const res = await window.erp.renameThisPc(pcName.value)
  if (!res?.ok) return ElMessage.warning('改名失败')
  ElMessage.success('改好了，下一次心跳后其它电脑也看得到')
  me.value = { ...me.value, deviceName: res.name }
}

onMounted(() => {
  load()
  // 心跳每 25 秒一拍，本机持有态跟着变；不另起一个轮询。
  stopWatch = window.erp.onCrawlerState?.(() => load())
})
onUnmounted(() => { stopWatch?.(); stopWatch = null })
</script>

<style scoped>
.crawlers { --ink: #21312b; --muted: #7c8983; --line: #e1e9e4; --paper: #fbfdfb; color: var(--ink); }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
h2 { margin: 0; font-size: 20px; font-weight: 700; }
.sub { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.alert { margin-bottom: 14px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--paper); padding: 18px 20px; }
.card.off { opacity: .68; }
.card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.name { font-size: 16px; font-weight: 650; }
.where { margin-top: 5px; color: #5f7268; font-size: 12.5px; line-height: 1.6; }
.where b { color: #2e6d4b; }
.handoff { margin-top: 6px; color: #a66d24; font-size: 12px; line-height: 1.55; }
.card-foot { display: flex; align-items: center; gap: 9px; margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.hint { color: var(--muted); font-size: 12px; }
.lead { margin: 0 0 12px; color: var(--muted); font-size: 12.5px; }
/* 标签内容自己滚，整页不滚 */
.crawlers :deep(.el-tab-pane) { display: flex; flex-direction: column; min-height: 0; height: 100%; overflow-y: auto; }
.pcs-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
h3 { margin: 0; font-size: 15px; font-weight: 650; }
.stamp { color: var(--muted); font-size: 11.5px; }
.tag { margin-left: 7px; }
.muted { color: #98a49e; }
.envs { color: #3c7e5b; font-weight: 600; font-variant-numeric: tabular-nums; }
.sub { margin-top: 2px; color: #98a49e; font-size: 11px; }
.ok { font-variant-numeric: tabular-nums; font-weight: 600; }
.why { margin-left: 7px; color: #a66d24; font-size: 11.5px; }
.reason { color: #a66d24; font-size: 11.5px; }
.rename { display: flex; align-items: center; gap: 9px; margin-top: 12px; }
</style>
