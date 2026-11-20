<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const list = ref([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = (await api.get('/ledger/grants')).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function revoke(g) {
  try {
    await api.post(`/ledger/grants/${g.id}/revoke`)
    ElMessage.success('已收回')
    load()
  } catch (err) {
    ElMessage.error(errText(err, '收回失败'))
  }
}

onMounted(load)
</script>

<template>
  <!-- 电脑：开放记录一张表 -->
  <div v-if="isDesktop" class="lgd-card">
    <div class="lgd-card__head">
      <h3 class="lgd-card__title">开放记录 <small>最近 {{ list.length }} 条</small></h3>
      <el-button @click="load">刷新</el-button>
    </div>
    <div class="lgd-card__body--table">
      <el-table v-loading="loading" :data="list" stripe size="small" empty-text="还没开放过">
        <el-table-column label="法人" min-width="110">
          <template #default="{ row }"><b>{{ row.legal_person_name || '（已删）' }}</b></template>
        </el-table-column>
        <el-table-column label="开放给" prop="staff_name" min-width="80" />
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="{ waiting: 'primary', reading: 'warning', read: 'success', expired: 'info', revoked: 'info' }[row.state] || 'info'">{{ row.state_label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开放原因" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.reason || '' }}</template>
        </el-table-column>
        <el-table-column label="开放时间" prop="created_at" width="135" />
        <el-table-column label="要在这之前打开" prop="expires_at" width="135" />
        <el-table-column label="打开时间 / 能看到" width="165">
          <template #default="{ row }">
            <template v-if="row.opened_at">
              {{ row.opened_at }}
              <div v-if="row.read_until" class="lgd-muted">看到 {{ row.read_until }}</div>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="" width="70" align="center" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.state === 'waiting' || row.state === 'reading'" link type="danger" @click="revoke(row)">收回</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <!-- 手机：原样 -->
  <template v-else>
    <div v-loading="loading">
      <div v-if="!list.length && !loading" class="lg-card lg-muted">还没开放过</div>
      <div v-for="g in list" :key="g.id" class="lg-card">
        <div class="lg-row">
          <div>
            <b>{{ g.legal_person_name || '（已删）' }}</b> → {{ g.staff_name }}
            <div class="lg-muted">{{ g.state_label }} · {{ g.created_at }} 开放<span v-if="g.opened_at"> · {{ g.opened_at }} 打开</span></div>
            <div v-if="g.reason" class="lg-muted">{{ g.reason }}</div>
          </div>
          <el-button v-if="g.state === 'waiting' || g.state === 'reading'" size="small" @click="revoke(g)">收回</el-button>
        </div>
      </div>
    </div>
  </template>
</template>
