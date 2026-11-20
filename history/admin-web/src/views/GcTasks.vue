<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime } from '../utils/labels'

// 分类:当前任务(进行中+待开始,进行中置顶) / 历史任务(已完结,按最近时间)
// gc 侧 status 支持逗号多值(IN),历史任务直接服务端分页
const CURRENT_STATUSES = 'RUNNING,DISPATCHED,PENDING'
const HISTORY_STATUSES = 'SUCCESS,FAILED,TIMEOUT,CANCELLED'

const section = ref('current')
const devices = ref([])
const deviceFilter = ref('')

const currentLoading = ref(false)
const currentList = ref([])
const currentLoaded = ref(false)

const historyLoading = ref(false)
const historyList = ref([])
const historyLoaded = ref(false)
const pagination = ref({ page: 1, size: 20, total: 0 })

const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref(null)

// 回放:流程发出的每个动作 + 动作后的截图。跑着的任务每 3 秒刷一次,看它走到哪一步
const REPLAY_POLL_MS = 3000
const replayVisible = ref(false)
const replayLoading = ref(false)
const replayRow = ref(null)
const replay = ref(null)
const replayList = ref(null)
let replayTimer = null
let replayToken = 0

const statusTypes = {
  SUCCESS: 'success',
  FAILED: 'danger',
  TIMEOUT: 'danger',
  RUNNING: 'warning',
  DISPATCHED: 'warning',
  PENDING: 'info',
  CANCELLED: 'info',
}

const TASK_TYPE_LABEL = {
  goods_publish: '上架',
  goods_delist: '下架',
  goods_reprice: '改价',
  goods_relist: '重新上架',
  goods_delete: '删除链接',
  goods_polish: '擦亮',
  chat_scan: '扫消息',
  chat_reply: '回消息',
  sold_scan: '查已售出',
}

const ACTION_LABEL = {
  tap: '点击',
  swipe: '滑动',
  key: '按键',
  set_text: '输入',
  set_clipboard: '写剪贴板',
  ime_picker: '切输入法',
  ime_commit: '输入法上屏',
  ime_prefix: '输入法上屏',
  force_stop: '关闭闲鱼',
  node_click: '点击',
  node_long_click: '长按',
  push_media: '准备图片',
  clear_media: '清理图片',
}

const STATUS_LABEL = {
  PENDING: '待开始',
  DISPATCHED: '已派发',
  RUNNING: '进行中',
  SUCCESS: '成功',
  FAILED: '失败',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
}

onMounted(() => {
  loadDevices()
  loadCurrent()
})

async function loadDevices() {
  try {
    const { data } = await api.get('/gc-ops/devices')
    devices.value = Array.isArray(data) ? data : (data.items || [])
  } catch { /* 设备下拉加载失败不阻塞任务列表 */ }
}

function baseParams() {
  const params = {}
  if (deviceFilter.value) params.device_id = deviceFilter.value
  return params
}

// 当前任务:数量少,一次拉全;进行中(RUNNING/DISPATCHED)置顶,待开始(PENDING)在后,组内按时间倒序
async function loadCurrent() {
  currentLoading.value = true
  try {
    const { data } = await api.get('/gc-ops/tasks', {
      params: { ...baseParams(), status: CURRENT_STATUSES, page: 1, page_size: 100 },
    })
    const items = data.items || []
    const running = items.filter((t) => t.status === 'RUNNING' || t.status === 'DISPATCHED')
    const pending = items.filter((t) => t.status === 'PENDING')
    currentList.value = running.concat(pending)
    currentLoaded.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    currentLoading.value = false
  }
}

async function loadHistory() {
  historyLoading.value = true
  try {
    const { data } = await api.get('/gc-ops/tasks', {
      params: {
        ...baseParams(),
        status: HISTORY_STATUSES,
        page: pagination.value.page,
        page_size: pagination.value.size,
      },
    })
    historyList.value = data.items || []
    pagination.value.total = data.total
    historyLoaded.value = true
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    historyLoading.value = false
  }
}

function onSectionChange(name) {
  if (name === 'current' && !currentLoaded.value) loadCurrent()
  if (name === 'history' && !historyLoaded.value) loadHistory()
}

function onRefresh() {
  if (section.value === 'history') loadHistory()
  else loadCurrent()
}

function onSearch() {
  pagination.value.page = 1
  currentLoaded.value = false
  historyLoaded.value = false
  onRefresh()
}

function onPageChange(page) {
  pagination.value.page = page
  loadHistory()
}

function onSizeChange(size) {
  pagination.value.size = size
  pagination.value.page = 1
  loadHistory()
}

function openDetail(row) {
  detailVisible.value = true
  detailLoading.value = true
  api.get(`/gc-ops/tasks/${row.id}`).then(({ data }) => {
    detail.value = data
  }).catch((err) => {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  }).finally(() => {
    detailLoading.value = false
  })
}

function actionLabel(step) {
  if (step.action === 'launch_app') return /^https?:/.test(step.args || '') ? '打开页面' : '打开闲鱼'
  return ACTION_LABEL[step.action] || step.action
}

function formatArgs(step) {
  const args = step.args || ''
  if (step.action === 'clear_media') return args.replace(/^(\d+)uris$/, '$1 张')
  if (step.action === 'swipe') return args.replace('->', ' → ')
  // 输入类记的是 Python repr,去掉外层引号
  if (/^(set_text|set_clipboard|ime_)/.test(step.action)) return args.replace(/^'(.*)'$/s, '$1')
  return args
}

function formatAt(at) {
  if (at == null) return ''
  if (at < 60) return `+${at.toFixed(1)}s`
  const m = Math.floor(at / 60)
  return `+${m}m${String(Math.floor(at - m * 60)).padStart(2, '0')}s`
}

function formatMs(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const replayTitle = computed(() => {
  const row = replayRow.value
  if (!row) return '回放'
  const who = row.account_nick || row.device_name || ''
  return ['回放', TASK_TYPE_LABEL[row.task_type] || row.task_type, who].filter(Boolean).join(' · ')
})

// 点开大图后能左右翻:所有截图按步骤顺序,结果截图在最后
const replayShots = computed(() => {
  const r = replay.value
  if (!r) return []
  const shots = r.steps.map((s) => s.shot_url).filter(Boolean)
  if (r.result_shot_url) shots.push(r.result_shot_url)
  return shots
})

function shotIndex(url) {
  return Math.max(0, replayShots.value.indexOf(url))
}

// 轮询时链接每次都重新签名;已经显示的截图沿用旧链接,免得每 3 秒整页图片重载一遍
function mergeSteps(prev, next) {
  const bySeq = new Map((prev || []).map((s) => [s.seq, s]))
  return next.map((s) => {
    const old = bySeq.get(s.seq)
    return old && old.shot_url ? { ...s, shot_url: old.shot_url, thumb_url: old.thumb_url } : s
  })
}

function replayScroller() {
  return replayList.value?.closest('.el-drawer__body') || null
}

function stopReplay() {
  clearTimeout(replayTimer)
  replayTimer = null
}

async function loadReplay(id, token, quiet = false) {
  if (!quiet) replayLoading.value = true
  const box = replayScroller()
  const atBottom = !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 40
  try {
    const { data } = await api.get(`/gc-ops/tasks/${id}/trace`)
    if (token !== replayToken) return
    const wasLive = replay.value?.live
    replay.value = { ...data, steps: mergeSteps(replay.value?.steps, data.steps || []) }
    if (data.live && replayVisible.value) {
      replayTimer = setTimeout(() => loadReplay(id, token, true), REPLAY_POLL_MS)
    } else if (wasLive) {
      loadCurrent() // 跑完了:它该从「当前任务」里挪走
    }
    // 跟着看最新一步:人没往上翻,就停在最底下
    if (quiet && atBottom) {
      await nextTick()
      const el = replayScroller()
      if (el) el.scrollTop = el.scrollHeight
    }
  } catch (err) {
    if (token === replayToken) ElMessage.error(err.response?.data?.detail || '回放加载失败')
  } finally {
    if (token === replayToken) replayLoading.value = false
  }
}

function openReplay(row) {
  stopReplay()
  replayToken += 1
  replayRow.value = row
  replay.value = null
  replayVisible.value = true
  loadReplay(row.id, replayToken)
}

function onReplayClosed() {
  stopReplay()
  replayToken += 1
}

onBeforeUnmount(stopReplay)

async function retry(row) {
  try {
    await ElMessageBox.confirm(`确认重试任务 #${row.id}（${row.task_type}）？`, '重试确认', {
      confirmButtonText: '重试',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await api.post(`/gc-ops/tasks/${row.id}/retry`)
    ElMessage.success('已发起重试')
    // 重试后任务回到待开始:两个分类都刷新
    loadCurrent()
    if (historyLoaded.value) loadHistory()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.response?.data?.detail || '操作失败')
    }
  }
}
</script>

<template>
  <div class="page-container">
    <el-card class="search-card">
      <div class="search-row">
        <el-select
          v-model="deviceFilter"
          placeholder="设备（全部）"
          clearable
          filterable
          style="width: 220px"
        >
          <el-option v-for="d in devices" :key="d.id" :label="d.name || d.serial" :value="d.id" />
        </el-select>
        <el-button type="primary" @click="onSearch">查询</el-button>
        <el-button :icon="Refresh" :loading="section === 'history' ? historyLoading : currentLoading" @click="onRefresh">
          刷新
        </el-button>
      </div>
    </el-card>

    <el-card>
      <el-tabs v-model="section" @tab-change="onSectionChange">
        <el-tab-pane label="当前任务" name="current" />
        <el-tab-pane label="历史任务" name="history" />
      </el-tabs>

      <!-- 当前任务:进行中置顶,待开始在后 -->
      <template v-if="section === 'current'">
        <el-table :data="currentList" v-loading="currentLoading" stripe>
          <el-table-column label="创建时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="task_type" label="任务类型" min-width="120">
            <template #default="{ row }">{{ row.task_type || '—' }}</template>
          </el-table-column>
          <el-table-column prop="device_name" label="设备" min-width="120">
            <template #default="{ row }">{{ row.device_name || '—' }}</template>
          </el-table-column>
          <el-table-column prop="account_nick" label="账号" min-width="120">
            <template #default="{ row }">{{ row.account_nick || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTypes[row.status] || 'info'">{{ STATUS_LABEL[row.status] || row.status || '—' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="progress" label="进度" width="90">
            <template #default="{ row }">{{ row.progress ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="错误" min-width="180">
            <template #default="{ row }">
              <span :title="row.error">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" link @click="openDetail(row)">详情</el-button>
              <el-button size="small" type="primary" link @click="openReplay(row)">回放</el-button>
            </template>
          </el-table-column>
          <template #empty>暂无进行中的任务</template>
        </el-table>
      </template>

      <!-- 历史任务:按最近时间倒序,服务端分页 -->
      <template v-else>
        <el-table :data="historyList" v-loading="historyLoading" stripe>
          <el-table-column label="创建时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="task_type" label="任务类型" min-width="120">
            <template #default="{ row }">{{ row.task_type || '—' }}</template>
          </el-table-column>
          <el-table-column prop="device_name" label="设备" min-width="120">
            <template #default="{ row }">{{ row.device_name || '—' }}</template>
          </el-table-column>
          <el-table-column prop="account_nick" label="账号" min-width="120">
            <template #default="{ row }">{{ row.account_nick || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTypes[row.status] || 'info'">{{ STATUS_LABEL[row.status] || row.status || '—' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="failed_step" label="失败步骤" min-width="120">
            <template #default="{ row }">{{ row.failed_step || '—' }}</template>
          </el-table-column>
          <el-table-column label="错误" min-width="180">
            <template #default="{ row }">
              <span :title="row.error">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" link @click="openDetail(row)">详情</el-button>
              <el-button size="small" type="primary" link @click="openReplay(row)">回放</el-button>
              <el-button
                v-if="row.status === 'FAILED' || row.status === 'TIMEOUT'"
                size="small"
                type="danger"
                link
                @click="retry(row)"
              >
                重试
              </el-button>
            </template>
          </el-table-column>
          <template #empty>暂无历史任务</template>
        </el-table>

        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.size"
          :total="pagination.total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="onPageChange"
          @size-change="onSizeChange"
          style="margin-top: 16px; justify-content: flex-end"
        />
      </template>
    </el-card>

    <el-dialog v-model="detailVisible" title="任务详情" width="720px" :close-on-click-modal="false">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="任务 ID">{{ detail.id }}</el-descriptions-item>
            <el-descriptions-item label="任务类型">{{ detail.task_type || '—' }}</el-descriptions-item>
            <el-descriptions-item label="设备">{{ detail.device_name || detail.device_id || '—' }}</el-descriptions-item>
            <el-descriptions-item label="账号">{{ detail.account_nick || detail.account_id || '—' }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="statusTypes[detail.status] || 'info'">{{ STATUS_LABEL[detail.status] || detail.status || '—' }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="进度">{{ detail.progress ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="失败步骤">{{ detail.failed_step || '—' }}</el-descriptions-item>
            <el-descriptions-item label="标记">{{ detail.mark || '—' }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ formatDateTime(detail.created_at) }}</el-descriptions-item>
            <el-descriptions-item label="下发时间">{{ formatDateTime(detail.dispatched_at) }}</el-descriptions-item>
            <el-descriptions-item label="完成时间">{{ formatDateTime(detail.finished_at) }}</el-descriptions-item>
            <el-descriptions-item label="截图 Key">{{ detail.shot_key || '—' }}</el-descriptions-item>
          </el-descriptions>
          <div v-if="detail.error" class="detail-block">
            <div class="detail-block__title">错误信息</div>
            <pre>{{ detail.error }}</pre>
          </div>
          <div class="detail-block">
            <div class="detail-block__title">Spec</div>
            <pre>{{ JSON.stringify(detail.spec, null, 2) }}</pre>
          </div>
          <div class="detail-block">
            <div class="detail-block__title">Result</div>
            <pre>{{ JSON.stringify(detail.result, null, 2) }}</pre>
          </div>
        </template>
      </div>
    </el-dialog>

    <el-drawer v-model="replayVisible" :title="replayTitle" size="720px" @closed="onReplayClosed">
      <div v-loading="replayLoading && !replay" class="replay">
        <template v-if="replay">
          <div class="replay-head">
            <el-tag :type="statusTypes[replay.status] || 'info'">{{ STATUS_LABEL[replay.status] || replay.status }}</el-tag>
            <span>共 {{ replay.steps.length }} 步</span>
            <span v-if="replay.live" class="replay-live"><i />进行中，每 3 秒刷新</span>
          </div>
          <el-empty
            v-if="!replay.steps.length && !replay.result_shot_url"
            :description="replay.note || (replay.live ? '刚开始，还没有动作' : '没有步骤')"
            :image-size="80"
          />
          <ol v-else ref="replayList" class="replay-steps">
            <li v-for="step in replay.steps" :key="step.seq" class="replay-step" :class="{ 'is-error': step.error }">
              <div class="replay-step__meta">
                <span class="replay-step__seq">#{{ step.seq }}</span>
                <span>{{ formatAt(step.at) }}</span>
              </div>
              <div class="replay-step__body">
                <div class="replay-step__title">
                  <b>{{ actionLabel(step) }}</b>
                  <span class="replay-step__args" :title="step.args">{{ formatArgs(step) }}</span>
                </div>
                <div class="replay-step__muted">耗时 {{ formatMs(step.ms) }}</div>
                <div v-if="step.error" class="replay-step__error">{{ step.error }}</div>
                <div v-else-if="step.shot_error && !step.shot_url" class="replay-step__muted">截图失败：{{ step.shot_error }}</div>
              </div>
              <el-image
                v-if="step.thumb_url"
                :src="step.thumb_url"
                :preview-src-list="replayShots"
                :initial-index="shotIndex(step.shot_url)"
                fit="contain"
                preview-teleported
                class="replay-step__shot"
              />
              <div v-else class="replay-step__shot replay-step__shot--none">无截图</div>
            </li>
            <li v-if="replay.result_shot_url" class="replay-step replay-step--result">
              <div class="replay-step__meta"><span class="replay-step__seq">结果</span></div>
              <div class="replay-step__body">
                <div class="replay-step__title"><b>结果截图</b></div>
                <div v-if="replayRow?.error" class="replay-step__error">{{ replayRow.error }}</div>
              </div>
              <el-image
                :src="replay.result_thumb_url || replay.result_shot_url"
                :preview-src-list="replayShots"
                :initial-index="shotIndex(replay.result_shot_url)"
                fit="contain"
                preview-teleported
                class="replay-step__shot"
              />
            </li>
          </ol>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page-container {
  max-width: 1400px;
}

.search-card {
  margin-bottom: 16px;
}

.search-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.detail-block {
  margin-top: 16px;
}

.detail-block__title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--el-text-color-regular);
}

.replay-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.replay-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--el-color-warning);
}

.replay-live i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: replay-pulse 1.2s ease-in-out infinite;
}

@keyframes replay-pulse {
  50% { opacity: 0.25; }
}

.replay-steps {
  list-style: none;
  margin: 0;
  padding: 0;
}

.replay-step {
  display: grid;
  grid-template-columns: 64px 1fr 150px;
  gap: 12px;
  align-items: start;
  padding: 10px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.replay-step__title b {
  flex: none;
}

.replay-step.is-error .replay-step__title b {
  color: var(--el-color-danger);
}

.replay-step__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.replay-step__seq {
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.replay-step__title {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
  font-size: 13px;
}

.replay-step__args {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--el-text-color-regular);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}

.replay-step__muted {
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.replay-step__error {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-color-danger);
  word-break: break-all;
}

.replay-step__shot {
  width: 150px;
  height: 112px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  cursor: zoom-in;
}

.replay-step__shot--none {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  cursor: default;
}

.detail-block pre {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 280px;
  overflow-y: auto;
}
</style>
