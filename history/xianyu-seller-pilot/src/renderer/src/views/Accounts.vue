<template>
  <div>
    <el-card shadow="never" class="block">
      <template #header>
        <div class="hd">
        <span>{{ isWeb ? '服务器浏览器 Profile（每个 = 一个独立登录态）' : '闲鱼账号（每个 = 一个独立登录态，分摊爬取范围）' }}</span>
          <div>
            <el-button :icon="Refresh" @click="load">刷新</el-button>
            <el-button @click="loadAdsProfiles">{{ isWeb ? '读取服务器 Profile' : '读取 AdsPower 环境' }}</el-button>
            <el-button type="primary" :icon="Plus" @click="addAccount">{{ isWeb ? '新增 Profile' : '新增账号' }}</el-button>
          </div>
        </div>
      </template>

      <el-table :data="accounts" v-loading="loading" border>
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <el-input v-if="row._editing" v-model="row.name" size="small" @blur="saveName(row)" @keyup.enter="saveName(row)" />
            <span v-else class="name" @click="row._editing = true">{{ row.name }} <el-icon><Edit /></el-icon></span>
          </template>
        </el-table-column>
        <el-table-column label="登录态" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.loggedIn" type="success" size="small">已登录</el-tag>
            <el-tag v-else type="info" size="small">未登录</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="浏览器环境" min-width="240">
          <template #default="{ row }">
            <el-select
              v-model="row.adsPowerId"
              clearable
              filterable
              allow-create
              default-first-option
              size="small"
              :placeholder="isWeb ? '选择服务器 Provider Profile' : 'Electron（选择或输入 AdsPower 环境 ID）'"
              @change="saveBrowser(row)"
            >
              <el-option
                v-for="profile in adsProfiles"
                :key="profile.id"
                :label="profileLabel(profile)"
                :value="profile.id"
              />
            </el-select>
            <el-tag v-if="isWeb" type="success" size="small" effect="plain" style="margin-left: 6px">{{ row.provider || '服务器' }}</el-tag>
            <el-tag v-else-if="row.browserProvider === 'adspower'" type="success" size="small" effect="plain" style="margin-left: 6px">AdsPower</el-tag>
            <el-tag v-else type="info" size="small" effect="plain" style="margin-left: 6px">Electron</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="参与爬取" width="110">
          <template #default="{ row }">
            <el-switch v-model="row.enabled" @change="toggle(row)" />
          </template>
        </el-table-column>
        <el-table-column label="本轮分配词数" width="130">
          <template #default="{ row }">{{ planMap[row.id] ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button v-if="!isWeb" size="small" :icon="Key" :loading="openingAccountId === row.id" @click="goLogin(row)">打开 AdsPower</el-button>
            <el-button size="small" type="danger" :icon="Delete" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="plan-line" v-if="planTotal">
        全量启用任务 <b>{{ planTotal }}</b> 个，按 {{ enabledCount }} 个启用账号轮询切片。
        <el-button text type="primary" @click="refreshPlan">重新计算分配</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>爬取设置</template>
      <el-form inline>
        <el-form-item label="任务间隔（秒）">
          <el-input-number v-model="intervals.taskMinSeconds" :min="8" :step="1" controls-position="right" style="width: 130px" @change="saveSettings" />
          <span style="margin: 0 8px; color: #909399">~</span>
          <el-input-number v-model="intervals.taskMaxSeconds" :min="8" :step="1" controls-position="right" style="width: 130px" @change="saveSettings" />
          <span style="margin-left: 8px; color: #909399; font-size: 12px">每次随机取值</span>
        </el-form-item>
        <el-form-item label="搜索词之间间隔（秒）">
          <el-input-number v-model="intervals.queryMinSeconds" :min="5" :step="1" controls-position="right" style="width: 130px" @change="saveSettings" />
          <span style="margin: 0 8px; color: #909399">~</span>
          <el-input-number v-model="intervals.queryMaxSeconds" :min="5" :step="1" controls-position="right" style="width: 130px" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="联调上限(0=不限)">
          <el-input-number v-model="settings.maxTasks" :min="0" :step="5" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="每N条重建浏览器(防内存崩,0=关)">
          <el-input-number v-model="settings.recycleEvery" :min="0" :step="10" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="每天自动采集时间">
          <el-time-picker v-model="dailyTimeDate" format="HH:mm" value-format="HH:mm" @change="onDailyTime" />
        </el-form-item>
        <el-form-item label="关闭即收托盘">
          <el-switch v-model="settings.closeToTray" @change="saveSettings" />
        </el-form-item>
      </el-form>
      <div class="plan-line">{{ isWeb ? '每日计划由服务器 Scheduler 持久化执行；员工关闭 H5 不会影响已保存的计划。' : '本机 Excel 任务的自动开爬时间请在「任务中心」设置；这里的定时仅兼容旧版服务端任务。' }}</div>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Key, Plus, Refresh } from '@element-plus/icons-vue'

const loading = ref(false)
const accounts = ref([])
const settings = reactive({ throttleMinMs: 12000, throttleMaxMs: 20000, queryDelayMinMs: 8000, queryDelayMaxMs: 14000, maxTasks: 0, recycleEvery: 50, dailyEnabled: false, dailyTime: '09:00', closeToTray: true })
const intervals = reactive({ taskMinSeconds: 12, taskMaxSeconds: 20, queryMinSeconds: 8, queryMaxSeconds: 14 })
const dailyTimeDate = ref('09:00')
const planMap = ref({})
const planTotal = ref(0)
const adsProfiles = ref([])
const openingAccountId = ref(null)
const isWeb = window.erp?.mode === 'web'

const enabledCount = computed(() => accounts.value.filter((a) => a.enabled).length)

onMounted(async () => {
  applySettings(await window.erp.getSettings())
  dailyTimeDate.value = settings.dailyTime
  await loadAdsProfiles()
  await load()
})

function millisecondsToSeconds(value, fallback) {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.max(1, Math.round(milliseconds / 1000)) : fallback
}

function secondsToMilliseconds(value, fallback) {
  const seconds = Number(value)
  return Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : fallback) * 1000)
}

function applySettings(next = {}) {
  Object.assign(settings, next)
  intervals.taskMinSeconds = millisecondsToSeconds(settings.throttleMinMs, 12)
  intervals.taskMaxSeconds = millisecondsToSeconds(settings.throttleMaxMs, 20)
  intervals.queryMinSeconds = millisecondsToSeconds(settings.queryDelayMinMs, 8)
  intervals.queryMaxSeconds = millisecondsToSeconds(settings.queryDelayMaxMs, 14)
}

async function load() {
  loading.value = true
  try {
    accounts.value = (await window.erp.listAccounts()).map((a) => ({ ...a, _editing: false }))
    await refreshPlan()
  } finally {
    loading.value = false
  }
}

function profileLabel(profile) {
  const name = profile.name || profile.remark || ''
  return name ? `${name} · ${profile.id.slice(0, 8)}` : `${isWeb ? '服务器 Profile' : 'AdsPower 环境'} · ${profile.id.slice(0, 8)}`
}

async function loadAdsProfiles() {
  try {
    adsProfiles.value = await window.erp.adsPowerProfiles()
  } catch {
    adsProfiles.value = []
  }
}

async function saveBrowser(row) {
  const adsPowerId = String(row.adsPowerId || '').trim()
  try {
    const next = await window.erp.updateAccount(row.id, isWeb
      ? { vendorProfileId: adsPowerId, provider: row.provider || 'camoufox' }
      : { adsPowerId, browserProvider: adsPowerId ? 'adspower' : 'electron' })
    Object.assign(row, next || {})
    ElMessage.success(adsPowerId ? (isWeb ? '已绑定服务器浏览器 Profile' : '已绑定 AdsPower 环境') : (isWeb ? '已清除服务器 Profile' : '已切回 Electron 环境'))
  } catch (error) {
    await load()
    ElMessage.error(error?.message || 'AdsPower 环境绑定失败')
  }
}

async function refreshPlan() {
  try {
    const plan = await window.erp.planTasks()
    planTotal.value = plan.total
    const m = {}
    plan.buckets.forEach((b) => (m[b.accountId] = b.count))
    planMap.value = m
  } catch {
    planTotal.value = 0
    planMap.value = {}
  }
}

async function addAccount() {
  if (isWeb) {
    const vendorProfileId = window.prompt('请输入 Camoufox Profile ID（服务器上的持久登录态）')
    if (!vendorProfileId) return
    const label = window.prompt('请输入显示名称（可选）') || vendorProfileId
    await window.erp.addAccount({ vendorProfileId, label })
  } else {
    await window.erp.addAccount('账号' + (accounts.value.length + 1))
  }
  await load()
}
async function saveName(row) {
  row._editing = false
  await window.erp.updateAccount(row.id, { name: row.name })
  await refreshPlan()
}
async function toggle(row) {
  await window.erp.updateAccount(row.id, { enabled: row.enabled })
  await refreshPlan()
}
async function remove(row) {
  await ElMessageBox.confirm(`删除账号「${row.name}」？服务器 Profile 绑定会被移除，登录态目录由服务器管理员按备份策略处理。`, '确认', { type: 'warning' })
  await window.erp.removeAccount(row.id)
  await load()
}
async function goLogin(row) {
  if (row?.browserProvider !== 'adspower' || !row?.adsPowerId) {
    ElMessage.warning('该账号尚未绑定 AdsPower 环境，已阻止打开内置浏览器。请先选择或填写 AdsPower 环境 ID。')
    return
  }
  openingAccountId.value = row.id
  try {
    const result = await window.erp.openAdsPowerProfile(row.id)
    if (result?.ok === false) throw new Error(result.reason || result.message || 'AdsPower 窗口打开失败')
    ElMessage.success(`已打开「${row.name || '闲鱼账号'}」对应的AdsPower 窗口`)
  } catch (error) {
    ElMessage.error(error?.message || 'AdsPower 窗口打开失败')
  } finally {
    openingAccountId.value = null
  }
}

async function saveSettings() {
  // 保证 min <= max
  intervals.taskMinSeconds = Math.max(8, Math.round(Number(intervals.taskMinSeconds) || 12))
  intervals.taskMaxSeconds = Math.max(intervals.taskMinSeconds, Math.round(Number(intervals.taskMaxSeconds) || intervals.taskMinSeconds))
  intervals.queryMinSeconds = Math.max(5, Math.round(Number(intervals.queryMinSeconds) || 8))
  intervals.queryMaxSeconds = Math.max(intervals.queryMinSeconds, Math.round(Number(intervals.queryMaxSeconds) || intervals.queryMinSeconds))
  const next = await window.erp.setSettings({
    throttleMinMs: secondsToMilliseconds(intervals.taskMinSeconds, 12),
    throttleMaxMs: secondsToMilliseconds(intervals.taskMaxSeconds, 20),
    queryDelayMinMs: secondsToMilliseconds(intervals.queryMinSeconds, 8),
    queryDelayMaxMs: secondsToMilliseconds(intervals.queryMaxSeconds, 14),
    maxTasks: settings.maxTasks,
    recycleEvery: settings.recycleEvery,
    dailyEnabled: settings.dailyEnabled,
    closeToTray: settings.closeToTray
  })
  applySettings(next)
  await refreshPlan()
}
async function onDailyTime(v) {
  settings.dailyTime = v || '09:00'
  await window.erp.setSettings({ dailyTime: settings.dailyTime })
  ElMessage.success('已保存定时：' + settings.dailyTime)
}
</script>

<style scoped>
.block { margin-bottom: 16px; }
.hd { display: flex; justify-content: space-between; align-items: center; }
.name { cursor: pointer; color: #409eff; }
.plan-line { margin-top: 12px; color: #606266; font-size: 13px; }
</style>
