<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RefreshRight, TopRight } from '@element-plus/icons-vue'
import api from '../api'
import { formatDateTime } from '../utils/labels'
import { errorText } from '../utils/evidenceUpload'

const STATUS = [
  { value: 'SEARCHING', label: '爬取中', type: 'info' },
  { value: 'REVIEWING', label: '等员工审核', type: 'warning' },
  { value: 'READY', label: '参考图可用', type: 'success' },
  { value: 'REJECTED', label: '审核不通过', type: 'danger' },
  { value: 'FAILED', label: '未搜到', type: 'danger' },
]
const TYPE_OF = Object.fromEntries(STATUS.map((s) => [s.value, s.type]))
// 这两种能重搜:在搜/在审的重搜会丢掉进行中的任务,参考图可用的没必要
const RETRYABLE = ['REJECTED', 'FAILED']

const loading = ref(false)
const status = ref('')
const data = ref({ enabled: true, review_url: '', counts: {}, pending_backfill: 0, items: [] })
const backfillLimit = ref(30)
const backfilling = ref(false)
const retrying = ref('')
const rebuilding = ref('')

const tabs = computed(() => {
  const counts = data.value.counts || {}
  const all = Object.values(counts).reduce((a, b) => a + b, 0)
  return [{ value: '', label: '全部', count: all }, ...STATUS.map((s) => ({ ...s, count: counts[s.value] || 0 }))]
})

async function load() {
  loading.value = true
  try {
    const res = await api.get('/product-images', { params: { status: status.value || undefined } })
    data.value = res.data
  } catch (err) {
    ElMessage.error(errorText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

function switchStatus(v) {
  status.value = v
  load()
}

async function backfill() {
  backfilling.value = true
  try {
    const { data: r } = await api.post('/product-images/backfill', null, { params: { limit: backfillLimit.value } })
    if (!r.enabled) ElMessage.warning('图片爬虫没配置')
    else if (r.requested) ElMessage.success(`已发起 ${r.requested} 个型号${r.skipped ? `，${r.skipped} 个没发起` : ''}`)
    else ElMessage.info('没有要补搜的型号')
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '补搜失败'))
  } finally {
    backfilling.value = false
  }
}

async function retry(row) {
  retrying.value = row.spu_id
  try {
    await api.post(`/product-images/spu/${row.spu_id}/search`)
    ElMessage.success(`${row.query} 已重新搜索`)
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '重新搜索失败'))
  } finally {
    retrying.value = ''
  }
}

async function rebuildArchive(row) {
  rebuilding.value = row.spu_id
  try {
    const { data: r } = await api.post(`/product-images/spu/${row.spu_id}/archive/rebuild`)
    ElMessage.success(`已写入 ${r.archived} 张，档案共 ${r.archive_count} 张`)
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '重建档案失败'))
  } finally {
    rebuilding.value = ''
  }
}

async function rebuildAllArchive() {
  rebuilding.value = '__all__'
  try {
    const { data: r } = await api.post('/product-images/archive/backfill', null, { params: { only_ready: true } })
    ElMessage.success(`回填 ${r.spus} 个型号，共 ${r.images} 张`)
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '批量回填失败'))
  } finally {
    rebuilding.value = ''
  }
}

function openReview() {
  window.open(data.value.review_url, '_blank', 'noopener')
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header list-header">
      <h3 class="page-card__title">图片爬虫</h3>
      <div class="list-tools">
        <el-tooltip content="员工在爬虫的审核页点「图片合格」后，这里才会转存参考图" placement="bottom">
          <el-button :icon="TopRight" :disabled="!data.review_url" @click="openReview">去审核</el-button>
        </el-tooltip>
        <el-input-number v-model="backfillLimit" :min="1" :max="200" size="default" class="limit-input" />
        <el-tooltip
          :content="`在库、一张图都没有、还没搜过的型号还有 ${data.pending_backfill} 个，缺图件数多的先搜；爬虫一个约 3 分钟`"
          placement="bottom"
        >
          <el-button
            type="primary"
            :loading="backfilling"
            :disabled="!data.enabled || !data.pending_backfill"
            @click="backfill"
          >批量补搜（剩 {{ data.pending_backfill }}）</el-button>
        </el-tooltip>
        <el-button :loading="rebuilding === '__all__'" @click="rebuildAllArchive">批量回填档案</el-button>
        <el-button :icon="RefreshRight" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-alert
        v-if="!data.enabled"
        type="warning"
        show-icon
        :closable="false"
        class="switch-alert"
        title="图片爬虫没配置（PRODUCT_IMAGE_BASE_URL / PRODUCT_IMAGE_TOKEN）"
      />
      <div class="stage-tabs">
        <el-button
          v-for="t in tabs"
          :key="t.value"
          :type="status === t.value ? 'primary' : 'default'"
          size="small"
          @click="switchStatus(t.value)"
        >{{ t.label }} {{ t.count }}</el-button>
      </div>
      <el-table v-loading="loading" :data="data.items" stripe empty-text="还没有搜过图" style="width: 100%">
        <el-table-column label="型号" min-width="180">
          <template #default="{ row }">
            <div>{{ row.query }}</div>
            <div class="sub">{{ row.spu_code }}</div>
          </template>
        </el-table-column>
        <el-table-column label="缺图在库" width="90" align="center">
          <template #default="{ row }">{{ row.missing_photo_skus || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tooltip v-if="row.error" :content="row.error" placement="top">
              <el-tag :type="TYPE_OF[row.status]" size="small">{{ row.status_label }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="TYPE_OF[row.status]" size="small">{{ row.status_label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="正式池" width="80" align="center">
          <template #default="{ row }">{{ row.status === 'SEARCHING' ? '—' : row.formal_count }}</template>
        </el-table-column>
        <el-table-column label="档案" width="80" align="center">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.crawl_progress && row.crawl_progress.message"
              :content="row.crawl_progress.message"
              placement="top"
            >
              <span>{{ row.archive_count || 0 }}</span>
            </el-tooltip>
            <span v-else>{{ row.archive_count || 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="参考图" width="100">
          <template #default="{ row }">
            <el-image
              v-if="row.reference_preview"
              :src="row.reference_preview"
              :preview-src-list="[row.reference_preview]"
              preview-teleported
              fit="cover"
              class="thumb"
            />
            <span v-else class="sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="来源 / 审核人" min-width="200">
          <template #default="{ row }">
            <a v-if="row.source_url" :href="row.source_url" target="_blank" rel="noopener" class="src">
              {{ row.source_url }}
            </a>
            <div v-if="row.reviewer" class="sub">{{ row.reviewer }}</div>
            <span v-if="!row.source_url && !row.reviewer" class="sub">—</span>
          </template>
        </el-table-column>
        <el-table-column label="更新" width="160">
          <template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="" width="100" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="RETRYABLE.includes(row.status)"
              link
              type="primary"
              :loading="retrying === row.spu_id"
              :disabled="!data.enabled"
              @click="retry(row)"
            >重新搜</el-button>
            <el-button
              v-if="row.formal_count && row.status === 'READY'"
              link
              type="primary"
              :loading="rebuilding === row.spu_id"
              @click="rebuildArchive(row)"
            >重建档案</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.list-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.list-tools { display: flex; align-items: center; gap: 8px; }
.limit-input { width: 110px; }
.switch-alert { margin: 0 20px 12px; width: auto; }
.stage-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 20px 12px; }
.sub { font-size: 12px; color: var(--text-secondary); }
.thumb { width: 56px; height: 56px; border-radius: 4px; display: block; }
.src {
  display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--el-color-primary);
}
</style>
