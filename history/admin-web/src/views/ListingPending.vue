<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
const loading = ref(false)
const list = ref([])

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/listing/pending')
    list.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

async function publish(row) {
  try {
    await api.post(`/listing/skus/${row.sku_code}/publish-all`)
    ElMessage.success('已提交全店铺上架')
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '上架失败')
  }
}

const statusMap = { DRAFT: '待填写', READY: '待上架', CREATED: '已创建', FAILED: '失败' }

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">待上架 SKU</h3></div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="sku_code" label="货号" width="150" />
        <el-table-column prop="product_name" label="商品" min-width="180" />
        <el-table-column label="入库时间" width="170">
          <template #default="{ row }">{{ row.inbound_at ? row.inbound_at.replace('T', ' ').slice(0, 19) : '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ statusMap[row.listing_status] || row.listing_status }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.listing_status === 'READY' || row.listing_status === 'CREATED' || row.listing_status === 'FAILED'"
              link
              type="primary"
              @click="publish(row)"
            >一键上架</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="hint">上架信息请在小程序「填写上架信息」页维护；本页可触发全店铺 publish。</p>
    </div>
  </div>
</template>

<style scoped>
.hint { margin: 12px 20px; font-size: 13px; color: var(--text-secondary); }
</style>
