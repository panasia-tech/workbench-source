<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import {
  formatDateTime,
  proposalStatusLabels,
  stocktakeStatusLabels,
  stocktakeStatusTypes,
} from '../utils/labels'

const route = useRoute()
const router = useRouter()
const loading = ref(false)
const session = ref(null)
const activeTab = ref('missing')

// 商品详情弹窗
const detailVisible = ref(false)
const detailLoading = ref(false)
const detailSku = ref(null)

const diff = computed(() => session.value?.diff_result || null)
const hasDiff = computed(() => !!diff.value && (diff.value.missing.length || diff.value.surplus.length))
const canReview = computed(() => session.value?.status === 'PENDING_APPROVAL')
// 有差异且尚未平账 → 可处理
const canSettle = computed(() => session.value?.status === 'COMPLETED' && hasDiff.value)

const currentItems = computed(() => {
  if (!diff.value) return []
  if (activeTab.value === 'matched') return diff.value.matched || []
  if (activeTab.value === 'surplus') return diff.value.surplus || []
  return diff.value.missing || []
})

async function load() {
  loading.value = true
  try {
    const { data } = await api.get(`/inventory/stocktake/${route.params.id}`)
    session.value = data
    // 默认 Tab：有盘亏看盘亏，否则有盘盈看盘盈，再否则看相符
    if (data.diff_result) {
      if (data.diff_result.missing.length) activeTab.value = 'missing'
      else if (data.diff_result.surplus.length) activeTab.value = 'surplus'
      else activeTab.value = 'matched'
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function openSku(row) {
  if (!row?.sku_code) return
  detailVisible.value = true
  detailLoading.value = true
  detailSku.value = null
  try {
    const { data } = await api.get(`/inventory/skus/${row.sku_code}`)
    detailSku.value = data
  } catch (err) {
    detailVisible.value = false
    ElMessage.warning(err.response?.data?.detail || '该货号在系统中不存在')
  } finally {
    detailLoading.value = false
  }
}

// 一键平账：自动生成处理方案 → 提交 → 审批通过(报损盘亏 / 盈库盘盈 / 外来标签忽略)
async function settle() {
  const m = diff.value?.missing?.length || 0
  const s = diff.value?.surplus?.length || 0
  await ElMessageBox.confirm(
    `将对本次盘点差异执行平账：盘亏 ${m} 件报损出库、盘盈中系统存在的货盈库入库、外来标签忽略。确认继续？`,
    '一键平账',
    { type: 'warning' },
  )
  loading.value = true
  try {
    const id = route.params.id
    await api.post(`/inventory/stocktake/${id}/proposals/auto`, {})
    await api.post(`/inventory/stocktake/${id}/submit`, {})
    const { data } = await api.post(`/inventory/stocktake/${id}/approve`, {})
    session.value = data
    ElMessage.success('已平账，库存已调整')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '平账失败')
    await load()
  } finally {
    loading.value = false
  }
}

async function approve() {
  await ElMessageBox.confirm('确认审批通过并执行平账？', '审批确认', { type: 'warning' })
  try {
    const { data } = await api.post(`/inventory/stocktake/${route.params.id}/approve`, {})
    session.value = data
    ElMessage.success('审批通过，库存已平账')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '审批失败')
  }
}

async function reject() {
  const { value } = await ElMessageBox.prompt('请输入驳回原因', '驳回审批', { inputPlaceholder: '驳回原因' })
  try {
    const { data } = await api.post(`/inventory/stocktake/${route.params.id}/reject`, { comment: value || '审批驳回' })
    session.value = data
    ElMessage.success('已驳回')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '操作失败')
  }
}

function adjustLabel(item) {
  if (item.adjust_type === 'LOSS') return '报损'
  if (item.adjust_type === 'OVERFLOW') return '盈出入库'
  return '忽略'
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <div class="page-card" v-if="session">
      <div class="page-card__header">
        <div>
          <el-button link @click="router.back()">← 返回</el-button>
          <h3 class="page-card__title">{{ session.session_no }}</h3>
        </div>
        <el-tag :type="stocktakeStatusTypes[session.status] || 'info'">
          {{ stocktakeStatusLabels[session.status] || session.status }}
        </el-tag>
      </div>

      <div class="detail-meta">
        <span>操作员：{{ session.operator_name || '—' }}</span>
        <span>开始：{{ formatDateTime(session.started_at) }}</span>
        <span>结束：{{ formatDateTime(session.completed_at) }}</span>
      </div>

      <div class="detail-stats" v-if="diff">
        <div class="stat-box">账实相符 {{ diff.matched_count }}</div>
        <div class="stat-box stat-box--danger">盘亏 {{ diff.missing.length }}</div>
        <div class="stat-box stat-box--warning">盘盈 {{ diff.surplus.length }}</div>
      </div>

      <!-- 差异明细：账实相符 / 盘亏 / 盘盈,带商品图,可点查看详情 -->
      <div class="page-card__body" v-if="diff">
        <el-tabs v-model="activeTab">
          <el-tab-pane :label="`账实相符 ${diff.matched_count}`" name="matched" />
          <el-tab-pane :label="`盘亏 ${diff.missing.length}`" name="missing" />
          <el-tab-pane :label="`盘盈 ${diff.surplus.length}`" name="surplus" />
        </el-tabs>
        <el-table :data="currentItems" stripe empty-text="该分类暂无商品" @row-click="openSku">
          <el-table-column label="图片" width="80">
            <template #default="{ row }">
              <el-image
                v-if="row.cover_url"
                :src="row.cover_url"
                fit="cover"
                style="width: 48px; height: 48px; border-radius: 6px"
                :preview-src-list="[row.cover_url]"
                @click.stop
              />
              <div v-else class="no-img">无图</div>
            </template>
          </el-table-column>
          <el-table-column prop="sku_code" label="货号" min-width="160" />
          <el-table-column prop="product_name" label="品名" min-width="180" show-overflow-tooltip />
          <el-table-column prop="spec" label="规格" min-width="120" show-overflow-tooltip />
          <el-table-column prop="location_code" label="库位" width="110">
            <template #default="{ row }">{{ row.location_code || '—' }}</template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 差异处理方案(平账后显示已执行的调整) -->
      <div class="page-card__body" v-if="session.proposals && session.proposals.length">
        <h4>处理方案</h4>
        <el-table :data="session.proposals" stripe>
          <el-table-column prop="sku_code" label="货号" min-width="160" />
          <el-table-column label="差异类型" width="100">
            <template #default="{ row }">{{ row.diff_type === 'MISSING' ? '盘亏' : '盘盈' }}</template>
          </el-table-column>
          <el-table-column label="处理方式" width="120">
            <template #default="{ row }">{{ adjustLabel(row) }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">{{ proposalStatusLabels[row.status] || row.status }}</template>
          </el-table-column>
          <el-table-column prop="adjust_no" label="调整单号" min-width="140">
            <template #default="{ row }">{{ row.adjust_no || '—' }}</template>
          </el-table-column>
        </el-table>
      </div>

      <div v-if="session.review_comment" class="review-comment">
        审批意见：{{ session.review_comment }}
      </div>

      <div class="review-actions">
        <template v-if="canSettle">
          <span class="hint">本次盘点存在差异,可一键平账处理</span>
          <el-button type="primary" @click="settle">一键平账(报损/盈库)</el-button>
        </template>
        <template v-else-if="canReview">
          <el-button @click="reject">驳回</el-button>
          <el-button type="primary" @click="approve">一键审批通过</el-button>
        </template>
        <span v-else-if="session.status === 'APPROVED'" class="hint hint--ok">✔ 已平账,无需处理</span>
      </div>
    </div>

    <!-- 商品详情弹窗 -->
    <el-dialog v-model="detailVisible" title="商品详情" width="420px">
      <div v-loading="detailLoading">
        <div v-if="detailSku" class="sku-detail">
          <el-image
            v-if="detailSku.cover_url"
            :src="detailSku.cover_url"
            fit="cover"
            style="width: 100%; height: 220px; border-radius: 8px; margin-bottom: 12px"
          />
          <div class="sku-row"><span>货号</span>{{ detailSku.sku_code }}</div>
          <div class="sku-row"><span>品名</span>{{ detailSku.product_name || '—' }}</div>
          <div class="sku-row"><span>品牌</span>{{ detailSku.brand || '—' }}</div>
          <div class="sku-row"><span>规格</span>{{ detailSku.spec || '—' }}</div>
          <div class="sku-row"><span>库位</span>{{ detailSku.location_code || '—' }}</div>
          <div class="sku-row"><span>状态</span>{{ detailSku.status }}</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.detail-meta {
  display: flex;
  gap: 24px;
  padding: 0 20px 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.detail-stats {
  display: flex;
  gap: 12px;
  padding: 0 20px 16px;
}

.stat-box {
  padding: 10px 16px;
  border-radius: 8px;
  background: #f5f7fa;
  font-size: 14px;
}

.stat-box--danger { background: #fef0f0; color: #c94444; }
.stat-box--warning { background: #fef9e7; color: #b8960c; }

.no-img {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  background: #f0f1f3;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #bbb;
}

.review-comment {
  margin: 0 20px 16px;
  padding: 12px 16px;
  background: #fef0f0;
  border-radius: 8px;
  color: #c94444;
}

.review-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 12px 20px 20px;
}

.hint { font-size: 13px; color: var(--text-secondary); }
.hint--ok { color: #67c23a; }

.sku-row {
  display: flex;
  gap: 12px;
  padding: 6px 0;
  font-size: 14px;
  border-bottom: 1px solid #f2f2f2;
}
.sku-row span { width: 56px; color: var(--text-secondary); flex-shrink: 0; }

h4 { margin: 0 0 12px; padding: 0 20px; }
:deep(.el-table) { cursor: pointer; }
</style>
