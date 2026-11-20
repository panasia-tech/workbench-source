<template>
  <el-card shadow="never" class="market-page">
    <template #header>
      <div class="header">
        <div><strong>行情任务</strong></div>
        <div class="header-actions">
          <el-input v-model="q" clearable placeholder="搜索商品或关键词" @keyup.enter="refresh" @clear="refresh"><template #prefix><el-icon><Search /></el-icon></template></el-input>
          <el-button :icon="Refresh" circle title="刷新" @click="refresh" />
          <el-button type="primary" plain @click="router.push('/prices/history')">运行历史</el-button>
        </div>
      </div>
    </template>

    <el-alert class="sync-alert" :title="syncStatusLabel(syncState.status)" :description="syncStatusCopy(syncState)" :type="syncState.status === 'synced' ? 'success' : syncState.status === 'syncing' ? 'info' : 'warning'" :closable="false" show-icon />

    <div class="status-filters" aria-label="任务状态筛选">
      <button v-for="item in queueOptions" :key="item.key" type="button" :class="{ active: queueKind === item.key }" @click="selectQueue(item.key)">
        <strong>{{ queueCounts[item.key] || 0 }}</strong><span>{{ item.label }}</span>
      </button>
    </div>
    <div v-if="queueKind === 'success'" class="bands" aria-label="成功价格子分类">
      <el-button v-for="item in priceBandOptions" :key="item.key" size="small" :type="priceBand === item.key ? 'primary' : 'default'" plain @click="selectBand(item.key)">{{ item.label }}（{{ priceBandCounts[item.key] || 0 }}）</el-button>
    </div>

    <div class="list-head">
      <span>{{ activeQueue.description }}</span>
      <el-button v-if="queueKind === 'failed'" size="small" type="warning" plain @click="requeueFailed">失败复采</el-button>
    </div>
    <section v-loading="queueLoading" class="task-list" aria-label="当前行情任务">
      <article v-for="row in queueItems" :key="row.taskId" class="task-card">
        <div class="task-main">
        <div class="task-title"><strong>{{ row.name || row.model || '未命名任务' }}</strong><el-tag size="small" :type="queueTagType(row.queueKind)">{{ queueLabel(row.queueKind, row.correctionWorkflowStatus) }}</el-tag></div>
          <p>{{ searchText(row) || '未设置搜索词' }}</p>
          <div class="fact-strip"><span>API 销售价 <b>{{ money(row.apiSalePrice) }}</b></span><span>API 建议价 <b>{{ money(row.apiSuggestPrice) }}</b></span><el-tooltip v-if="row.referencePrice == null && row.referencePriceReason" placement="top" :content="row.referencePriceReason"><span>成本价 <b>—</b></span></el-tooltip><span v-else>成本价 <b>{{ money(row.referencePrice) }}</b></span><span>行情观察价 <b>{{ money(row.lastPrice) }}</b></span></div>
          <div class="comparison">
            <template v-if="row.priceComparison">
              <el-tag size="small" effect="plain" :type="comparisonType(row.priceComparison.key)">{{ row.priceComparison.label }}</el-tag>
              <span v-if="row.priceComparison.ratioPercent != null">{{ row.priceComparison.ratioPercent }}% · {{ signed(row.priceComparison.markupPercent) }}</span>
              <span class="reason">{{ row.priceComparison.reason || row.lastReason }}</span>
            </template>
            <span v-else class="reason">{{ row.lastReason || '等待采集结果' }}</span>
          </div>
          <div v-if="row.spuCode || row.spu_code" class="spu-policy-strip" :class="{ configured: row.spuSearchPolicy }" aria-label="当前 SPU 策略摘要">
            <span class="spu-policy-title">SPU {{ row.spuCode || row.spu_code }}</span>
            <span><b>搜索词</b>{{ policyQueries(row) }}</span>
            <span><b>屏蔽词</b>{{ policyTerms(row) }}</span>
            <span><b>最低挂牌价</b>{{ policyMinPrice(row) }}</span>
            <span><b>中文展示名</b>{{ policyDisplayName(row) }}</span>
            <span><b>页面价格筛选</b>{{ policyPageFilter(row) }}</span>
          </div>
        </div>
        <div class="task-side"><b v-if="row.lastPrice != null">¥{{ row.lastPrice }}</b><span v-else>—</span><el-button type="primary" link @click="openDetail(row)">查看详情</el-button><el-button v-if="row.spuCode || row.spu_code" type="primary" link @click="openPolicy(row)">{{ row.spuSearchPolicy ? '编辑 SPU 策略' : '配置 SPU 策略' }}</el-button></div>
      </article>
      <el-empty v-if="!queueLoading && !queueItems.length" description="这个分类暂时没有任务" :image-size="70" />
    </section>
  </el-card>

  <MarketSnapshotDialog v-model="detailVisible" :row="detailRow">
    <template #actions>
      <el-button v-if="['candidate', 'search_failed'].includes(detailRow.aiReviewStatus)" size="small" type="warning" plain @click="rejectAiAndSearch(detailRow)">联网核查</el-button>
      <el-button v-if="detailRow.aiReviewStatus === 'needs_review'" size="small" type="success" plain @click="approveAiReview(detailRow)">人工确认</el-button>
      <el-button v-if="isAnomaly(detailRow)" size="small" plain @click="editTaskCorrection(detailRow)">修改搜索信息</el-button>
      <el-button v-if="isAnomaly(detailRow) && detailRow.correctionWorkflowStatus === 'recollect_pending'" size="small" type="primary" plain @click="requestLocalRecollect(detailRow)">{{ isWeb ? '服务器策略复采' : '本地策略复采' }}</el-button>
      <el-button v-if="canWriteBack(detailRow)" size="small" plain @click="writeBackApi(detailRow)">回写 API 名称</el-button>
      <el-button v-if="detailRow.lastPrice != null || detailRow.apiSalePrice != null" size="small" type="primary" plain @click="previewPrice(detailRow)">预览采购价策略</el-button>
      <el-button v-if="detailRow.aiWebSearchResults?.length" size="small" plain @click="viewAiEvidence(detailRow)">联网证据</el-button>
      <el-button v-if="aliasProvider.configured && isAnomaly(detailRow)" size="small" plain @click="suggestAliases(detailRow)">找型号别名</el-button>
    </template>
  </MarketSnapshotDialog>

  <el-dialog v-model="aiReviewVisible" title="联网核查证据" width="min(760px, 94vw)">
    <template v-if="aiReviewRow">
      <el-alert v-if="aiReviewRow.aiReviewStatus === 'search_failed'" :title="aiReviewRow.aiReviewReason || '联网核查失败'" type="warning" :closable="false" show-icon />
      <el-card v-for="(item, index) in aiReviewRow.aiWebSearchResults || []" :key="`${item.link}-${index}`" shadow="never" class="evidence"><el-link v-if="item.link" :href="item.link" target="_blank" type="primary">{{ item.title || item.link }}</el-link><p>{{ item.content || '没有摘要' }}</p></el-card>
      <el-empty v-if="!aiReviewRow.aiWebSearchResults?.length" description="暂无联网证据" :image-size="70" />
    </template>
  </el-dialog>
  <el-dialog v-model="correctionVisible" title="修改搜索信息" width="min(520px, 94vw)">
    <el-form label-width="86px"><el-form-item label="品牌"><el-input v-model="correctionForm.brand" /></el-form-item><el-form-item label="型号"><el-input v-model="correctionForm.model" /></el-form-item><el-form-item label="搜索别称"><el-input v-model="correctionForm.alias" /></el-form-item></el-form>
    <template #footer><el-button @click="correctionVisible = false">取消</el-button><el-button type="primary" :loading="correctionSaving" @click="saveCorrection">保存并复核</el-button></template>
  </el-dialog>
  <el-dialog v-model="pricePreviewVisible" title="采购价策略预览" width="min(640px, 94vw)">
    <template v-if="pricePreview">
      <el-alert title="这里只生成带审计信息的价格意图，不会直接修改 API 价格。" type="info" :closable="false" show-icon />
      <div class="price-facts"><div><span>API 当前销售价</span><b>{{ money(pricePreview.facts?.apiCurrentSalePrice) }}</b></div><div><span>API 建议价</span><b>{{ money(pricePreview.facts?.apiSuggestPrice) }}</b></div><div><span>成本价</span><b>{{ money(pricePreview.facts?.costPrice) }}</b></div><div><span>行情中位价</span><b>{{ money(pricePreview.market?.median) }}</b></div></div>
      <el-table :data="pricePreview.candidates || []" size="small" border class="candidate-table">
        <el-table-column label="候选" min-width="150"><template #default="{ row }"><el-radio v-model="selectedPriceChoice" :label="row.key">{{ row.label }}</el-radio></template></el-table-column>
        <el-table-column label="价格" width="110"><template #default="{ row }">{{ money(row.price) }}</template></el-table-column>
        <el-table-column label="候选状态" width="110"><template #default="{ row }"><el-tag size="small" :type="pricePreview.status === 'ready' ? 'success' : 'warning'">{{ pricePreview.status === 'ready' ? '可提交意图' : '需复核' }}</el-tag></template></el-table-column>
        <el-table-column label="说明" min-width="180"><template #default="{ row }">{{ row.reason || '—' }}</template></el-table-column>
      </el-table>
      <div class="custom-price"><el-checkbox v-model="customPriceEnabled">自定义价格</el-checkbox><el-input-number v-model="customPrice" :disabled="!customPriceEnabled" :min="0.01" :precision="2" :step="1" /></div>
      <el-input v-model="priceSelectionNote" type="textarea" :rows="2" maxlength="240" show-word-limit placeholder="复核备注（可选）" />
      <el-alert v-if="priceIntentResult" :title="priceIntentResult.reason || '价格意图已记录'" :type="priceIntentResult.ok ? 'success' : 'warning'" :closable="false" show-icon class="intent-alert" />
    </template>
    <el-skeleton v-else-if="pricePreviewLoading" :rows="4" animated />
    <el-empty v-else description="暂无可预览的价格候选" />
    <template #footer><el-button @click="pricePreviewVisible = false">关闭</el-button><el-button type="primary" :loading="priceConfirming" :disabled="!pricePreview || !selectedPriceChoice" @click="confirmPrice">确认并记录意图</el-button></template>
  </el-dialog>
  <el-drawer v-model="policyVisible" title="行情记录 · SPU 独立策略" size="470px" append-to-body>
    <div v-if="policyTask" class="policy-drawer-intro">当前卡片：<b>{{ policyTask.localizedDisplayName || policyTask.name || policyTask.model }}</b><span>SPU {{ policyTask.spuCode || policyTask.spu_code }}</span></div>
    <el-form v-if="policyTask" label-position="top" class="policy-form">
      <el-form-item label="搜索模式"><el-select v-model="policyForm.search.mode" style="width:100%"><el-option label="继承品类策略" value="inherit_category" /><el-option label="SPU 独立搜索词" value="explicit" /></el-select></el-form-item>
      <el-form-item label="SPU 独立搜索词（每行一条，最多 12 条）"><el-input v-model="policyForm.searchText" type="textarea" :rows="4" placeholder="例如：14600K\n小米 G24 显示器" /></el-form-item>
      <el-form-item label="SPU 屏蔽词模式"><el-select v-model="policyForm.blacklist.mode" style="width:100%"><el-option label="继承通用屏蔽词" value="inherit" /><el-option label="通用 + SPU 追加" value="append" /><el-option label="仅使用 SPU 屏蔽词" value="replace" /></el-select></el-form-item>
      <el-form-item label="SPU 屏蔽词"><el-input v-model="policyForm.blacklistText" type="textarea" :rows="3" placeholder="例如：滤芯\n配件" /></el-form-item>
      <div class="policy-price-row"><el-form-item label="最低挂牌价"><el-input-number v-model="policyForm.priceFence.minListingPrice" :min="0" :max="10000000" /></el-form-item><el-form-item label="最高挂牌价"><el-input-number v-model="policyForm.priceFence.maxListingPrice" :min="0" :max="10000000" /></el-form-item></div>
      <el-form-item label="中文展示名"><el-input v-model="policyForm.localization.displayName" placeholder="例如：苹果妙控板四" /></el-form-item>
      <el-form-item label="中文搜索别名"><el-input v-model="policyForm.aliasText" placeholder="例如：苹果妙控板4" /></el-form-item>
      <el-checkbox v-model="policyForm.pageFilter.enabled">先用闲鱼自带的价格筛选（失败也不影响）</el-checkbox>
      <div class="policy-effective-preview"><b>当前生效策略</b><span>搜索：{{ policyPreview.effective?.search?.queries?.join(' · ') || '继承品类策略' }}</span><span>屏蔽：{{ policyPreview.effective?.blacklist?.terms?.join(' · ') || '无额外屏蔽词' }}</span><span>价格：{{ policyPreview.effective?.priceFence?.minListingPrice != null ? `≥ ¥${policyPreview.effective.priceFence.minListingPrice}` : '无最低挂牌价' }}</span><span>页面筛选：{{ policyPreview.effective?.pageFilter?.enabled ? '已开启意图' : '未开启' }}</span></div>
      <el-button type="primary" :loading="policySaving" @click="savePolicy">保存并应用到行情采集</el-button>
    </el-form>
  </el-drawer>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import MarketSnapshotDialog from '../components/MarketSnapshotDialog.vue'

const router = useRouter()
const isWeb = window.erp?.mode === 'web'
const q = ref(''); const queueKind = ref('all'); const priceBand = ref(null); const queueItems = ref([]); const queueCounts = ref({}); const priceBandCounts = ref({}); const queueLoading = ref(false)
const detailVisible = ref(false); const detailRow = ref({}); const aliasProvider = ref({ configured: false, supportsWebSearch: false, webSearchCostCny: 0 })
const aiReviewVisible = ref(false); const aiReviewRow = ref(null); const correctionVisible = ref(false); const correctionSaving = ref(false); const correctionRow = ref(null); const correctionForm = reactive({ brand: '', model: '', alias: '' })
const syncState = reactive({ status: 'unconfigured', source: '', syncedAt: null, lastSuccessAt: null, stale: false, safeError: '' })
const pricePreviewVisible = ref(false); const pricePreviewLoading = ref(false); const pricePreview = ref(null); const selectedPriceChoice = ref(''); const customPriceEnabled = ref(false); const customPrice = ref(null); const priceSelectionNote = ref(''); const priceConfirming = ref(false); const priceIntentResult = ref(null)
const policyVisible = ref(false); const policySaving = ref(false); const policyTask = ref(null); const policyPreview = ref({}); const policyForm = reactive({ search: { mode: 'inherit_category' }, searchText: '', blacklist: { mode: 'inherit' }, blacklistText: '', priceFence: { minListingPrice: null, maxListingPrice: null }, localization: { displayName: '' }, aliasText: '', pageFilter: { enabled: false } })
let off = null
const queueOptions = [{ key: 'all', label: '全部', description: '所有当前任务' }, { key: 'failed', label: '失败', description: '需要处理的任务' }, { key: 'pending', label: '待采集', description: '还没有行情结果' }, { key: 'success', label: '成功', description: '已完成的行情任务' }, { key: 'review', label: '待复核', description: '等待人工确认' }]
const priceBandOptions = [{ key: 'purchase_100_119', label: '未满120%' }, { key: 'purchase_120_plus', label: '120%档' }, { key: 'purchase_150_plus', label: '150%档' }, { key: 'purchase_200_plus', label: '200%档' }]
const activeQueue = computed(() => queueOptions.find((item) => item.key === queueKind.value) || queueOptions[0])
const statusLabels = { pending: '待采集', success: '成功', empty: '无在售', fail: '失败', invalid_price: '错误价格', risk_control: '风控暂停', ai_correction: '待复核', ai_review: '待复核' }
function queueLabel(kind, workflow = '') { return workflow === 'custom_search_pending' ? '待配置 SPU 搜索' : workflow === 'price_review' ? '价格待复核' : statusLabels[kind] || '待采集' }
function queueTagType(kind) { return kind === 'success' ? 'success' : kind === 'pending' ? 'info' : ['review', 'ai_correction', 'ai_review'].includes(kind) ? 'warning' : 'danger' }
function searchText(row = {}) { const keys = Array.isArray(row.searchKeywords) ? row.searchKeywords.filter(Boolean) : []; return (keys.length ? keys : [row.keyword || [row.brand, row.model].filter(Boolean).join(' ')]).filter(Boolean).join(' · ') }
function comparisonType(key) { return ['below_minimum', 'below_purchase_price', 'invalid_purchase_price', 'invalid_market_price'].includes(key) ? 'danger' : key === 'purchase_200_plus' ? 'success' : key === 'purchase_150_plus' ? 'primary' : key === 'purchase_120_plus' ? 'warning' : 'info' }
function signed(value) { return value == null ? '' : `${value >= 0 ? '+' : ''}${value}%` }
function money(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : `¥${Number(value).toFixed(2)}` }
function policyQueries(row = {}) { const values = row.effectiveSearchPolicy?.queries || row.searchKeywords || []; return values.length ? values.join(' · ') : '继承品类策略' }
function policyTerms(row = {}) { const values = row.effectiveBlacklist?.terms || []; return values.length ? values.join(' · ') : '无' }
function policyMinPrice(row = {}) { const value = row.effectivePriceFence?.minListingPrice; return value == null ? '未设置' : `≥ ¥${Number(value).toFixed(0)}` }
function policyDisplayName(row = {}) { return row.localizedDisplayName || row.name || row.model || '未设置' }
function policyPageFilter(row = {}) { return row.effectivePageFilter?.enabled ? '已开启意图' : '未开启' }
function syncStatusLabel(status) { return ({ unconfigured: 'API 尚未配置', syncing: 'API 正在同步', synced: 'API 已同步', stale: 'API 数据已过期', failed: 'API 同步失败' }[status]) || 'API 状态未知' }
function syncStatusCopy(state = {}) { if (state.status === 'synced') return `${state.source || 'API'} · 最近同步 ${state.syncedAt ? new Date(state.syncedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}`; return state.safeError || '行情页只读取主进程快照，等待后台同步或人工处理连接配置' }
function isAnomaly(row = {}) { return ['failed', 'review'].includes(row.displayGroup) || ['empty', 'fail', 'invalid_price', 'risk_control'].includes(row.queueKind || row.lastStatus) }
function apiSku(row = {}) { return row.apiSkuCode || row.wmsSkuCode || row.sku_code || '' }
function canWriteBack(row = {}) { return row.aiReviewStatus === 'approved' && row.lastStatus === 'success' && apiSku(row) && Number(row.apiSkuCount || 0) === 1 && !row.apiDataConflict && ['success_pending_review', 'verified', 'approved'].includes(row.correctionReviewStatus || 'approved') }
// Legacy queue DTO shape used `priceBandCounts.value = res.priceBandCounts || {}`;
// the live projection now supplies the same aggregate under `res.market`.
async function loadQueues() { queueLoading.value = true; try { const res = await window.erp.getWmsProjection({ q: q.value.trim(), page: 1, pageSize: 1, marketGroup: queueKind.value, marketPage: 1, marketPageSize: 50 }); const items = res?.market?.items || []; const band = queueKind.value === 'success' ? priceBand.value : null; queueItems.value = band ? items.filter((row) => (row.priceComparison || row.lastPriceComparison)?.key === band) : items; queueCounts.value = res?.market?.groupCounts || {}; priceBandCounts.value = res?.market?.priceBandCounts || {}; Object.assign(syncState, res?.sync || {}); const alias = await window.erp.getTaskAliasStatus?.(); aliasProvider.value = alias || aliasProvider.value } finally { queueLoading.value = false } }
function refresh() { void loadQueues() }
async function selectQueue(kind) { queueKind.value = kind; if (kind !== 'success') priceBand.value = null; await loadQueues() }
async function selectBand(key) { priceBand.value = priceBand.value === key ? null : key; await loadQueues() }
function openDetail(row) { detailRow.value = row; detailVisible.value = true }
function splitPolicyText(value) { return String(value || '').split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean) }
async function openPolicy(row) {
  const spuCode = row?.spuCode || row?.spu_code
  if (!spuCode) return ElMessage.warning('当前行情卡片没有关联 SPU，不能保存独立策略')
  policyTask.value = row
  const record = await window.erp.getSpuPolicy(spuCode)
  const policy = record || row.spuSearchPolicy || {}
  policyForm.search.mode = policy.search?.mode || 'inherit_category'
  policyForm.searchText = (policy.search?.queries || []).join('\n')
  policyForm.blacklist.mode = policy.blacklist?.mode || 'inherit'
  policyForm.blacklistText = (policy.blacklist?.terms || []).join('\n')
  policyForm.priceFence.minListingPrice = policy.priceFence?.minListingPrice ?? null
  policyForm.priceFence.maxListingPrice = policy.priceFence?.maxListingPrice ?? null
  policyForm.localization.displayName = policy.localization?.displayName || ''
  policyForm.aliasText = (policy.localization?.searchAliases || []).join('\n')
  policyForm.pageFilter.enabled = policy.pageFilter?.enabled === true
  policyPreview.value = await window.erp.previewSpuPolicy(spuCode) || {}
  policyVisible.value = true
}
async function savePolicy() {
  const spuCode = policyTask.value?.spuCode || policyTask.value?.spu_code
  if (!spuCode) return
  policySaving.value = true
  try {
    const result = await window.erp.saveSpuPolicy(spuCode, { search: { mode: policyForm.search.mode, queries: splitPolicyText(policyForm.searchText) }, blacklist: { mode: policyForm.blacklist.mode, terms: splitPolicyText(policyForm.blacklistText) }, priceFence: policyForm.priceFence, pageFilter: policyForm.pageFilter, localization: { displayName: policyForm.localization.displayName, searchAliases: splitPolicyText(policyForm.aliasText) } })
    if (!result?.ok) return ElMessage.warning(result?.reason || 'SPU 策略保存失败')
    policyPreview.value = await window.erp.previewSpuPolicy(spuCode) || {}
    policyVisible.value = false
    ElMessage.success('SPU 策略已应用到行情采集')
    await loadQueues()
  } catch (error) { ElMessage.warning(error?.message || 'SPU 策略保存失败') } finally { policySaving.value = false }
}
async function requeueFailed() { const result = await window.erp.startTaskQueue('failed'); if (!result?.ok) return ElMessage.warning(result?.reason || '失败复采未启动'); ElMessage.success(`失败复采已进入队列，共 ${result.total || 0} 条`); await loadQueues() }
async function suggestAliases(row) { const result = await window.erp.suggestTaskAliases(row.taskId); if (!result?.ok) return ElMessage.warning(result?.reason || '别名生成失败'); ElMessage.success('已保存搜索别名'); await loadQueues() }
async function rejectAiAndSearch(row) { if (!aliasProvider.value.supportsWebSearch) return ElMessage.warning('当前供应商不支持联网核查'); try { await ElMessageBox.confirm('联网核查只保存证据，不会自动改型号或发布。确定继续？', '联网核查', { type: 'warning' }) } catch { return }; const result = await window.erp.rejectAiAndSearch(row.taskId, `人工核查：${row.name}`); if (!result?.ok) return ElMessage.warning(result?.reason || '联网核查失败'); ElMessage.success('联网核查已完成，请查看证据'); await loadQueues() }
async function approveAiReview(row) { const result = await window.erp.approveAiReview(row.taskId); if (!result?.ok) return ElMessage.warning(result?.reason || '人工确认失败'); ElMessage.success('已记录人工确认'); detailVisible.value = false; await loadQueues() }
function editTaskCorrection(row) { correctionRow.value = row; correctionForm.brand = row.brand || ''; correctionForm.model = row.model || ''; correctionForm.alias = row.effectiveAlias || ''; correctionVisible.value = true }
async function saveCorrection() { if (!correctionRow.value?.taskId) return; correctionSaving.value = true; try { const result = await window.erp.manualTaskCorrection(correctionRow.value.taskId, { brand: correctionForm.brand, model: correctionForm.model, alias: correctionForm.alias }); if (!result?.ok) return ElMessage.warning(result?.reason || '任务修改失败'); correctionVisible.value = false; detailVisible.value = false; ElMessage.success('已保存并进入待复核'); await loadQueues() } catch (error) { ElMessage.warning(error?.message || '任务修改失败') } finally { correctionSaving.value = false } }
async function requestLocalRecollect(row) { const result = await window.erp.requestTaskRecollect(row.taskId, { mode: 'local', operator: 'prices' }); if (!result?.ok) return ElMessage.warning(result?.reason || '复采意图保存失败'); ElMessage.success(isWeb ? '已登记服务器策略复采，请点击异常队列的复采按钮执行' : '已登记本地策略复采，请点击异常队列的复采按钮执行'); await loadQueues() }
async function writeBackApi(row) { const skuCode = apiSku(row); if (!canWriteBack(row)) return ElMessage.warning('只有成功且已复核的唯一 API SKU 才允许回写'); try { await ElMessageBox.confirm(`将按 API SKU ${skuCode} 回写品牌/型号并在 GET 校验后登记复采；价格不会修改。`, '确认同步 WMS 后复采', { type: 'warning' }) } catch { return }; const result = await window.erp.updateWmsSku({ taskId: row.taskId, skuCode, patch: { product_name: row.name || '', brand: row.brand || '', model: row.model || '' } }); if (!result?.ok) return ElMessage.warning(result?.reason || 'WMS 品牌/型号修正失败'); ElMessage.success('WMS 已回读确认，并登记同步后复采'); await loadQueues() }
async function previewPrice(row) { pricePreviewVisible.value = true; pricePreviewLoading.value = true; pricePreview.value = null; priceIntentResult.value = null; selectedPriceChoice.value = ''; customPriceEnabled.value = false; customPrice.value = null; try { const result = await window.erp.previewPriceCandidates(row.taskId); if (!result?.ok) return ElMessage.warning(result?.reason || '当前没有可用的价格预览'); pricePreview.value = result.preview; selectedPriceChoice.value = result.preview?.candidates?.find((candidate) => candidate.enabled)?.key || '' } catch (error) { ElMessage.warning(error?.message || '价格预览失败') } finally { pricePreviewLoading.value = false } }
async function confirmPrice() { if (!pricePreview.value || !detailRow.value?.taskId) return; const choice = customPriceEnabled.value ? 'custom' : selectedPriceChoice.value; if (!choice) return ElMessage.warning('请选择一个价格候选'); priceConfirming.value = true; try { const result = await window.erp.confirmPriceSelection({ taskId: detailRow.value.taskId, previewId: pricePreview.value.previewId, policyVersion: pricePreview.value.policyVersion, choice, customPrice: customPriceEnabled.value ? customPrice.value : null, confirmed: true, operatorId: 'prices', note: priceSelectionNote.value }); priceIntentResult.value = result; if (result?.ok) { ElMessage.success('价格意图已记录，API 价格未修改'); await loadQueues() } } catch (error) { priceIntentResult.value = { ok: false, reason: error?.message || '价格意图保存失败' } } finally { priceConfirming.value = false } }
function viewAiEvidence(row) { aiReviewRow.value = row; aiReviewVisible.value = true }
onMounted(() => { void loadQueues(); off = window.erp.onCrawlEvent?.(({ type }) => { if (type === 'counters' || type === 'done' || type === 'sync-state') void loadQueues() }) })
onUnmounted(() => off?.())
</script>

<style scoped>
.header,.header-actions,.status-filters,.bands,.list-head,.task-title,.comparison,.task-side{display:flex;align-items:center}.header{justify-content:space-between;gap:16px}.header strong{font-size:18px;color:#273a30}.header p{margin:4px 0 0;color:#84928a;font-size:12px}.header-actions{gap:8px}.header-actions .el-input{width:220px}.sync-alert{margin-bottom:12px}.status-filters{gap:8px;overflow:auto;padding:4px 0 10px}.status-filters button{min-width:86px;padding:9px 11px;border:1px solid #e0e9e2;border-radius:10px;background:#fff;color:#718078;cursor:pointer;text-align:left}.status-filters button.active{border-color:#64a97b;background:#f1f9f3;color:#2c7048;box-shadow:0 0 0 2px rgba(100,169,123,.12)}.status-filters strong{display:block;font-size:18px;line-height:1.1}.status-filters span{display:block;margin-top:3px;font-size:11px}.bands{flex-wrap:wrap;gap:7px;margin:0 0 10px}.list-head{justify-content:space-between;margin:2px 0 8px;color:#819087;font-size:12px}.task-list{display:grid;gap:9px}.task-card{display:flex;justify-content:space-between;gap:14px;padding:13px 14px;border:1px solid #e1eae3;border-radius:12px;background:#fff}.task-main{min-width:0}.task-title{gap:8px}.task-title strong{overflow:hidden;color:#35463c;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.task-main p{overflow:hidden;margin:5px 0;color:#93a099;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.fact-strip{display:flex;flex-wrap:wrap;gap:5px 12px;margin:5px 0;color:#7b8b82;font-size:11px}.fact-strip b{color:#486b59;font-weight:650}.comparison{flex-wrap:wrap;gap:5px 8px;color:#597065;font-size:12px}.reason{color:#839188}.task-side{flex:0 0 auto;flex-direction:column;align-items:flex-end;gap:7px}.task-side b{color:#e76f3c;font-size:17px}.task-side span{color:#9ba7a0}.spu-policy-strip{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:8px;padding:7px 9px;border:1px solid #e4ebe6;border-radius:8px;background:#fafcfb;color:#718078;font-size:11px;line-height:1.4}.spu-policy-strip.configured{border-color:#cce5d2;background:#f5fbf6}.spu-policy-strip span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.spu-policy-strip b{margin-right:3px;color:#52675a;font-weight:600}.spu-policy-title{color:#2f7250;font-weight:700}.price-facts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.price-facts div{padding:10px;border:1px solid #e2ebe4;border-radius:9px;background:#f8fbf8}.price-facts span,.price-facts b{display:block}.price-facts span{color:#819087;font-size:11px}.price-facts b{margin-top:5px;color:#3f6f52}.candidate-table{margin-bottom:12px}.custom-price{display:flex;align-items:center;gap:12px;margin:12px 0}.intent-alert{margin-top:12px}.evidence{margin-top:9px}.evidence p{margin:6px 0 0;color:#66776e;font-size:12px;line-height:1.55}.policy-drawer-intro{display:flex;flex-direction:column;gap:4px;margin-bottom:16px;color:#687970;font-size:13px}.policy-drawer-intro span{color:#3d7652;font-size:12px}.policy-form{padding-bottom:12px}.policy-price-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.policy-effective-preview{display:grid;gap:5px;margin:16px 0;padding:10px 12px;border:1px solid #dfeae2;border-radius:9px;background:#f7fbf8;color:#66786d;font-size:12px}.policy-effective-preview b{color:#3c6e50}.policy-effective-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:720px){.header{align-items:flex-start;flex-direction:column}.header-actions{width:100%}.header-actions .el-input{flex:1;width:auto}.task-card{padding:12px}.task-side{min-width:92px}.status-filters{margin-inline:-2px}.price-facts{grid-template-columns:repeat(2,1fr)}.spu-policy-strip{display:grid;grid-template-columns:1fr}.policy-price-row{grid-template-columns:1fr}}
</style>
