<template>
  <el-dialog v-model="visible" title="任务详情 / 快照日志" width="min(960px, 94vw)" top="4vh" destroy-on-close>
    <el-alert :title="`任务判定：${decisionLabel(row)}`" :type="decisionType(row)" :closable="false" show-icon>
      <template #default>{{ decisionReason(row) }}</template>
    </el-alert>

    <div class="summary">
      <div><span>商品</span><strong>{{ row.name || row.model || '—' }}</strong></div>
      <div v-if="row.price != null"><span>行情价</span><strong>¥{{ row.price }}</strong></div>
      <div v-if="row.priceComparison"><span>采购价对比</span><strong>{{ row.priceComparison.label }}</strong></div>
    </div>
    <details v-if="row.priceBreakdown" class="breakdown">
      <summary>查看价格构成</summary>
      <div class="breakdown-stats"><span>合并候选 {{ row.priceBreakdown.allCandidateCount ?? '—' }}</span><span>参与平均 {{ row.priceBreakdown.validCount ?? '—' }}</span><span>低价剔除 {{ row.priceBreakdown.rejectedBelow100Count ?? '—' }}</span></div>
      <div v-for="item in row.priceBreakdown.queryResults || []" :key="item.query" class="breakdown-query"><span>{{ item.query || '未记录关键词' }}</span><span>卡片 {{ item.cards ?? 0 }} · 有价 {{ item.priced ?? 0 }}</span></div>
    </details>

    <section v-if="$slots.actions" class="actions"><slot name="actions" /></section>

    <div class="tabs" role="tablist" aria-label="按搜索词选择快照">
      <button v-for="(entry, index) in entries" :key="entry.entryId || index" type="button" :class="{ active: index === indexActive }" @click="selectSnapshot(index)">
        {{ entry.query || '未记录关键词' }}<small>{{ statusLabel(entry.snapshotStatus) }}</small>
      </button>
    </div>
    <div class="meta">
      <span>{{ activeEntry.query || '未记录关键词' }}</span>
      <span>快照：{{ statusLabel(activeEntry.snapshotStatus) }}</span>
      <span v-if="activeEntry.error" class="error">{{ activeEntry.error }}</span>
    </div>
    <section class="log-card">
      <strong>{{ activeLog.query || activeEntry.query || '逐关键词' }} · 判定日志</strong>
      <div class="stats"><span>卡片 {{ metric(['cards', 'cardCount']) }}</span><span>通过 {{ metric(['accepted', 'acceptedCount', 'passed']) }}</span><span>黑名单 {{ metric(['blocked', 'blockedCount']) }}</span><span>低价剔除 {{ metric(['lowPrice', 'lowPriceCount']) }}</span></div>
      <div v-if="codes.length" class="codes"><el-tag v-for="code in codes" :key="code" size="small" effect="plain">{{ code }}</el-tag></div>
      <div v-if="logItems.length" class="log-items"><span class="muted">卡片判定（最多10条）</span><div v-for="(item, index) in logItems" :key="`${item.itemId || item.itemUrl || item.title || 'card'}-${index}`" class="log-item"><span>{{ item.title || item.itemId || '未命名卡片' }}</span><el-tag v-if="item.reasonCode || item.decision" size="small" effect="plain">{{ item.reasonCode || item.decision }}</el-tag></div></div>
      <p v-if="activeLog.error" class="error">{{ activeLog.error }}</p>
      <p v-else-if="!activeEntry.path" class="muted">没有原始网页快照；这里保留了该搜索词的判定和日志。</p>
    </section>
    <div v-loading="loading" class="snapshot-wrap">
      <iframe v-if="snapshotUrl" :src="snapshotUrl" class="frame" title="闲鱼网页 DOM 快照" sandbox="allow-same-origin" />
      <iframe v-else-if="snapshotHtml" :srcdoc="snapshotHtml" class="frame" title="快照诊断" sandbox="allow-same-origin" />
      <img v-else-if="snapshotSrc" :src="snapshotSrc" class="image" alt="闲鱼抓取页面快照" />
      <el-empty v-else description="没有可读取的快照；请查看上方判定日志。" :image-size="80" />
    </div>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ modelValue: Boolean, row: { type: Object, default: () => ({}) } })
const emit = defineEmits(['update:modelValue'])
const visible = computed({ get: () => props.modelValue, set: (value) => emit('update:modelValue', value) })
const entries = ref([])
const logs = ref([])
const indexActive = ref(0)
const loading = ref(false)
const snapshotUrl = ref('')
const snapshotHtml = ref('')
const snapshotSrc = ref('')
const activeEntry = computed(() => entries.value[indexActive.value] || {})
const activeLog = computed(() => logs.value[indexActive.value] || {})
const explicitId = (value = {}) => String(value.entryId || value.snapshotEntryId || value.id || '').trim()
const query = (value = {}) => String(value.query || '').trim()
const matches = (entry, candidate) => {
  const a = explicitId(entry); const b = explicitId(candidate)
  if (a && b) return a === b
  return Boolean(query(entry) && query(candidate) && query(entry) === query(candidate))
}
function normalize() {
  const row = props.row || {}
  const result = (Array.isArray(row.snapshotEntries) ? row.snapshotEntries : []).map((entry) => ({ ...entry, entryId: explicitId(entry) || (query(entry) ? `query:${query(entry)}` : ''), query: query(entry), path: entry.path || entry.snapshotPath || null, snapshotStatus: entry.snapshotStatus || (entry.path ? 'saved' : 'log_only') }))
  const allLogs = [...(Array.isArray(row.queryLogs) ? row.queryLogs : []), ...(Array.isArray(row.priceBreakdown?.queryResults) ? row.priceBreakdown.queryResults : [])]
  const savedPaths = [...(Array.isArray(row.snapshotPaths) ? row.snapshotPaths : []), row.snapshotPath].filter(Boolean)
  for (const path of [...new Set(savedPaths)]) if (!result.some((entry) => entry.path === path)) result.push({ entryId: `legacy:${path}`, query: '兼容快照（关键词未记录）', path, snapshotStatus: 'legacy_unlabeled' })
  for (const log of allLogs) if ((query(log) || explicitId(log)) && !result.some((entry) => matches(entry, log))) result.push({ ...log, entryId: explicitId(log) || (query(log) ? `query:${query(log)}` : ''), query: query(log), path: null, snapshotStatus: 'log_only', error: log.error || '仅保存了判定日志' })
  entries.value = result.length ? result : [{ query: '未记录关键词', path: null, snapshotStatus: 'unrecorded', error: '该次运行没有保存逐关键词快照' }]
  logs.value = entries.value.map((entry) => {
    const log = allLogs.find((candidate) => matches(entry, candidate)) || {}
    return { ...log, query: query(log) || entry.query, error: log.error || entry.error || '' }
  })
  indexActive.value = 0
}
function statusLabel(status) { return ({ saved: '已保存', captured: '已保存', ok: '已保存', log_only: '仅日志', legacy_unlabeled: '兼容快照', missing: '未保存', failed: '保存失败', unrecorded: '未记录' })[status] || (status || '未记录') }
function rowStatus(row = {}) { return row.status || row.lastStatus || row.queueKind || row.taskDecision?.status || '' }
function decisionLabel(row = {}) { const status = rowStatus(row); return row.taskDecision?.label || (status === 'success' ? '成功' : status === 'empty' ? '无在售' : status === 'invalid_price' || Number(row.price) < 100 ? '错误价格' : status === 'pending' ? '待采集' : status === 'risk_control' ? '风控暂停' : '失败') }
function decisionType(row = {}) { const status = rowStatus(row); return status === 'success' ? 'success' : ['empty', 'pending'].includes(status) ? 'info' : 'error' }
function decisionReason(row = {}) { return row.taskDecision?.reason || row.reason || row.lastReason || row.priceComparison?.reason || row.priceReason || (rowStatus(row) === 'success' ? '已完成行情抓取与采购价判定。' : '未记录任务判定原因。') }
function metric(keys) { for (const key of keys) if (activeLog.value[key] != null) return activeLog.value[key]; return 0 }
const codes = computed(() => { const value = activeLog.value.markReasonCodes || activeLog.value.reasonCodes || []; return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean) })
const logItems = computed(() => {
  const source = activeLog.value.cardSummaries || activeLog.value.cardsSummary || activeLog.value.items || activeEntry.value.cardSummaries || activeEntry.value.cardsSummary || []
  if (Array.isArray(source) && source.length) return source.slice(0, 10)
  const titles = Array.isArray(activeLog.value.titles) ? activeLog.value.titles : []
  return titles.slice(0, 10).map((title) => ({ title }))
})
function diagnosticHtml(entry, message) { return `<!doctype html><meta charset="utf-8"><style>body{font:15px -apple-system,sans-serif;padding:32px;background:#f7f9f8;color:#28352f}.card{max-width:760px;margin:auto;padding:24px;background:white;border:1px solid #dce8df;border-radius:12px}h1{margin-top:0}</style><main class="card"><h1>快照诊断 · ${entry.query || '未记录关键词'}</h1><p>${message}</p><p>任务判定：${decisionLabel(props.row)}</p><p>原因：${decisionReason(props.row)}</p></main>` }
async function loadEntry() {
  snapshotUrl.value = ''; snapshotHtml.value = ''; snapshotSrc.value = ''
  if (!activeEntry.value.path) { snapshotHtml.value = diagnosticHtml(activeEntry.value, activeEntry.value.error || activeLog.value.error || '没有保存原始网页快照，但判定日志仍可查看。'); return }
  loading.value = true
  try {
    const result = await window.erp.getTaskSnapshot(activeEntry.value.path)
    if (!result?.ok) { snapshotHtml.value = diagnosticHtml(activeEntry.value, result?.reason || '快照读取失败'); ElMessage.warning(result?.reason || '快照读取失败'); return }
    if (result.kind === 'html') snapshotUrl.value = result.url || ''
    else if (result.kind === 'html_text') snapshotHtml.value = result.html || ''
    else snapshotSrc.value = result.dataUrl || ''
  } finally { loading.value = false }
}
async function selectSnapshot(index) { indexActive.value = index; await loadEntry() }
watch(() => [props.modelValue, props.row], ([isOpen]) => { if (isOpen) { normalize(); void loadEntry() } }, { deep: true })
</script>

<style scoped>
.summary{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.summary>div{min-width:120px;padding:9px 11px;border:1px solid #e3ebe5;border-radius:9px;background:#fafcfb}.summary span{display:block;color:#829088;font-size:11px}.summary strong{display:block;margin-top:3px;color:#33443a;font-size:13px}.breakdown{margin:10px 0;padding:8px 11px;border:1px solid #e3ebe5;border-radius:9px;background:#fbfdfb;color:#53645b;font-size:12px}.breakdown summary{cursor:pointer;color:#467a59;font-weight:600}.breakdown-stats,.breakdown-query{display:flex;flex-wrap:wrap;justify-content:space-between;gap:7px;margin-top:7px}.breakdown-query{padding:5px 7px;border-radius:6px;background:#f1f7f3}.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;padding:10px;border-radius:9px;background:#f6faf7}.tabs{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}.tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:7px 10px;border:1px solid #dce8df;border-radius:8px;background:#fff;color:#526159;cursor:pointer;text-align:left}.tabs button.active,.tabs button:hover{border-color:#75b68a;background:#f2faf4;color:#2e744b}.tabs small{color:#8a9990}.meta,.stats,.codes{display:flex;flex-wrap:wrap;gap:7px 14px;margin:8px 0;color:#718078;font-size:12px}.log-card{padding:11px 13px;border:1px solid #e0e9e2;border-radius:9px;background:#fbfdfb}.log-items{display:grid;gap:5px;margin-top:9px}.log-item{display:flex;justify-content:space-between;gap:8px;padding:5px 7px;border-radius:6px;background:#f1f7f3;color:#53645b;font-size:12px}.log-item>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.error{color:#c45656}.muted{color:#89978f}.snapshot-wrap{min-height:300px;max-height:58vh;overflow:auto;margin-top:12px;padding:9px;border:1px solid #e0e9e2;border-radius:10px;background:#f7faf8}.frame{display:block;width:100%;min-height:460px;border:0;background:#fff}.image{display:block;max-width:100%;height:auto;margin:auto}
</style>
