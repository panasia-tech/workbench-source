<template>
  <div>
    <el-card shadow="never" class="block">
      <template #header>
        <div class="hd">
          <span>闲鱼账号（每个 = 一个独立登录态，分摊爬取范围）</span>
          <div>
            <el-button :icon="Refresh" @click="load">刷新</el-button>
            <el-button type="primary" :icon="Plus" @click="addAccount">新增账号</el-button>
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
            <el-button size="small" :icon="Key" @click="goLogin(row)">去登录</el-button>
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
        <el-form-item label="任务间隔(ms)">
          <el-input-number v-model="settings.throttleMinMs" :min="300" :step="200" controls-position="right" style="width: 130px" @change="saveSettings" />
          <span style="margin: 0 8px; color: #909399">~</span>
          <el-input-number v-model="settings.throttleMaxMs" :min="300" :step="200" controls-position="right" style="width: 130px" @change="saveSettings" />
          <span style="margin-left: 8px; color: #909399; font-size: 12px">每次随机取值</span>
        </el-form-item>
        <el-form-item label="联调上限(0=不限)">
          <el-input-number v-model="settings.maxTasks" :min="0" :step="5" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="每N条重建浏览器(防内存崩,0=关)">
          <el-input-number v-model="settings.recycleEvery" :min="0" :step="10" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="每日定时">
          <el-switch v-model="settings.dailyEnabled" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="时间" v-if="settings.dailyEnabled">
          <el-time-picker v-model="dailyTimeDate" format="HH:mm" value-format="HH:mm" @change="onDailyTime" />
        </el-form-item>
        <el-form-item label="关闭即收托盘">
          <el-switch v-model="settings.closeToTray" @change="saveSettings" />
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Key, Plus, Refresh } from '@element-plus/icons-vue'

const router = useRouter()
const loading = ref(false)
const accounts = ref([])
const settings = reactive({ throttleMinMs: 1500, throttleMaxMs: 3500, maxTasks: 0, recycleEvery: 50, dailyEnabled: false, dailyTime: '09:00', closeToTray: true })
const dailyTimeDate = ref('09:00')
const planMap = ref({})
const planTotal = ref(0)

const enabledCount = computed(() => accounts.value.filter((a) => a.enabled).length)

onMounted(async () => {
  Object.assign(settings, await window.erp.getSettings())
  dailyTimeDate.value = settings.dailyTime
  await load()
})

async function load() {
  loading.value = true
  try {
    accounts.value = (await window.erp.listAccounts()).map((a) => ({ ...a, _editing: false }))
    await refreshPlan()
  } finally {
    loading.value = false
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
  await window.erp.addAccount('账号' + (accounts.value.length + 1))
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
  await ElMessageBox.confirm(`删除账号「${row.name}」？其登录态(cookie)将一并清除。`, '确认', { type: 'warning' })
  await window.erp.removeAccount(row.id)
  await load()
}
function goLogin(row) {
  router.push({ path: '/preview', query: { account: row.id } })
}

async function saveSettings() {
  // 保证 min <= max
  if (settings.throttleMaxMs < settings.throttleMinMs) {
    const t = settings.throttleMinMs
    settings.throttleMinMs = settings.throttleMaxMs
    settings.throttleMaxMs = t
  }
  Object.assign(settings, await window.erp.setSettings({
    throttleMinMs: settings.throttleMinMs,
    throttleMaxMs: settings.throttleMaxMs,
    maxTasks: settings.maxTasks,
    recycleEvery: settings.recycleEvery,
    dailyEnabled: settings.dailyEnabled,
    closeToTray: settings.closeToTray
  }))
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
