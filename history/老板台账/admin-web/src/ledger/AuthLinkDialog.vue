<script setup>
// 授权对账：生成链接 + 复制弹窗。台账、对账、第一次建台账三处共用，ref.open(id, account) 打开。
// 生成链接的接口只认管理员。
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import api, { errText } from './api'

const show = ref(false)
const info = ref({ account: '', url: '', days: 30 })

async function open(alipayId, account) {
  try {
    const { data } = await api.post(`/ledger/alipays/${alipayId}/auth-link`)
    info.value = { account, url: data.url, days: data.days }
    show.value = true
  } catch (err) {
    ElMessage.error(errText(err, '生成授权链接失败'))
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(info.value.url)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制不了，长按链接手动复制')
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="show" title="授权对账" width="92%" style="max-width: 520px" append-to-body>
    <p>把下面的链接发给 <b>{{ info.account }}</b> 这个企业支付宝的管理员。对方用这个企业支付宝登录后打开链接，点「同意授权」就行。</p>
    <p class="lg-muted">链接只能用一次，{{ info.days }} 天内有效。授权后每天上午自动拉前一天的账单来对。</p>
    <div class="al-url">{{ info.url }}</div>
    <template #footer>
      <el-button @click="show = false">关闭</el-button>
      <el-button type="primary" @click="copy">复制链接</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.al-url { padding: 10px; border-radius: 6px; background: var(--lg-bg); font-size: 12px; word-break: break-all; user-select: all; }
</style>
