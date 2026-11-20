<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import MediaGallery from '../components/MediaGallery.vue'
import { formatDateTime } from '../utils/labels'

const CATEGORY_OPTIONS = [
  { label: '全部类型', value: '' },
  { label: '我要返工', value: 'REWORK' },
  { label: '我要反馈', value: 'FEEDBACK' },
  { label: '我要投诉', value: 'COMPLAINT' },
]

const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  { label: '待处理', value: 'OPEN' },
  { label: '处理中', value: 'IN_PROGRESS' },
  { label: '已关闭', value: 'CLOSED' },
]

const CATEGORY_META = {
  REWORK: { text: '返工', type: 'warning' },
  FEEDBACK: { text: '反馈', type: 'info' },
  COMPLAINT: { text: '投诉', type: 'danger' },
}

const STATUS_META = {
  OPEN: { text: '待处理', type: 'info' },
  IN_PROGRESS: { text: '处理中', type: 'warning' },
  CLOSED: { text: '已关闭', type: 'success' },
}

const loading = ref(false)
const rows = ref([])
const q = ref('')
const category = ref('')
const status = ref('')

const detailVisible = ref(false)
const saving = ref(false)
const detailForm = reactive({
  id: '',
  title: '',
  category: '',
  target: '',
  content: '',
  attachments: [],
  status: 'OPEN',
  handled_note: '',
  handled_at: '',
  handled_by_name: '',
  created_at: '',
})

const currentCategoryMeta = computed(() => CATEGORY_META[detailForm.category] || { text: detailForm.category, type: 'info' })
const currentStatusMeta = computed(() => STATUS_META[detailForm.status] || { text: detailForm.status, type: 'info' })

function fillDetail(row) {
  detailForm.id = row.id
  detailForm.title = row.title || ''
  detailForm.category = row.category || ''
  detailForm.target = row.target || ''
  detailForm.content = row.content || ''
  detailForm.attachments = row.attachments || []
  detailForm.status = row.status || 'OPEN'
  detailForm.handled_note = row.handled_note || ''
  detailForm.handled_at = row.handled_at || ''
  detailForm.handled_by_name = row.handled_by_name || ''
  detailForm.created_at = row.created_at || ''
}

async function load() {
  loading.value = true
  try {
    const params = {}
    if (q.value.trim()) params.q = q.value.trim()
    if (category.value) params.category = category.value
    if (status.value) params.status = status.value
    const { data } = await api.get('/feedback/anonymous', { params })
    rows.value = data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function search() {
  load()
}

function openDetail(row) {
  fillDetail(row)
  detailVisible.value = true
}

async function saveDetail() {
  saving.value = true
  try {
    const { data } = await api.patch(`/feedback/anonymous/${detailForm.id}`, {
      status: detailForm.status,
      handled_note: detailForm.handled_note || null,
    })
    const index = rows.value.findIndex((item) => item.id === data.id)
    if (index >= 0) rows.value.splice(index, 1, data)
    fillDetail(data)
    ElMessage.success('已更新处理状态')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">匿名反馈箱</h3>
      <div class="toolbar">
        <el-input
          v-model="q"
          clearable
          placeholder="搜索标题 / 模块 / 内容"
          class="toolbar__search"
          @keyup.enter="search"
          @clear="search"
        />
        <el-select v-model="category" class="toolbar__select" @change="search">
          <el-option v-for="item in CATEGORY_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select v-model="status" class="toolbar__select" @change="search">
          <el-option v-for="item in STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="rows" stripe>
        <el-table-column label="提交时间" width="168">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="CATEGORY_META[row.category]?.type || 'info'">
              {{ CATEGORY_META[row.category]?.text || row.category }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
        <el-table-column prop="target" label="涉及模块 / 对象" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="STATUS_META[row.status]?.type || 'info'">
              {{ STATUS_META[row.status]?.text || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="附件" width="90">
          <template #default="{ row }">{{ row.attachments?.length || 0 }}</template>
        </el-table-column>
        <el-table-column label="最后处理" min-width="180">
          <template #default="{ row }">
            <span v-if="row.handled_at">{{ formatDateTime(row.handled_at) }}{{ row.handled_by_name ? ` · ${row.handled_by_name}` : '' }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDetail(row)">查看处理</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <el-drawer v-model="detailVisible" title="匿名反馈详情" size="720px">
    <div class="detail-wrap">
      <div class="detail-head">
        <div>
          <div class="detail-title">{{ detailForm.title || '未命名反馈' }}</div>
          <div class="detail-meta">
            <el-tag :type="currentCategoryMeta.type">{{ currentCategoryMeta.text }}</el-tag>
            <el-tag :type="currentStatusMeta.type">{{ currentStatusMeta.text }}</el-tag>
            <span>{{ formatDateTime(detailForm.created_at) }}</span>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-label">涉及模块 / 对象</div>
        <div class="detail-text">{{ detailForm.target || '—' }}</div>
      </div>

      <div class="detail-section">
        <div class="detail-label">详细内容</div>
        <div class="detail-content">{{ detailForm.content || '—' }}</div>
      </div>

      <div class="detail-section">
        <div class="detail-label">附件</div>
        <MediaGallery :urls="detailForm.attachments" thumb-size="large" />
        <div v-if="!detailForm.attachments.length" class="detail-text">无附件</div>
      </div>

      <div class="detail-section">
        <div class="detail-label">处理状态</div>
        <el-select v-model="detailForm.status" style="width: 180px">
          <el-option label="待处理" value="OPEN" />
          <el-option label="处理中" value="IN_PROGRESS" />
          <el-option label="已关闭" value="CLOSED" />
        </el-select>
      </div>

      <div class="detail-section">
        <div class="detail-label">处理备注</div>
        <el-input v-model="detailForm.handled_note" type="textarea" :rows="5" placeholder="记录跟进动作、结论或行政处理结果" />
      </div>

      <div class="detail-foot" v-if="detailForm.handled_at">
        最近处理：{{ formatDateTime(detailForm.handled_at) }}{{ detailForm.handled_by_name ? ` · ${detailForm.handled_by_name}` : '' }}
      </div>

      <div class="detail-actions">
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" :loading="saving" @click="saveDetail">保存处理结果</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar__search {
  width: 260px;
}

.toolbar__select {
  width: 150px;
}

.detail-wrap {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.detail-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
}

.detail-text {
  font-size: 14px;
  color: var(--text-primary);
}

.detail-content {
  white-space: pre-wrap;
  line-height: 1.7;
  font-size: 14px;
  color: var(--text-primary);
  padding: 14px 16px;
  background: #fafafa;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.detail-foot {
  font-size: 13px;
  color: var(--text-secondary);
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
}
</style>
