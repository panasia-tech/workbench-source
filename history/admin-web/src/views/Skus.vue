<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '../api'
import MediaGallery from '../components/MediaGallery.vue'
import MediaThumb from '../components/MediaThumb.vue'
import { formatDateTime, formatPrice, skuStatusLabels, skuStatusTypes } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const q = ref('')
const statusFilter = ref('IN_STOCK')
const pagination = ref({ page: 1, size: 20, total: 0 })
const detailVisible = ref(false)
const detailSku = ref(null)
const detailLoading = ref(false)

async function load() {
  loading.value = true
  try {
    const params = {
      page: pagination.value.page,
      size: pagination.value.size,
    }
    if (statusFilter.value) params.status = statusFilter.value
    if (q.value.trim()) params.q = q.value.trim()
    const { data } = await api.get('/inventory/skus', { params })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载库存失败')
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

async function showDetail(row) {
  detailLoading.value = true
  detailVisible.value = true
  detailSku.value = null
  try {
    const { data } = await api.get(`/inventory/skus/${encodeURIComponent(row.sku_code)}`)
    detailSku.value = data
  } catch (err) {
    detailVisible.value = false
    ElMessage.error(err.response?.data?.detail || '加载 SKU 详情失败')
  } finally {
    detailLoading.value = false
  }
}

async function editSkuCode() {
  if (!detailSku.value) return
  const oldCode = detailSku.value.sku_code
  let newCode
  try {
    const { value } = await ElMessageBox.prompt(
      `当前货号:${oldCode}\n输入新货号(将同步更新关联单据,保存后自动转大写)`,
      '修改货号',
      {
        confirmButtonText: '保存',
        cancelButtonText: '取消',
        inputValue: oldCode,
        inputValidator: (v) => (v && v.trim() ? true : '货号不能为空'),
      },
    )
    newCode = value.trim()
  } catch {
    return
  }
  if (!newCode || newCode === oldCode) return
  try {
    const { data } = await api.post('/inventory/skus/recode', {
      old_sku_code: oldCode,
      new_sku_code: newCode,
    })
    ElMessage.success(`货号已改为 ${data.new_sku_code}`)
    detailSku.value = { ...detailSku.value, sku_code: data.new_sku_code }
    load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '修改货号失败')
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">库存 SKU</h3>
      <div class="page-card__actions toolbar">
        <el-input
          v-model="q"
          placeholder="搜索货号/商品/库位"
          clearable
          style="width: 240px"
          @keyup.enter="onSearch"
          @clear="onSearch"
        />
        <el-select
          v-model="statusFilter"
          placeholder="筛选状态"
          style="width: 140px"
          @change="onSearch"
        >
          <el-option label="全部" value="" />
          <el-option label="在库" value="IN_STOCK" />
          <el-option label="已出库" value="SHIPPED" />
          <el-option label="盘亏" value="LOSS" />
        </el-select>
        <el-button type="primary" :icon="Search" @click="onSearch">查询</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无库存数据" @row-click="showDetail">
        <el-table-column label="缩略图" width="72" align="center">
          <template #default="{ row }">
            <span v-if="row.cover_url" @click.stop>
              <MediaThumb :url="row.cover_url" size="small" :preview="true" />
            </span>
            <span v-else class="thumb-empty">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="sku_code" label="货号" min-width="160" fixed />
        <el-table-column prop="product_name" label="商品" min-width="160" show-overflow-tooltip />
        <el-table-column label="库位" min-width="100">
          <template #default="{ row }">{{ row.location_code || '—' }}</template>
        </el-table-column>
        <el-table-column label="成本" min-width="100" align="right">
          <template #default="{ row }">{{ formatPrice(row.cost_price) }}</template>
        </el-table-column>
        <el-table-column prop="operator_name" label="操作人" min-width="100">
          <template #default="{ row }">{{ row.operator_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="100">
          <template #default="{ row }">
            <el-tag :type="skuStatusTypes[row.status] || 'info'" size="small">
              {{ skuStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入库时间" min-width="160">
          <template #default="{ row }">{{ formatDateTime(row.inbound_at) }}</template>
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

    <el-dialog v-model="detailVisible" title="SKU 详情" width="900px" top="6vh" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detailSku">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="货号">
              {{ detailSku.sku_code }}
              <el-button link type="primary" size="small" @click="editSkuCode">修改</el-button>
            </el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="skuStatusTypes[detailSku.status] || 'info'" size="small">
                {{ skuStatusLabels[detailSku.status] || detailSku.status }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="商品" :span="2">{{ detailSku.product_name }}</el-descriptions-item>
            <el-descriptions-item label="库位">{{ detailSku.location_code || '—' }}</el-descriptions-item>
            <el-descriptions-item label="成色">{{ detailSku.condition_grade || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="detailSku.images?.length" class="detail-media">
            <div class="detail-media__label">商品图册</div>
            <MediaGallery :urls="detailSku.images" thumb-size="xlarge" />
          </div>
          <div v-if="detailSku.location_images?.length" class="detail-media">
            <div class="detail-media__label">仓库定位图</div>
            <MediaGallery :urls="detailSku.location_images" thumb-size="xlarge" />
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

.thumb-empty {
  color: #bfbfbf;
}

.detail-media {
  margin-top: 16px;
}

.detail-media__label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.detail-cover {
  margin-bottom: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

</style>
