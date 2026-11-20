<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const loading = ref(false)
const list = ref([])
const editVisible = ref(false)
const editForm = ref({ id: '', unit_price: 0, deposit_amount: 0, final_amount: 0, remark: '' })

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/switch/orders', { params: { size: 100 } })
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function openEdit(row) {
  editForm.value = {
    id: row.id,
    unit_price: Number(row.unit_price),
    deposit_amount: Number(row.deposit_amount || 0),
    final_amount: Number(row.final_amount || 0),
    remark: row.remark || '',
  }
  editVisible.value = true
}

async function saveEdit() {
  try {
    await api.patch(`/switch/orders/${editForm.value.id}`, {
      unit_price: editForm.value.unit_price,
      deposit_amount: editForm.value.deposit_amount || null,
      final_amount: editForm.value.final_amount || null,
      remark: editForm.value.remark,
    })
    ElMessage.success('已保存')
    editVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

async function review(row, approved) {
  const action = approved ? '通过' : '拒绝'
  try {
    await ElMessageBox.confirm(`确定${action}截单 ${row.switch_no}？`, '截单审批', { type: 'warning' })
    await api.post(`/switch/orders/${row.id}/review-cutoff`, { approved })
    ElMessage.success(`已${action}`)
    await load()
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '操作失败')
  }
}

const statusMap = { ACTIVE: '进行中', COMPLETED: '已完成', CANCELLED: '已取消' }
const cutoffMap = { NONE: '-', PENDING: '待审批', APPROVED: '已通过', REJECTED: '已拒绝' }

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">切单管理</h3></div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="switch_no" label="切单号" width="160" />
        <el-table-column prop="sku_code" label="货号" width="140" />
        <el-table-column prop="product_name" label="商品" min-width="160" />
        <el-table-column prop="unit_price" label="单价" width="100" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ statusMap[row.status] || row.status }}</template>
        </el-table-column>
        <el-table-column label="截单" width="100">
          <template #default="{ row }">{{ cutoffMap[row.cutoff_status] || row.cutoff_status }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">修改</el-button>
            <template v-if="row.cutoff_status === 'PENDING'">
              <el-button link type="success" @click="review(row, true)">通过</el-button>
              <el-button link type="danger" @click="review(row, false)">拒绝</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
  <el-dialog v-model="editVisible" title="修改切单" width="420px">
    <el-form label-position="top">
      <el-form-item label="单价"><el-input-number v-model="editForm.unit_price" :min="0" :precision="2" style="width:100%" /></el-form-item>
      <el-form-item label="定金"><el-input-number v-model="editForm.deposit_amount" :min="0" :precision="2" style="width:100%" /></el-form-item>
      <el-form-item label="尾款"><el-input-number v-model="editForm.final_amount" :min="0" :precision="2" style="width:100%" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="editForm.remark" type="textarea" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>
</template>
