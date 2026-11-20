<template>
  <el-card shadow="never">
    <template #header>
      <div class="hd">
        <span>爬取内容（本机实时爬取日志，最新在前）</span>
        <div class="filters">
          <el-input v-model="q" placeholder="按商品名/关键词/账号筛选" clearable style="width: 240px" @keyup.enter="search" @clear="search">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-select v-model="status" placeholder="全部状态" clearable style="width: 130px" @change="search">
            <el-option label="成功" value="success" />
            <el-option label="无在售" value="empty" />
            <el-option label="失败" value="fail" />
          </el-select>
          <el-button :icon="Refresh" @click="load">刷新</el-button>
          <el-button type="danger" plain :icon="Delete" @click="clearAll">清空</el-button>
        </div>
      </div>
    </template>

    <el-table :data="list" v-loading="loading" border height="calc(100vh - 280px)">
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.at) }}</template>
      </el-table-column>
      <el-table-column prop="name" label="商品名" min-width="180" show-overflow-tooltip />
      <el-table-column prop="keyword" label="搜索词" min-width="140" show-overflow-tooltip />
      <el-table-column prop="account" label="账号" width="110" />
      <el-table-column label="价格" width="110">
        <template #default="{ row }">{{ row.price != null ? '¥' + row.price : '—' }}</template>
      </el-table-column>
      <el-table-column label="来源" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.source === 'market_quote'" type="success" size="small">行情均价</el-tag>
          <el-tag v-else-if="row.source === 'lowest_listing'" size="small">最低挂牌</el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="220">
        <template #default="{ row }">
          <el-tag v-if="row.status === 'success'" type="success" size="small">成功</el-tag>
          <el-tag v-else-if="row.status === 'empty'" type="info" size="small">无在售</el-tag>
          <el-tag v-else type="danger" size="small">失败</el-tag>
          <span v-if="row.status !== 'success'" class="reason">{{ row.reason }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        background
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="onPage"
      />
    </div>
  </el-card>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Delete, Refresh, Search } from '@element-plus/icons-vue'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const q = ref('')
const status = ref(null)
let off = null

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function load() {
  loading.value = true
  try {
    const res = await window.erp.queryResults({ q: q.value, status: status.value, page: page.value, pageSize: pageSize.value })
    list.value = res.items
    total.value = res.total
  } finally {
    loading.value = false
  }
}
function search() { page.value = 1; load() }
function onPage(p) { page.value = p; load() }

async function clearAll() {
  await ElMessageBox.confirm('清空本机爬取日志？（不影响已上报到服务器的数据）', '确认', { type: 'warning' })
  await window.erp.clearResults()
  search()
}

onMounted(() => {
  load()
  // 爬取进行时实时刷新当前页（仅第 1 页自动刷，避免打断翻页）
  off = window.erp.onCrawlEvent(({ type }) => {
    if ((type === 'counters' || type === 'done') && page.value === 1) load()
  })
})
onUnmounted(() => off && off())
</script>

<style scoped>
.hd { display: flex; justify-content: space-between; align-items: center; }
.filters { display: flex; gap: 8px; }
.reason { margin-left: 8px; color: #f56c6c; font-size: 12px; }
.pager { margin-top: 12px; text-align: right; }
</style>
