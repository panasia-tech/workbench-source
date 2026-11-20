<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const form = ref({ code: '', zone: '', enabled: true, sort_order: 0 })

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/master/locations')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!form.value.code) {
    ElMessage.warning('请填写库位编码')
    return
  }
  try {
    await api.post('/master/locations', {
      code: form.value.code.trim(),
      zone: form.value.zone.trim() || null,
      enabled: form.value.enabled,
      sort_order: form.value.sort_order,
    })
    ElMessage.success('创建成功')
    form.value = { code: '', zone: '', enabled: true, sort_order: 0 }
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/master/locations/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
    ElMessage.success('已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function saveRow(row) {
  try {
    await api.patch(`/master/locations/${row.id}`, {
      zone: row.zone || null,
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
      `确定删除库位「${row.code}」吗？删除后小程序将不再下发该选项。`,
      '删除库位',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/master/locations/${row.id}`)
    ElMessage.success('库位已删除')
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
      <h3 class="page-card__title">新建库位</h3>
    </div>
    <div class="page-card__body">
      <el-form inline class="inline-form--compact">
        <el-form-item label="库位编码">
          <el-input v-model="form.code" placeholder="如 A-01" style="width: 120px" />
        </el-form-item>
        <el-form-item label="库区">
          <el-input v-model="form.zone" placeholder="如 A" style="width: 100px" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" class="sort-input-number" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Plus" @click="create">添加</el-button>
        </el-form-item>
      </el-form>
      <p class="form-hint">启用的库位会通过 <code>/api/config</code> 下发至小程序验货页</p>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">库位列表</h3>
    </div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无库位" style="width: 100%">
        <el-table-column prop="code" label="库位编码" width="120" show-overflow-tooltip />
        <el-table-column label="库区" width="120">
          <template #default="{ row }">
            <el-input v-model="row.zone" size="small" class="table-cell-input" placeholder="可选" />
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

<style scoped>
.form-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary, #909399);
}
.form-hint code {
  font-size: 12px;
  background: #f5f7fa;
  padding: 2px 6px;
  border-radius: 4px;
}
</style>
