<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { formatDateTime, stocktakeStatusLabels, stocktakeStatusTypes } from '../utils/labels'

const router = useRouter()
const loading = ref(false)
const list = ref([])
const statusFilter = ref('PENDING_APPROVAL')

async function load() {
  loading.value = true
  try {
    const params = statusFilter.value ? { status: statusFilter.value } : {}
    const { data } = await api.get('/inventory/stocktake', { params })
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function openDetail(row) {
  router.push(`/inventory/stocktake/${row.id}`)
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">盘点审批</h3>
      <div class="page-card__actions">
        <el-select v-model="statusFilter" style="width: 160px" @change="load">
          <el-option label="审批中" value="PENDING_APPROVAL" />
          <el-option label="有差异" value="COMPLETED" />
          <el-option label="账实相符" value="APPROVED" />
          <el-option label="已驳回" value="REJECTED" />
          <el-option label="全部" value="" />
        </el-select>
        <span class="page-card__count">共 {{ list.length }} 单</span>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无盘点单" @row-click="openDetail">
        <el-table-column prop="session_no" label="盘点单号" min-width="160" />
        <el-table-column prop="operator_name" label="操作员" min-width="100" />
        <el-table-column label="状态" min-width="110">
          <template #default="{ row }">
            <el-tag :type="stocktakeStatusTypes[row.status] || 'info'" size="small">
              {{ stocktakeStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="scanned_count" label="实盘" width="80" />
        <el-table-column prop="missing_count" label="盘亏" width="80" />
        <el-table-column prop="surplus_count" label="盘盈" width="80" />
        <el-table-column label="完成时间" min-width="160">
          <template #default="{ row }">{{ formatDateTime(row.completed_at || row.started_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.page-card__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.page-card__count {
  font-size: 13px;
  color: var(--text-secondary);
}
</style>
