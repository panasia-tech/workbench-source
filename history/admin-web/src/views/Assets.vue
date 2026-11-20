<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime, formatPrice } from '../utils/labels'

const assetStatusLabels = {
  IDLE: '在库',
  IN_USE: '使用中',
  SCRAPPED: '已报废',
  SOLD: '已售出',
}

const assetStatusTypes = {
  IDLE: 'info',
  IN_USE: 'success',
  SCRAPPED: 'warning',
  SOLD: 'danger',
}

const loading = ref(false)
const list = ref([])
const q = ref('')
const pagination = ref({ page: 1, size: 20, total: 0 })

const formVisible = ref(false)
const formSaving = ref(false)
const isEdit = ref(false)
const editId = ref('')
const form = ref({})

const purchaseSearchQ = ref('')
const purchaseResults = ref([])
const purchaseSearching = ref(false)

const defaultForm = () => ({
  asset_no: '',
  device_name: '',
  device_sn: '',
  device_type: '',
  brand: '',
  model: '',
  spec: '',
  unit_price: null,
  cost: 0,
  owner_name: '',
  owner_account: '',
  office_site: '',
  status: 'IDLE',
  purpose: '',
  purchase_date: '',
  remark: '',
  purchase_order_id: '',
  purchase_order_no: '',
  product_images: [],
  image_files: [],
})

onMounted(() => load())

async function load() {
  loading.value = true
  try {
    const params = { page: pagination.value.page, size: pagination.value.size }
    if (q.value.trim()) params.q = q.value.trim()
    const { data } = await api.get('/asset/devices', { params })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
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

function openCreate() {
  isEdit.value = false
  editId.value = ''
  form.value = defaultForm()
  purchaseSearchQ.value = ''
  purchaseResults.value = []
  formVisible.value = true
}

function openEdit(row) {
  isEdit.value = true
  editId.value = row.id
  api.get(`/asset/devices/${row.id}`).then(({ data }) => {
    form.value = {
      asset_no: data.asset_no || '',
      device_name: data.device_name || '',
      device_sn: data.device_sn || '',
      device_type: data.device_type || '',
      brand: data.brand || '',
      model: data.model || '',
      spec: data.spec || '',
      unit_price: data.unit_price,
      cost: data.cost,
      owner_name: data.owner_name || '',
      owner_account: data.owner_account || '',
      office_site: data.office_site || '',
      status: data.status || 'IDLE',
      purpose: data.purpose || '',
      purchase_date: data.purchase_date || '',
      remark: data.remark || '',
      purchase_order_id: data.purchase_order_id || '',
      purchase_order_no: data.purchase_order_no || '',
      product_images: data.product_images || [],
      image_files: data.image_files || [],
    }
    purchaseSearchQ.value = ''
    purchaseResults.value = []
    formVisible.value = true
  }).catch((err) => {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  })
}

async function searchPurchaseOrders(query) {
  if (!query.trim()) {
    purchaseResults.value = []
    return
  }
  purchaseSearching.value = true
  try {
    const { data } = await api.get('/purchase/orders', { params: { q: query.trim(), size: 10 } })
    purchaseResults.value = data.items || []
  } catch {
    purchaseResults.value = []
  } finally {
    purchaseSearching.value = false
  }
}

function selectPurchase(po) {
  form.value.purchase_order_id = po.id
  form.value.purchase_order_no = po.order_no
  if (!form.value.brand) form.value.brand = po.brand || ''
  if (!form.value.model) form.value.model = po.model || ''
  if (!form.value.spec) form.value.spec = po.spec || ''
  if (!form.value.unit_price) form.value.unit_price = po.unit_price
  if (!form.value.product_images.length) form.value.product_images = po.product_images || []
  if (!form.value.device_name) form.value.device_name = po.product_name || ''
  purchaseSearchQ.value = ''
  purchaseResults.value = []
}

function clearPurchase() {
  form.value.purchase_order_id = ''
  form.value.purchase_order_no = ''
}

async function save() {
  if (!form.value.device_name.trim()) {
    ElMessage.warning('请输入设备名称')
    return
  }
  formSaving.value = true
  try {
    const payload = {
      ...form.value,
      asset_no: form.value.asset_no.trim() || undefined,
      device_name: form.value.device_name.trim(),
      device_sn: form.value.device_sn.trim() || undefined,
      device_type: form.value.device_type.trim() || undefined,
      brand: form.value.brand.trim() || undefined,
      model: form.value.model.trim() || undefined,
      spec: form.value.spec.trim() || undefined,
      unit_price: form.value.unit_price || undefined,
      cost: form.value.cost || 0,
      owner_name: form.value.owner_name.trim() || undefined,
      office_site: form.value.office_site.trim() || undefined,
      purpose: form.value.purpose.trim() || undefined,
      purchase_date: form.value.purchase_date || undefined,
      remark: form.value.remark.trim() || undefined,
      purchase_order_id: form.value.purchase_order_id || undefined,
      purchase_order_no: form.value.purchase_order_no || undefined,
    }
    if (isEdit.value) {
      await api.put(`/asset/devices/${editId.value}`, payload)
      ElMessage.success('已保存')
    } else {
      await api.post('/asset/devices', payload)
      ElMessage.success('已创建')
    }
    formVisible.value = false
    load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    formSaving.value = false
  }
}

async function deleteDevice(row) {
  try {
    await ElMessageBox.confirm(`确认删除资产 ${row.asset_no}？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.delete(`/asset/devices/${row.id}`)
    ElMessage.success('已删除')
    load()
  } catch { /* cancelled */ }
}
</script>

<template>
  <div class="page-container">
    <!-- Search -->
    <el-card class="search-card">
      <div class="search-row">
        <el-input
          v-model="q"
          placeholder="搜索资产编号 / 名称 / SN / 品牌 / 型号"
          clearable
          :prefix-icon="Search"
          @keyup.enter="onSearch"
          @clear="onSearch"
          class="search-input"
        />
        <el-button type="primary" @click="onSearch">搜索</el-button>
        <el-button type="success" @click="openCreate">新建资产</el-button>
      </div>
    </el-card>

    <!-- Table -->
    <el-card>
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="asset_no" label="资产编号" min-width="140" />
        <el-table-column prop="device_name" label="设备名称" min-width="140" />
        <el-table-column label="品牌型号" min-width="160">
          <template #default="{ row }">
            {{ [row.brand, row.model, row.spec].filter(Boolean).join(' · ') || '—' }}
          </template>
        </el-table-column>
        <el-table-column prop="device_sn" label="SN" min-width="120" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="assetStatusTypes[row.status] || 'info'" size="small">
              {{ assetStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="office_site" label="地点" width="80" />
        <el-table-column prop="purchase_order_no" label="来源采购单" min-width="130">
          <template #default="{ row }">
            <span v-if="row.purchase_order_no" style="color: #2563EB; cursor: pointer">{{ row.purchase_order_no }}</span>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="110">
          <template #default="{ row }">{{ formatPrice(row.cost) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" link @click="deleteDevice(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.size"
        :total="pagination.total"
        :page-sizes="[10, 20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @current-change="onPageChange"
        @size-change="onSizeChange"
        style="margin-top: 16px; justify-content: flex-end"
      />
    </el-card>

    <!-- Form Dialog -->
    <el-dialog
      v-model="formVisible"
      :title="isEdit ? '编辑资产' : '新建资产'"
      width="680px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="100px" label-position="right">
        <!-- Purchase order linkage -->
        <el-form-item label="采购单来源">
          <div v-if="form.purchase_order_id" class="po-linked">
            <span>已关联：{{ form.purchase_order_no }}</span>
            <el-button size="small" type="danger" link @click="clearPurchase">× 取消关联</el-button>
          </div>
          <el-select
            v-else
            v-model="purchaseSearchQ"
            filterable
            remote
            reserve-keyword
            placeholder="输入采购单号搜索…"
            :remote-method="searchPurchaseOrders"
            :loading="purchaseSearching"
            style="width: 100%"
            @change="(val) => { const po = purchaseResults.find(p => p.id === val); if (po) selectPurchase(po) }"
          >
            <el-option
              v-for="po in purchaseResults"
              :key="po.id"
              :label="`${po.order_no} — ${po.product_name}${po.brand ? ' ' + po.brand : ''}${po.model ? ' ' + po.model : ''}`"
              :value="po.id"
            />
          </el-select>
        </el-form-item>

        <el-divider />

        <el-form-item label="设备名称" required>
          <el-input v-model="form.device_name" placeholder="如 iPhone 14 Pro Max" />
        </el-form-item>
        <el-form-item label="资产编号">
          <el-input v-model="form.asset_no" placeholder="留空自动生成" />
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="品牌">
              <el-input v-model="form.brand" placeholder="品牌" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="型号">
              <el-input v-model="form.model" placeholder="型号" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="规格">
              <el-input v-model="form.spec" placeholder="规格" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="设备类型">
              <el-input v-model="form.device_type" placeholder="如 显示器/手机" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="设备 SN">
          <el-input v-model="form.device_sn" placeholder="序列号" />
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="单价">
              <el-input-number v-model="form.unit_price" :precision="2" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="成本">
              <el-input-number v-model="form.cost" :precision="2" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider>归属信息</el-divider>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="使用人">
              <el-input v-model="form.owner_name" placeholder="姓名" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="办公地点">
              <el-input v-model="form.office_site" placeholder="如 杭州/深圳" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="状态">
          <el-select v-model="form.status" style="width: 100%">
            <el-option label="在库" value="IDLE" />
            <el-option label="使用中" value="IN_USE" />
            <el-option label="已报废" value="SCRAPPED" />
            <el-option label="已售出" value="SOLD" />
          </el-select>
        </el-form-item>

        <el-form-item label="用途">
          <el-input v-model="form.purpose" placeholder="用途说明" />
        </el-form-item>

        <el-form-item label="购入日期">
          <el-date-picker v-model="form.purchase_date" type="date" placeholder="选择日期" style="width: 100%" />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="备注" />
        </el-form-item>

        <el-form-item label="设备图片">
          <div class="image-list">
            <div v-for="(url, i) in form.image_files" :key="i" class="image-item">
              <img :src="url" class="image-thumb" />
              <el-button
                class="image-remove-btn"
                size="small"
                type="danger"
                circle
                :icon="'Close'"
                @click="form.image_files.splice(i, 1)"
              />
            </div>
          </div>
          <span class="text-muted" style="font-size: 12px">图片通过小程序端上传</span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="formSaving" @click="save">
          {{ isEdit ? '保存修改' : '创建资产' }}
        </el-button>
      </template>
    </el-dialog>
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

.search-input {
  max-width: 400px;
}

.text-muted {
  color: #9CA3AF;
}

.po-linked {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #EFF6FF;
  border: 1px solid #BFDBFE;
  border-radius: 6px;
  color: #2563EB;
  font-size: 14px;
  width: 100%;
  justify-content: space-between;
}

.image-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.image-item {
  position: relative;
}

.image-thumb {
  width: 80px;
  height: 80px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid #E5E7EB;
}

.image-remove-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
}
</style>
