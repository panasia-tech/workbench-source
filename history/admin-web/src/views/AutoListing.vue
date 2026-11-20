<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, RefreshRight } from '@element-plus/icons-vue'
import api from '../api'
import {
  autoListingStageLabels,
  autoListingStageTypes,
  formatPrice,
  formatDateTime,
} from '../utils/labels'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const q = ref('')
const stage = ref('NEEDS_HUMAN') // 默认直接落在要人处理的那一档
const enabled = ref(true)
const counts = ref({})

// 只有「停下来等人」的两种能重跑：在跑的行重置会重复发布
const RETRYABLE = ['NEEDS_HUMAN', 'FAILED']
const STAGES = Object.keys(autoListingStageLabels)

const tabs = computed(() => [
  { value: '', label: '全部', count: total0() },
  ...STAGES.map((s) => ({ value: s, label: autoListingStageLabels[s], count: counts.value[s] || 0 })),
])

function total0() {
  return Object.values(counts.value).reduce((a, b) => a + b, 0)
}

async function loadSummary() {
  try {
    const { data } = await api.get('/auto-listing/summary')
    counts.value = data.counts || {}
    enabled.value = data.enabled
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载统计失败')
  }
}

async function load() {
  loading.value = true
  try {
    const params = { page: page.value, page_size: pageSize.value }
    if (stage.value) params.stage = stage.value
    if (q.value.trim()) params.q = q.value.trim()
    const { data } = await api.get('/auto-listing/rows', { params })
    list.value = data.items
    total.value = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function switchStage(v) {
  stage.value = v
  search()
}

function onPageChange(p) {
  page.value = p
  load()
}

async function retry(row) {
  try {
    await ElMessageBox.confirm(
      `「${row.sku_code}」将从头（重新解析 SPU）跑一遍自动上架。` +
        '请先确认转人工的原因已经解决——SPU 对照表补好了，或行情价已经爬到。',
      '放回流水线',
      { type: 'warning', confirmButtonText: '重跑', cancelButtonText: '取消' },
    )
  } catch {
    return // 取消
  }
  try {
    await api.post(`/auto-listing/rows/${row.id}/retry`)
    ElMessage.success('已放回流水线')
    await Promise.all([load(), loadSummary()])
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '重跑失败')
  }
}

const OUTCOME_LABELS = {
  ready: '备好',
  ready_crawled: '备好（爬虫图）',
  missing_photo: '缺图',
  waiting_price: '等行情价',
  waiting_image: '等爬虫搜图',
  unresolved: '认不出型号',
  below_cost: '行情低于成本',
  needs_human: '其他要人看',
  listed: '已在架',
}

const backfilling = ref(false)

async function backfill() {
  backfilling.value = true
  try {
    const { data: plan } = await api.post('/auto-listing/backfill', null, { params: { dry_run: true } })
    if (!plan.new && !plan.rerun) {
      ElMessage.info('没有要补的存量货')
      return
    }
    try {
      await ElMessageBox.confirm(
        `新登记 ${plan.new} 件，重查 ${plan.rerun} 件。只补行情价和图，不会发布。`,
        '存量补价补图',
        { confirmButtonText: '开始', cancelButtonText: '取消' },
      )
    } catch {
      return // 取消
    }
    const { data } = await api.post('/auto-listing/backfill', null, { params: { dry_run: false } })
    const parts = Object.entries(data.outcomes).map(([k, n]) => `${OUTCOME_LABELS[k] || k} ${n}`)
    if (data.failed) parts.push(`出错 ${data.failed}`)
    ElMessage.success(parts.join('，') || '完成')
    await refresh()
    if (data.outcomes.unresolved) openIdentify()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '补价补图失败')
  } finally {
    backfilling.value = false
  }
}

// ---- 认不出型号：弹窗填品牌型号 ----
const identifyOpen = ref(false)
const identifyLoading = ref(false)
const identifyRows = ref([])

async function openIdentify(row) {
  identifyOpen.value = true
  if (row) {
    identifyRows.value = [toForm(row)]
    return
  }
  identifyLoading.value = true
  try {
    const { data } = await api.get('/auto-listing/rows', { params: { issue: 'unresolved', page_size: 200 } })
    identifyRows.value = data.items.map(toForm)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    identifyLoading.value = false
  }
}

function toForm(row) {
  return { ...row, newBrand: row.brand || '', newModel: row.model || '', saving: false, notice: '' }
}

async function suggestSpu(q, cb) {
  if (!q || !q.trim()) return cb([])
  try {
    const { data } = await api.get('/spu-match/search', { params: { q: q.trim() } })
    cb(data.items.map((s) => ({ value: s.name, brand: s.brand, model: s.model, spec: s.spec })))
  } catch {
    cb([])
  }
}

function pickSpu(f, s) {
  f.newBrand = s.brand
  f.newModel = s.model
}

async function saveIdentify(f) {
  if (!f.newBrand.trim() || !f.newModel.trim()) {
    ElMessage.warning('品牌和型号都要填')
    return
  }
  f.saving = true
  try {
    const { data } = await api.post(`/auto-listing/rows/${f.id}/identify`, {
      brand: f.newBrand.trim(),
      model: f.newModel.trim(),
    })
    if (data.in_catalog) {
      ElMessage.success(`${f.sku_code}：${OUTCOME_LABELS[data.row.issue] || data.row.last_error || '已重新解析'}`)
      identifyRows.value = identifyRows.value.filter((x) => x.id !== f.id)
      if (!identifyRows.value.length) identifyOpen.value = false
    } else {
      f.notice = `商品目录里没有「${f.newBrand} ${f.newModel}」，先去商品目录里加上这一款`
    }
    refresh()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    f.saving = false
  }
}

function refresh() {
  return Promise.all([load(), loadSummary()])
}

onMounted(refresh)
</script>

<template>
  <div class="page-card">
    <div class="page-card__header list-header">
      <h3 class="page-card__title">自动上架流水线</h3>
      <div class="list-tools">
        <el-input
          v-model="q"
          placeholder="搜索货号 / 商品 / 品牌 / 型号"
          class="tool-search"
          clearable
          :prefix-icon="Search"
          @keyup.enter="search"
          @clear="search"
        />
        <el-button @click="search">查询</el-button>
        <el-button :icon="RefreshRight" @click="refresh">刷新</el-button>
        <el-button
          type="primary"
          plain
          :loading="backfilling"
          title="在库货补行情价和图，备好停在待人工上架，不会发布"
          @click="backfill"
        >存量补价补图</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-alert
        v-if="!enabled"
        type="warning"
        show-icon
        :closable="false"
        class="switch-alert"
        title="自动上架总开关未开启（AUTO_LISTING_ENABLED）"
        description="开关关着时：入库不再登记新行，worker 也不推进已有的行。已登记的行原地不动，开关一开就继续。"
      />
      <div class="stage-tabs">
        <el-button
          v-for="t in tabs"
          :key="t.value"
          :type="stage === t.value ? 'primary' : 'default'"
          size="small"
          @click="switchStage(t.value)"
        >{{ t.label }} {{ t.count }}</el-button>
      </div>
      <el-table v-loading="loading" :data="list" stripe empty-text="暂无记录" style="width: 100%">
        <el-table-column prop="sku_code" label="货号" width="150" />
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">
            <div>{{ row.product_name || '—' }}</div>
            <div class="sub">{{ [row.brand, row.model].filter(Boolean).join(' ') || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="autoListingStageTypes[row.stage]" size="small" disable-transitions>
              {{ row.hold_publish && row.stage === 'READY' ? '待人工上架' : autoListingStageLabels[row.stage] || row.stage }}
            </el-tag>
            <div v-if="row.hold_publish" class="sub">存量</div>
          </template>
        </el-table-column>
        <el-table-column label="成本" width="100" align="right">
          <template #default="{ row }">{{ formatPrice(row.cost_price) }}</template>
        </el-table-column>
        <el-table-column label="行情价" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.below_cost" class="below-cost" title="行情价比成本还低">{{ formatPrice(row.market_price) }}</span>
            <span v-else>{{ formatPrice(row.market_price) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="售价" width="100" align="right">
          <template #default="{ row }">
            <span class="price">{{ formatPrice(row.resolved_price) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="议价" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.negotiated_at" type="success" size="small" disable-transitions>已议</el-tag>
            <el-tag v-else type="warning" size="small" disable-transitions>未议</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="停下来的原因" min-width="240">
          <template #default="{ row }">
            <span :class="{ 'err-text': RETRYABLE.includes(row.stage) }">{{ row.last_error || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次推进" width="150" align="center">
          <template #default="{ row }">{{ row.next_run_at ? formatDateTime(row.next_run_at) : '挂起' }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.issue === 'unresolved'"
              link
              type="primary"
              @click="openIdentify(row)"
            >填型号</el-button>
            <el-button
              v-else-if="RETRYABLE.includes(row.stage)"
              link
              type="primary"
              @click="retry(row)"
            >重跑</el-button>
            <span v-else class="sub">—</span>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          layout="total, prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="page"
          @current-change="onPageChange"
        />
      </div>
      <p class="hint">
        入库即登记，worker 每分钟推一步：解析 SPU → 等行情价并写上架信息 → 等议价放行 → 下发群控发布。
        「转人工」是流水线主动认输（解析不出 / 行情低于成本 / 等行情超期），处理完原因后按「重跑」放回流水线。
        在跑的行不提供重置——群控作业已经发出去了，重置会让同一件货挂两条链接。
      </p>
    </div>
    <el-dialog v-model="identifyOpen" title="认不出型号，填一下品牌和型号" width="760px">
      <div v-loading="identifyLoading">
        <p v-if="!identifyLoading && !identifyRows.length" class="sub">没有认不出型号的货</p>
        <div v-for="f in identifyRows" :key="f.id" class="identify-row">
          <div class="identify-sku">
            <div>{{ f.sku_code }} · {{ f.product_name || '—' }}</div>
            <div class="sub">原来登记：{{ [f.brand, f.model].filter(Boolean).join(' ') || '空' }}</div>
          </div>
          <el-autocomplete
            v-model="f.newBrand"
            :fetch-suggestions="suggestSpu"
            placeholder="品牌"
            class="identify-brand"
            @select="(s) => pickSpu(f, s)"
          />
          <el-autocomplete
            v-model="f.newModel"
            :fetch-suggestions="suggestSpu"
            placeholder="型号（输几个字会提示目录里的）"
            class="identify-model"
            @select="(s) => pickSpu(f, s)"
          />
          <el-button type="primary" :loading="f.saving" @click="saveIdentify(f)">保存</el-button>
          <div v-if="f.notice" class="identify-notice">{{ f.notice }}</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.list-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.list-tools { display: flex; align-items: center; gap: 8px; }
.tool-search { width: 240px; }
.switch-alert { margin: 0 20px 12px; width: auto; }
.stage-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 20px 12px; }
.sub { font-size: 12px; color: var(--text-secondary); }
.err-text { color: var(--el-color-danger); }
.price { font-weight: 600; }
.below-cost { color: var(--el-color-danger); font-weight: 600; }
.identify-row { display: grid; grid-template-columns: 1fr 120px 200px auto; gap: 8px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.identify-sku { min-width: 0; }
.identify-notice { grid-column: 1 / -1; font-size: 13px; color: var(--el-color-warning); }
.pager { display: flex; justify-content: flex-end; padding: 12px 20px; }
.hint { margin: 4px 20px 12px; font-size: 13px; color: var(--text-secondary); line-height: 1.7; }
</style>
