<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const q = ref('')
const pagination = ref({ page: 1, size: 20, total: 0 })

const formVisible = ref(false)
const formSaving = ref(false)
const isEdit = ref(false)
const editId = ref('')
const form = ref({})

const CARRIER_OPTIONS = ['中国移动', '中国联通', '中国电信', '中国广电']

const defaultForm = () => ({
  name: '',
  phone_number: '',
  iccid: '',
  carrier: '',
  activation_date: '',
  plan_details: '',
  xianyu_member_name: '',
  remark: '',
})

onMounted(() => load())

async function load() {
  loading.value = true
  try {
    const params = { page: pagination.value.page, size: pagination.value.size }
    if (q.value.trim()) params.q = q.value.trim()
    const { data } = await api.get('/phone/numbers', { params })
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
  formVisible.value = true
}

function openEdit(row) {
  isEdit.value = true
  editId.value = row.id
  api.get(`/phone/numbers/${row.id}`).then(({ data }) => {
    form.value = {
      name: data.name || '',
      phone_number: data.phone_number || '',
      iccid: data.iccid || '',
      carrier: data.carrier || '',
      activation_date: data.activation_date || '',
      plan_details: data.plan_details || '',
      xianyu_member_name: data.xianyu_member_name || '',
      remark: data.remark || '',
    }
    formVisible.value = true
  }).catch((err) => {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  })
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请输入姓名')
    return
  }
  if (!form.value.phone_number.trim()) {
    ElMessage.warning('请输入号码')
    return
  }
  if (!form.value.iccid.trim()) {
    ElMessage.warning('请输入 ICCID')
    return
  }
  formSaving.value = true
  try {
    const payload = {
      name: form.value.name.trim(),
      phone_number: form.value.phone_number.trim(),
      iccid: form.value.iccid.trim(),
      carrier: form.value.carrier || undefined,
      activation_date: form.value.activation_date || undefined,
      plan_details: form.value.plan_details.trim() || undefined,
      xianyu_member_name: form.value.xianyu_member_name.trim() || undefined,
      remark: form.value.remark.trim() || undefined,
    }
    if (isEdit.value) {
      await api.put(`/phone/numbers/${editId.value}`, payload)
      ElMessage.success('已保存')
    } else {
      await api.post('/phone/numbers', payload)
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

async function deletePhone(row) {
  try {
    await ElMessageBox.confirm(`确认删除号码 ${row.phone_number}？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.delete(`/phone/numbers/${row.id}`)
    ElMessage.success('已删除')
    load()
  } catch { /* cancelled */ }
}
</script>

<template>
  <div class="page-container">
    <el-card class="search-card">
      <div class="search-row">
        <el-input
          v-model="q"
          placeholder="搜索姓名 / 号码 / 闲鱼会员名"
          clearable
          :prefix-icon="Search"
          @keyup.enter="onSearch"
          @clear="onSearch"
          class="search-input"
        />
        <el-button type="primary" @click="onSearch">搜索</el-button>
        <el-button type="success" @click="openCreate">新建号码</el-button>
      </div>
    </el-card>

    <el-card>
      <el-table :data="list" v-loading="loading" stripe>
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column prop="phone_number" label="号码" min-width="130" />
        <el-table-column prop="iccid" label="ICCID" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">{{ row.iccid || '—' }}</template>
        </el-table-column>
        <el-table-column prop="carrier" label="运营商" min-width="100" />
        <el-table-column prop="xianyu_member_name" label="闲鱼会员名" min-width="130" />
        <el-table-column prop="activation_date" label="开通时间" min-width="110">
          <template #default="{ row }">
            {{ row.activation_date || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="套餐详情" min-width="200">
          <template #default="{ row }">
            {{ row.plan_details ? (row.plan_details.length > 40 ? row.plan_details.slice(0, 40) + '…' : row.plan_details) : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" link @click="deletePhone(row)">删除</el-button>
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
      :title="isEdit ? '编辑手机号' : '新建手机号'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form :model="form" label-width="100px" label-position="right">
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" placeholder="姓名" />
        </el-form-item>
        <el-form-item label="号码" required>
          <el-input v-model="form.phone_number" placeholder="手机号" />
        </el-form-item>
        <el-form-item label="ICCID" required>
          <el-input v-model="form.iccid" maxlength="50" placeholder="SIM 卡 ICCID" />
        </el-form-item>
        <el-form-item label="运营商">
          <el-select v-model="form.carrier" placeholder="请选择运营商" clearable style="width: 100%">
            <el-option v-for="c in CARRIER_OPTIONS" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="开通时间">
          <el-date-picker v-model="form.activation_date" type="date" placeholder="选择日期" style="width: 100%" />
        </el-form-item>
        <el-form-item label="套餐详情">
          <el-input v-model="form.plan_details" type="textarea" :rows="3" placeholder="套餐内容、月租等" />
        </el-form-item>
        <el-form-item label="闲鱼会员名">
          <el-input v-model="form.xianyu_member_name" placeholder="闲鱼会员名" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="备注（选填）" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="formSaving" @click="save">
          {{ isEdit ? '保存修改' : '创建' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-container {
  max-width: 1200px;
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
</style>
