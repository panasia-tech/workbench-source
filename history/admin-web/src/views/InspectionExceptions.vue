<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { formatDateTime } from '../utils/labels'
import {
  errorText,
  exceptionTypeLabels,
  refundStatusLabels,
  rejectStatusLabels,
  returnLogisticsLabels,
  uploadEvidence,
} from '../utils/evidenceUpload'

const POLL_MS = 30000

const list = ref([])
const notices = ref([])
const statusFilter = ref('OPEN')
const me = ref(null)
const current = ref(null)
const events = ref([])
const progress = ref({})
const finalResult = ref('')
// W12 平台售后：申请状态（已提交要回执）、平台期限和来源、留货补差提议
const AFTERSALE = { preparing: '准备材料', submitted: '已在平台提交', accepted: '平台已受理', withdrawn: '已撤销申请', disputed: '平台介入中', resolved: '平台已处理完' }
const aftersaleForm = ref({ status: null, deadline: '', deadline_source: 'platform', note: '' })
const offerForm = ref({ by: 'seller', text: '', amount: '' })
let timer = null

async function load() {
  const [rows, unread] = await Promise.all([
    api.get('/inspection-ops/exceptions', { params: { status: statusFilter.value || undefined } }),
    api.get('/inspection-ops/notices'),
  ])
  list.value = rows.data
  notices.value = unread.data
}

async function open(row) {
  current.value = row
  progress.value = {
    reject_status: row.reject_status,
    return_tracking_no: row.return_tracking_no || '',
    return_carrier: row.return_carrier || '',
    return_station: row.return_station || '',
    return_logistics: row.return_logistics || null,
    refund_status: row.refund_status,
    refund_amount: row.refund_amount,
    refund_fee: row.refund_fee,
    refund_shortfall_reason: row.refund_shortfall_reason || '',
    note: '',
  }
  finalResult.value = ''
  aftersaleForm.value = { status: null, deadline: '', deadline_source: row.deadline_source || 'platform', note: '' }
  offerForm.value = { by: 'seller', text: '', amount: '' }
  const { data } = await api.get(`/inspection-ops/exceptions/${row.id}/events`)
  events.value = data
}

async function act(fn, failText) {
  try {
    const { data } = await fn()
    await load()
    await open(data)
  } catch (err) {
    ElMessage.error(errorText(err, failText))
  }
}

function ack() {
  act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/ack`), '接单失败')
}

function saveProgress() {
  const { refund_amount, refund_fee, return_logistics, ...rest } = progress.value
  act(
    () => api.patch(`/inspection-ops/exceptions/${current.value.id}`, {
      ...rest,
      refund_amount: refund_amount || null,
      refund_fee: refund_fee === '' || refund_fee == null ? null : refund_fee,
      return_logistics: return_logistics || null,
    }),
    '保存失败',
  )
}

// 网点签收凭证：只追加
async function uploadSignEvidence(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  try {
    const urls = []
    for (const f of files) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase()
      urls.push(await uploadEvidence(f, 'inspection/return-sign', ext))
    }
    act(() => api.patch(`/inspection-ops/exceptions/${current.value.id}`, { return_sign_evidence: urls, note: '上传签收凭证' }), '保存失败')
  } catch (err) {
    ElMessage.error(errorText(err, '上传失败'))
  }
}

function saveAftersale() {
  const f = aftersaleForm.value
  const body = { note: f.note || null }
  if (f.status && f.status !== current.value.aftersale_status) body.status = f.status
  if (f.deadline) Object.assign(body, { deadline: f.deadline, deadline_source: f.deadline_source })
  act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/aftersale`, body), '保存失败')
}

async function uploadReceipt(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  try {
    const urls = []
    for (const f of files) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase()
      urls.push(await uploadEvidence(f, 'inspection/aftersale', ext))
    }
    act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/aftersale`, { receipt: urls, note: '上传平台回执' }), '保存失败')
  } catch (err) {
    ElMessage.error(errorText(err, '上传失败'))
  }
}

function addOffer() {
  const f = offerForm.value
  act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/keep-offer`, { by: f.by, text: f.text, amount: f.amount || null }), '没记上')
}

function close() {
  act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/close`, { final_result: finalResult.value }), '结束失败')
}

async function uploadPurchaserEvidence(e) {
  const files = [...e.target.files]
  e.target.value = ''
  if (!files.length) return
  try {
    const urls = await Promise.all(
      files.map((f) => uploadEvidence(f, 'inspection/exception/', f.name.slice(f.name.lastIndexOf('.')) || '.jpg')),
    )
    await act(() => api.post(`/inspection-ops/exceptions/${current.value.id}/purchaser-evidence`, { evidence: urls }), '提交失败')
  } catch {
    ElMessage.error('上传失败')
  }
}

async function openNotice(n) {
  await api.post(`/inspection-ops/notices/${n.id}/read`)
  statusFilter.value = ''
  await load()
  const row = list.value.find((x) => x.id === n.exception_id)
  if (row) await open(row)
}

function canAck(row) {
  return !row.handler_ack_at && (['ADMIN', 'BUSINESS'].includes(me.value?.my_role))
}

function canSubmitEvidence(row) {
  return me.value?.my_role === 'ADMIN' || me.value?.my_id === row.purchaser_id
}

onMounted(async () => {
  const { data } = await api.get('/inspection-ops/settings')
  me.value = data
  await load()
  timer = setInterval(load, POLL_MS)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">拒签退款跟踪</h3>
      <el-radio-group v-model="statusFilter" @change="load">
        <el-radio-button value="OPEN">处理中</el-radio-button>
        <el-radio-button value="CLOSED">已结束</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
    </div>
    <div class="page-card__body">
      <el-alert
        v-for="n in notices"
        :key="n.id"
        :title="n.detail"
        type="warning"
        :closable="false"
        style="margin-bottom: 6px; cursor: pointer"
        @click="openNotice(n)"
      />
      <el-table :data="list" highlight-current-row @row-click="open">
        <el-table-column label="发现时间" width="150"><template #default="{ row }">{{ formatDateTime(row.raised_at) }}</template></el-table-column>
        <el-table-column prop="order_no" label="采购单" width="150" />
        <el-table-column prop="product_name" label="商品" min-width="170" show-overflow-tooltip />
        <el-table-column label="类型" width="90"><template #default="{ row }">{{ exceptionTypeLabels[row.exception_type] }}</template></el-table-column>
        <el-table-column label="业务员" width="130">
          <template #default="{ row }">{{ row.handler_ack_at ? `${row.handler_name} 已接单` : '未接单' }}</template>
        </el-table-column>
        <el-table-column label="采购员" width="130">
          <template #default="{ row }">{{ row.purchaser_name }} {{ row.purchaser_evidence_at ? '已交' : '未交' }}</template>
        </el-table-column>
        <el-table-column label="通知" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.notice || '—' }}</template>
        </el-table-column>
        <el-table-column label="拒签" width="110">
          <template #default="{ row }">
            {{ rejectStatusLabels[row.reject_status] }}
            <el-tag v-if="row.needs_takeover" type="danger" size="small">要接管</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="退款" width="90"><template #default="{ row }">{{ refundStatusLabels[row.refund_status] }}</template></el-table-column>
        <el-table-column label="时限" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'CLOSED'" type="info" size="small">已结束</el-tag>
            <el-tag v-else-if="row.overdue" type="danger" size="small">已超时</el-tag>
            <span v-else>{{ formatDateTime(row.due_at).slice(11) }}前</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-drawer :model-value="!!current" size="520px" :title="current?.product_name" @close="current = null">
      <template v-if="current">
        <p>{{ exceptionTypeLabels[current.exception_type] }}：{{ current.description }}</p>
        <div class="row">
          <el-button v-if="canAck(current)" type="primary" @click="ack">接单</el-button>
          <template v-if="canSubmitEvidence(current) && current.status === 'OPEN'">
            <el-button @click="$refs.purchaserFile.click()">{{ current.purchaser_evidence_at ? '更新凭证' : '提交首轮凭证' }}</el-button>
            <input ref="purchaserFile" type="file" multiple hidden accept="image/*,video/*" @change="uploadPurchaserEvidence" />
          </template>
          <a v-for="(u, i) in current.purchaser_evidence" :key="u" :href="u" target="_blank">凭证{{ i + 1 }}</a>
        </div>

        <div v-if="current.status === 'OPEN'" class="as-box">
          <div class="as-head">平台售后：<b>{{ current.aftersale_label }}</b>
            <span v-if="current.aftersale_deadline" class="muted">· 期限 {{ current.aftersale_deadline.replace('T', ' ').slice(0, 16) }}（{{ current.deadline_source_label }}）</span>
          </div>
          <el-alert v-for="h in current.aftersale_hints" :key="h" :title="h" type="warning" :closable="false" show-icon style="margin-top: 6px" />
          <div class="row" style="margin-top: 8px">
            <span class="muted">平台回执</span>
            <a v-for="(u, i) in current.aftersale_receipt" :key="u" :href="u" target="_blank">回执{{ i + 1 }}</a>
            <el-button size="small" @click="$refs.receiptFile.click()">上传</el-button>
            <input ref="receiptFile" type="file" multiple hidden accept="image/*" @change="uploadReceipt" />
          </div>
          <div class="row" style="margin-top: 8px">
            <el-select v-model="aftersaleForm.status" placeholder="改售后状态" clearable style="width: 150px">
              <el-option v-for="(label, key) in AFTERSALE" :key="key" :value="key" :label="label" />
            </el-select>
            <el-date-picker v-model="aftersaleForm.deadline" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="平台期限" style="width: 190px" />
            <el-select v-model="aftersaleForm.deadline_source" style="width: 130px">
              <el-option value="platform" label="平台页面上写的" />
              <el-option value="estimate" label="自己估的" />
            </el-select>
          </div>
          <div class="row" style="margin-top: 8px">
            <el-input v-model="aftersaleForm.note" placeholder="说明（撤销、介入要写为什么）" style="flex: 1" />
            <el-button type="primary" @click="saveAftersale">保存售后</el-button>
          </div>
          <div class="as-head" style="margin-top: 12px">留货 / 补差提议<span v-if="current.first_offer_by" class="muted"> · {{ current.first_offer_by === 'seller' ? '卖家先提的' : '我们先提的' }}</span></div>
          <div v-for="(o, i) in current.keep_offers" :key="i" class="muted">{{ o.at.replace('T', ' ').slice(5, 16) }} {{ o.by_label }}：「{{ o.text }}」<template v-if="o.amount"> 补差 ¥{{ o.amount }}</template></div>
          <div class="row" style="margin-top: 6px">
            <el-select v-model="offerForm.by" style="width: 90px"><el-option value="seller" label="卖家" /><el-option value="us" label="我们" /></el-select>
            <el-input v-model="offerForm.text" placeholder="对方原话" style="flex: 1" />
            <el-input v-model="offerForm.amount" placeholder="补差" style="width: 80px" />
            <el-button @click="addOffer">记下</el-button>
          </div>
        </div>

        <el-form v-if="current.status === 'OPEN'" label-width="84px" style="margin-top: 16px">
          <el-form-item label="拒签">
            <el-select v-model="progress.reject_status">
              <el-option v-for="(label, key) in rejectStatusLabels" :key="key" :value="key" :label="label" />
            </el-select>
          </el-form-item>
          <el-form-item label="退回单号"><el-input v-model="progress.return_tracking_no" /></el-form-item>
          <el-form-item label="承运方"><el-input v-model="progress.return_carrier" placeholder="如 顺丰" /></el-form-item>
          <el-form-item label="退回网点"><el-input v-model="progress.return_station" placeholder="退回的目标发件网点" /></el-form-item>
          <el-form-item label="运输">
            <el-select v-model="progress.return_logistics" clearable placeholder="寄出后跟踪">
              <el-option v-for="(label, key) in returnLogisticsLabels" :key="key" :value="key" :label="label" />
            </el-select>
          </el-form-item>
          <el-form-item label="签收凭证">
            <a v-for="(u, i) in current.return_sign_evidence" :key="u" :href="u" target="_blank" style="margin-right: 8px">凭证{{ i + 1 }}</a>
            <el-button size="small" @click="$refs.signFile.click()">上传</el-button>
            <input ref="signFile" type="file" multiple hidden accept="image/*" @change="uploadSignEvidence" />
          </el-form-item>
          <el-form-item label="退款">
            <el-select v-model="progress.refund_status">
              <el-option v-for="(label, key) in refundStatusLabels" :key="key" :value="key" :label="label" />
            </el-select>
          </el-form-item>
          <el-form-item label="到账金额">
            <el-input v-model="progress.refund_amount" style="width: 140px" />
            <span class="muted" style="margin-left: 8px">采购金额 {{ current.purchase_amount || '—' }}</span>
          </el-form-item>
          <el-form-item label="扣费"><el-input v-model="progress.refund_fee" placeholder="运费等已发生费用" style="width: 140px" /></el-form-item>
          <el-form-item label="差额原因">
            <el-input v-model="progress.refund_shortfall_reason" type="textarea" :rows="2" placeholder="不足额、费用争议的原因和复核结果（部分退款/被驳回必填）" />
          </el-form-item>
          <el-form-item label="说明"><el-input v-model="progress.note" /></el-form-item>
          <el-form-item><el-button type="primary" @click="saveProgress">保存进度</el-button></el-form-item>
          <el-form-item label="最终结果"><el-input v-model="finalResult" type="textarea" :rows="2" /></el-form-item>
          <el-form-item><el-button @click="close">结束这条异常</el-button></el-form-item>
        </el-form>
        <p v-else>最终结果：{{ current.final_result }}</p>

        <el-timeline style="margin-top: 16px">
          <el-timeline-item v-for="(e, i) in events" :key="i" :timestamp="formatDateTime(e.created_at)">
            <span v-if="e.target_name">
              通知 {{ e.target_name }}（{{ e.read_at ? '站内已读' : '站内未读' }}<template v-if="e.channel_detail">，{{ e.channel_detail }}</template>）：
            </span>
            <span v-else-if="e.operator_name">{{ e.operator_name }}：</span>
            {{ e.detail || e.action }}
          </el-timeline-item>
        </el-timeline>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.as-box { margin-top: 16px; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
.as-head { font-size: 14px; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
</style>
