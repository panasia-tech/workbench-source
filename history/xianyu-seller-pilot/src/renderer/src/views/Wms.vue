<template>
  <div class="spu-page">
    <section class="workbench-hero">
      <div class="hero-topline">
        <div class="hero-copy">
          
          <h1>库存商品</h1>
        </div>
        <div class="hero-actions">
          <el-button type="primary" :icon="Refresh" :loading="syncing" @click="refreshApi">刷新数据</el-button>
          <el-button :icon="Download" @click="exportWms" :disabled="!tasks.length && !catalogTotal">导出关联表</el-button>
          <el-button :icon="Setting" plain @click="connectionVisible = true">连接设置</el-button>
        </div>
      </div>
      <div class="sync-line">
        <span class="sync-dot" :class="{ ready: wmsState.available, waiting: !wmsState.available && connectionConfigured }"></span>
        <strong>{{ syncStatusLabel(wmsState.status) }}</strong>
        <span class="sync-copy">{{ wmsState.available ? `${wmsState.skuTotal || 0} 个在库 SKU 正在参与采集` : syncStatusCopy(wmsState.status) }}</span>
        <span v-if="wmsState.source || lastSource" class="sync-source">· {{ sourceLabel(wmsState.source || lastSource) }}</span>
        <span class="sync-time">最近同步 <b>{{ formatTime(wmsState.syncedAt) }}</b></span>
      </div>
    </section>

    <section class="metric-grid" aria-label="库存数据概览">
      <div class="metric-card metric-primary">
        <span class="metric-label">API SPU 总数</span>
        <strong>{{ wmsState.spuTotal || 0 }}</strong>
        <small>{{ wmsState.skuTotal || 0 }} 个在库 SKU</small>
      </div>
      <div class="metric-card metric-pending">
        <span class="metric-label">待采集</span>
        <strong>{{ pendingTaskCount }}</strong>
        <small>还没有行情结果</small>
      </div>
      <div class="metric-card metric-success">
        <span class="metric-label">成功</span>
        <strong>{{ successTaskCount }}</strong>
        <small>最近一次采集成功</small>
      </div>
      <div class="metric-card metric-warning">
        <span class="metric-label">异常</span>
        <strong>{{ anomalyTaskCount }}</strong>
        <small>需要人工处理或复核</small>
      </div>
      <div class="metric-card metric-time">
        <span class="metric-label">最近同步</span>
        <strong>{{ formatTime(wmsState.syncedAt) }}</strong>
        <small>{{ wmsState.status === 'failed' ? (wmsState.safeError || '保留最近有效快照') : (wmsState.source ? sourceLabel(wmsState.source) : '尚未读取 API') }}</small>
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-heading">
        <div><h2>仓库里的货</h2></div>
        <div class="tools"><el-input v-model="q" clearable placeholder="搜索 SPU / 商品名 / 品牌 / 型号" :prefix-icon="Search" style="width: 280px" @clear="loadCatalog" @keyup.enter="loadCatalog" /><el-button plain @click="loadCatalog">查询</el-button></div>
      </div>
      <el-alert v-if="loadError" :title="loadError" type="warning" show-icon :closable="false" class="load-alert" />
      <el-table :data="catalogRows" v-loading="loading" border height="calc(100vh - 455px)">
        <el-table-column label="API SPU" width="150" fixed><template #default="{ row }"><span class="spu-code">{{ row.spu_code || '—' }}</span></template></el-table-column>
        <el-table-column label="SKU 数量" width="90" align="center"><template #default="{ row }">{{ row.sku_count || 0 }}</template></el-table-column>
        <el-table-column label="API 商品信息" min-width="260"><template #default="{ row }"><div class="product-name">{{ row.product_name || '未提供商品名' }}</div><div class="product-sub">{{ row.brand || '—' }} · {{ row.model || '—' }} · {{ row.spec || '—' }}</div></template></el-table-column>
        <el-table-column label="数据来源" width="130"><template #default="{ row }"><el-tag type="success" size="small" effect="plain">API-SPU 主库</el-tag></template></el-table-column>
        <el-table-column label="API 当前销售价" width="155"><template #default="{ row }"><span v-if="row.sale_price" class="api-price">¥{{ row.sale_price }}</span><el-tag v-else-if="row.sale_price_values?.length > 1" type="warning" size="small" effect="plain">多 SKU 价格待复核</el-tag><span v-else-if="row.suggest_price" class="suggest-price">建议价 ¥{{ row.suggest_price }}</span><span v-else class="muted">未提供</span></template></el-table-column>
        <el-table-column label="成本价" width="140"><template #default="{ row }"><span v-if="row.cost_price" class="cost-price">¥{{ row.cost_price }}</span><el-tooltip v-else-if="row.cost_price_values?.length > 1" placement="top" :content="`在库 SKU 成本价：${row.cost_price_values.join(' / ')}。不同批次进价不同，调价底价需人工定夺`"><el-tag type="warning" size="small" effect="plain">多 SKU 成本不同</el-tag></el-tooltip><span v-else class="muted">未提供</span></template></el-table-column>
        <el-table-column label="最近行情价" width="125"><template #default="{ row }"><span v-if="row.task?.lastPrice != null" class="market-price">¥{{ row.task.lastPrice }}</span><span v-else class="muted">未采集</span></template></el-table-column>
        <el-table-column label="采集状态" width="110"><template #default="{ row }"><el-tag :type="statusTagType(row.task?.lastStatus)" size="small">{{ statusLabel(row.task?.lastStatus) }}</el-tag></template></el-table-column>
        <el-table-column label="搜索/复核" min-width="170"><template #default="{ row }"><span v-if="row.task?.correctionReviewStatus && row.task.correctionReviewStatus !== 'none'" class="reason">{{ correctionLabel(row.task.correctionReviewStatus) }}</span><span v-else-if="row.task?.lastReason" class="reason">{{ row.task.lastReason }}</span><span v-else class="muted">—</span></template></el-table-column>
        <el-table-column label="最近采集时间" width="155"><template #default="{ row }"><span class="muted">{{ formatTime(row.task?.lastRunAt) }}</span></template></el-table-column>
        <el-table-column label="上下架" width="104"><template #default="{ row }"><el-button link type="primary" @click="goListing(row)">去上架</el-button></template></el-table-column>
        <el-table-column label="SPU 搜索策略" width="130" fixed="right"><template #default="{ row }"><el-button v-if="row.task" link type="primary" @click="openPolicy(row.task)">{{ row.task.spuSearchPolicy ? '已配置' : '配置' }}</el-button><span v-else class="muted">—</span></template></el-table-column>
      </el-table>
      <div class="table-footer"><span>显示 {{ catalogRows.length }} / {{ catalogTotal }} 个 API SPU</span><el-pagination v-model:current-page="catalogPage" v-model:page-size="catalogPageSize" :page-sizes="[25, 50, 100]" layout="sizes, prev, pager, next" :total="catalogTotal" @current-change="loadCatalog" @size-change="loadCatalog" /></div>
    </section>

    <section class="panel-card issue-card">
      <div class="panel-heading compact"><div><h2>待处理队列</h2><p class="section-desc">系统拿不准是哪件货，需要人工确认</p></div><el-tag :type="issueCount ? 'warning' : 'success'" effect="plain">{{ issueCount }} 条</el-tag></div>
      <el-table v-if="filteredIssues.length" :data="filteredIssues" border size="small">
        <el-table-column label="任务名称" min-width="220"><template #default="{ row }"><span>{{ row.brand || '—' }} · {{ row.model || row.name || '未命名' }}</span></template></el-table-column>
        <el-table-column label="API SPU" width="160"><template #default="{ row }"><span class="task-spu">{{ taskSpu(row) || '—' }}</span></template></el-table-column>
        <el-table-column label="状态" width="190"><template #default="{ row }"><el-tag type="warning" size="small" effect="plain">{{ correctionLabel(row.correctionReviewStatus || row.displayGroup || row.lastStatus) }}</el-tag></template></el-table-column>
        <el-table-column label="说明" min-width="300"><template #default="{ row }"><span class="reason">{{ row.lastReason || row.aiReviewReason || '需要人工处理或复核' }}</span></template></el-table-column>
      </el-table>
      <el-alert v-else-if="issueCount" title="API 数据仍有待处理项，但当前页没有可展示的任务记录。请刷新 API 数据后再查看。" type="warning" :closable="false" show-icon />
      <el-empty v-else description="当前没有需要人工处理的 SPU" :image-size="70" />
    </section>

    <el-drawer v-model="connectionVisible" title="库存 API 连接" size="470px" append-to-body>
      <div class="drawer-intro">读库存<b>用本工作台的登录账号即可</b>。下面的管理账号只在「回写 API 名称」时需要，平时留空。密钥只存在本机，不展示也不导出。</div>
      <el-form label-position="top" class="connection-form">
        <el-form-item v-if="!isWeb" label="ERP 服务器地址">
          <el-input v-model="serverBaseUrl" :placeholder="defaultServerBaseUrl" />
        </el-form-item>
        <el-form-item label="数据源">
          <el-select v-model="wmsSource" style="width: 100%"><el-option label="自动（REST → MCP 兜底）" value="auto" /><el-option label="仅 REST API" value="rest" /><el-option label="仅 MCP 只读" value="mcp" /></el-select>
        </el-form-item>
        <el-form-item label="MCP 地址">
          <el-input v-model="wmsMcpUrl" placeholder="http://127.0.0.1:8000" />
        </el-form-item>
        <el-form-item label="MCP 密钥">
          <el-input v-model="wmsMcpKey" type="password" show-password :placeholder="wmsMcpKeyConfigured ? '密钥已配置，留空保持不变' : '请输入 MCP 密钥'" />
        </el-form-item>
        <el-form-item label="回写权限">
          <div class="writeback-note">
            回写商品名称用<b>你现在登录的这个账号</b>，不用再填第二套账号密码。
            <br />价格回写属于上架权限，目前未开通。
          </div>
        </el-form-item>
        <el-button type="primary" :loading="syncing" @click="saveWmsSource">保存并同步</el-button>
      </el-form>
      <div class="connection-status">
        <div class="status-heading">当前配置状态</div>
        <div class="status-tags"><el-tag size="small" type="success" effect="plain">REST 用登录账号</el-tag><el-tag size="small" :type="wmsMcpKeyConfigured ? 'success' : 'info'" effect="plain">MCP {{ wmsMcpKeyConfigured ? '已配置' : '未配置' }}</el-tag></div>
      </div>
    </el-drawer>
    <el-drawer v-model="policyVisible" title="SPU 独立搜索策略" size="470px" append-to-body>
      <div v-if="policyTask" class="drawer-intro">当前 SPU：<b>{{ policyTask.spuCode || policyTask.spu_code }}</b>。保存只修改本地搜索策略，不修改 WMS 主数据。</div>
      <el-form v-if="policyTask" label-position="top" class="connection-form">
        <el-form-item label="搜索模式"><el-select v-model="policyForm.search.mode" style="width:100%"><el-option label="继承品类策略" value="inherit_category" /><el-option label="SPU 独立搜索词" value="explicit" /></el-select></el-form-item>
        <el-form-item label="搜索词（每行一条，最多 12 条）"><el-input v-model="policyForm.searchText" type="textarea" :rows="4" placeholder="例如：14600K\nApple TV 4K" /></el-form-item>
        <el-form-item label="SPU 屏蔽词模式"><el-select v-model="policyForm.blacklist.mode" style="width:100%"><el-option label="继承通用屏蔽词" value="inherit" /><el-option label="通用 + SPU 追加" value="append" /><el-option label="仅使用 SPU 屏蔽词" value="replace" /></el-select></el-form-item>
        <el-form-item label="SPU 屏蔽词"><el-input v-model="policyForm.blacklistText" type="textarea" :rows="3" placeholder="例如：滤芯\n配件" /></el-form-item>
        <div class="policy-price-row"><el-form-item label="最低挂牌价"><el-input-number v-model="policyForm.priceFence.minListingPrice" :min="0" :max="10000000" /></el-form-item><el-form-item label="最高挂牌价"><el-input-number v-model="policyForm.priceFence.maxListingPrice" :min="0" :max="10000000" /></el-form-item></div>
        <el-form-item label="中文展示名"><el-input v-model="policyForm.localization.displayName" placeholder="例如：苹果妙控板四" /></el-form-item>
        <el-form-item label="中文搜索别名"><el-input v-model="policyForm.aliasText" placeholder="例如：苹果妙控板4" /></el-form-item>
        <el-checkbox v-model="policyForm.pageFilter.enabled">先用闲鱼自带的价格筛选（失败也不影响）</el-checkbox>
        <div class="policy-preview"><b>当前生效查询</b><span>{{ policyPreview.effective?.search?.queries?.join(' · ') || policyTask.effectiveSearchPolicy?.queries?.join(' · ') || '—' }}</span><b>当前生效展示名</b><span>{{ policyPreview.effective?.displayName || policyTask.localizedDisplayName || policyTask.name }}</span></div>
        <el-button type="primary" :loading="policySaving" @click="savePolicy">保存 SPU 策略</el-button>
      </el-form>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Refresh, Search, Setting } from '@element-plus/icons-vue'

const loading = ref(false)
const syncing = ref(false)
const tasks = ref([])
const catalogRows = ref([])
const catalogTotal = ref(0)
const catalogPage = ref(1)
const catalogPageSize = ref(50)
const q = ref('')
const loadError = ref('')
const connectionVisible = ref(false)
const policyVisible = ref(false)
const policySaving = ref(false)
const policyTask = ref(null)
const policyPreview = ref({})
const policyForm = reactive({ search: { mode: 'inherit_category' }, searchText: '', blacklist: { mode: 'inherit' }, blacklistText: '', priceFence: { minListingPrice: null, maxListingPrice: null }, localization: { displayName: '' }, aliasText: '', pageFilter: { enabled: false } })
const wmsState = reactive({ available: false, status: 'unconfigured', source: '', spuTotal: 0, skuTotal: 0, syncedAt: null, lastAttemptAt: null, lastSuccessAt: null, stale: false, retry: 0, safeError: '', invalidSpuRows: 0, conflictSpuCount: 0 })
const wmsSource = ref('auto')
const wmsMcpUrl = ref('')
const wmsMcpKey = ref('')
const wmsMcpKeyConfigured = ref(false)
const connectionConfigured = ref(false)
const lastSource = ref('')
// 库存 REST 走的就是登录时那个 ERP 服务器地址，放在这里一并可改，
// 省得为了换部署再退回登录页。H5 版跑在服务器上，地址就是自己的 origin，
// 适配层的 setServer 是直接 reject 的，所以那边不给这个字段。
const isWeb = window.erp?.mode === 'web'
const router = useRouter()

/** 带着这件货去上下架页。上一版得自己切页再从待上架列表里把它找回来——
 *  而它刚才就在眼前。带上搜索词，那页只有一条命中时会直接选中。 */
function goListing(row) {
  const q = String(row.product_name || row.model || row.spu_code || '').trim()
  router.push({ path: '/listing', query: q ? { q } : {} })
}
const serverBaseUrl = ref('')
const defaultServerBaseUrl = ref('http://127.0.0.1:8000')
const marketCounts = reactive({ all: 0, failed: 0, pending: 0, success: 0, review: 0 })
let stopWmsSyncState = null

function taskSpu(row) { return row?.spuCode || row?.spu_code || row?.spu || '' }
const issues = computed(() => tasks.value.filter((task) => ['failed', 'review'].includes(task.displayGroup) || ['empty', 'fail', 'invalid_price', 'risk_control'].includes(task.lastStatus)))
const issueCount = computed(() => Number(marketCounts.failed || 0) + Number(marketCounts.review || 0) + Number(wmsState.invalidSpuRows || 0))
const filteredIssues = computed(() => { const query = q.value.trim().toLowerCase(); if (!query) return issues.value.slice(0, 100); return issues.value.filter((row) => [row.brand, row.model, row.name, taskSpu(row), row.lastReason].map((v) => String(v || '').toLowerCase()).join(' ').includes(query)).slice(0, 100) })
const pendingTaskCount = computed(() => Number(marketCounts.pending || 0))
const successTaskCount = computed(() => Number(marketCounts.success || 0))
const anomalyTaskCount = computed(() => Number(marketCounts.failed || 0) + Number(marketCounts.review || 0) + Number(wmsState.invalidSpuRows || 0))

function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function sourceLabel(source) { return source === 'rest' ? 'REST API' : source === 'mcp' || source === 'mcp-fallback' ? 'MCP 只读' : source || '—' }
function syncStatusLabel(status) { return ({ unconfigured: 'API 尚未配置', syncing: 'API 正在同步', synced: 'API 已同步', stale: 'API 数据已过期', failed: 'API 同步失败' }[status]) || 'API 状态未知' }
function syncStatusCopy(status) { return ({ unconfigured: '请在设置中配置受保护的库存 API 凭据', syncing: '主进程正在读取在库 API-SPU', stale: '仍保留最近一次完整快照，可继续查看与采集', failed: '已保留最近一次成功快照，等待自动重试' }[status]) || '等待主进程同步状态' }
// REST 只读靠工作台自己的登录态，能进到这个页面就说明已登录，所以 rest 恒为可用；
// 回写管理账号是可选项，不影响"连接是否配好"的判定。
function sourceHasCredentials(source = wmsSource.value) { if (source === 'mcp') return wmsMcpKeyConfigured.value; return true }
function statusLabel(status) { return { success: '成功', empty: '无在售', fail: '失败', invalid_price: '错误价格', risk_control: '风控暂停' }[status] || '未采集' }
function statusTagType(status) { return status === 'success' ? 'success' : status === 'invalid_price' ? 'warning' : status === 'fail' || status === 'risk_control' ? 'danger' : 'info' }
function correctionLabel(status) { return { review_pending: '待复核', approved: '已复核', success_pending_review: '成功待复核', verified: '已验证回写' }[status] || status || '待处理' }
function splitPolicyText(value) { return String(value || '').split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean) }
async function openPolicy(task) {
  policyTask.value = task
  const record = await window.erp.getSpuPolicy(task.spuCode || task.spu_code)
  const policy = record || task.spuSearchPolicy || {}
  policyForm.search.mode = policy.search?.mode || 'inherit_category'; policyForm.searchText = (policy.search?.queries || []).join('\n')
  policyForm.blacklist.mode = policy.blacklist?.mode || 'inherit'; policyForm.blacklistText = (policy.blacklist?.terms || []).join('\n')
  policyForm.priceFence.minListingPrice = policy.priceFence?.minListingPrice ?? null; policyForm.priceFence.maxListingPrice = policy.priceFence?.maxListingPrice ?? null
  policyForm.localization.displayName = policy.localization?.displayName || ''; policyForm.aliasText = (policy.localization?.searchAliases || []).join('\n'); policyForm.pageFilter.enabled = policy.pageFilter?.enabled === true
  policyPreview.value = await window.erp.previewSpuPolicy(task.spuCode || task.spu_code) || {}; policyVisible.value = true
}
async function savePolicy() {
  if (!policyTask.value) return
  policySaving.value = true
  try {
    const spuCode = policyTask.value.spuCode || policyTask.value.spu_code
    const result = await window.erp.saveSpuPolicy(spuCode, { search: { mode: policyForm.search.mode, queries: splitPolicyText(policyForm.searchText) }, blacklist: { mode: policyForm.blacklist.mode, terms: splitPolicyText(policyForm.blacklistText) }, priceFence: policyForm.priceFence, pageFilter: policyForm.pageFilter, localization: { displayName: policyForm.localization.displayName, searchAliases: splitPolicyText(policyForm.aliasText) } })
    if (!result?.ok) return ElMessage.warning(result?.reason || 'SPU 策略保存失败')
    policyPreview.value = await window.erp.previewSpuPolicy(spuCode) || {}; ElMessage.success('SPU 独立策略已保存'); policyVisible.value = false; await loadCatalog()
  } catch (error) { ElMessage.warning(error?.message || 'SPU 策略保存失败') } finally { policySaving.value = false }
}

async function loadCatalog() {
  loading.value = true; loadError.value = ''
  try {
    const [projection, settings] = await Promise.all([
      window.erp.getWmsProjection({ q: q.value.trim(), page: catalogPage.value, pageSize: catalogPageSize.value, marketGroup: 'all', marketPage: 1, marketPageSize: 50 }),
      window.erp.getTaskSettings()
    ])
    Object.assign(wmsState, projection?.sync || {}); tasks.value = (projection?.inventory?.items || []).map((item) => item.task).filter(Boolean); catalogRows.value = projection?.inventory?.items || []; catalogTotal.value = Number(projection?.inventory?.total) || 0
    Object.assign(marketCounts, projection?.market?.groupCounts || {})
    if (!isWeb) {
      const auth = await window.erp.getAuthState()
      defaultServerBaseUrl.value = auth?.defaultServerBaseUrl || defaultServerBaseUrl.value
      serverBaseUrl.value = auth?.serverBaseUrl || defaultServerBaseUrl.value
    }
    wmsSource.value = settings.wmsSource || 'auto'; wmsMcpUrl.value = settings.wmsMcpUrl || ''; wmsMcpKey.value = ''
    wmsMcpKeyConfigured.value = Boolean(settings.wmsMcpKeyConfigured); connectionConfigured.value = sourceHasCredentials()
  } catch (error) { loadError.value = error?.message || 'API-SPU 数据加载失败，请稍后重试' } finally { loading.value = false }
}

async function refreshApi() {
  syncing.value = true; loadError.value = ''
  try {
    const result = await window.erp.syncWmsSkus({ source: wmsSource.value })
    if (!result?.ok) { loadError.value = result?.reason || 'API-SPU 刷新失败，已保留上次有效数据'; return ElMessage.warning(loadError.value) }
    lastSource.value = result.source || wmsSource.value; ElMessage.success(`已读取 ${result.spuTotal || result.counts?.spuTotal || 0} 个 API-SPU（${sourceLabel(lastSource.value)}）`); await loadCatalog()
  } catch (error) { loadError.value = error?.message || 'API-SPU 刷新失败，已保留上次有效数据'; ElMessage.error(loadError.value) } finally { syncing.value = false }
}

async function saveWmsSource() {
  // 地址先落库：MCP 白名单和 REST baseURL 都跟着它走，顺序反了就会用旧地址去校验。
  if (!isWeb) {
    const server = await window.erp.setServer(serverBaseUrl.value.trim()).catch((error) => ({ ok: false, reason: error?.message }))
    if (server?.ok === false) return ElMessage.error(server.reason || '服务器地址无效')
    if (server?.serverBaseUrl) serverBaseUrl.value = server.serverBaseUrl
  }
  const patch = { wmsSource: wmsSource.value, wmsMcpUrl: wmsMcpUrl.value.trim() }; if (wmsMcpKey.value.trim()) patch.wmsMcpKey = wmsMcpKey.value.trim()
  try { const next = await window.erp.setTaskSettings(patch); wmsSource.value = next.wmsSource || 'auto'; wmsMcpUrl.value = next.wmsMcpUrl || ''; wmsMcpKey.value = ''; wmsMcpKeyConfigured.value = Boolean(next.wmsMcpKeyConfigured); connectionConfigured.value = sourceHasCredentials(); ElMessage.success('API 连接配置已保存，主进程将持续同步'); connectionVisible.value = false; await refreshApi() } catch { ElMessage.error('API 连接配置保存失败') }
}

async function exportWms() { const result = await window.erp.exportWmsMapping(); if (result?.canceled) return; if (!result?.ok) return ElMessage.warning(result?.reason || '没有可导出的 API-SPU 数据'); ElMessage.success(`已导出 ${result.count || 0} 条 API-SPU 关联证据，其中 ${result.associated || 0} 条为 100% 精确关联`) }
onMounted(async () => {
  stopWmsSyncState = window.erp.onWmsSyncState((state) => {
    Object.assign(wmsState, state || {})
    if (state?.source) lastSource.value = state.source
    if (['synced', 'stale'].includes(state?.status)) void loadCatalog()
  })
  await loadCatalog()
})
onUnmounted(() => { stopWmsSyncState?.(); stopWmsSyncState = null })
</script>

<style scoped>
.writeback-note { color: #7b8a82; font-size: 12px; line-height: 1.7; }
.spu-page { --ink: #21312b; --line: #e1e9e4; --mint-deep: #3c7e5b; --paper: #fff; color: var(--ink); min-width: 980px; padding-bottom: 30px; }
.workbench-hero { padding: 24px 26px 18px; border: 1px solid #dce8df; border-radius: 18px; background: radial-gradient(circle at 88% 6%, rgba(183,228,199,.3), transparent 29%), linear-gradient(135deg, #fff 0%, #f1f8f3 100%); box-shadow: 0 12px 28px rgba(37, 71, 53, .055); }
.hero-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }.eyebrow, .section-label { color: var(--mint-deep); font-size: 10px; font-weight: 750; letter-spacing: 1.6px; } h1 { margin: 7px 0 5px; font-size: 30px; line-height: 1.1; letter-spacing: -.9px; font-weight: 750; } h2 { margin: 5px 0 0; font-size: 17px; line-height: 1.2; font-weight: 700; }
.hero-copy p { max-width: 610px; margin: 0; color: #6f7d76; font-size: 13px; line-height: 1.6; }.hero-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }.sync-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 22px; padding-top: 14px; border-top: 1px solid rgba(120, 158, 135, .18); color: #687970; font-size: 12px; }.sync-line strong { color: #355b45; font-weight: 700; }.sync-copy { color: #87968d; }.sync-source { color: #779181; }.sync-time { margin-left: auto; color: #8a9991; }.sync-time b { color: #5f7668; font-weight: 650; }.sync-dot { width: 8px; height: 8px; border-radius: 50%; background: #b6c1bb; box-shadow: 0 0 0 4px rgba(182,193,187,.16); }.sync-dot.ready { background: #56a573; box-shadow: 0 0 0 4px rgba(86,165,115,.14); }.sync-dot.waiting { background: #ce9a45; box-shadow: 0 0 0 4px rgba(206,154,69,.14); }
.metric-grid { display: grid; grid-template-columns: 1.3fr repeat(3, 1fr) 1.2fr; gap: 10px; margin-top: 14px; }.metric-card { min-width: 0; min-height: 110px; display: flex; flex-direction: column; justify-content: center; padding: 16px 17px; border: 1px solid #e1e9e4; border-radius: 13px; background: var(--paper); box-shadow: 0 4px 13px rgba(37, 71, 53, .03); }.metric-label { color: #7a8a81; font-size: 11px; font-weight: 600; letter-spacing: .3px; }.metric-card strong { margin-top: 8px; color: #263b30; font-size: 29px; line-height: 1; font-variant-numeric: tabular-nums; }.metric-card small { margin-top: 8px; overflow: hidden; color: #9aa69f; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.metric-primary { border-color: #cfe3d5; background: linear-gradient(145deg, #fff, #f3faf4); }.metric-primary strong { color: #2e6d4b; }.metric-pending strong { color: #4f7d90; }.metric-success strong { color: #3c7e5b; }.metric-warning { border-color: #ecdcbf; background: #fffdf8; }.metric-warning strong { color: #b87829; }.metric-time strong { margin-top: 10px; color: #4a6254; font-size: 18px; letter-spacing: -.2px; }
.panel-card { margin-top: 14px; padding: 19px; border: 1px solid var(--line); border-radius: 13px; background: var(--paper); box-shadow: 0 5px 16px rgba(37, 71, 53, .03); }.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }.panel-heading.compact { align-items: center; }.section-desc { margin: 6px 0 0; color: #93a099; font-size: 11px; line-height: 1.45; }.tools { display: flex; gap: 8px; align-items: center; }.load-alert { margin-bottom: 12px; }
.issue-card { border-color: #ecdcbf; background: #fffdf8; }.issue-card :deep(.el-empty) { padding: 14px 0 8px; }.table-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; color: #89978f; font-size: 12px; }
.spu-code, .task-spu { color: #2f6f8f; font-weight: 700; font-variant-numeric: tabular-nums; }.product-name { color: #31443a; font-size: 13px; font-weight: 650; line-height: 1.4; }.product-sub { margin-top: 3px; color: #9aa69f; font-size: 11px; }.api-price { color: #3c7e5b; font-weight: 700; }.cost-price { color: #3f5148; font-weight: 700; font-variant-numeric: tabular-nums; }.suggest-price { color: #9a7a43; font-size: 11px; }.market-price { color: #2f7e55; font-weight: 700; }.muted { color: #a8b2ac; }.association-percent { margin-top: 3px; color: #5e856c; font-size: 10px; }.reason { color: #a66d24; font-size: 11px; line-height: 1.4; }.drawer-intro { margin-bottom: 21px; padding: 11px 12px; border-radius: 8px; background: #f4faf5; color: #658071; font-size: 12px; line-height: 1.55; }.connection-form :deep(.el-form-item) { margin-bottom: 18px; }.connection-form :deep(.el-form-item__label) { padding-bottom: 5px; color: #5d7165; font-size: 12px; font-weight: 650; }.connection-form > .el-button { width: 100%; margin-top: 2px; }.connection-status { margin-top: 28px; padding-top: 18px; border-top: 1px solid #e8efe9; }.status-heading { margin-bottom: 10px; color: #62766a; font-size: 12px; font-weight: 700; }.status-tags { display: flex; gap: 8px; }.connection-status p { margin: 11px 0 0; color: #98a49e; font-size: 11px; line-height: 1.55; }
:deep(.el-button--primary) { --el-button-bg-color: #3c7e5b; --el-button-border-color: #3c7e5b; --el-button-hover-bg-color: #2f694a; --el-button-hover-border-color: #2f694a; } @media (max-width: 1240px) { .hero-topline { flex-direction: column; }.hero-actions { justify-content: flex-start; }.sync-time { margin-left: 0; }.metric-grid { grid-template-columns: repeat(4, 1fr); }.metric-time { grid-column: span 2; } } @media (max-width: 1180px) { .spu-page { min-width: 0; }.metric-grid { grid-template-columns: repeat(2, 1fr); }.metric-time { grid-column: auto; }.panel-heading { flex-direction: column; }.tools { width: 100%; }.tools .el-input { flex: 1; width: auto !important; } }
.policy-price-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.policy-price-row :deep(.el-input-number) { width: 100%; }.policy-preview { display: grid; grid-template-columns: 105px 1fr; gap: 6px 10px; margin: 14px 0; padding: 11px; border-radius: 8px; background: #f4faf5; color: #688074; font-size: 11px; line-height: 1.45; }.policy-preview b { color: #4f6e5c; }
</style>
