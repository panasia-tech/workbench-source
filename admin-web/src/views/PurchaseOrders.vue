<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Search } from '@element-plus/icons-vue'
import api from '../api'
import MediaGallery from '../components/MediaGallery.vue'
import MediaThumb from '../components/MediaThumb.vue'
import { blobErrorDetail, downloadBlob } from '../utils/download'
import { formatDateTime, formatPrice, orderStatusLabels, orderStatusTypes } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const q = ref('')
const dateRange = ref([])
const pagination = ref({ page: 1, size: 20, total: 0 })
const detailVisible = ref(false)
const detailOrder = ref(null)
const detailLoading = ref(false)
const purchaseAccounts = ref([])

const editVisible = ref(false)
const editSaving = ref(false)
const editForm = ref(null)

const changesVisible = ref(false)
const changesLoading = ref(false)
const changeLogs = ref([])

async function load() {
  loading.value = true
  try {
    const params = {
      page: pagination.value.page,
      size: pagination.value.size,
    }
    if (q.value.trim()) params.q = q.value.trim()
    if (dateRange.value?.length === 2) {
      params.date_from = dateRange.value[0]
      params.date_to = dateRange.value[1]
    }
    const { data } = await api.get('/purchase/orders', { params })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载采购订单失败')
  } finally {
    loading.value = false
  }
}

function onSearch() {
  pagination.value.page = 1
  load()
}

const exporting = ref(false)

async function onExport() {
  exporting.value = true
  try {
    const params = {}
    if (q.value.trim()) params.q = q.value.trim()
    if (dateRange.value?.length === 2) {
      params.date_from = dateRange.value[0]
      params.date_to = dateRange.value[1]
    }
    const resp = await api.get('/purchase/orders/export', { params, responseType: 'blob' })
    const range = dateRange.value?.length === 2 ? `${dateRange.value[0]}_${dateRange.value[1]}` : '全部'
    downloadBlob(resp.data, `采购记录_${range}.xlsx`)
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

function productDesc(row) {
  const parts = [row.brand, row.model, row.spec].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

// 一单多件、分次到货（禅道 WH01-04）：每件一张验货单，没到的件标没到货跟退款
const pieces = ref(null)
const qtyInput = ref(1)
const pieceSaving = ref(false)
const refundLabels = { PENDING: '待申请', APPLIED: '已申请', ACCEPTED: '已受理', PARTIAL: '部分到账', RECEIVED: '已到账', DENIED: '被驳回', NOT_NEEDED: '不用退' }

async function loadPieces(id) {
  try {
    const { data } = await api.get(`/purchase/orders/${id}/pieces`)
    pieces.value = data
    qtyInput.value = data.quantity
  } catch {
    pieces.value = null
  }
}

async function refreshOrder() {
  const { data } = await api.get(`/purchase/orders/${detailOrder.value.id}`)
  detailOrder.value = data
}

async function saveQuantity() {
  pieceSaving.value = true
  try {
    const { data } = await api.put(`/purchase/orders/${detailOrder.value.id}/quantity`, { quantity: qtyInput.value })
    pieces.value = data
    await refreshOrder()
    ElMessage.success(`已改为 ${data.quantity} 件`)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    pieceSaving.value = false
  }
}

async function markMissing(p) {
  let reason
  try {
    ;({ value: reason } = await ElMessageBox.prompt(
      `第 ${p.piece_no} 件按 ¥${p.cost} 开退款跟踪，不用退回。写明情况：`,
      '标记没到货',
      { inputPlaceholder: '比如：卖家说只剩 2 件', confirmButtonText: '确认没到货', cancelButtonText: '取消' },
    ))
  } catch {
    return
  }
  try {
    const { data } = await api.post(`/purchase/orders/${detailOrder.value.id}/pieces/${p.piece_no}/missing`, { reason })
    pieces.value = data
    await refreshOrder()
    ElMessage.success('已标没到货，退款进度在「验货异常」里跟')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '提交失败')
  }
}

async function showDetail(row) {
  detailLoading.value = true
  detailVisible.value = true
  detailOrder.value = null
  pieces.value = null
  try {
    const { data } = await api.get(`/purchase/orders/${row.id}`)
    detailOrder.value = data
    await loadPieces(row.id)
  } catch (err) {
    detailVisible.value = false
    ElMessage.error(err.response?.data?.detail || '加载订单详情失败')
  } finally {
    detailLoading.value = false
  }
}

async function loadAccounts() {
  try {
    const { data } = await api.get('/master/purchase-accounts')
    purchaseAccounts.value = data || []
  } catch {
    purchaseAccounts.value = []
  }
}

function openEdit() {
  const o = detailOrder.value
  if (!o) return
  editForm.value = {
    brand: o.brand || '',
    model: o.model || '',
    spec: o.spec || '',
    unit_price: o.unit_price != null ? Number(o.unit_price) : null,
    external_order_no: o.external_order_no || '',
    transaction_no: o.transaction_no || '',
    tracking_no: o.tracking_no || '',
    tracking_phone_suffix: o.tracking_phone_suffix || '',
    seller_name: o.seller_name || '',
    purchase_account: o.purchase_account || '',
    order_time: o.order_time || '',
    paid_at: o.paid_at || '',
    remark: o.remark || '',
    is_overdue: !!o.is_overdue,
    condition_warning: !!o.condition_warning,
  }
  editVisible.value = true
}

async function submitEdit() {
  const o = detailOrder.value
  if (!o) return
  const f = editForm.value
  if (!f.brand.trim() || !f.model.trim()) {
    ElMessage.warning('品牌与型号不能为空')
    return
  }
  if (f.unit_price == null || Number(f.unit_price) <= 0) {
    ElMessage.warning('请填写正确的成交金额')
    return
  }
  editSaving.value = true
  try {
    const payload = {
      brand: f.brand.trim(),
      model: f.model.trim(),
      spec: f.spec.trim() || null,
      unit_price: Number(f.unit_price),
      external_order_no: f.external_order_no.trim() || null,
      transaction_no: f.transaction_no.trim() || null,
      tracking_no: f.tracking_no.trim() || null,
      tracking_phone_suffix: (f.tracking_phone_suffix || '').replace(/\D/g, '').slice(0, 4) || null,
      seller_name: f.seller_name.trim() || null,
      purchase_account: f.purchase_account || null,
      order_time: f.order_time || null,
      paid_at: f.paid_at || null,
      remark: f.remark.trim() || null,
      is_overdue: !!f.is_overdue,
      condition_warning: !!f.condition_warning,
    }
    const { data } = await api.put(`/purchase/orders/${o.id}`, payload)
    detailOrder.value = data
    editVisible.value = false
    ElMessage.success('已保存修改')
    load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    editSaving.value = false
  }
}

async function openChanges() {
  const o = detailOrder.value
  if (!o) return
  changesVisible.value = true
  changesLoading.value = true
  changeLogs.value = []
  try {
    const { data } = await api.get(`/purchase/orders/${o.id}/changes`)
    changeLogs.value = data.items || []
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载修改记录失败')
  } finally {
    changesLoading.value = false
  }
}

const deleting = ref(false)

async function deleteOrder() {
  const o = detailOrder.value
  if (!o) return
  try {
    await ElMessageBox.confirm(
      `确认删除采购单 ${o.order_no}？该操作不可恢复。`,
      '删除采购单',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  deleting.value = true
  try {
    await api.delete(`/purchase/orders/${o.id}`)
    detailVisible.value = false
    ElMessage.success('已删除采购单')
    load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '删除失败')
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  load()
  loadAccounts()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">采购订单</h3>
      <div class="page-card__actions toolbar">
        <el-input
          v-model="q"
          placeholder="搜索单号/商品/品牌/卖家"
          clearable
          style="width: 240px"
          @keyup.enter="onSearch"
          @clear="onSearch"
        />
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
        <el-button :icon="Download" :loading="exporting" @click="onExport">导出</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无采购订单" @row-click="showDetail">
        <el-table-column prop="order_no" label="单号" min-width="160" fixed />
        <el-table-column label="商品" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <el-tag v-if="row.quantity > 1" size="small" style="margin-right: 4px">{{ row.quantity }} 件</el-tag>{{ row.product_name }}
          </template>
        </el-table-column>
        <el-table-column label="规格" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ productDesc(row) }}</template>
        </el-table-column>
        <el-table-column label="单价" min-width="100" align="right">
          <template #default="{ row }">{{ formatPrice(row.unit_price) }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="120">
          <template #default="{ row }">
            <el-tag v-if="row.is_overdue" type="danger" size="small" effect="dark" style="margin-right: 4px">逾期采购</el-tag>
            <el-tag v-if="row.is_unnegotiated" type="warning" size="small" effect="dark" style="margin-right: 4px">未议价</el-tag>
            <el-tag v-if="row.condition_warning" type="danger" size="small" effect="dark" style="margin-right: 4px">⚠{{ row.condition_warning_text || '全新' }}</el-tag>
            <el-tag :type="orderStatusTypes[row.status] || 'info'" size="small">
              {{ orderStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="seller_name" label="卖家" min-width="100" show-overflow-tooltip>
          <template #default="{ row }">{{ row.seller_name || '—' }}</template>
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

    <el-dialog v-model="detailVisible" title="采购订单详情" width="600px" destroy-on-close>
      <div v-loading="detailLoading">
        <template v-if="detailOrder">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="单号">{{ detailOrder.order_no }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag v-if="detailOrder.is_overdue" type="danger" size="small" effect="dark" style="margin-right: 4px">逾期采购</el-tag>
              <el-tag v-if="detailOrder.is_unnegotiated" type="warning" size="small" effect="dark" style="margin-right: 4px">未议价</el-tag>
              <el-tag v-if="detailOrder.condition_warning" type="danger" size="small" effect="dark" style="margin-right: 4px">⚠{{ detailOrder.condition_warning_text || '全新' }}</el-tag>
              <el-tag :type="orderStatusTypes[detailOrder.status] || 'info'" size="small">
                {{ orderStatusLabels[detailOrder.status] || detailOrder.status }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="商品" :span="2">{{ detailOrder.product_name }}</el-descriptions-item>
            <el-descriptions-item label="规格" :span="2">{{ productDesc(detailOrder) }}</el-descriptions-item>
            <el-descriptions-item label="单价">{{ formatPrice(detailOrder.unit_price) }}<span v-if="detailOrder.quantity > 1" class="muted">（{{ detailOrder.quantity }} 件均摊）</span></el-descriptions-item>
            <el-descriptions-item label="卖家">{{ detailOrder.seller_name || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="pieces" class="detail-media">
            <div class="detail-media__label">
              分件到货：共 {{ pieces.quantity }} 件 · 已到 {{ pieces.arrived }} 件<template v-if="pieces.missing"> · 没到货 {{ pieces.missing }} 件</template><template v-if="pieces.quantity - pieces.done"> · 还差 {{ pieces.quantity - pieces.done }} 件</template>
            </div>
            <div v-if="pieces.can_set_quantity" class="pieces-qty">
              <span>同一件商品买了几件</span>
              <el-input-number v-model="qtyInput" :min="1" :max="50" size="small" controls-position="right" />
              <el-button size="small" type="primary" :loading="pieceSaving" :disabled="qtyInput === pieces.quantity" @click="saveQuantity">保存件数</el-button>
            </div>
            <el-table v-if="pieces.quantity > 1" :data="pieces.pieces" size="small" border>
              <el-table-column label="件" width="56"><template #default="{ row }">第 {{ row.piece_no }}</template></el-table-column>
              <el-table-column label="状态" width="92">
                <template #default="{ row }">
                  <el-tag size="small" :type="row.status === 'PENDING' ? 'warning' : row.action_type === 'INBOUND' ? 'success' : 'danger'">{{ row.state }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="金额" width="80"><template #default="{ row }">¥{{ row.cost }}</template></el-table-column>
              <el-table-column label="货号 / 情况" min-width="120">
                <template #default="{ row }">
                  {{ row.sku_code || row.remark || row.inspect_no }}
                  <span v-if="row.refund_status" class="muted">退款{{ refundLabels[row.refund_status] || row.refund_status }}</span>
                </template>
              </el-table-column>
              <el-table-column label="" width="84">
                <template #default="{ row }">
                  <el-button v-if="row.status === 'PENDING'" link type="danger" size="small" @click="markMissing(row)">没到货</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <div v-if="detailOrder.product_images?.length" class="detail-media">
            <div class="detail-media__label">商品图</div>
            <MediaGallery :urls="detailOrder.product_images" thumb-size="medium" />
          </div>
          <div v-if="detailOrder.screenshot_url || detailOrder.screenshot_url_2" class="detail-media">
            <div class="detail-media__label">闲鱼截图</div>
            <div class="detail-media__row">
              <MediaThumb v-if="detailOrder.screenshot_url" :url="detailOrder.screenshot_url" size="large" />
              <MediaThumb v-if="detailOrder.screenshot_url_2" :url="detailOrder.screenshot_url_2" size="large" />
            </div>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button
          v-if="detailOrder && detailOrder.status === 'PENDING_INSPECT'"
          type="danger"
          plain
          :loading="deleting"
          @click="deleteOrder"
        >删除</el-button>
        <el-button @click="openChanges" :disabled="!detailOrder">修改记录</el-button>
        <el-button type="primary" @click="openEdit" :disabled="!detailOrder">编辑</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑采购单" width="560px" destroy-on-close>
      <el-form v-if="editForm" :model="editForm" label-width="92px" size="default">
        <el-form-item label="成交金额" required>
          <el-input-number v-model="editForm.unit_price" :min="0" :precision="2" :step="100" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="品牌" required>
          <el-input v-model="editForm.brand" />
        </el-form-item>
        <el-form-item label="型号" required>
          <el-input v-model="editForm.model" />
        </el-form-item>
        <el-form-item label="规格">
          <el-input v-model="editForm.spec" />
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="editForm.purchase_account" clearable filterable placeholder="选择采购账号" style="width: 100%">
            <el-option v-for="acc in purchaseAccounts" :key="acc.code" :label="`${acc.label}（${acc.code}）`" :value="acc.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="卖家昵称">
          <el-input v-model="editForm.seller_name" />
        </el-form-item>
        <el-form-item label="闲鱼订单号">
          <el-input v-model="editForm.external_order_no" />
        </el-form-item>
        <el-form-item label="交易流水号">
          <el-input v-model="editForm.transaction_no" />
        </el-form-item>
        <el-form-item label="物流单号">
          <el-input v-model="editForm.tracking_no" />
        </el-form-item>
        <el-form-item label="手机后四位">
          <el-input v-model="editForm.tracking_phone_suffix" maxlength="4" placeholder="顺丰查询选填，收/寄件人手机号后 4 位" />
        </el-form-item>
        <el-form-item label="下单时间">
          <el-date-picker v-model="editForm.order_time" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
        <el-form-item label="付款时间">
          <el-date-picker v-model="editForm.paid_at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="逾期采购">
          <el-switch v-model="editForm.is_overdue" active-color="#DC2626" />
          <span class="overdue-hint">开启后该单不发放采购基础提成</span>
        </el-form-item>
        <el-form-item label="货况警示">
          <el-switch v-model="editForm.condition_warning" active-color="#DC2626" />
          <span class="overdue-hint">实拍图疑似全新时自动开启；OCR 误报可在此关闭</span>
        </el-form-item>
      </el-form>
      <div class="edit-hint">商品图、闲鱼截图请在小程序端编辑，此处不改动。</div>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="changesVisible" title="修改记录" width="640px" destroy-on-close>
      <div v-loading="changesLoading">
        <el-empty v-if="!changesLoading && !changeLogs.length" description="暂无修改记录" />
        <el-timeline v-else>
          <el-timeline-item
            v-for="log in changeLogs"
            :key="log.id"
            :timestamp="`${formatDateTime(log.created_at)} · ${log.operator_name || '—'}`"
            placement="top"
          >
            <el-tag v-if="log.cost_synced" type="warning" size="small" effect="plain" class="change-cost-tag">已联动回写成本价</el-tag>
            <el-table :data="log.changes" size="small" border>
              <el-table-column prop="label" label="字段" width="120" />
              <el-table-column label="修改前">
                <template #default="{ row }"><span class="change-old">{{ row.old || '空' }}</span></template>
              </el-table-column>
              <el-table-column label="修改后">
                <template #default="{ row }"><span class="change-new">{{ row.new || '空' }}</span></template>
              </el-table-column>
            </el-table>
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.muted {
  margin-left: 4px;
  color: #909399;
  font-size: 12px;
}
.pieces-qty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

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

.detail-media__row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.edit-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.overdue-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-secondary);
}

.change-cost-tag {
  margin-bottom: 8px;
}

.change-old {
  color: var(--color-danger, #dc2626);
  text-decoration: line-through;
}

.change-new {
  color: var(--color-success, #059669);
}

</style>
