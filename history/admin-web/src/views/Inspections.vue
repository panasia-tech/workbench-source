<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '../api'
import MediaGallery from '../components/MediaGallery.vue'
import { formatDateTime, inspectionStatusLabels, inspectionStatusTypes } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const q = ref('')
const statusFilter = ref('')
const dateRange = ref([])
const pagination = ref({ page: 1, size: 20, total: 0 })
const detailVisible = ref(false)
const detailTask = ref(null)
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
    const { data } = await api.get('/inspection/tasks', { params })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载验货记录失败')
  } finally {
    loading.value = false
  }
}

function onSearch() {
  pagination.value.page = 1
  load()
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

function productDesc(row) {
  const parts = [row.brand, row.model, row.spec].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

function displayTime(row) {
  return formatDateTime(row.inspected_at || row.created_at)
}

async function showDetail(row) {
  detailLoading.value = true
  detailVisible.value = true
  detailTask.value = null
  try {
    const { data } = await api.get(`/inspection/tasks/${row.id}`)
    detailTask.value = data
  } catch (err) {
    detailVisible.value = false
    ElMessage.error(err.response?.data?.detail || '加载验货详情失败')
  } finally {
    detailLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">验货记录</h3>
      <div class="page-card__actions toolbar">
        <el-input
          v-model="q"
          placeholder="搜索验货单/采购单/商品"
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
          <el-option label="待验货" value="PENDING" />
          <el-option label="已完成" value="DONE" />
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
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无验货记录" @row-click="showDetail">
        <el-table-column prop="inspect_no" label="验货单号" min-width="160" fixed />
        <el-table-column prop="order_no" label="采购单号" min-width="160" />
        <el-table-column label="商品" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.condition_warning" type="danger" size="small" effect="dark" style="margin-right: 6px">
              ⚠{{ row.condition_warning_text || '全新' }}
            </el-tag>
            <el-tag v-if="row.piece_label" size="small" style="margin-right: 6px">{{ row.piece_label }}</el-tag>
            {{ row.product_name }}
          </template>
        </el-table-column>
        <el-table-column label="规格" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ productDesc(row) }}</template>
        </el-table-column>
        <el-table-column label="成色" min-width="80">
          <template #default="{ row }">{{ row.condition_grade || '—' }}</template>
        </el-table-column>
        <el-table-column label="库位" min-width="90">
          <template #default="{ row }">{{ row.location_code || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="100">
          <template #default="{ row }">
            <el-tag :type="inspectionStatusTypes[row.status] || 'info'" size="small">
              {{ inspectionStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="operator_name" label="操作人" min-width="100">
          <template #default="{ row }">{{ row.operator_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="160">
          <template #default="{ row }">{{ displayTime(row) }}</template>
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

    <el-dialog v-model="detailVisible" title="验货详情" width="560px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detailTask">
          <el-alert
            v-if="detailTask.condition_warning"
            type="error"
            :closable="false"
            show-icon
            :title="`实拍图含「${detailTask.condition_warning_text || '全新'}」字样，请重点核对货况`"
            style="margin-bottom: 12px"
          />
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="验货单号">{{ detailTask.inspect_no }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="inspectionStatusTypes[detailTask.status] || 'info'" size="small">
                {{ inspectionStatusLabels[detailTask.status] || detailTask.status }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="成色">{{ detailTask.condition_grade || '—' }}</el-descriptions-item>
            <el-descriptions-item label="库位">{{ detailTask.location_code || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="detailTask.listing_images?.length" class="detail-media">
            <div class="detail-media__label">上架图</div>
            <MediaGallery :urls="detailTask.listing_images" thumb-size="medium" />
          </div>
          <div v-if="detailTask.defect_images?.length" class="detail-media">
            <div class="detail-media__label">瑕疵图</div>
            <MediaGallery :urls="detailTask.defect_images" thumb-size="medium" />
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
