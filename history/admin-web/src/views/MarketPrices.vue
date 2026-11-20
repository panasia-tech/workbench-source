<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, Upload, Download } from '@element-plus/icons-vue'
import api from '../api'
import { formatPrice, formatDateTime } from '../utils/labels'

const loading = ref(false)
const list = ref([])
const form = ref({ name: '', keyword: '', sort_order: 0, note: '' })

// 筛选 / 分页（监控商品可能上千条，必须分页）
const q = ref('')
const enabledFilter = ref(null) // null=全部 true=启用 false=停用
const page = ref(1)
const pageSize = ref(50)
const total = ref(0)

// 导入
const importing = ref(false)
const fileInput = ref(null)

const historyVisible = ref(false)
const historyLoading = ref(false)
const historyRows = ref([])
const historyTitle = ref('')

function fmtDate(v) {
  return v || '—'
}

function fmtDelta(v) {
  if (v == null || v === '') return '—'
  const n = Number(v)
  if (n > 0) return `▲ ¥${n.toFixed(2)}`
  if (n < 0) return `▼ ¥${Math.abs(n).toFixed(2)}`
  return '持平'
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (q.value.trim()) params.q = q.value.trim()
    if (enabledFilter.value !== null) params.enabled = enabledFilter.value
    const { data } = await api.get('/market/products', { params })
    list.value = data.items
    total.value = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function onPageChange(p) {
  page.value = p
  load()
}

// ---------- 全量导出 / 覆盖导入 ----------
async function exportAll() {
  try {
    const resp = await api.get('/market/products/export', { responseType: 'blob' })
    const url = window.URL.createObjectURL(resp.data)
    const a = document.createElement('a')
    a.href = url
    a.download = 'crawl_products_all.xlsx'
    a.click()
    window.URL.revokeObjectURL(url)
  } catch (err) {
    ElMessage.error('导出失败')
  }
}

async function triggerImport() {
  try {
    await ElMessageBox.confirm(
      '覆盖导入：导入后监控名单将与文件严格一致——文件里没有的商品会被删除，' +
        '其全部历史行情记录一并删除且不可恢复。建议先「下载全部」做备份。确定继续？',
      '覆盖导入',
      { type: 'warning', confirmButtonText: '选择文件并导入', cancelButtonText: '取消' },
    )
  } catch {
    return // 取消
  }
  fileInput.value?.click()
}

async function onFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = '' // 允许重复选择同一文件
  if (!file) return
  importing.value = true
  try {
    const fd = new FormData()
    fd.append('file', file)
    const { data } = await api.post('/market/products/import', fd)
    ElMessageBox.alert(
      `有效数据 ${data.total} 行：新建 ${data.created} 条，更新 ${data.updated} 条，` +
        `删除 ${data.deleted} 条` +
        (data.skipped ? `，文件内重名合并 ${data.skipped} 条` : '') + '。',
      '导入完成',
      { type: 'success' },
    )
    page.value = 1
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '导入失败')
  } finally {
    importing.value = false
  }
}

async function create() {
  if (!form.value.name.trim()) {
    ElMessage.warning('请填写商品名')
    return
  }
  try {
    await api.post('/market/products', {
      name: form.value.name.trim(),
      keyword: (form.value.keyword || '').trim() || null,
      sort_order: form.value.sort_order,
      note: (form.value.note || '').trim() || null,
    })
    ElMessage.success('添加成功')
    form.value = { name: '', keyword: '', sort_order: 0, note: '' }
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '添加失败')
  }
}

async function toggleEnabled(row) {
  try {
    await api.patch(`/market/products/${row.id}`, { enabled: !row.enabled })
    row.enabled = !row.enabled
    ElMessage.success('已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新失败')
  }
}

async function saveRow(row) {
  try {
    await api.patch(`/market/products/${row.id}`, {
      name: (row.name || '').trim(),
      keyword: (row.keyword || '').trim() || null,
      sort_order: row.sort_order,
      note: (row.note || '').trim() || null,
    })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

async function removeRow(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除商品「${row.name}」吗？该商品的全部历史行情记录将一并删除，且不可恢复。`,
      '删除商品',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/market/products/${row.id}`)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

async function showHistory(row) {
  historyTitle.value = `${row.name} — 近30天行情`
  historyVisible.value = true
  historyLoading.value = true
  historyRows.value = []
  try {
    const { data } = await api.get(`/market/products/${row.id}/prices`, { params: { days: 30 } })
    historyRows.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载历史失败')
  } finally {
    historyLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">新增监控商品</h3>
    </div>
    <div class="page-card__body">
      <el-form label-width="100px" class="create-form" @submit.prevent>
        <el-form-item label="商品名">
          <el-input v-model="form.name" placeholder="如 3070显卡" class="f-name" />
        </el-form-item>
        <el-form-item label="搜索词">
          <el-input v-model="form.keyword" placeholder="选填：闲鱼实际搜索词，留空则用商品名" class="f-name" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="选填" class="f-name" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort_order" :min="0" controls-position="right" />
        </el-form-item>
        <el-form-item label=" ">
          <el-button type="primary" :icon="Plus" @click="create">添加商品</el-button>
        </el-form-item>
      </el-form>
      <p class="form-hint">
        启用的商品会下发给行情采集：手机 APP 读闲鱼「行情」页的近7日成交均价，巡航台算清洗后的平均挂牌价。
        最近价 = 当天爬到的价；当天没爬到则显示最近一次爬到的价。
      </p>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header list-header">
      <h3 class="page-card__title">监控商品列表</h3>
      <div class="list-tools">
        <el-input
          v-model="q"
          placeholder="搜索名称 / 搜索词 / 备注"
          class="tool-search"
          clearable
          :prefix-icon="Search"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="enabledFilter" class="tool-filter" @change="search">
          <el-option label="全部" :value="null" />
          <el-option label="启用" :value="true" />
          <el-option label="停用" :value="false" />
        </el-select>
        <el-button @click="search">查询</el-button>
        <el-button :icon="Download" @click="exportAll">下载全部</el-button>
        <el-button type="primary" :icon="Upload" :loading="importing" @click="triggerImport">覆盖导入</el-button>
        <input
          ref="fileInput"
          type="file"
          accept=".xlsx,.xls"
          style="display: none"
          @change="onFileChange"
        />
      </div>
    </div>
    <div class="page-card__body page-card__body--table table--compact">
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无商品" style="width: 100%">
        <el-table-column label="商品名" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.name" size="small" class="table-cell-input" />
          </template>
        </el-table-column>
        <el-table-column label="搜索词" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.keyword" size="small" placeholder="（同商品名）" />
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="140">
          <template #default="{ row }">
            <el-input v-model="row.note" size="small" placeholder="选填" />
          </template>
        </el-table-column>
        <el-table-column label="最近价" width="120" align="right">
          <template #default="{ row }">
            <span class="price">{{ formatPrice(row.last_price) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="行情日期" width="120" align="center">
          <template #default="{ row }">{{ fmtDate(row.last_price_date) }}</template>
        </el-table-column>
        <el-table-column label="最近爬取" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.last_crawled_at) }}</template>
        </el-table-column>
        <el-table-column label="排序" width="110" align="center">
          <template #default="{ row }">
            <el-input-number v-model="row.sort_order" size="small" :min="0" />
          </template>
        </el-table-column>
        <el-table-column label="启用" width="72" align="center">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" align="center" class-name="col-action">
          <template #default="{ row }">
            <el-button link type="primary" @click="saveRow(row)">保存</el-button>
            <el-button link type="primary" @click="showHistory(row)">历史</el-button>
            <el-button link type="danger" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
        <el-table-column class-name="is-filler" label="" min-width="1" :resizable="false" />
      </el-table>
      <div class="list-pager">
        <el-pagination
          background
          layout="total, prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
    </div>
  </div>

  <el-dialog v-model="historyVisible" :title="historyTitle" width="560px">
    <el-table v-loading="historyLoading" :data="historyRows" stripe empty-text="暂无行情记录" max-height="420">
      <el-table-column prop="crawl_date" label="日期" width="130" />
      <el-table-column label="行情价" align="right">
        <template #default="{ row }"><span class="price">{{ formatPrice(row.price) }}</span></template>
      </el-table-column>
      <el-table-column label="口径" align="center" width="110">
        <template #default="{ row }">{{ row.price_basis || '—' }}</template>
      </el-table-column>
      <el-table-column label="较上周" align="center">
        <template #default="{ row }">{{ fmtDelta(row.trend_delta) }}</template>
      </el-table-column>
      <el-table-column label="在搜人数" align="center">
        <template #default="{ row }">{{ row.search_heat ?? '—' }}</template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<style scoped>
.form-hint {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--text-secondary, #909399);
}
.create-form {
  max-width: 640px;
}
.f-name {
  width: 360px;
}
.price {
  font-weight: 600;
  color: #303133;
}
.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.list-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tool-search {
  width: 220px;
}
.tool-filter {
  width: 100px;
}
.list-pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 4px;
}
</style>
