<script setup>
// 群控 → 消息响应：闲鱼买家消息推给负责人、超时提醒/升级、按员工统计看了多久回了多久。
// 数据在群控（groupcontrol-server/app/chat_sla.py），经 ERP /api/gc-ops/chat-sla 转发。
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { isAdmin } from '../utils/consoleAccess'

const admin = isAdmin()
const conf = ref(null)
const saving = ref(false)
const accounts = ref([])
const owners = ref({})
const staffList = ref([])
const waiting = ref([])
const stats = ref([])
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const range = ref([today(), today()])

function errorText(err, fallback) {
  return err?.response?.data?.detail || fallback
}

function dur(sec) {
  if (sec == null) return '—'
  if (sec < 60) return `${sec} 秒`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

async function loadAll() {
  try {
    const [c, o, w] = await Promise.all([
      api.get('/gc-ops/chat-sla/settings'),
      api.get('/gc-ops/chat-sla/owners'),
      api.get('/gc-ops/chat-sla/waiting'),
    ])
    conf.value = c.data
    owners.value = o.data
    waiting.value = w.data.items
  } catch (err) {
    ElMessage.error(errorText(err, '读不到群控（消息响应）'))
  }
  if (admin) {
    try {
      const [a, s] = await Promise.all([api.get('/gc-bind/accounts'), api.get('/staff', { params: { page: 1, size: 200 } })])
      accounts.value = a.data
      staffList.value = (s.data.items || []).filter((x) => x.status === 'ACTIVE')
    } catch {
      /* 非管理员看不到账号列表 */
    }
  }
  await loadStats()
}

async function loadStats() {
  try {
    const { data } = await api.get('/gc-ops/chat-sla/stats', { params: { date_from: range.value[0], date_to: range.value[1] } })
    stats.value = data.items
  } catch (err) {
    ElMessage.error(errorText(err, '读不到统计'))
  }
}

async function saveConf() {
  saving.value = true
  try {
    const { data } = await api.put('/gc-ops/chat-sla/settings', conf.value)
    conf.value = data
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

const ownerIds = (accountId) => (owners.value[accountId] || []).map((o) => o.staff_id)

async function setOwners(accountId, ids) {
  try {
    const { data } = await api.put(`/gc-ops/chat-sla/owners/${accountId}`, { staff_ids: ids })
    owners.value = { ...owners.value, [accountId]: data }
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  }
}

const noOwnerCount = computed(() => accounts.value.filter((a) => !ownerIds(a.id).length).length)

onMounted(loadAll)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">消息响应考核</h3>
      <span class="muted">买家发来消息 → 推给闲鱼号负责人；超时没看提醒本人，超时没回通知管理员</span>
    </div>
    <div v-if="conf" class="page-card__body">
      <el-form inline>
        <el-form-item label="开启">
          <el-switch v-model="conf.enabled" :disabled="!admin" />
        </el-form-item>
        <el-form-item label="没看提醒负责人">
          <el-input-number v-model="conf.read_min" :min="1" :max="240" :disabled="!admin" /> <span class="unit">分钟</span>
        </el-form-item>
        <el-form-item label="没回通知管理员">
          <el-input-number v-model="conf.reply_min" :min="1" :max="1440" :disabled="!admin" /> <span class="unit">分钟</span>
        </el-form-item>
        <el-form-item label="夜间不考核">
          <el-input-number v-model="conf.quiet_start" :min="0" :max="23" :disabled="!admin" style="width: 100px" />
          <span class="unit">点 到</span>
          <el-input-number v-model="conf.quiet_end" :min="0" :max="23" :disabled="!admin" style="width: 100px" />
          <span class="unit">点</span>
        </el-form-item>
        <el-form-item v-if="admin">
          <el-button type="primary" :loading="saving" @click="saveConf">保存</el-button>
        </el-form-item>
      </el-form>
      <p class="muted">
        「看」= 员工在我们的 H5/小程序里打开会话（闲鱼上的已读是机器人读消息造成的，不算）；「回」= 从我们系统发出回复，或在闲鱼 App 里直接回。
        兜底自动回复不算员工处理。夜间不推送、不计时，早上接着算。通知发钉钉（没关联钉钉的发企微）。
      </p>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">正在等回复</h3>
      <span class="page-card__count">{{ waiting.length }} 个会话</span>
      <el-button size="small" style="margin-left: auto" @click="loadAll">刷新</el-button>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table :data="waiting" size="small" empty-text="都回了">
        <el-table-column prop="account" label="闲鱼号" width="120" />
        <el-table-column prop="buyer" label="买家" width="120" />
        <el-table-column prop="item_title" label="商品" min-width="160" show-overflow-tooltip />
        <el-table-column prop="last_message" label="最后一句" min-width="180" show-overflow-tooltip />
        <el-table-column label="等了" width="110">
          <template #default="{ row }">
            <el-tag :type="row.escalated ? 'danger' : row.reminded ? 'warning' : 'info'" size="small">{{ dur(row.waited_sec) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="看了没" width="110">
          <template #default="{ row }">{{ row.read_by ? `${row.read_by} 看了` : '没人看' }}</template>
        </el-table-column>
        <el-table-column label="负责人" min-width="120">
          <template #default="{ row }">{{ row.owners.join('、') || '未指定' }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">按员工统计</h3>
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        size="small"
        style="margin-left: auto; width: 260px"
        @change="loadStats"
      />
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table :data="stats" size="small" empty-text="这段时间没有买家消息">
        <el-table-column prop="name" label="负责人" width="120" />
        <el-table-column prop="cycles" label="收到" width="80" />
        <el-table-column prop="read" label="看了" width="80" />
        <el-table-column prop="replied" label="回了" width="80" />
        <el-table-column label="平均多久看" width="120">
          <template #default="{ row }">{{ dur(row.avg_read_sec) }}</template>
        </el-table-column>
        <el-table-column label="平均多久回" width="120">
          <template #default="{ row }">{{ dur(row.avg_reply_sec) }}</template>
        </el-table-column>
        <el-table-column prop="late_read" label="超时没看" width="100" />
        <el-table-column prop="late_reply" label="超时没回" width="100" />
        <el-table-column prop="open" label="还在等" width="90" />
      </el-table>
      <p class="muted" style="padding: 8px 12px">一个号多个负责人时，这个号的每轮消息算到每个负责人头上。</p>
    </div>
  </div>

  <div v-if="admin" class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">闲鱼号负责人</h3>
      <span class="muted">{{ noOwnerCount }} 个号还没指定，这些号的新消息不推送，只在超时没回时通知管理员</span>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table :data="accounts" size="small">
        <el-table-column prop="nick" label="闲鱼号" width="160" />
        <el-table-column label="设备" width="140">
          <template #default="{ row }">{{ row.device_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="负责人（可多选）" min-width="300">
          <template #default="{ row }">
            <el-select
              :model-value="ownerIds(row.id)"
              multiple
              filterable
              placeholder="选员工"
              style="width: 100%"
              @change="(ids) => setOwners(row.id, ids)"
            >
              <el-option v-for="s in staffList" :key="s.id" :value="s.id" :label="`${s.name}（${s.staff_no}）`" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.muted { color: var(--text-secondary); font-size: 13px; }
.unit { margin: 0 6px; color: var(--text-secondary); font-size: 13px; }
</style>
