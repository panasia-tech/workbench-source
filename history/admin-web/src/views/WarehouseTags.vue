<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const SIZE_OPTIONS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']
const RESOLUTION_OPTIONS = ['1k', '2k', '4k']
const form = ref({ name: '', enabled: true, sort_order: 0, prompt: '', ai_size: 'auto', ai_resolution: '1k' })

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/master/warehouse-tags')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写标签名称')
    return
  }
  try {
    await api.post('/master/warehouse-tags', {
      name: form.value.name.trim(),
      enabled: form.value.enabled,
      sort_order: form.value.sort_order,
      prompt: (form.value.prompt || '').trim() || null,
      ai_size: form.value.ai_size || null,
      ai_resolution: form.value.ai_resolution || null,
    })
    ElMessage.success('创建成功')
    form.value = { name: '', enabled: true, sort_order: 0, prompt: '', ai_size: 'auto', ai_resolution: '1k' }
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/master/warehouse-tags/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
    ElMessage.success('已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function saveRow(row) {
  try {
    await api.patch(`/master/warehouse-tags/${row.id}`, {
      name: (row.name || '').trim(),
      sort_order: row.sort_order,
      prompt: (row.prompt || '').trim() || null,
      ai_size: row.ai_size || null,
      ai_resolution: row.ai_resolution || null,
    })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

async function removeRow(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除标签「${row.name}」吗？删除后已打该标签的商品仍保留历史值，但小程序不再下发。`,
      '删除标签',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/master/warehouse-tags/${row.id}`)
    ElMessage.success('标签已删除')
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
      <h3 class="page-card__title">新建标签</h3>
    </div>
    <div class="page-card__body">
      <el-form label-width="100px" class="tag-create-form">
        <el-form-item label="标签名称">
          <el-input v-model="form.name" placeholder="如 全新 / 二手 / 调拨" class="tcf-name" />
        </el-form-item>

        <el-form-item label="AI 重绘提示词">
          <el-input
            v-model="form.prompt"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 6 }"
            placeholder="选填：上架时按此提示词调用 gpt-image-2 重绘主图"
            class="tcf-prompt"
          />
        </el-form-item>

        <el-form-item label="参数配置">
          <div class="tcf-inline">
            <div class="tcf-inline-item">
              <span class="tcf-inline-label">比例</span>
              <el-select v-model="form.ai_size" class="tcf-select">
                <el-option v-for="s in SIZE_OPTIONS" :key="s" :value="s" :label="s" />
              </el-select>
            </div>
            <div class="tcf-inline-item">
              <span class="tcf-inline-label">清晰度</span>
              <el-select v-model="form.ai_resolution" class="tcf-select">
                <el-option v-for="r in RESOLUTION_OPTIONS" :key="r" :value="r" :label="r" />
              </el-select>
            </div>
            <div class="tcf-inline-item">
              <span class="tcf-inline-label">排序</span>
              <el-input-number v-model="form.sort_order" :min="0" controls-position="right" class="tcf-number" />
            </div>
          </div>
        </el-form-item>

        <el-form-item label=" " class="tcf-actions-row">
          <el-button type="primary" :icon="Plus" @click="create">添加标签</el-button>
        </el-form-item>
      </el-form>
      <p class="form-hint">启用的标签会下发到小程序：验货入库时可多选打标签，仓库列表按标签筛选（多选为「满足任意一个」）；上架表单可按此标签的提示词调用 gpt-image-2 重绘主图。</p>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">标签列表</h3>
    </div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无标签" style="width: 100%">
        <el-table-column label="标签名称" width="200">
          <template #default="{ row }">
            <el-input v-model="row.name" size="small" class="table-cell-input" />
          </template>
        </el-table-column>
        <el-table-column label="AI 重绘提示词" min-width="280">
          <template #default="{ row }">
            <el-input
              v-model="row.prompt"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 4 }"
              size="small"
              placeholder="选填，用于上架时调用 gpt-image-2"
            />
          </template>
        </el-table-column>
        <el-table-column label="比例" width="100" align="center">
          <template #default="{ row }">
            <el-select v-model="row.ai_size" size="small" placeholder="auto">
              <el-option v-for="s in SIZE_OPTIONS" :key="s" :value="s" :label="s" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="清晰度" width="100" align="center">
          <template #default="{ row }">
            <el-select v-model="row.ai_resolution" size="small" placeholder="1k">
              <el-option v-for="r in RESOLUTION_OPTIONS" :key="r" :value="r" :label="r" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="130" align="center" class-name="col-sort" header-cell-class-name="col-sort">
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
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-secondary, #909399);
}

.tag-create-form {
  max-width: 760px;
}

.tag-create-form :deep(.el-form-item) {
  margin-bottom: 20px;
}

.tcf-name {
  width: 320px;
}

.tcf-prompt {
  width: 100%;
}

.tcf-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 28px;
  align-items: center;
}

.tcf-inline-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tcf-inline-label {
  font-size: 14px;
  color: #606266;
  white-space: nowrap;
}

.tcf-select {
  width: 140px;
}

.tcf-number {
  width: 140px;
}

.tcf-actions-row :deep(.el-form-item__label) {
  visibility: hidden;
}
</style>
