<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const loading = ref(false)
const list = ref([])
const statusFilter = ref('OPEN')

const closeVisible = ref(false)
const closeForm = ref({ id: '', order_no: '', close_note: '' })
const closing = ref(false)

const convertVisible = ref(false)
const convertForm = ref({
  id: '', order_no: '', product_name: '',
  sku_code: '', cost_price: null, location_code: '', serial_number: '', condition_grade: '', remark: '',
})
const converting = ref(false)

const statusMap = { OPEN: '待处理', CLOSED: '已关闭', CONVERTED: '已转商品', cancelled: '已取消' }
const statusTag = { OPEN: 'warning', CLOSED: 'info', CONVERTED: 'success', cancelled: 'info' }

const filtered = computed(() =>
  statusFilter.value === 'ALL' ? list.value : list.value.filter((t) => t.status === statusFilter.value)
)

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/negotiation-tasks')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function openClose(row) {
  closeForm.value = { id: row.id, order_no: row.order_no || row.purchase_no || '-', close_note: '' }
  closeVisible.value = true
}

async function submitClose() {
  closing.value = true
  try {
    await api.post(`/negotiation-tasks/${closeForm.value.id}/close`, { close_note: closeForm.value.close_note || null })
    ElMessage.success('已关闭')
    closeVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '操作失败')
  } finally {
    closing.value = false
  }
}

function openConvert(row) {
  convertForm.value = {
    id: row.id,
    order_no: row.order_no || row.purchase_no || '-',
    product_name: row.product_name || '历史商品',
    sku_code: row.goods_code || '',
    cost_price: row.purchase_price != null ? Number(row.purchase_price) : null,
    location_code: row.location || '',
    serial_number: row.serial_no || '',
    condition_grade: '',
    remark: '',
  }
  convertVisible.value = true
}

async function submitConvert() {
  if (!convertForm.value.cost_price || convertForm.value.cost_price <= 0) {
    ElMessage.warning('请填写成本价')
    return
  }
  converting.value = true
  try {
    const { data } = await api.post(`/negotiation-tasks/${convertForm.value.id}/convert`, {
      sku_code: convertForm.value.sku_code || null,
      cost_price: convertForm.value.cost_price,
      location_code: convertForm.value.location_code || null,
      serial_number: convertForm.value.serial_number || null,
      condition_grade: convertForm.value.condition_grade || null,
      remark: convertForm.value.remark || null,
    })
    ElMessage.success(`已转为在库商品 ${data.sku_code}`)
    convertVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '操作失败')
  } finally {
    converting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">历史议价处理</h3>
      <el-radio-group v-model="statusFilter" size="small">
        <el-radio-button value="OPEN">待处理</el-radio-button>
        <el-radio-button value="CONVERTED">已转商品</el-radio-button>
        <el-radio-button value="CLOSED">已关闭</el-radio-button>
        <el-radio-button value="ALL">全部</el-radio-button>
      </el-radio-group>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="filtered" stripe>
        <el-table-column label="议价单号" width="180">
          <template #default="{ row }">{{ row.order_no || row.purchase_no || '-' }}</template>
        </el-table-column>
        <el-table-column prop="product_name" label="商品" min-width="180" show-overflow-tooltip />
        <el-table-column prop="serial_no" label="序列号" width="150" show-overflow-tooltip />
        <el-table-column prop="purchase_price" label="采购价" width="100" />
        <el-table-column prop="location" label="库位" width="90" />
        <el-table-column label="图片" width="110">
          <template #default="{ row }">
            <el-image
              v-if="row.product_images?.length"
              :src="row.product_images[0]"
              :preview-src-list="[...row.product_images, ...(row.defect_images || [])]"
              preview-teleported
              fit="cover"
              style="width: 48px; height: 48px; border-radius: 4px"
            />
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTag[row.status] || 'info'" size="small">{{ statusMap[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="close_note" label="处理备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'OPEN'">
              <el-button link type="success" @click="openConvert(row)">转为商品</el-button>
              <el-button link type="danger" @click="openClose(row)">关闭</el-button>
            </template>
            <span v-else>{{ row.closed_by_name || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <el-dialog v-model="closeVisible" title="关闭议价单" width="420px">
    <p style="margin: 0 0 12px; color: var(--el-text-color-secondary)">
      关闭 {{ closeForm.order_no }}，该单不再进入议价或上架流程。
    </p>
    <el-form label-position="top">
      <el-form-item label="关闭备注（退货/结束原因等）">
        <el-input v-model="closeForm.close_note" type="textarea" :rows="3" placeholder="例如：已退货给卖家 / 货已处理，单据结束" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="closeVisible = false">取消</el-button>
      <el-button type="danger" :loading="closing" @click="submitClose">确认关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="convertVisible" title="转为在库商品" width="480px">
    <p style="margin: 0 0 12px; color: var(--el-text-color-secondary)">
      {{ convertForm.order_no }} · {{ convertForm.product_name }}<br />
      转入后免议价，直接进入仓库上架流程（待填表 → 待创建 → 待上架）。
    </p>
    <el-form label-position="top">
      <el-form-item label="货号（留空自动生成）">
        <el-input v-model="convertForm.sku_code" placeholder="留空自动生成" />
      </el-form-item>
      <el-form-item label="成本价（必填）">
        <el-input-number v-model="convertForm.cost_price" :min="0.01" :precision="2" style="width: 100%" />
      </el-form-item>
      <el-form-item label="库位">
        <el-input v-model="convertForm.location_code" />
      </el-form-item>
      <el-form-item label="序列号">
        <el-input v-model="convertForm.serial_number" />
      </el-form-item>
      <el-form-item label="成色">
        <el-select v-model="convertForm.condition_grade" clearable placeholder="选填" style="width: 100%">
          <el-option label="95新" value="95新" />
          <el-option label="9新" value="9新" />
          <el-option label="85新" value="85新" />
          <el-option label="8新" value="8新" />
        </el-select>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="convertForm.remark" type="textarea" :rows="2" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="convertVisible = false">取消</el-button>
      <el-button type="primary" :loading="converting" @click="submitConvert">确认转入</el-button>
    </template>
  </el-dialog>
</template>
