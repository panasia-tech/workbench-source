<template>
  <el-card shadow="never" class="history-page">
    <template #header>
      <div class="header">
        <div><strong>运行历史</strong></div>
        <div class="header-actions"><el-input v-model="q" clearable placeholder="搜索商品或关键词" @keyup.enter="search" @clear="search"><template #prefix><el-icon><Search /></el-icon></template></el-input><el-button :icon="Refresh" circle title="刷新" @click="load" /><el-button plain @click="router.push('/prices')">返回当前任务</el-button></div>
      </div>
    </template>
    <el-alert class="sync-alert" :title="syncStatusLabel(syncState.status)" :description="syncStatusCopy(syncState)" :type="syncState.status === 'synced' ? 'success' : syncState.status === 'syncing' ? 'info' : 'warning'" :closable="false" show-icon />
    <div class="history-groups" aria-label="历史状态筛选"><button v-for="item in historyGroups" :key="item.key" type="button" :class="{ active: group === item.key }" @click="selectGroup(item.key)"><strong>{{ groupCounts[item.key] || 0 }}</strong><span>{{ item.label }}</span></button></div>
    <section v-loading="loading" class="history-list" aria-label="行情运行历史">
      <article v-for="row in list" :key="row.id || `${row.at}-${row.taskId}-${row.keyword}`" class="history-card">
        <div class="history-main">
          <div class="title">
            <strong>{{ row.name || row.model || '未命名任务' }}</strong>
            <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row) }}</el-tag>
          </div>
          <p>{{ fmtTime(row.at) }} · {{ searchText(row) || '未记录搜索词' }}</p>
          <div class="fact-strip">
            <span>API 销售价 <b>{{ money(row.apiSalePrice) }}</b></span>
            <span>API 建议价 <b>{{ money(row.apiSuggestPrice) }}</b></span>
            <span>成本价 <b>{{ money(row.referencePrice) }}</b></span>
            <span>行情观察价 <b>{{ money(row.price) }}</b></span>
          </div>
          <div class="comparison">
            <el-tag v-if="row.priceComparison" size="small" effect="plain" :type="comparisonType(row.priceComparison.key)">{{ row.priceComparison.label }}</el-tag>
            <span v-if="row.priceComparison?.ratioPercent != null">{{ row.priceComparison.ratioPercent }}% · {{ signed(row.priceComparison.markupPercent) }}</span>
            <span class="reason">{{ row.reason || row.priceComparison?.reason }}</span>
          </div>
          <div v-if="latestWritebackAudit(row)" class="writeback-audit" data-testid="history-writeback-audit" aria-label="API 回写审计">
            <span><b>回写审计</b>{{ writebackAuditLabel(latestWritebackAudit(row)) }}</span>
            <span v-if="latestWritebackAudit(row).skuCode">SKU {{ latestWritebackAudit(row).skuCode }}</span>
            <span v-if="latestWritebackAudit(row).verified">GET 已验证</span>
            <span v-if="latestWritebackAudit(row).reason" class="reason">{{ latestWritebackAudit(row).reason }}</span>
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
        <div class="history-side">
          <b v-if="row.price != null">¥{{ row.price }}</b>
          <span v-else>—</span>
          <el-button link type="primary" @click="openDetail(row)">查看详情</el-button>
          <el-button v-if="row.spuCode || row.spu_code" link type="primary" @click="openPolicy(row)">{{ row.spuSearchPolicy ? '编辑 SPU 策略' : '配置 SPU 策略' }}</el-button>
        </div>
      </article>
      <el-empty v-if="!loading && !list.length" description="没有符合条件的运行历史" :image-size="70" />
    </section>
    <div class="pager"><el-pagination background layout="total, prev, pager, next" :total="total" :page-size="pageSize" :current-page="page" @current-change="changePage" /></div>
  </el-card>
  <MarketSnapshotDialog v-model="detailVisible" :row="detailRow" />
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
import { reactive, ref, onMounted } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import MarketSnapshotDialog from '../components/MarketSnapshotDialog.vue'

const router = useRouter(); const loading = ref(false); const list = ref([]); const total = ref(0); const page = ref(1); const pageSize = ref(30); const q = ref(''); const group = ref('all'); const groupCounts = ref({}); const priceBand = ref(null); const detailVisible = ref(false); const detailRow = ref({}); const syncState = ref({ status: 'unconfigured', source: '', syncedAt: null, safeError: '' }); const policyVisible = ref(false); const policySaving = ref(false); const policyTask = ref(null); const policyPreview = ref({}); const policyForm = reactive({ search: { mode: 'inherit_category' }, searchText: '', blacklist: { mode: 'inherit' }, blacklistText: '', priceFence: { minListingPrice: null, maxListingPrice: null }, localization: { displayName: '' }, aliasText: '', pageFilter: { enabled: false } })
const historyGroups = [{ key: 'all', label: '全部' }, { key: 'failed', label: '失败' }, { key: 'pending', label: '待采集' }, { key: 'success', label: '成功' }, { key: 'review', label: '待复核' }]
const priceBandOptions = [{ key: 'purchase_100_119', label: '未满120%' }, { key: 'purchase_120_plus', label: '120%档' }, { key: 'purchase_150_plus', label: '150%档' }, { key: 'purchase_200_plus', label: '200%档' }]
function fmtTime(value) { if (!value) return '—'; const d = new Date(value); const pad = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
function searchText(row = {}) { const terms = Array.isArray(row.searchKeywords) ? row.searchKeywords.filter(Boolean) : []; return (terms.length ? terms : [row.keyword || [row.brand, row.model].filter(Boolean).join(' ')]).filter(Boolean).join(' · ') }
function statusLabel(row = {}) { return row.status === 'success' ? '成功' : row.status === 'empty' ? '无在售' : row.status === 'invalid_price' || Number(row.price) < 100 ? '错误价格' : row.status === 'pending' ? '待采集' : row.status === 'risk_control' ? '风控暂停' : '失败' }
function statusType(status) { return status === 'success' ? 'success' : ['empty', 'pending'].includes(status) ? 'info' : status === 'invalid_price' ? 'warning' : 'danger' }
function comparisonType(key) { return ['below_minimum', 'below_purchase_price', 'invalid_purchase_price', 'invalid_market_price'].includes(key) ? 'danger' : key === 'purchase_200_plus' ? 'success' : key === 'purchase_150_plus' ? 'primary' : key === 'purchase_120_plus' ? 'warning' : 'info' }
function signed(value) { return value == null ? '' : `${value >= 0 ? '+' : ''}${value}%` }
function money(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : `¥${Number(value).toFixed(2)}` }
function policyQueries(row = {}) { const values = row.effectiveSearchPolicy?.queries || row.searchKeywords || []; return values.length ? values.join(' · ') : '继承品类策略' }
function policyTerms(row = {}) { const values = row.effectiveBlacklist?.terms || []; return values.length ? values.join(' · ') : '无' }
function policyMinPrice(row = {}) { const value = row.effectivePriceFence?.minListingPrice; return value == null ? '未设置' : `≥ ¥${Number(value).toFixed(0)}` }
function policyDisplayName(row = {}) { return row.localizedDisplayName || row.name || row.model || '未设置' }
function policyPageFilter(row = {}) { return row.effectivePageFilter?.enabled ? '已开启意图' : '未开启' }
function latestWritebackAudit(row = {}) { return Array.isArray(row.writebackAudit) && row.writebackAudit.length ? row.writebackAudit.at(-1) : null }
function writebackAuditLabel(audit = {}) {
  if (audit.verified === true || audit.result === 'verified' || audit.status === 'success' || audit.status === 'applied') return '已验证'
  if (audit.result === 'failed' || audit.status === 'failed') return '失败'
  if (audit.status === 'blocked') return '已阻断'
  return audit.result || audit.status || '已记录'
}
function syncStatusLabel(status) { return ({ unconfigured: 'API 尚未配置', syncing: 'API 正在同步', synced: 'API 已同步', stale: 'API 数据已过期', failed: 'API 同步失败' }[status]) || 'API 状态未知' }
function syncStatusCopy(state = {}) { if (state.status === 'synced') return `${state.source || 'API'} · 最近同步 ${state.syncedAt ? new Date(state.syncedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}`; return state.safeError || '历史页只读取主进程快照，等待后台同步或人工处理连接配置' }
// Legacy queryTaskResults/tasks:results is intentionally bypassed; this view reads the bounded market-history projection.
async function load() { loading.value = true; try { const res = await window.erp.queryMarketHistory({ q: q.value.trim(), group: group.value, priceBand: priceBand.value, page: page.value, pageSize: pageSize.value }); list.value = res.items || []; total.value = res.total || 0; groupCounts.value = res.groupCounts || {}; syncState.value = res.sync || syncState.value } finally { loading.value = false } }
function search() { page.value = 1; void load() }; function selectGroup(value) { group.value = value; page.value = 1; void load() }; function changePage(value) { page.value = value; void load() }; function openDetail(row) { detailRow.value = row; detailVisible.value = true }
function splitPolicyText(value) { return String(value || '').split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean) }
async function openPolicy(row) {
  const spuCode = row?.spuCode || row?.spu_code
  if (!spuCode) return
  policyTask.value = row
  const record = await window.erp.getSpuPolicy(spuCode)
  const policy = record || row.spuSearchPolicy || {}
  policyForm.search.mode = policy.search?.mode || 'inherit_category'; policyForm.searchText = (policy.search?.queries || []).join('\n')
  policyForm.blacklist.mode = policy.blacklist?.mode || 'inherit'; policyForm.blacklistText = (policy.blacklist?.terms || []).join('\n')
  policyForm.priceFence.minListingPrice = policy.priceFence?.minListingPrice ?? null; policyForm.priceFence.maxListingPrice = policy.priceFence?.maxListingPrice ?? null
  policyForm.localization.displayName = policy.localization?.displayName || ''; policyForm.aliasText = (policy.localization?.searchAliases || []).join('\n'); policyForm.pageFilter.enabled = policy.pageFilter?.enabled === true
  policyPreview.value = await window.erp.previewSpuPolicy(spuCode) || {}; policyVisible.value = true
}
async function savePolicy() {
  const spuCode = policyTask.value?.spuCode || policyTask.value?.spu_code
  if (!spuCode) return
  policySaving.value = true
  try {
    const result = await window.erp.saveSpuPolicy(spuCode, { search: { mode: policyForm.search.mode, queries: splitPolicyText(policyForm.searchText) }, blacklist: { mode: policyForm.blacklist.mode, terms: splitPolicyText(policyForm.blacklistText) }, priceFence: policyForm.priceFence, pageFilter: policyForm.pageFilter, localization: { displayName: policyForm.localization.displayName, searchAliases: splitPolicyText(policyForm.aliasText) } })
    if (!result?.ok) return
    policyPreview.value = await window.erp.previewSpuPolicy(spuCode) || {}; policyVisible.value = false; await load()
  } finally { policySaving.value = false }
}
onMounted(() => { void load() })
</script>

<style scoped>
.header,.header-actions,.title,.comparison,.writeback-audit{display:flex;align-items:center}.header{justify-content:space-between;gap:16px}.header strong{font-size:18px;color:#273a30}.header p{margin:4px 0 0;color:#84928a;font-size:12px}.header-actions{gap:8px}.header-actions .el-input{width:220px}.sync-alert{margin-bottom:12px}.history-groups{display:flex;gap:8px;overflow:auto;padding:4px 0 12px}.history-groups button{min-width:82px;padding:9px 11px;border:1px solid #e0e9e2;border-radius:10px;background:#fff;color:#718078;cursor:pointer;text-align:left}.history-groups button.active{border-color:#64a97b;background:#f1f9f3;color:#2c7048;box-shadow:0 0 0 2px rgba(100,169,123,.12)}.history-groups strong,.history-groups span{display:block}.history-groups strong{font-size:18px;line-height:1.1}.history-groups span{margin-top:3px;font-size:11px}.history-list{display:grid;gap:9px}.history-card{display:flex;justify-content:space-between;gap:14px;padding:13px 14px;border:1px solid #e1eae3;border-radius:12px;background:#fff}.history-main{min-width:0}.title{gap:8px}.title strong{overflow:hidden;color:#35463c;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.history-main p{overflow:hidden;margin:5px 0;color:#93a099;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.fact-strip{display:flex;flex-wrap:wrap;gap:5px 12px;margin:5px 0;color:#7b8b82;font-size:11px}.fact-strip b{color:#486b59;font-weight:650}.comparison{flex-wrap:wrap;gap:5px 8px;color:#597065;font-size:12px}.writeback-audit{flex-wrap:wrap;gap:5px 9px;margin-top:7px;padding:6px 8px;border:1px solid #dce8df;border-radius:7px;background:#f7fbf8;color:#65766d;font-size:11px}.writeback-audit b{color:#3c6e50}.reason{color:#839188}.history-side{display:flex;flex:0 0 auto;flex-direction:column;align-items:flex-end;gap:7px}.history-side b{color:#e76f3c;font-size:17px}.history-side span{color:#9ba7a0}.spu-policy-strip{display:flex;flex-wrap:wrap;gap:5px 10px;margin-top:8px;padding:7px 9px;border:1px solid #e4ebe6;border-radius:8px;background:#fafcfb;color:#718078;font-size:11px;line-height:1.4}.spu-policy-strip.configured{border-color:#cce5d2;background:#f5fbf6}.spu-policy-strip span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.spu-policy-strip b{margin-right:3px;color:#52675a;font-weight:600}.spu-policy-title{color:#2f7250;font-weight:700}.policy-drawer-intro{display:flex;flex-direction:column;gap:4px;margin-bottom:16px;color:#687970;font-size:13px}.policy-drawer-intro span{color:#3d7652;font-size:12px}.policy-form{padding-bottom:12px}.policy-price-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.policy-effective-preview{display:grid;gap:5px;margin:16px 0;padding:10px 12px;border:1px solid #dfeae2;border-radius:9px;background:#f7fbf8;color:#66786d;font-size:12px}.policy-effective-preview b{color:#3c6e50}.policy-effective-preview span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pager{margin-top:14px;display:flex;justify-content:flex-end}@media(max-width:720px){.header{align-items:flex-start;flex-direction:column}.header-actions{width:100%}.header-actions .el-input{flex:1;width:auto}.history-card{padding:12px}.history-side{min-width:92px}.spu-policy-strip{display:grid;grid-template-columns:1fr}.policy-price-row{grid-template-columns:1fr}}
</style>
