<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { errorText } from '../utils/evidenceUpload'
import { formatDateTime } from '../utils/labels'

const STATE_LABEL = {
  IDENTIFY: '识别',
  QUOTE: '报价',
  COUNTER: '还价',
  DEAL: '谈妥',
  PAUSING: '待确认暂停',
  PAUSED: '已暂停',
  CLOSED: '结束',
}
const STATE_TYPE = {
  IDENTIFY: 'info',
  QUOTE: 'warning',
  COUNTER: 'warning',
  DEAL: 'success',
  PAUSING: 'danger',
  PAUSED: 'info',
  CLOSED: 'info',
}
const TABS = [
  { key: 'IDENTIFY,QUOTE,COUNTER,PAUSING,PAUSED', label: '进行中' },
  { key: 'DEAL', label: '已谈妥' },
  { key: 'CLOSED', label: '已结束' },
  { key: '', label: '全部' },
]

const tab = ref(TABS[0].key)
const loading = ref(false)
const items = ref([])
const total = ref(0)
const page = ref(1)
const openVisible = ref(false)
const openForm = ref({ platform_item_id: '', purchase_account: '', seller_name: '', title: '', listed_price: null })
const saving = ref(false)
const active = ref(null)
const drawerOpen = ref(false)
const actionPrice = ref(null)
const actionNote = ref('')
const acting = ref(false)

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/bargain/sessions', {
      params: { state: tab.value || undefined, page: page.value, size: 20 },
    })
    items.value = data.items
    total.value = data.total
  } catch (err) {
    ElMessage.error(errorText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

function switchTab() {
  page.value = 1
  load()
}

async function createSession() {
  if (!openForm.value.platform_item_id && !openForm.value.title) {
    ElMessage.warning('请至少填商品 ID 或标题')
    return
  }
  saving.value = true
  try {
    const { data } = await api.post('/bargain/sessions', openForm.value)
    ElMessage.success('已开聊')
    openVisible.value = false
    active.value = data
    drawerOpen.value = true
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '开聊失败'))
  } finally {
    saving.value = false
  }
}

async function openRow(row) {
  try {
    const { data } = await api.get(`/bargain/sessions/${row.id}`)
    active.value = data
    drawerOpen.value = true
    actionPrice.value = null
    actionNote.value = ''
  } catch (err) {
    ElMessage.error(errorText(err, '打开失败'))
  }
}

function closeDrawer() {
  drawerOpen.value = false
  active.value = null
}

async function doAction(action) {
  if (['quote', 'counter', 'deal'].includes(action) && (actionPrice.value == null || actionPrice.value <= 0)) {
    ElMessage.warning('请填写价格')
    return
  }
  if (action === 'deal' && (active.value?.pending_required || 0) > 0) {
    ElMessage.warning(`还有 ${active.value.pending_required} 项必要问题待核`)
    return
  }
  acting.value = true
  try {
    const { data } = await api.post(`/bargain/sessions/${active.value.id}/transition`, {
      action,
      price: actionPrice.value,
      note: actionNote.value || null,
    })
    active.value = data
    actionPrice.value = null
    actionNote.value = ''
    ElMessage.success(STATE_LABEL[data.state] || '已更新')
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '操作失败'))
  } finally {
    acting.value = false
  }
}

const CHECK_LABEL = { PENDING: '待核', DECLARED: '卖家已声明', VERIFIED: '已核对', SKIPPED: '跳过' }

async function setCheck(key, status) {
  acting.value = true
  try {
    const { data } = await api.post(`/bargain/sessions/${active.value.id}/checks`, { key, status })
    active.value = data
    ElMessage.success(CHECK_LABEL[status] || '已更新')
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '更新失败'))
  } finally {
    acting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">采购议价</h3>
      <div class="row">
        <el-radio-group v-model="tab" @change="switchTab">
          <el-radio-button v-for="t in TABS" :key="t.key || 'all'" :value="t.key">{{ t.label }}</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="openVisible = true">开聊</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="items" empty-text="暂无议价会话" @row-click="openRow">
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="STATE_TYPE[row.state] || 'info'" size="small">{{ STATE_LABEL[row.state] || row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="商品" min-width="180" show-overflow-tooltip />
        <el-table-column prop="platform_item_id" label="商品 ID" width="140" show-overflow-tooltip />
        <el-table-column prop="seller_name" label="卖家" width="120" show-overflow-tooltip />
        <el-table-column prop="purchase_account" label="采购账号" width="120" show-overflow-tooltip />
        <el-table-column label="我方/对方/谈妥" min-width="160">
          <template #default="{ row }">
            {{ row.our_price ?? '—' }} / {{ row.their_price ?? '—' }} / {{ row.deal_price ?? '—' }}
          </template>
        </el-table-column>
        <el-table-column label="更新" width="160">
          <template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template>
        </el-table-column>
      </el-table>
      <div class="pager" v-if="total > 20">
        <el-pagination
          v-model:current-page="page"
          layout="prev, pager, next"
          :total="total"
          :page-size="20"
          @current-change="load"
        />
      </div>
    </div>
  </div>

  <el-drawer v-model="drawerOpen" :with-header="false" size="420px" destroy-on-close @close="closeDrawer">
    <template v-if="active">
      <h3>{{ active.title || active.platform_item_id || '议价会话' }}</h3>
      <p class="muted">
        <el-tag :type="STATE_TYPE[active.state]" size="small">{{ STATE_LABEL[active.state] }}</el-tag>
        · 第 {{ active.round_no }} 轮
      </p>
      <el-descriptions :column="1" border size="small" style="margin: 12px 0">
        <el-descriptions-item label="商品 ID">{{ active.platform_item_id || '—' }}</el-descriptions-item>
        <el-descriptions-item label="卖家">{{ active.seller_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="采购账号">{{ active.purchase_account || '—' }}</el-descriptions-item>
        <el-descriptions-item label="标价">{{ active.listed_price ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="我方报价">{{ active.our_price ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="对方还价">{{ active.their_price ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="谈妥">{{ active.deal_price ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="采购单">
          <router-link v-if="active.purchase_order_id" :to="`/orders/purchase`">已绑定</router-link>
          <span v-else>未绑</span>
        </el-descriptions-item>
        <el-descriptions-item label="群控会话">{{ active.gc_conversation_id || '—' }}</el-descriptions-item>
        <el-descriptions-item label="必要问题">
          待核 {{ active.pending_required || 0 }} / 共 {{ (active.checks || []).length }}
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="active.state === 'DEAL' && !active.purchase_order_id"
        type="success"
        :closable="false"
        title="已谈妥：请到小程序采购页建单，或建单时带 bargain_session_id"
        style="margin-bottom: 12px"
      />

      <div v-if="(active.checks || []).length" class="checks">
        <h4>必要问题待核</h4>
        <div v-for="c in active.checks" :key="c.key" class="check-row">
          <div>
            <strong>{{ c.required ? '* ' : '' }}{{ c.title }}</strong>
            <el-tag size="small" :type="c.status === 'PENDING' ? 'warning' : 'info'" style="margin-left: 8px">
              {{ CHECK_LABEL[c.status] || c.status }}
            </el-tag>
            <div v-if="c.note" class="muted">{{ c.note }}</div>
          </div>
          <div v-if="active.state !== 'DEAL' && active.state !== 'CLOSED'" class="row" style="margin-top: 6px">
            <el-button size="small" :loading="acting" @click="setCheck(c.key, 'DECLARED')">卖家已声明</el-button>
            <el-button size="small" type="success" :loading="acting" @click="setCheck(c.key, 'VERIFIED')">已核对</el-button>
            <el-button size="small" :loading="acting" @click="setCheck(c.key, 'SKIPPED')">跳过</el-button>
          </div>
        </div>
      </div>

      <div v-if="active.state !== 'DEAL' && active.state !== 'CLOSED'" class="actions">
        <template v-if="active.state !== 'PAUSING' && active.state !== 'PAUSED'">
          <el-input-number v-model="actionPrice" :min="1" :precision="0" placeholder="价格" />
          <el-input v-model="actionNote" placeholder="说明（可选）" style="margin-top: 8px" />
        </template>
        <div class="row" style="margin-top: 10px; flex-wrap: wrap">
          <template v-if="active.state !== 'PAUSING' && active.state !== 'PAUSED'">
            <el-button :loading="acting" @click="doAction('quote')">报价</el-button>
            <el-button :loading="acting" @click="doAction('counter')">还价</el-button>
            <el-button type="success" :loading="acting" @click="doAction('deal')">谈妥</el-button>
            <el-button :loading="acting" @click="doAction('pause_request')">请求暂停</el-button>
          </template>
          <el-button v-if="active.state === 'PAUSING'" type="warning" :loading="acting" @click="doAction('pause_confirm')">确认暂停</el-button>
          <el-button v-if="active.state === 'PAUSING' || active.state === 'PAUSED'" :loading="acting" @click="doAction('resume')">
            {{ active.state === 'PAUSING' ? '取消请求' : '恢复' }}
          </el-button>
          <el-button type="danger" plain :loading="acting" @click="doAction('close')">结束</el-button>
        </div>
      </div>

      <h4 style="margin-top: 20px">历程</h4>
      <div v-for="(e, i) in (active.events || []).slice().reverse()" :key="i" class="event">
        <span class="muted">{{ e.at }}</span>
        {{ e.from }} → {{ e.to }}
        <span v-if="e.price"> · ¥{{ e.price }}</span>
        <span v-if="e.note" class="muted"> · {{ e.note }}</span>
      </div>
    </template>
  </el-drawer>

  <el-dialog v-model="openVisible" title="开聊" width="420px">
    <el-form label-width="90px">
      <el-form-item label="商品 ID"><el-input v-model="openForm.platform_item_id" /></el-form-item>
      <el-form-item label="标题"><el-input v-model="openForm.title" /></el-form-item>
      <el-form-item label="卖家"><el-input v-model="openForm.seller_name" /></el-form-item>
      <el-form-item label="采购账号"><el-input v-model="openForm.purchase_account" /></el-form-item>
      <el-form-item label="标价"><el-input-number v-model="openForm.listed_price" :min="1" :precision="0" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="openVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="createSession">开聊</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.pager { margin-top: 12px; display: flex; justify-content: flex-end; }
.event { padding: 6px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 13px; }
.actions { margin-top: 8px; }
.checks { margin: 12px 0; }
.check-row { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); font-size: 13px; }
</style>
