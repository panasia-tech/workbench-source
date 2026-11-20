<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Search } from '@element-plus/icons-vue'
import api from '../api'
import MediaThumb from '../components/MediaThumb.vue'
import { blobErrorDetail, downloadBlob } from '../utils/download'
import { formatDateTime, formatPrice, saleOrderStatusLabels, saleOrderStatusTypes } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const q = ref('')
const statusFilter = ref('')
const dateRange = ref([])
const pagination = ref({ page: 1, size: 20, total: 0 })
const detailVisible = ref(false)
const detailOrder = ref(null)
const detailLoading = ref(false)

async function load() {
  loading.value = true
  try {
    const params = {
      page: pagination.value.page,
      size: pagination.value.size,
    }
    if (q.value.trim()) params.q = q.value.trim()
    if (statusFilter.value) params.status = statusFilter.value
    if (dateRange.value?.length === 2) {
      params.date_from = dateRange.value[0]
      params.date_to = dateRange.value[1]
    }
    const { data } = await api.get('/sales/orders', { params })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载销售订单失败')
  } finally {
    loading.value = false
  }
}

function onSearch() {
  pagination.value.page = 1
  load()
}

const exporting = ref(false)

// 导出走出库流水口径（含成本/手续费/到手收益），带当前关键词与日期区间；状态筛选不适用于出库流水，忽略
async function onExport() {
  exporting.value = true
  try {
    const params = {}
    if (q.value.trim()) params.q = q.value.trim()
    if (dateRange.value?.length === 2) {
      params.date_from = dateRange.value[0]
      params.date_to = dateRange.value[1]
    }
    const resp = await api.get('/sales/outbounds/export', { params, responseType: 'blob' })
    const range = dateRange.value?.length === 2 ? `${dateRange.value[0]}_${dateRange.value[1]}` : '全部'
    downloadBlob(resp.data, `销售出库流水_${range}.xlsx`)
  } catch (err) {
    ElMessage.error((await blobErrorDetail(err)) || '导出失败')
  } finally {
    exporting.value = false
  }
}

function onPageChange(page) {
  pagination.value.page = page
  load()
}

function onSizeChange(size) {
  pagination.value.size = size
  pagination.value.page = 1
  load()
}

async function showDetail(row) {
  detailLoading.value = true
  detailVisible.value = true
  detailOrder.value = null
  try {
    const { data } = await api.get(`/sales/orders/${row.id}`)
    detailOrder.value = data
  } catch (err) {
    detailVisible.value = false
    ElMessage.error(err.response?.data?.detail || '加载销售订单详情失败')
  } finally {
    detailLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">销售订单</h3>
      <div class="page-card__actions toolbar">
        <el-input
          v-model="q"
          placeholder="搜索单号/买家/平台"
          clearable
          style="width: 240px"
          @keyup.enter="onSearch"
          @clear="onSearch"
        />
        <el-select
          v-model="statusFilter"
          placeholder="全部状态"
          clearable
          style="width: 120px"
          @change="onSearch"
        >
          <el-option label="待发货" value="PENDING" />
          <el-option label="已发货" value="SHIPPED" />
          <el-option label="已完成" value="COMPLETED" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          value-format="YYYY-MM-DD"
          style="width: 260px"
          @change="onSearch"
        />
        <el-button type="primary" :icon="Search" @click="onSearch">查询</el-button>
        <el-button :icon="Download" :loading="exporting" @click="onExport">导出出库流水</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无销售订单" @row-click="showDetail">
        <el-table-column prop="order_no" label="单号" min-width="160" fixed />
        <el-table-column prop="buyer_name" label="买家" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.buyer_name || '—' }}</template>
        </el-table-column>
        <el-table-column prop="platform" label="平台" min-width="90">
          <template #default="{ row }">{{ row.platform || '—' }}</template>
        </el-table-column>
        <el-table-column prop="external_order_no" label="平台单号" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.external_order_no || '—' }}</template>
        </el-table-column>
        <el-table-column label="金额" min-width="100" align="right">
          <template #default="{ row }">{{ formatPrice(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="100">
          <template #default="{ row }">
            <el-tag :type="saleOrderStatusTypes[row.status] || 'info'" size="small">
              {{ saleOrderStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="operator_name" label="操作人" min-width="100">
          <template #default="{ row }">{{ row.operator_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" min-width="160">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
      </el-table>
      <div class="table-pagination">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.size"
          :total="pagination.total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="销售订单详情" width="520px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detailOrder">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="单号">{{ detailOrder.order_no }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="saleOrderStatusTypes[detailOrder.status] || 'info'" size="small">
                {{ saleOrderStatusLabels[detailOrder.status] || detailOrder.status }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="买家">{{ detailOrder.buyer_name || '—' }}</el-descriptions-item>
            <el-descriptions-item label="平台">{{ detailOrder.platform || '—' }}</el-descriptions-item>
            <el-descriptions-item label="金额">{{ formatPrice(detailOrder.amount) }}</el-descriptions-item>
            <el-descriptions-item label="平台单号">{{ detailOrder.external_order_no || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="detailOrder.screenshot_url" class="detail-media">
            <div class="detail-media__label">订单截图</div>
            <MediaThumb :url="detailOrder.screenshot_url" size="large" />
          </div>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
:deep(.el-table__row) {
  cursor: pointer;
}

.detail-media {
  margin-top: 16px;
}

.detail-media__label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

</style>
