<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const LEVEL = { legal_person: '法人', entity: '主体', alipay: '支付宝', shop: '店铺', grant: '开放' }
const list = ref([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)

async function load(p = 1) {
  loading.value = true
  try {
    const { data } = await api.get('/ledger/logs', { params: { page: p, size: 50 } })
    list.value = data.items
    total.value = data.total
    page.value = p
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <!-- 电脑：查看记录一张表 -->
  <div v-if="isDesktop" class="lgd-card">
    <div class="lgd-card__head">
      <h3 class="lgd-card__title">查看记录 <small>谁看了、改了、开放了什么</small></h3>
      <el-button @click="load(page)">刷新</el-button>
    </div>
    <div class="lgd-card__body--table">
      <el-table v-loading="loading" :data="list" stripe size="small" empty-text="还没有记录">
        <el-table-column label="时间" prop="at" width="150" />
        <el-table-column label="谁" prop="staff_name" width="120" />
        <el-table-column label="做了什么" width="140">
          <template #default="{ row }">{{ row.action }}{{ LEVEL[row.target_type] || '' }}</template>
        </el-table-column>
        <el-table-column label="详情" min-width="300" show-overflow-tooltip>
          <template #default="{ row }">{{ row.detail || '' }}</template>
        </el-table-column>
      </el-table>
      <div class="lgd-pager">
        <el-pagination
          layout="total, prev, pager, next"
          :total="total"
          :page-size="50"
          :current-page="page"
          background
          @current-change="load"
        />
      </div>
    </div>
  </div>

  <!-- 手机：原样 -->
  <template v-else>
    <div v-loading="loading" class="lg-card">
      <div v-if="!list.length && !loading" class="lg-muted">还没有记录</div>
      <div v-for="(x, i) in list" :key="i" class="al-row">
        <div><b>{{ x.staff_name }}</b> {{ x.action }}{{ LEVEL[x.target_type] || '' }}<span v-if="x.detail" class="lg-muted"> · {{ x.detail }}</span></div>
        <div class="lg-muted">{{ x.at }}</div>
      </div>
      <el-pagination
        v-if="total > 50"
        layout="prev, pager, next"
        :total="total"
        :page-size="50"
        :current-page="page"
        small
        @current-change="load"
      />
    </div>
  </template>
</template>

<style scoped>
.al-row { padding: 8px 0; border-bottom: 1px solid var(--lg-line); font-size: 14px; }
.al-row:last-of-type { border-bottom: 0; }
</style>
