<script setup>
// 我的账号（第五步）：管理员给我用的账号。看不到密码；开了「员工领码」的能领当前 30 秒的 6 位动态码。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()
const items = ref([])
const codes = ref({})
let timer = null

async function load() {
  try {
    items.value = (await api.get('/ledger/vault/mine')).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  }
}

async function getCode(row) {
  try {
    codes.value = { ...codes.value, [row.id]: (await api.post(`/ledger/vault/items/${row.id}/code`)).data }
  } catch (err) {
    ElMessage.error(errText(err, '领不了'))
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('复制了')
  } catch {
    ElMessage.warning('浏览器不让复制，照着输')
  }
}

onMounted(() => {
  load()
  // 倒计时到 0 就把码收起来，要用再领
  timer = setInterval(() => {
    const next = {}
    for (const [k, v] of Object.entries(codes.value)) if (v.seconds_left > 1) next[k] = { ...v, seconds_left: v.seconds_left - 1 }
    codes.value = next
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
    <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
      <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">给我用的账号 <small>看不到密码；能领码的点「领码」</small></h3>
    </div>
    <div :class="isDesktop ? 'lgd-card__body' : ''">
      <div v-if="!items.length" class="lg-muted">还没有</div>
      <div v-for="row in items" :key="row.id" class="ma-row">
        <div class="ma-info">
          <b>{{ row.title }}</b>
          <span class="lg-muted">{{ row.category_label }}<template v-if="row.login_name"> · {{ row.login_name }}</template><template v-if="row.device_name"> · 环境 {{ row.device_name }}</template></span>
        </div>
        <template v-if="row.employee_totp && row.has_totp">
          <template v-if="codes[row.id]">
            <span class="ma-code lgd-num" @click="copy(codes[row.id].code)">{{ codes[row.id].code }}</span>
            <span class="lg-muted">{{ codes[row.id].seconds_left }} 秒</span>
          </template>
          <el-button v-else type="primary" size="small" @click="getCode(row)">领码</el-button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ma-row { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.ma-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.ma-code { font-size: 22px; font-weight: 700; letter-spacing: 3px; cursor: pointer; color: #1677ff; }
</style>
