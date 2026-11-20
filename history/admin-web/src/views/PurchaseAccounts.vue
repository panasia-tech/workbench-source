<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const form = ref({ code: '', label: '', enabled: true, sort_order: 0 })

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/master/purchase-accounts')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!form.value.code || !form.value.label) {
    ElMessage.warning('请填写编码和显示名')
    return
  }
  try {
    await api.post('/master/purchase-accounts', form.value)
    ElMessage.success('创建成功')
    form.value = { code: '', label: '', enabled: true, sort_order: 0 }
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/master/purchase-accounts/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
    ElMessage.success('已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function saveRow(row) {
  try {
    await api.patch(`/master/purchase-accounts/${row.id}`, {
      label: row.label,
      sort_order: row.sort_order,
    })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

async function removeRow(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除采购账号「${row.label}（${row.code}）」吗？删除后小程序将不再下发该选项。`,
      '删除采购账号',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/master/purchase-accounts/${row.id}`)
    ElMessage.success('采购账号已删除')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">新建采购账号</h3>
    </div>
    <div class="page-card__body">
      <el-form inline class="inline-form--compact">
        <el-form-item label="编码">
          <el-input v-model="form.code" placeholder="如 xianyu_a" style="width: 140px" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="form.label" placeholder="如 闲鱼号 A" style="width: 160px" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" class="sort-input-number" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Plus" @click="create">添加</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">采购账号</h3>
    </div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无账号" style="width: 100%">
        <el-table-column prop="code" label="编码" width="120" show-overflow-tooltip />
        <el-table-column label="显示名" width="200">
          <template #default="{ row }">
            <el-input v-model="row.label" size="small" class="table-cell-input" />
          </template>
        </el-table-column>
        <el-table-column label="排序" width="150" align="center" class-name="col-sort" header-cell-class-name="col-sort">
          <template #default="{ row }">
            <el-input-number v-model="row.sort_order" size="small" :min="0" class="sort-input-number" />
          </template>
        </el-table-column>
        <el-table-column label="启用" width="72" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center" class-name="col-action">
          <template #default="{ row }">
            <el-button link type="primary" @click="saveRow(row)">保存</el-button>
            <el-button link type="danger" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
        <el-table-column class-name="is-filler" label="" min-width="1" :resizable="false" />
      </el-table>
    </div>
  </div>
</template>
