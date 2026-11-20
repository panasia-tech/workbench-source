<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { isAdmin } from '../utils/consoleAccess'
import { errorText, uploadEvidence } from '../utils/evidenceUpload'

const STATE_TYPES = {
  NONE: 'info',
  DRAFT: 'info',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  STALE: 'danger',
}
const TABS = [
  { key: 'todo', label: '待清洗' },
  { key: 'review', label: '待审批' },
  { key: 'fix', label: '在架待整改' },
  { key: 'done', label: '全部通过' },
  { key: 'all', label: '全部在库' },
]

const admin = isAdmin()
const tab = ref('todo')
const keyword = ref('')
const page = ref(1)
const loading = ref(false)
const shops = ref([])
const items = ref([])
const total = ref(0)
const counts = ref({})
const costHidden = ref(false)
const settings = ref({ required: false, min_cost_ratio: '1.00', auto_publish: true })
const ratioInput = ref(1)

const detail = ref(null)
const drafts = ref({})
const activeShop = ref('')
const picked = ref([])
const saving = ref(false)
const uploading = ref(false)

async function loadSettings() {
  const { data } = await api.get('/listing-approvals/settings')
  settings.value = data
  ratioInput.value = Number(data.min_cost_ratio)
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/listing-approvals/tasks', {
      params: { state: tab.value, keyword: keyword.value || undefined, page: page.value, size: 20 },
    })
    shops.value = data.shops
    items.value = data.items
    total.value = data.total
    counts.value = data.counts
    costHidden.value = !!data.cost_hidden
  } catch (err) {
    ElMessage.error(errorText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function saveSettings(patch) {
  if (patch.required) {
    let hint = '打开后，手动上架、自动上架、链接焕新都只发批过的价和图，没批的店铺一律不发。'
    try {
      const { data: ready } = await api.get('/listing-approvals/readiness')
      hint += `\n\n当前在库 ${ready.in_stock} 件：待清洗 ${ready.todo}、待审批 ${ready.review}、在架待整改 ${ready.fix}、全部通过 ${ready.done}。`
      hint += `\n${ready.safe_hint}`
      if (ready.fix > 0) {
        hint += `\n样例：${(ready.fix_samples || []).slice(0, 5).join('、') || '—'}`
      }
    } catch {
      /* 盘点失败仍可打开，只是少提示 */
    }
    try {
      await ElMessageBox.confirm(hint, '打开上架审批', {
        type: 'warning',
        confirmButtonText: '打开',
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: false,
      })
    } catch {
      return
    }
  }
  try {
    const { data } = await api.put('/listing-approvals/settings', patch)
    settings.value = data
    ratioInput.value = Number(data.min_cost_ratio)
    ElMessage.success(patch.required && data.readiness?.fix
      ? `已打开；还有 ${data.readiness.fix} 件在架待整改，请先清「在架待整改」`
      : '已保存')
    if (patch.required && data.readiness?.fix) tab.value = 'fix'
    await load()
    if (detail.value) await openSku(detail.value.sku.sku_code)
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  }
}

function applyDetail(data) {
  detail.value = data
  const next = {}
  for (const s of data.shops) {
    const a = s.approval
    next[s.id] = {
      price: a?.price ?? null,
      images: (a?.images || []).map((x) => x.raw),
      note: a?.note || '',
    }
  }
  drafts.value = next
  if (!data.shops.some((s) => s.id === activeShop.value)) activeShop.value = data.shops[0]?.id || ''
  picked.value = picked.value.filter((id) => data.shops.some((s) => s.id === id))
}

async function openSku(skuCode) {
  try {
    const { data } = await api.get(`/listing-approvals/skus/${skuCode}`)
    applyDetail(data)
  } catch (err) {
    ElMessage.error(errorText(err, '打开失败'))
  }
}

function closeDetail() {
  detail.value = null
  picked.value = []
  load()
}

// 图在页面上要显示签过名的地址，存的是原始地址
const urlOf = computed(() => {
  const map = {}
  for (const c of detail.value?.candidates || []) map[c.raw] = c.url
  for (const s of detail.value?.shops || []) for (const img of s.approval?.images || []) map[img.raw] ||= img.url
  return map
})

// 后端算好的占用（已提交/已批审批、在架号、停用号），选图页要和提交时同一个口径
function occupiedBy(raw) {
  return (detail.value?.occupied?.[raw] || []).filter((h) => h.id !== activeShop.value)
}

// 别的号占着：草稿里选了，或后端说已经占了
function heldBy(raw) {
  const labels = (detail.value?.shops || [])
    .filter((s) => s.id !== activeShop.value && (drafts.value[s.id]?.images || []).includes(raw))
    .map((s) => s.label)
  for (const h of occupiedBy(raw)) if (!labels.includes(h.label)) labels.push(h.label)
  return labels
}

function usedBy(raw) {
  const labels = (detail.value?.shops || [])
    .filter((s) => (drafts.value[s.id]?.images || []).includes(raw))
    .map((s) => (drafts.value[s.id].images[0] === raw ? `${s.label}首图` : s.label))
  for (const h of occupiedBy(raw)) if (!labels.includes(h.label)) labels.push(h.label)
  return labels
}

function editable(shop) {
  return ['NONE', 'DRAFT', 'REJECTED', 'STALE', 'APPROVED'].includes(shop.cell.state)
}

function toggleImage(raw) {
  const d = drafts.value[activeShop.value]
  if (!d) return
  const i = d.images.indexOf(raw)
  if (i >= 0) {
    d.images.splice(i, 1)
    return
  }
  const held = heldBy(raw)
  if (held.length) {
    ElMessage.warning(`这张图已经给「${held[0]}」用了，换一张或上传新图`)
    return
  }
  if (d.images.length < 9) d.images.push(raw)
}

function makeFirst(shopId, raw) {
  const d = drafts.value[shopId]
  d.images = [raw, ...d.images.filter((x) => x !== raw)]
}

async function onUpload(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''
  if (!files.length) return
  uploading.value = true
  try {
    for (const f of files) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase()
      const url = await uploadEvidence(f, 'listing-approval', ext)
      detail.value.candidates.push({ raw: url, url, source: '新上传' })
      toggleImage(url)
    }
  } catch (err) {
    ElMessage.error(errorText(err, '上传失败'))
  } finally {
    uploading.value = false
  }
}

async function saveShop(shopId) {
  const d = drafts.value[shopId]
  saving.value = true
  try {
    const { data } = await api.put(`/listing-approvals/skus/${detail.value.sku.sku_code}/shops/${shopId}`, {
      price: d.price,
      images: d.images,
      note: d.note,
    })
    applyDetail(data)
    ElMessage.success('已存草稿')
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

function fillPriceToAll() {
  const price = drafts.value[activeShop.value]?.price
  if (!price) return
  for (const s of detail.value.shops) if (editable(s) && !drafts.value[s.id].price) drafts.value[s.id].price = price
}

function isLow(shopId) {
  const p = drafts.value[shopId]?.price
  return !!(detail.value?.floor_price && p && p < detail.value.floor_price)
}

// 高于成本 5 倍：标黄提醒，不拦
function isHigh(shopId) {
  const p = drafts.value[shopId]?.price
  const cost = Number(detail.value?.sku?.cost_price)
  return !!(p && cost > 0 && p > cost * (detail.value.high_price_multiple || 5))
}

async function submitPicked() {
  const noReason = detail.value.shops.find(
    (s) => picked.value.includes(s.id) && isLow(s.id) && (drafts.value[s.id].note || '').trim().length < 4,
  )
  if (noReason) {
    ElMessage.warning(`「${noReason.label}」低于成本线，要写低价理由（至少 4 个字）`)
    return
  }
  saving.value = true
  try {
    // 先把页面上改过的存成草稿，再一起提交
    for (const id of picked.value) {
      const d = drafts.value[id]
      await api.put(`/listing-approvals/skus/${detail.value.sku.sku_code}/shops/${id}`, {
        price: d.price,
        images: d.images,
        note: d.note,
      })
    }
    const { data } = await api.post(`/listing-approvals/skus/${detail.value.sku.sku_code}/submit`, {
      shop_ids: picked.value,
    })
    applyDetail(data)
    ElMessage.success(data.auto_publish ? '已提交并发布（正在发布）' : '已提交审批')
  } catch (err) {
    ElMessage.error(errorText(err, '提交失败'))
    await openSku(detail.value.sku.sku_code)
  } finally {
    saving.value = false
  }
}

// 退回：原因必填，可附标注截图 / 对照说明，员工照着补正后重新提交
const rejectDlg = ref({ open: false, note: '', media: [], uploading: false })

function openReject() {
  rejectDlg.value = { open: true, note: '', media: [], uploading: false }
}

async function onRejectFiles(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length) return
  rejectDlg.value.uploading = true
  try {
    for (const f of files.slice(0, 9 - rejectDlg.value.media.length)) {
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.png'])[0].toLowerCase()
      rejectDlg.value.media.push(await uploadEvidence(f, 'listing-approval/review', ext))
    }
  } catch (err) {
    ElMessage.error(errorText(err, '上传失败'))
  } finally {
    rejectDlg.value.uploading = false
  }
}

async function reviewPicked(approve) {
  const low = detail.value.shops.find((s) => picked.value.includes(s.id) && isLow(s.id))
  if (approve && low && !detail.value.can_review_low_price) {
    ElMessage.warning(`「${low.label}」低于成本线，只有管理员能批`)
    return
  }
  if (!approve && !rejectDlg.value.note.trim()) {
    ElMessage.warning('退回要写原因：哪里不对、要补什么')
    return
  }
  saving.value = true
  try {
    const { data } = await api.post(`/listing-approvals/skus/${detail.value.sku.sku_code}/review`, {
      shop_ids: picked.value,
      approve,
      note: approve ? '' : rejectDlg.value.note,
      media: approve ? [] : rejectDlg.value.media,
    })
    applyDetail(data)
    rejectDlg.value.open = false
    ElMessage.success(approve ? '已通过' : '已退回')
  } catch (err) {
    ElMessage.error(errorText(err, '操作失败'))
  } finally {
    saving.value = false
  }
}

const pickedStates = computed(() =>
  (detail.value?.shops || []).filter((s) => picked.value.includes(s.id)).map((s) => s.cell.state),
)
const canSubmit = computed(() => pickedStates.value.length && pickedStates.value.every((st) => st !== 'SUBMITTED'))
const canReview = computed(() => pickedStates.value.length && pickedStates.value.every((st) => st === 'SUBMITTED'))

function switchTab() {
  page.value = 1
  load()
}

onMounted(async () => {
  await loadSettings()
  await load()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">上架审批</h3>
      <div class="row">
        <el-tag :type="settings.required ? 'success' : 'info'">
          {{ settings.required ? '已打开：只发批过的价和图' : '没打开：照旧发布' }}
        </el-tag>
        <template v-if="admin">
          <el-button v-if="!settings.required" type="primary" plain @click="saveSettings({ required: true })">打开</el-button>
          <el-button v-else plain @click="saveSettings({ required: false })">关掉</el-button>
          <span class="muted">成本比例</span>
          <el-input-number v-model="ratioInput" :min="0.5" :max="5" :step="0.05" :precision="2" size="small" />
          <el-button size="small" :disabled="ratioInput === Number(settings.min_cost_ratio)" @click="saveSettings({ min_cost_ratio: ratioInput })">
            保存比例
          </el-button>
          <span class="muted">提交即发布</span>
          <el-switch v-model="settings.auto_publish" @change="(v) => saveSettings({ auto_publish: v })" />
        </template>
        <span v-else class="muted">成本比例 {{ settings.min_cost_ratio }}</span>
      </div>
    </div>
    <div class="page-card__body">
      <div class="row" style="margin-bottom: 12px">
        <el-radio-group v-model="tab" @change="switchTab">
          <el-radio-button v-for="t in TABS" :key="t.key" :value="t.key">
            {{ t.label }} {{ counts[t.key] ?? '' }}
          </el-radio-button>
        </el-radio-group>
        <el-input v-model="keyword" placeholder="货号或品名" clearable style="width: 200px" @change="switchTab" />
      </div>

      <el-table v-loading="loading" :data="items" highlight-current-row empty-text="没有要处理的货" @row-click="(r) => openSku(r.sku_code)">
        <el-table-column label="商品" min-width="220">
          <template #default="{ row }">
            <div class="row nowrap">
              <img v-if="row.cover" :src="row.cover" class="thumb" alt="" />
              <div>
                <div>{{ row.product_name }}</div>
                <div class="muted mono">{{ row.sku_code }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="!costHidden" label="成本" width="90" align="right">
          <template #default="{ row }">{{ row.cost_price ?? '—' }}</template>
        </el-table-column>
        <el-table-column v-for="s in shops" :key="s.id" :label="s.label" min-width="96" align="center">
          <template #default="{ row }">
            <el-tooltip :disabled="!row.cells[s.id].problem" :content="row.cells[s.id].problem || ''">
              <el-tag size="small" :type="STATE_TYPES[row.cells[s.id].state]">{{ row.cells[s.id].label }}</el-tag>
            </el-tooltip>
            <div v-if="row.cells[s.id].needs_fix" class="fix">在架待整改</div>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > 20"
        v-model:current-page="page"
        layout="prev, pager, next, total"
        :total="total"
        :page-size="20"
        style="margin-top: 12px"
        @current-change="load"
      />
    </div>

    <el-drawer :model-value="!!detail" size="78%" :title="detail ? `${detail.sku.product_name} · ${detail.sku.sku_code}` : ''" @close="closeDetail">
      <template v-if="detail">
        <div class="facts">
          <div v-if="!detail.cost_hidden"><span class="muted">成本</span> {{ detail.sku.cost_price ?? '没有' }}</div>
          <div><span class="muted">成本线</span> <b>{{ detail.floor_price ?? '—' }}</b> 元（× {{ detail.min_cost_ratio }}）</div>
          <div>
            <span class="muted">行情价</span>
            {{ detail.market.price ?? '没有' }}
            <span v-if="detail.market.basis" class="muted">（{{ detail.market.basis }}<template v-if="detail.market.date">，{{ detail.market.date }}</template>）</span>
          </div>
          <div v-if="detail.sku.condition_grade"><span class="muted">成色</span> {{ detail.sku.condition_grade }}</div>
        </div>

        <h4>可选的图 <span class="muted small">点图加到「{{ detail.shops.find((s) => s.id === activeShop)?.label }}」，再点一次去掉</span></h4>
        <div class="gallery">
          <div
            v-for="c in detail.candidates"
            :key="c.raw"
            class="cand"
            :class="{ on: drafts[activeShop]?.images.includes(c.raw), taken: !drafts[activeShop]?.images.includes(c.raw) && heldBy(c.raw).length }"
            @click="toggleImage(c.raw)"
          >
            <img :src="c.url" alt="" />
            <div class="small">{{ c.source }}</div>
            <div v-if="usedBy(c.raw).length" class="small muted">{{ usedBy(c.raw).join('、') }}</div>
          </div>
          <label class="cand upload">
            <input type="file" accept="image/*" multiple hidden @change="onUpload" />
            <span>{{ uploading ? '上传中…' : '+ 上传' }}</span>
          </label>
        </div>

        <h4>各店铺</h4>
        <div class="shops">
          <div
            v-for="s in detail.shops"
            :key="s.id"
            class="shop"
            :class="{ active: s.id === activeShop }"
            @click="activeShop = s.id"
          >
            <div class="row">
              <el-checkbox v-model="picked" :value="s.id" @click.stop />
              <b>{{ s.label }}</b>
              <el-tag size="small" :type="STATE_TYPES[s.cell.state]">{{ s.cell.label }}</el-tag>
              <span v-if="s.cell.listed" class="muted small">在架</span>
              <span v-if="s.approval" class="muted small">第 {{ s.approval.version }} 版</span>
            </div>
            <div v-if="s.cell.problem" class="err small">{{ s.cell.problem }}</div>
            <div v-if="s.approval?.review_note" class="small review-back">
              <b>{{ s.approval.status === 'REJECTED' ? '退回原因' : '审批意见' }}：</b>{{ s.approval.review_note }}
              <div v-if="s.approval.review_media?.length" class="review-media">
                <el-image
                  v-for="(m, i) in s.approval.review_media"
                  :key="m.raw"
                  :src="m.url"
                  :preview-src-list="s.approval.review_media.map((x) => x.url)"
                  :initial-index="i"
                  fit="cover"
                  class="review-thumb"
                  preview-teleported
                />
              </div>
              <div v-if="s.approval.status === 'REJECTED'" class="muted">按上面改好价或图后重新提交</div>
            </div>
            <div class="row" style="margin-top: 6px">
              <el-input-number
                v-model="drafts[s.id].price"
                :min="1"
                :precision="0"
                :disabled="!editable(s)"
                size="small"
                placeholder="售价"
                @click.stop
              />
              <span v-if="isLow(s.id)" class="err small">低于成本线</span>
              <span v-else-if="isHigh(s.id)" class="warn small">高于成本 {{ detail.high_price_multiple }} 倍</span>
              <el-button v-if="editable(s)" size="small" :loading="saving" @click.stop="saveShop(s.id)">存草稿</el-button>
            </div>
            <div v-if="isLow(s.id)" style="margin-top: 6px" @click.stop>
              <el-input
                v-if="editable(s)"
                v-model="drafts[s.id].note"
                size="small"
                maxlength="200"
                placeholder="为什么要低价（只有管理员能批，至少 4 个字）"
              />
              <div v-else class="err small">低价理由：{{ drafts[s.id].note || '没写' }}</div>
            </div>
            <div class="picked">
              <div v-for="(raw, i) in drafts[s.id].images" :key="raw" class="mini" :title="i === 0 ? '首图' : '点一下设为首图'" @click.stop="makeFirst(s.id, raw)">
                <img :src="urlOf[raw] || raw" alt="" />
                <span v-if="i === 0" class="first">首图</span>
              </div>
              <span v-if="!drafts[s.id].images.length" class="muted small">还没选图</span>
            </div>
            <div v-if="s.approval?.submitted_by_name" class="muted small">
              {{ s.approval.submitted_by_name }} 提交<template v-if="s.approval.reviewed_by_name">，{{ s.approval.reviewed_by_name }} 审批</template>
            </div>
          </div>
        </div>

        <div class="footer row">
          <span class="muted">已选 {{ picked.length }} 个店铺</span>
          <el-button size="small" @click="picked = detail.shops.map((s) => s.id)">全选</el-button>
          <el-button size="small" :disabled="!drafts[activeShop]?.price" @click="fillPriceToAll">把当前店铺的价填到没填的店铺</el-button>
          <span v-if="detail.auto_publish" class="muted">提交后直接发布，不用再点通过</span>
          <el-button type="primary" :disabled="!canSubmit" :loading="saving" @click="submitPicked">{{ detail.auto_publish ? '提交并发布' : '提交审批' }}</el-button>
          <el-button type="success" :disabled="!canReview" :loading="saving" @click="reviewPicked(true)">通过</el-button>
          <el-button type="danger" plain :disabled="!canReview" :loading="saving" @click="openReject">退回</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="rejectDlg.open" title="退回" width="480px" append-to-body>
      <el-input
        v-model="rejectDlg.note"
        type="textarea"
        :rows="4"
        maxlength="500"
        placeholder="退回原因，员工会看到：哪里不对、要补什么"
      />
      <div class="review-media" style="margin-top: 10px">
        <el-image v-for="u in rejectDlg.media" :key="u" :src="u" fit="cover" class="review-thumb" />
        <label class="review-add">
          <input type="file" accept="image/*" multiple hidden @change="onRejectFiles" />
          {{ rejectDlg.uploading ? '上传中…' : '+ 标注截图（选填）' }}
        </label>
      </div>
      <template #footer>
        <el-button @click="rejectDlg.open = false">取消</el-button>
        <el-button type="danger" :loading="saving || rejectDlg.uploading" @click="reviewPicked(false)">退回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.review-back { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: #fef0f0; color: #303133; }
.review-media { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.review-thumb { width: 64px; height: 64px; border-radius: 4px; }
.review-add { display: inline-flex; align-items: center; justify-content: center; width: 120px; height: 64px; border: 1px dashed #dcdfe6; border-radius: 4px; color: #909399; font-size: 12px; cursor: pointer; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nowrap { flex-wrap: nowrap; }
.muted { color: var(--el-text-color-secondary); }
.small { font-size: 12px; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.err { color: var(--el-color-danger); }
.warn { color: var(--el-color-warning-dark-2); }
.fix { color: var(--el-color-danger); font-size: 11px; margin-top: 2px; }
.thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; }
.facts { display: flex; flex-wrap: wrap; gap: 24px; padding: 12px 16px; background: var(--el-fill-color-light); border-radius: 6px; }
h4 { margin: 20px 0 8px; }
.gallery { display: flex; flex-wrap: wrap; gap: 10px; }
.cand { width: 112px; cursor: pointer; border: 2px solid transparent; border-radius: 6px; padding: 4px; text-align: center; }
.cand img { width: 100px; height: 100px; object-fit: cover; border-radius: 4px; display: block; margin: 0 auto 4px; }
.cand.on { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.cand.taken { opacity: .5; cursor: not-allowed; }
.cand.upload { display: flex; align-items: center; justify-content: center; height: 128px; border: 1px dashed var(--el-border-color); color: var(--el-text-color-secondary); }
.shops { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.shop { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.shop.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary) inset; }
.picked { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; min-height: 56px; align-items: center; }
.mini { position: relative; }
.mini img { width: 56px; height: 56px; object-fit: cover; border-radius: 4px; display: block; }
.first { position: absolute; left: 0; bottom: 0; background: var(--el-color-primary); color: #fff; font-size: 10px; padding: 0 4px; border-radius: 0 4px 0 4px; }
.footer { position: sticky; bottom: 0; background: var(--el-bg-color); padding: 12px 0; margin-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
</style>
