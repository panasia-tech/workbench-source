<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'

const loading = ref(false)
const list = ref([])
const form = ref({
  code: '',
  label: '',
  xianyu_user_name: '',
  enabled: true,
  sort_order: 0,
  worry_free_sell: false,
})

const emptyForm = () => ({
  code: '',
  label: '',
  xianyu_user_name: '',
  enabled: true,
  sort_order: 0,
  worry_free_sell: false,
})

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/master/sale-shops')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!form.value.code || !form.value.label || !form.value.xianyu_user_name) {
    ElMessage.warning('请填写编码、显示名、闲鱼会员名')
    return
  }
  try {
    await api.post('/master/sale-shops', form.value)
    ElMessage.success('创建成功')
    form.value = emptyForm()
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/master/sale-shops/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function toggleWorryFree(row) {
  const next = !row.worry_free_sell
  try {
    await api.patch(`/master/sale-shops/${row.id}`, { worry_free_sell: next })
    row.worry_free_sell = next
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function saveRow(row) {
  try {
    await api.patch(`/master/sale-shops/${row.id}`, {
      label: row.label,
      xianyu_user_name: row.xianyu_user_name,
      sort_order: row.sort_order,
    })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">新建销售店铺</h3></div>
    <div class="page-card__body">
      <el-form label-width="96px" class="sale-shop-form">
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="编码">
              <el-input v-model="form.code" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="显示名">
              <el-input v-model="form.label" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="闲鱼会员名">
              <el-input v-model="form.xianyu_user_name" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" class="sort-input-number" />
          <!-- 无忧卖暂时下线(2026-09):开关隐藏,worry_free_sell 恒为 false;恢复时解开注释即可
          <span style="margin-left: 20px">无忧卖默认</span>
          <el-switch v-model="form.worry_free_sell" style="margin-left: 8px" />
          -->
          <el-button type="primary" :icon="Plus" style="margin-left: 12px" @click="create">添加</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">销售店铺</h3></div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无店铺" style="width: 100%">
        <el-table-column prop="code" label="编码" width="100" show-overflow-tooltip />
        <el-table-column label="显示名" width="140">
          <template #default="{ row }">
            <el-input v-model="row.label" size="small" class="table-cell-input" />
          </template>
        </el-table-column>
        <el-table-column label="闲鱼会员名" width="160">
          <template #default="{ row }">
            <el-input v-model="row.xianyu_user_name" size="small" class="table-cell-input--wide" />
          </template>
        </el-table-column>
        <el-table-column label="排序" width="120" align="center" class-name="col-sort" header-cell-class-name="col-sort">
          <template #default="{ row }">
            <el-input-number v-model="row.sort_order" size="small" :min="0" class="sort-input-number" />
          </template>
        </el-table-column>
        <!-- 无忧卖暂时下线(2026-09):整列隐藏,worry_free_sell 保持库内默认 false;恢复时解开注释即可
        <el-table-column label="无忧卖(默认)" width="110" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.worry_free_sell" @change="toggleWorryFree(row)" />
          </template>
        </el-table-column>
        -->
        <el-table-column label="启用" width="72" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="72" align="center" class-name="col-action">
          <template #default="{ row }">
            <el-button link type="primary" @click="saveRow(row)">保存</el-button>
          </template>
        </el-table-column>
        <el-table-column class-name="is-filler" label="" min-width="1" :resizable="false" />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.sale-shop-form {
  max-width: 920px;
}
</style>
