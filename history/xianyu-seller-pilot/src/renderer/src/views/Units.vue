<!--
  执行单元：一个闲鱼账号 + 它当前的执行端 + 今日配额 + 在跑任务。

  账号是主体，执行端只是它的一个属性——手机坏了换一台，账号不变。所以真机
  只列浏览器（browser，AdsPower）。真机归群控守护台，那边才有 adb。

  数据源是群控服务端已有的聚合接口 GET /gc/units。
  下发类操作（重试任务、改配额）仍在群控守护端，本页不重复实现——那部分依赖
  本机 adb 与 MQTT，属于群控宿主机的能力，不该搬到销售工位上。

  唯一的写操作是「解冻」：浏览器号命中风控（扫码认证、滑块）会被冻住、自动操作全停，
  人在浏览器窗口里处理完要有地方点一下放行。它只是改服务端一条账号记录，不碰 adb，
  而浏览器号又不归守护端管，所以放在这里（2026-10-06）。
-->
<template>
  <div class="units">
    <div class="bar">
      <div class="title"><b>设备与账号</b></div>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      <span class="stamp">{{ stamp }}</span>
    </div>

    <el-alert v-if="error" type="error" :closable="false" show-icon class="err">
      {{ error }}
    </el-alert>

    <el-table v-loading="loading" :data="rows" size="small" class="tbl" empty-text="没有执行单元">
      <el-table-column label="账号" min-width="170">
        <template #default="{ row }">
          <b>{{ row.nick || row.account_id }}</b>
          <div class="sub mono">{{ row.account_id }}</div>
        </template>
      </el-table-column>

      <el-table-column label="执行端" min-width="210">
        <template #default="{ row }">
          <template v-if="row.device">
            <el-tag size="small" :type="row.device.kind === 'browser' ? 'success' : 'warning'" effect="plain">
              {{ row.device.kind === 'browser' ? 'AdsPower' : '真机' }}
            </el-tag>
            <span class="name">{{ row.device.name || row.device.id }}</span>
            <el-button
              v-if="row.device.kind === 'browser'"
              size="small"
              plain
              class="upd"
              :loading="updating === row.device.id"
              @click="updateCode(row)"
            >更新</el-button>
            <div class="sub">
              {{ [row.device.brand, row.device.model, row.device.app_version].filter(Boolean).join(' · ') || '—' }}
            </div>
          </template>
          <el-tag v-else size="small" type="info" effect="plain">未绑定</el-tag>
        </template>
      </el-table-column>

      <el-table-column label="状态" min-width="140">
        <template #default="{ row }">
          <el-tag size="small" :type="riskType(row.risk_state)" effect="plain">{{ row.risk_state || row.status }}</el-tag>
          <div v-if="row.risk_note" class="sub risk">{{ row.risk_note }}</div>
          <div v-else-if="row.device?.blocking" class="sub risk">{{ row.device.blocking }}</div>
          <el-button
            v-if="frozen(row)"
            size="small"
            type="primary"
            plain
            class="thaw"
            :loading="thawing === row.account_id"
            @click="unfreeze(row)"
          >解冻</el-button>
        </template>
      </el-table-column>

      <el-table-column label="今日配额" min-width="210">
        <template #default="{ row }">
          <div v-for="(q, name) in row.quota" :key="name" class="quota">
            <span class="qname">{{ quotaLabel(name) }}</span>
            <el-progress
              :percentage="quotaPct(q)"
              :status="quotaPct(q) >= 100 ? 'exception' : undefined"
              :stroke-width="6"
              :show-text="false"
              class="qbar"
            />
            <span class="qnum mono">{{ q.used }}<template v-if="q.limit">/{{ q.limit }}</template></span>
          </div>
          <span v-if="!row.quota || !Object.keys(row.quota).length" class="sub">—</span>
        </template>
      </el-table-column>

      <el-table-column label="在跑任务" min-width="150">
        <template #default="{ row }">
          <template v-if="row.task">
            <span class="mono">{{ row.task.task_type }}</span>
            <div class="sub">{{ row.task.status }}</div>
          </template>
          <span v-else class="sub">空闲</span>
        </template>
      </el-table-column>

      <el-table-column label="最近活动" min-width="130">
        <template #default="{ row }">
          <span class="sub">{{ ago(row.last_op_at) }}</span>
        </template>
      </el-table-column>
    </el-table>

  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const rows = ref([])
const loading = ref(false)
const error = ref('')
// 这个应用只管 AdsPower 浏览器，真机（android）归群控守护台——那边才有 adb。
// 所以这里写死只取 browser，不再给一个"全部/真机"的筛选：一张表横跨两个应用，
// 谁都说不清哪些行该在这儿看、哪些行该去那儿管。
const kind = ref('browser')
const stamp = ref('')
const thawing = ref('')
const updating = ref('')
let timer = null

// limit=0 表示不限；此时进度条按 0 画，但 used 照实显示，不造一个假的百分比。
function quotaPct(q) {
  const limit = Number(q?.limit) || 0
  if (!limit) return 0
  return Math.min(100, Math.round((Number(q?.used) || 0) / limit * 100))
}

function quotaLabel(name) {
  return { publish: '上架', reprice: '改价', delist: '下架' }[name] || name
}

function riskType(state) {
  const s = String(state || '').toUpperCase()
  if (s.includes('OK') || s === 'NORMAL') return 'success'
  if (s.includes('RISK') || s.includes('BLOCK') || s.includes('FROZEN')) return 'danger'
  return 'info'
}

function ago(iso) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`
}

function frozen(row) {
  return row.status === 'FROZEN' || row.risk_state === 'FROZEN'
}

// 解冻后调度器马上会给它派任务，任务一来就接管浏览器窗口——人要是还在扫码，
// 页面会被跳走。所以先问一句。
async function unfreeze(row) {
  try {
    await ElMessageBox.confirm(
      `解冻「${row.nick || row.account_id}」？解冻后会接着给它派任务、接管浏览器窗口，先把窗口里的弹窗处理完。`,
      '解冻账号',
      { type: 'warning', confirmButtonText: '解冻', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  thawing.value = row.account_id
  try {
    await window.erp.gcUnfreeze(row.account_id)
    ElMessage.success('已解冻')
    await load()
  } catch (e) {
    ElMessage.error(String(e?.message || '解冻失败').replace(/^Error invoking remote method '[^']+': Error: /, ''))
  } finally {
    thawing.value = ''
  }
}

// 下发更新:执行端收到 cmd 后尽力下载新代码、退出进程,由 supervisor 拉起换新。
// 约 1 分钟期间该账号任务暂停(浏览器窗口不杀)。逐台人工点,不做全 fleet 批量——
// 避免所有工位同时重启(新代码有问题时全军覆没,灰度一台台来)。
async function updateCode(row) {
  const dev = row.device
  const label = `${row.nick || row.account_id} · ${dev.name || dev.id}`
  try {
    await ElMessageBox.confirm(
      `给「${label}」的执行端下发更新？执行端会立即下载新代码并自动重启，约 1 分钟，` +
      '期间该账号的任务暂停（浏览器窗口不受影响）。老机器没有热更能力则需重装 exe。',
      '下发更新',
      { type: 'warning', confirmButtonText: '下发更新', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  updating.value = dev.id
  try {
    await window.erp.gcUpdateDeviceCode(dev.id)
    ElMessage.success('已下发，约 1 分钟内完成更新重启')
  } catch (e) {
    ElMessage.error(String(e?.message || '下发失败').replace(/^Error invoking remote method '[^']+': Error: /, ''))
  } finally {
    updating.value = ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await window.erp.gcUnits(kind.value || undefined)
    rows.value = Array.isArray(data) ? data : []
    stamp.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } catch (e) {
    error.value = e?.message || '读取执行单元失败'
    rows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  // 与群控守护端同口径的 10s 轮询；本页只读，轮询不会产生副作用。
  timer = setInterval(load, 10_000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.units { display: flex; flex-direction: column; gap: 12px; }
.bar { display: flex; align-items: center; gap: 12px; }
.title b { font-size: 15px; }
.title small { margin-left: 8px; color: #8d9a92; font-size: 12px; }
.stamp { margin-left: auto; color: #8d9a92; font-size: 12px; font-variant-numeric: tabular-nums; }
.err { margin: 0; }
.tbl { width: 100%; }
.sub { color: #8d9a92; font-size: 11.5px; line-height: 1.5; margin-top: 2px; }
.sub.risk { color: #c45c47; }
.thaw { margin-top: 4px; }
.upd { margin-left: 6px; padding: 1px 8px; font-size: 11px; }
.name { margin-left: 6px; font-size: 12.5px; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
.quota { display: flex; align-items: center; gap: 7px; margin: 2px 0; }
.qname { width: 28px; color: #8d9a92; font-size: 11px; flex: none; }
.qbar { flex: 1; min-width: 46px; }
.qnum { flex: none; min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
