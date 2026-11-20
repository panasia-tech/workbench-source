<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { currentRole } from '../utils/consoleAccess'
import MediaGallery from '../components/MediaGallery.vue'
import { formatDateTime } from '../utils/labels'
import {
  checkResultLabels,
  checkResultTypes,
  errorText,
  evidenceKindLabels,
  exceptionTypeLabels,
} from '../utils/evidenceUpload'

const CHECK_OPTS = [
  { key: 'SAME', label: '一样' },
  { key: 'FIXED', label: '已修好' },
  { key: 'WORSE', label: '更严重' },
  { key: 'NEW', label: '新问题' },
]

const code = ref('')
const dossier = ref(null)
const remark = ref('')
const identity = ref('')
const result = ref('OK')
const itemChecks = ref({})
const loading = ref(false)
const submitting = ref(false)

const photos = computed(() => {
  if (!dossier.value) return []
  return [
    ...dossier.value.evidence.filter((e) => !e.is_video).map((e) => e.url),
    ...(dossier.value.inspection?.defect_images || []),
  ]
})
const videos = computed(() => dossier.value?.evidence.filter((e) => e.is_video) || [])
const inStock = computed(() => ['IN_STOCK', 'RESERVED'].includes(dossier.value?.sku.status))
const canReview = ['SALES', 'ADMIN'].includes(currentRole())
const problemItems = computed(() =>
  (dossier.value?.items || []).filter((i) => i.result === 'FAIL' || i.result === 'UNTESTABLE'),
)

watch(itemChecks, (map) => {
  const worse = Object.values(map).some((s) => s === 'WORSE' || s === 'NEW')
  if (worse) result.value = 'PROBLEM'
}, { deep: true })

async function search() {
  const sku = code.value.trim()
  if (!sku) return
  loading.value = true
  remark.value = ''
  identity.value = ''
  result.value = 'OK'
  itemChecks.value = {}
  try {
    const { data } = await api.get(`/inspection-ops/skus/${encodeURIComponent(sku)}/dossier`)
    dossier.value = data
  } catch (err) {
    dossier.value = null
    ElMessage.error(errorText(err, '查询失败'))
  } finally {
    loading.value = false
  }
}

const problems = ref([])
async function loadProblems() {
  try {
    const { data } = await api.get('/inspection-ops/outbound-problems')
    problems.value = data.items
  } catch {
    problems.value = []
  }
}
function openProblem(row) {
  code.value = row.sku_code
  search()
}
onMounted(loadProblems)

async function submit(ok) {
  if (!identity.value.trim()) {
    ElMessage.warning('请先扫或输货号/序列号核对实物')
    return
  }
  const missing = problemItems.value.find((i) => !itemChecks.value[i.item_key])
  if (missing) {
    ElMessage.warning(`请逐项比对：${missing.title}`)
    return
  }
  const nextResult = ok ? result.value : 'PROBLEM'
  if (nextResult === 'PROBLEM' && !remark.value.trim()) {
    ElMessage.warning('发现新问题要写清是什么问题、在哪个部位')
    return
  }
  submitting.value = true
  try {
    const { data } = await api.post(`/inspection-ops/skus/${encodeURIComponent(dossier.value.sku.sku_code)}/review`, {
      result: nextResult,
      identity_code: identity.value.trim(),
      remark: remark.value,
      item_checks: problemItems.value.map((i) => ({ item_key: i.item_key, status: itemChecks.value[i.item_key] })),
    })
    dossier.value = data
    ElMessage.success(nextResult === 'OK' ? '已复核，可以发货' : '已登记问题并拦住出库')
    remark.value = ''
    identity.value = ''
    itemChecks.value = {}
    result.value = 'OK'
    loadProblems()
  } catch (err) {
    ElMessage.error(errorText(err, '复核失败'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="problems.length" class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">出库问题待处理</h3>
      <span class="muted">复核发现新问题，已拦住出库；处理后点进去重新复核</span>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table :data="problems" size="small" @row-click="openProblem">
        <el-table-column prop="sku_code" label="货号" width="140" />
        <el-table-column prop="product_name" label="商品" min-width="180" />
        <el-table-column prop="remark" label="问题" min-width="220" />
        <el-table-column prop="reviewer_name" label="发现人" width="100" />
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">出库复核</h3>
      <el-input v-model="code" placeholder="扫或输货号" style="width: 240px" @keyup.enter="search">
        <template #append><el-button :loading="loading" @click="search">查询</el-button></template>
      </el-input>
    </div>
    <div v-if="dossier" class="page-card__body">
      <el-descriptions :column="3" border>
        <el-descriptions-item label="货号">{{ dossier.sku.sku_code }}</el-descriptions-item>
        <el-descriptions-item label="序列号">{{ dossier.sku.serial_number }}</el-descriptions-item>
        <el-descriptions-item label="库位">{{ dossier.sku.location_code }}</el-descriptions-item>
        <el-descriptions-item label="商品" :span="2">{{ dossier.sku.product_name }} {{ dossier.sku.model }}</el-descriptions-item>
        <el-descriptions-item label="成色">{{ dossier.sku.condition_grade || '—' }}</el-descriptions-item>
        <el-descriptions-item v-if="dossier.full_check && dossier.full_check.state !== 'NONE'" label="全检" :span="3">
          <el-tag :type="dossier.full_check.state === 'COMPLETE' ? 'success' : 'danger'" size="small">{{ dossier.full_check.label }}</el-tag>
          <span v-if="dossier.full_check.retest.length" class="muted"> 待补测：{{ dossier.full_check.retest.join('、') }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="dossier.inspection?.mismatch_remark" label="货不符" :span="3">
          {{ dossier.inspection.mismatch_remark }}
        </el-descriptions-item>
      </el-descriptions>

      <h4>验货结果</h4>
      <el-empty v-if="!dossier.items.length" description="这件货没有逐项记录" :image-size="48" />
      <div v-for="i in dossier.items" :key="i.item_key" class="row">
        <el-tag :type="checkResultTypes[i.result] || 'info'" size="small">{{ checkResultLabels[i.result] || '没验' }}</el-tag>
        <span>{{ i.title }}</span>
        <span class="muted">{{ i.note }}</span>
      </div>

      <template v-if="problemItems.length && inStock && canReview && !(dossier.pending_review && dossier.pending_review.result === 'OK')">
        <h4>入库瑕疵逐项比对</h4>
        <p class="muted">对照实物勾选：一样 / 已修好 / 更严重 / 新问题。更严重或新问题会拦住出库。</p>
        <div v-for="i in problemItems" :key="i.item_key" class="check-block">
          <div class="row">
            <el-tag :type="checkResultTypes[i.result] || 'warning'" size="small">{{ checkResultLabels[i.result] }}</el-tag>
            <span>{{ i.title }}</span>
            <span v-if="i.defect_part" class="muted">· {{ i.defect_part }}</span>
          </div>
          <el-radio-group v-model="itemChecks[i.item_key]" size="small">
            <el-radio-button v-for="opt in CHECK_OPTS" :key="opt.key" :value="opt.key">{{ opt.label }}</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <template v-if="dossier.exceptions.length">
        <h4>异常</h4>
        <el-alert
          v-for="x in dossier.exceptions"
          :key="x.id"
          :type="x.status === 'OPEN' ? 'error' : 'info'"
          :closable="false"
          :title="`${exceptionTypeLabels[x.exception_type]}：${x.description}${x.final_result ? ' → ' + x.final_result : ''}`"
          style="margin-bottom: 6px"
        />
      </template>

      <h4>开箱视频</h4>
      <el-empty v-if="!videos.length && !dossier.inspection?.defect_videos?.length" description="没有开箱视频" :image-size="48" />
      <div class="videos">
        <div v-for="v in videos" :key="v.id">
          <video :src="v.url" controls preload="metadata" />
          <div class="row">
            <span class="muted">{{ evidenceKindLabels[v.kind] }} {{ formatDateTime(v.created_at) }}</span>
            <a :href="v.url" target="_blank" download>下载</a>
          </div>
        </div>
        <video v-for="u in dossier.inspection?.defect_videos || []" :key="u" :src="u" controls preload="metadata" />
      </div>

      <h4>商品和瑕疵照片</h4>
      <MediaGallery :urls="photos" />

      <el-divider />
      <el-alert
        v-if="dossier.pending_review && dossier.pending_review.result === 'OK'"
        type="success"
        :closable="false"
        :title="`${dossier.pending_review.reviewer_name} 已于 ${formatDateTime(dossier.pending_review.created_at)} 复核，可以发货`"
      />
      <el-alert
        v-else-if="dossier.pending_review && dossier.pending_review.result === 'PROBLEM'"
        type="error"
        :closable="false"
        :title="`出库被拦：${dossier.pending_review.remark || '发现新问题'}（处理后重新复核）`"
        style="margin-bottom: 12px"
      />
      <div v-if="inStock && canReview && !(dossier.pending_review && dossier.pending_review.result === 'OK')" class="review-box">
        <el-input v-model="identity" placeholder="扫或输货号/序列号核对实物（必填）" style="max-width: 360px" />
        <el-input
          v-model="remark"
          :placeholder="result === 'PROBLEM' ? '什么新问题、在哪个部位（必填）' : '复核说明（没有开箱视频或异常没结束时必填）'"
          style="flex: 1"
        />
        <el-button type="primary" :loading="submitting" @click="submit(true)">核对无误</el-button>
        <el-button type="danger" plain :loading="submitting" @click="submit(false)">发现新问题</el-button>
      </div>
      <p v-else-if="!inStock" class="muted">这件货不在库，不用复核。</p>
      <p v-else-if="!canReview" class="muted">当前账号只能查看凭证，复核请用销售或管理员账号。</p>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.videos { display: flex; gap: 12px; flex-wrap: wrap; }
.videos video { width: 360px; border-radius: 6px; background: #111; }
.check-block { margin: 10px 0 16px; padding-bottom: 10px; border-bottom: 1px solid var(--el-border-color-lighter); }
.review-box { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
