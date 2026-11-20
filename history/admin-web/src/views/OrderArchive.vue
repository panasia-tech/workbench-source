<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Delete, Refresh, Search } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime, orderStatusLabels, orderStatusTypes } from '../utils/labels'

const archiveBatchStatusLabels = {
  PENDING: '待处理',
  PACKING: '打包中',
  READY: '可下载',
  FAILED: '失败',
  OSS_DELETED: '已清理 OSS',
}

const archiveBatchStatusTypes = {
  PENDING: 'info',
  PACKING: 'warning',
  READY: 'success',
  FAILED: 'danger',
  OSS_DELETED: '',
}

const activeTab = ref('eligible')
const eligibleLoading = ref(false)
const batchLoading = ref(false)
const eligibleList = ref([])
const batchList = ref([])
const selectedIds = ref([])
const eligibleQ = ref('')
const eligiblePagination = ref({ page: 1, size: 20, total: 0 })
const batchPagination = ref({ page: 1, size: 20, total: 0 })
const detailVisible = ref(false)
const detailBatch = ref(null)
const creating = ref(false)

async function loadEligible() {
  eligibleLoading.value = true
  try {
    const { data } = await api.get('/archive/eligible', {
      params: {
        page: eligiblePagination.value.page,
        size: eligiblePagination.value.size,
        q: eligibleQ.value.trim() || undefined,
      },
    })
    eligibleList.value = data.items
    eligiblePagination.value.total = data.total
    selectedIds.value = []
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载待归档订单失败')
  } finally {
    eligibleLoading.value = false
  }
}

async function loadBatches() {
  batchLoading.value = true
  try {
    const { data } = await api.get('/archive/batches', {
      params: {
        page: batchPagination.value.page,
        size: batchPagination.value.size,
      },
    })
    batchList.value = data.items
    batchPagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载归档批次失败')
  } finally {
    batchLoading.value = false
  }
}

function onEligibleSearch() {
  eligiblePagination.value.page = 1
  loadEligible()
}

function onTabChange(name) {
  if (name === 'eligible') loadEligible()
  else loadBatches()
}

async function createArchiveBatch() {
  if (!selectedIds.value.length) {
    ElMessage.warning('请先勾选要归档的订单')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将为 ${selectedIds.value.length} 个订单打包全流程图片/视频，请确认已了解需先下载到本地 NAS 再清理 OSS。`,
      '创建归档批次',
      { type: 'warning' },
    )
  } catch {
    return
  }
  creating.value = true
  try {
    const { data } = await api.post('/archive/batches', {
      purchase_order_ids: selectedIds.value,
    })
    ElMessage.success(`批次 ${data.batch_no} 已创建`)
    activeTab.value = 'batches'
    await loadBatches()
    if (data.status === 'READY' && data.package_url) {
      openPackageUrl(data.package_url)
    } else if (data.status === 'FAILED') {
      ElMessage.error(data.error_message || '打包失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建归档批次失败')
  } finally {
    creating.value = false
  }
}

function openPackageUrl(url) {
  if (!url) {
    ElMessage.warning('暂无下载链接')
    return
  }
  window.open(url, '_blank')
}

async function refreshPackageUrl(row) {
  try {
    const { data } = await api.post(`/archive/batches/${row.id}/refresh-package-url`)
    row.package_url = data.package_url
    ElMessage.success('下载链接已刷新（7 天有效）')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '刷新链接失败')
  }
}

async function showBatchDetail(row) {
  try {
    const { data } = await api.get(`/archive/batches/${row.id}`)
    detailBatch.value = data
    detailVisible.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载批次详情失败')
  }
}

async function deleteBatchOss(row) {
  try {
    await ElMessageBox.confirm(
      `确认已把批次 ${row.batch_no} 的压缩包保存到本地 NAS？\n\n此操作将删除 OSS 上对应订单的全部媒体文件，数据库 URL 将标记为不可用，且不可恢复。`,
      '删除 OSS 文件',
      { type: 'error', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await api.post(`/archive/batches/${row.id}/delete-oss`)
    ElMessage.success('OSS 文件已删除，数据库 URL 已同步为不可用')
    loadBatches()
    if (detailBatch.value?.id === row.id) {
      const { data } = await api.get(`/archive/batches/${row.id}`)
      detailBatch.value = data
    }
    if (activeTab.value === 'eligible') loadEligible()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '删除 OSS 失败')
  }
}

onMounted(() => {
  loadEligible()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">批量归档订单</h3>
      <p class="page-card__desc">
        终态（已出库/盘亏/已取消）且结束超过 7 天的采购订单；打包目录为
        <code>年-月/年-月-日/订单号/</code>。请先下载到 NAS，再手动删除 OSS。
      </p>
    </div>

    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <el-tab-pane label="待归档" name="eligible">
        <div class="toolbar">
          <el-input
            v-model="eligibleQ"
            placeholder="搜索单号/商品"
            clearable
            style="width: 220px"
            @keyup.enter="onEligibleSearch"
            @clear="onEligibleSearch"
          />
          <el-button type="primary" :icon="Search" @click="onEligibleSearch">查询</el-button>
          <el-button
            type="warning"
            :loading="creating"
            :disabled="!selectedIds.length"
            @click="createArchiveBatch"
          >
            打包选中 ({{ selectedIds.length }})
          </el-button>
        </div>
        <el-table
          v-loading="eligibleLoading"
          :data="eligibleList"
          stripe
          empty-text="暂无符合归档条件的订单"
          @selection-change="(rows) => (selectedIds = rows.map((r) => r.id))"
        >
          <el-table-column type="selection" width="48" :resizable="false" />
          <el-table-column prop="order_no" label="单号" min-width="150" />
          <el-table-column prop="product_name" label="商品" min-width="140" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="orderStatusTypes[row.status] || 'info'" size="small">
                {{ orderStatusLabels[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="file_count" label="媒体数" width="80" align="center" />
          <el-table-column label="结束时间" min-width="160">
            <template #default="{ row }">{{ formatDateTime(row.ended_at) }}</template>
          </el-table-column>
        </el-table>
        <div class="table-pagination">
          <el-pagination
            v-model:current-page="eligiblePagination.page"
            v-model:page-size="eligiblePagination.size"
            :total="eligiblePagination.total"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadEligible"
            @size-change="
              () => {
                eligiblePagination.page = 1
                loadEligible()
              }
            "
          />
        </div>
      </el-tab-pane>

      <el-tab-pane label="归档批次" name="batches">
        <el-table v-loading="batchLoading" :data="batchList" stripe empty-text="暂无归档批次">
          <el-table-column prop="batch_no" label="批次号" min-width="150" />
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="archiveBatchStatusTypes[row.status] || 'info'" size="small">
                {{ archiveBatchStatusLabels[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="order_count" label="订单数" width="80" align="center" />
          <el-table-column prop="file_count" label="文件数" width="80" align="center" />
          <el-table-column prop="created_by_name" label="操作人" width="100" />
          <el-table-column label="创建时间" min-width="160">
            <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="280" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="showBatchDetail(row)">详情</el-button>
              <el-button
                v-if="row.status === 'READY'"
                link
                type="primary"
                :icon="Download"
                @click="openPackageUrl(row.package_url)"
              >
                下载
              </el-button>
              <el-button
                v-if="row.status === 'READY'"
                link
                :icon="Refresh"
                @click="refreshPackageUrl(row)"
              >
                刷新链接
              </el-button>
              <el-button
                v-if="row.status === 'READY'"
                link
                type="danger"
                :icon="Delete"
                @click="deleteBatchOss(row)"
              >
                删除 OSS
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="table-pagination">
          <el-pagination
            v-model:current-page="batchPagination.page"
            v-model:page-size="batchPagination.size"
            :total="batchPagination.total"
            :page-sizes="[10, 20, 50]"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="loadBatches"
            @size-change="
              () => {
                batchPagination.page = 1
                loadBatches()
              }
            "
          />
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="detailVisible" title="归档批次详情" width="640px">
      <template v-if="detailBatch">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="批次号">{{ detailBatch.batch_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            {{ archiveBatchStatusLabels[detailBatch.status] || detailBatch.status }}
          </el-descriptions-item>
          <el-descriptions-item label="订单数">{{ detailBatch.order_count }}</el-descriptions-item>
          <el-descriptions-item label="文件数">{{ detailBatch.file_count }}</el-descriptions-item>
          <el-descriptions-item label="打包时间" :span="2">
            {{ formatDateTime(detailBatch.packed_at) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detailBatch.error_message" label="备注" :span="2">
            {{ detailBatch.error_message }}
          </el-descriptions-item>
        </el-descriptions>
        <el-table :data="detailBatch.orders" size="small" style="margin-top: 16px">
          <el-table-column prop="order_no" label="采购单号" />
          <el-table-column prop="file_count" label="文件数" width="80" align="center" />
          <el-table-column label="OSS 清理" width="100">
            <template #default="{ row }">
              {{ row.oss_deleted_at ? '已清理' : '—' }}
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-card__desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary, #666);
  line-height: 1.5;
}

.page-card__desc code {
  font-size: 12px;
  background: #f5f5f5;
  padding: 1px 4px;
  border-radius: 4px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
</style>
