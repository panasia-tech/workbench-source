<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const autoRefresh = ref(false)
let timer = null

const statusTypes = {
  ONLINE: 'success',
  OFFLINE: 'info',
  DISABLED: 'danger',
}

onMounted(() => load())
onUnmounted(() => stopTimer())

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/gc-ops/devices')
    list.value = Array.isArray(data) ? data : (data.items || [])
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function startTimer() {
  stopTimer()
  timer = setInterval(() => load(), 10000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function onAutoRefreshChange(val) {
  if (val) {
    startTimer()
  } else {
    stopTimer()
  }
}

async function selfCheck(row) {
  try {
    await ElMessageBox.confirm(`确认对设备 ${row.name || row.serial} 发起自检？`, '自检确认', {
      confirmButtonText: '自检',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.post(`/gc-ops/devices/${row.id}/self-check`)
    ElMessage.success('已发起自检')
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.detail || '操作失败')
    }
  }
}

async function restart(row) {
  try {
    await ElMessageBox.confirm(`确认重启设备 ${row.name || row.serial}？`, '重启确认', {
      confirmButtonText: '重启',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.post(`/gc-ops/devices/${row.id}/restart`)
    ElMessage.success('已发起重启')
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.detail || '操作失败')
    }
  }
}

async function toggleStatus(row) {
  const disabling = row.status !== 'DISABLED'
  try {
    await ElMessageBox.confirm(
      `确认${disabling ? '停用' : '启用'}设备 ${row.name || row.serial}？`,
      `${disabling ? '停用' : '启用'}确认`,
      {
        confirmButtonText: disabling ? '停用' : '启用',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
    await api.patch(`/gc-ops/devices/${row.id}`, { status: disabling ? 'DISABLED' : 'ONLINE' })
    ElMessage.success(disabling ? '已停用' : '已启用')
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.detail || '操作失败')
    }
  }
}
</script>

<template>
  <div class="page-container">
    <el-card class="search-card">
      <div class="search-row">
        <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <div class="auto-refresh">
          <el-switch v-model="autoRefresh" @change="onAutoRefreshChange" />
          <span class="auto-refresh__label">10s 自动刷新</span>
        </div>
      </div>
    </el-card>

    <el-card>
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTypes[row.status] || 'info'">{{ row.status || '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="120">
          <template #default="{ row }">{{ row.name || '—' }}</template>
        </el-table-column>
        <el-table-column label="型号" min-width="160">
          <template #default="{ row }">
            {{ [row.brand, row.model].filter(Boolean).join(' ') || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="serial" label="序列号" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.serial || '—' }}</template>
        </el-table-column>
        <el-table-column label="闲鱼昵称" min-width="130">
          <template #default="{ row }">{{ row.reported_nick || '未识别' }}</template>
        </el-table-column>
        <el-table-column label="绑定账号" min-width="130">
          <template #default="{ row }">{{ row.account_nick || '—' }}</template>
        </el-table-column>
        <el-table-column label="就绪" width="80">
          <template #default="{ row }">{{ row.last_ready ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="阻塞" width="80">
          <template #default="{ row }">{{ row.blocking ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="最近心跳" width="160">
          <template #default="{ row }">{{ formatDateTime(row.last_heartbeat_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="selfCheck(row)">自检</el-button>
            <el-button size="small" type="primary" link @click="restart(row)">重启</el-button>
            <el-button
              size="small"
              :type="row.status === 'DISABLED' ? 'success' : 'danger'"
              link
              @click="toggleStatus(row)"
            >
              {{ row.status === 'DISABLED' ? '启用' : '停用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.page-container {
  max-width: 1400px;
}

.search-card {
  margin-bottom: 16px;
}

.search-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.auto-refresh {
  display: flex;
  gap: 8px;
  align-items: center;
}

.auto-refresh__label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>
