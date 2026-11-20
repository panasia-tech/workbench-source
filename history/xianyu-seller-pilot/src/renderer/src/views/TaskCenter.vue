<template>
  <div class="task-center page">
    <section class="hero">
      <div class="hero-copy">
        <h1>行情采集</h1>
        <div class="hero-actions">
          <el-button size="large" plain :icon="Setting" @click="settingsDrawer = true">采集设置</el-button>
          <el-button size="large" plain :icon="Clock" @click="historyDrawer = true">运行与榜单</el-button>
          <template v-if="!running && resumeInfo.available">
            <el-button type="primary" size="large" :icon="VideoPlay" @click="startCrawl(true)">继续上次（{{ resumeInfo.pendingCount }} 条）</el-button>
            <el-button size="large" plain @click="startCrawl(false)">从头开始</el-button>
          </template>
          <el-button v-else type="primary" size="large" :icon="VideoPlay" :disabled="running" @click="startCrawl(false)">
            {{ running ? '正在采集…' : '立即开爬' }}
          </el-button>
          <el-button size="large" plain :icon="Upload" @click="importExcel">替换 Excel 清单</el-button>
        </div>
        <div class="hero-note">
          <span class="pulse" :class="{ on: running }"></span>
          {{ running ? `正在处理：${current || '准备中'}` : (resumeInfo.available ? `上次中断已完成 ${resumeInfo.completedCount} 条，待继续 ${resumeInfo.pendingCount} 条${resumeInfo.nextTask ? `；从「${resumeInfo.nextTask}」开始` : ''}` : nextScheduleLabel) }}
        </div>
        <div class="search-config-note" aria-label="Excel 搜索字段自动识别规则">
          <el-tag type="success" effect="plain" size="small">Excel 字段自动识别</el-tag>
          <el-button text size="small" :icon="Document" @click="showRules = true">查看搜索规则.md</el-button>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat primary-stat">
          <span>当前可执行任务</span>
          <strong>{{ summary.activeCount || 0 }}</strong>
          <small>{{ summary.categoryCount || 0 }} 个分类 · {{ summary.totalCount || 0 }} 行清单</small>
        </div>
        <div class="hero-stat">
          <span>最近一轮</span>
          <strong>{{ latestRunTotal }}</strong>
          <small>{{ latestRunText }}</small>
        </div>
      </div>
    </section>

    <section class="source-strip">
      <div class="source-main">
        <div class="file-icon">XLS</div>
        <div>
          <div class="source-kicker">当前任务清单</div>
          <div class="source-name">{{ summary.active?.sourceFile || '还没有导入 Excel' }}</div>
          <div class="source-meta" v-if="summary.active">
            工作表「{{ summary.active.sheetName }}」 · {{ summary.active.rowCount }} 条型号 · 导入于 {{ formatTime(summary.active.importedAt) }}
          </div>
          <div class="source-meta" v-else>支持 .xlsx / .xls / .xlsm</div>
        </div>
      </div>
      <div class="source-actions">
        <el-tag v-if="summary.active" type="success" effect="plain">{{ isWeb ? '服务器 Worker 运行' : '本机规则运行' }}</el-tag>
        <el-tag v-if="summary.active" type="info" effect="plain">按品类策略 + 行字段生成搜索</el-tag>
        <el-tag v-if="resumeInfo.available" type="warning" effect="plain">有中断任务可继续</el-tag>
          <el-button v-if="latestInvalidCount" text type="warning" :icon="Download" @click="exportInvalidExcel(summary.latestRun.id)">导出错误 Excel</el-button>
          <el-button text :icon="Document" @click="showSample = !showSample">{{ showSample ? '收起 sample' : '查看 sample' }}</el-button>
          <el-button text :icon="Document" @click="showRules = true">搜索规则.md</el-button>
        </div>
    </section>

    <el-dialog v-model="showRules" title="搜索规则.md" width="720px"><pre class="rules-markdown">{{ searchRulesMarkdown }}</pre></el-dialog>
    <el-dialog v-model="policyVisible" title="SPU 独立搜索策略" width="min(560px, 94vw)">
      <div v-if="policyTask" class="policy-dialog-note">SPU {{ policyTask.spuCode || policyTask.spu_code }} · 只保存本地策略，不修改 WMS 主数据。</div>
      <el-form v-if="policyTask" label-width="110px"><el-form-item label="搜索模式"><el-select v-model="policyForm.search.mode"><el-option label="继承品类策略" value="inherit_category" /><el-option label="SPU 独立搜索词" value="explicit" /></el-select></el-form-item><el-form-item label="搜索词"><el-input v-model="policyForm.searchText" type="textarea" :rows="3" placeholder="每行一条，最多 12 条" /></el-form-item><el-form-item label="屏蔽词模式"><el-select v-model="policyForm.blacklist.mode"><el-option label="继承通用" value="inherit" /><el-option label="通用 + SPU 追加" value="append" /><el-option label="仅 SPU" value="replace" /></el-select></el-form-item><el-form-item label="SPU 屏蔽词"><el-input v-model="policyForm.blacklistText" type="textarea" :rows="2" /></el-form-item><el-form-item label="最低挂牌价"><el-input-number v-model="policyForm.priceFence.minListingPrice" :min="0" :max="10000000" /></el-form-item><el-form-item label="中文展示名"><el-input v-model="policyForm.localization.displayName" /></el-form-item><el-checkbox v-model="policyForm.pageFilter.enabled">先用闲鱼自带的价格筛选（失败也不影响）</el-checkbox></el-form>
      <template #footer><el-button @click="policyVisible = false">取消</el-button><el-button type="primary" :loading="policySaving" @click="saveTaskPolicy">保存策略</el-button></template>
    </el-dialog>

    <section v-if="showSample" class="sample-card panel-card">
      <div class="panel-heading">
        <div>
          <h2>{{ sample.sourceFile }}</h2>
        </div>
        <div class="sample-heading-actions">
          <span class="sample-meta">{{ sample.sheetName }} · 共 {{ sample.rowCount }} 行 · 展示前 {{ sample.rows.length }} 行</span>
          <el-button type="primary" plain size="small" :icon="Download" @click="downloadTaskTemplate">下载卖家工作台模板</el-button>
        </div>
      </div>
      <div class="template-guide">
        <div class="template-guide-title"><el-tag type="success" effect="plain" size="small">标准格式</el-tag><b>请按这个模板整理后再导入</b></div>
      </div>
      <el-table :data="sample.rows" size="small" class="sample-table">
        <el-table-column prop="brand" label="品牌" width="120" />
        <el-table-column label="名称（兼容型号）" min-width="180"><template #default="{ row }">{{ row.model || row.name || row.modelName || '—' }}</template></el-table-column>
        <el-table-column label="商品别名" min-width="260">
          <template #default="{ row }">
            <div class="api-alias-cell"><span>{{ effectiveAlias(row) || '—' }}</span><small>{{ aliasSourceLabel(row) }}</small></div>
            <el-popover trigger="click" width="440" placement="bottom-start">
              <template #reference><el-button link type="primary" size="small">SPU 详情</el-button></template>
              <div class="spu-evidence"><b>库存系统里的货号</b><span>{{ apiSpu(row) || '—' }}</span><b>库存系统里的商品名</b><span>{{ apiProductName(row) || '—' }}</span><b>系统猜的别名</b><span>{{ apiSpuAlias(row) || '—' }}</span><b>为什么用这个别名</b><span>{{ apiAliasReason(row) || '—' }}</span></div>
            </el-popover>
          </template>
        </el-table-column>
        <el-table-column label="SPU编号" width="150"><template #default="{ row }">{{ taskSpu(row) || '—' }}</template></el-table-column>
        <el-table-column label="成本价" width="100"><template #default="{ row }"><el-tooltip v-if="row.referencePrice == null && row.referencePriceReason" placement="top" :content="row.referencePriceReason"><span class="muted">—</span></el-tooltip><span v-else>{{ row.referencePrice ?? row.purchasePrice ?? row.purchase_price ?? row.purchaseCost ?? '—' }}</span></template></el-table-column>
      </el-table>
    </section>

    <div class="page-body content-grid">
      <section class="panel-card task-panel">
        <div class="panel-heading task-heading">
          <div>
            <h2>要盯的型号</h2>
          </div>
          <div class="task-tools">
            <el-input v-model="taskQuery" clearable placeholder="搜品牌 / 型号" :prefix-icon="Search" />
            <el-radio-group v-model="taskView" size="small">
              <el-radio-button label="current">当前任务</el-radio-button>
              <el-radio-button label="history">历史任务</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <template v-if="taskView === 'current'">
          <div class="category-row">
            <button class="category-pill" :class="{ active: currentCategory === '' }" @click="currentCategory = ''">全部 <b>{{ summary.totalCount || 0 }}</b></button>
            <button v-for="item in categoryList" :key="item.name" class="category-pill" :class="{ active: currentCategory === item.name }" @click="currentCategory = item.name">
              {{ item.name }} <b>{{ item.count }}</b>
            </button>
          </div>
          <el-table :data="tasks" v-loading="loading" :height="tasks.length ? 390 : undefined" class="task-table">
            <el-table-column label="任务" min-width="230">
              <template #default="{ row }">
                <div class="task-name">{{ row.name }}</div>
                <div class="task-sub">字段 {{ searchFields(row).join('、') }} · {{ searchText(row) }} · 搜索 {{ searchCount(row) }} 次</div>
              </template>
            </el-table-column>
            <el-table-column label="商品别名" min-width="180">
              <template #default="{ row }"><div class="api-alias-cell"><span>{{ effectiveAlias(row) || '—' }}</span><small>{{ aliasSourceLabel(row) }}</small></div></template>
            </el-table-column>
            <el-table-column label="库存货号" width="150" show-overflow-tooltip>
              <template #default="{ row }"><span class="spu-code">{{ taskSpu(row) || '—' }}</span></template>
            </el-table-column>
            <el-table-column label="成本价" width="112"><template #default="{ row }"><span v-if="row.referencePrice != null">¥{{ row.referencePrice }}</span><el-tooltip v-else-if="row.referencePriceReason" placement="top" :content="row.referencePriceReason"><span class="muted">—</span></el-tooltip><span v-else class="muted">—</span></template></el-table-column>
            <el-table-column label="库存原始记录" width="128">
              <template #default="{ row }">
                <el-popover trigger="click" width="440" placement="bottom-start">
                  <template #reference><el-button link type="primary">查看</el-button></template>
                  <div class="spu-evidence"><b>库存系统里的货号</b><span>{{ apiSpu(row) || '—' }}</span><b>库存系统里的商品名</b><span>{{ apiProductName(row) || '—' }}</span><b>系统猜的别名</b><span>{{ apiSpuAlias(row) || '—' }}</span><b>为什么用这个别名</b><span>{{ apiAliasReason(row) || '—' }}</span></div>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column label="最近查到的价" width="132">
              <template #default="{ row }">
                <span v-if="row.lastStatus === 'invalid_price' || Number(row.lastPrice) < 100" class="invalid-price">错误 ¥{{ row.lastPrice }}</span>
                <span v-else-if="row.lastPrice != null" class="price">¥{{ row.lastPrice }}</span>
                <span v-else class="muted">未采集</span>
                <small v-if="row.lastPriceComparison" class="price-comparison-label">{{ row.lastPriceComparison.label }}</small>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="72" fixed="right">
              <template #default="{ row }"><el-switch v-model="row.enabled" @change="toggleTask(row)" /></template>
            </el-table-column>
            <el-table-column label="搜索设置" width="104" fixed="right"><template #default="{ row }"><el-button v-if="taskSpu(row)" link type="primary" @click="openTaskPolicy(row)">{{ row.spuSearchPolicy ? '已配置' : '配置' }}</el-button><span v-else class="muted">—</span></template></el-table-column>
          </el-table>
        </template>

        <template v-else>
          <el-table :data="archivedCollections" height="430" class="task-table">
            <el-table-column label="历史清单" min-width="220">
              <template #default="{ row }"><div class="task-name">{{ row.sourceFile }}</div><div class="task-sub">{{ row.sheetName }}</div></template>
            </el-table-column>
            <el-table-column prop="rowCount" label="任务数" width="90" />
            <el-table-column label="导入时间" width="170"><template #default="{ row }">{{ formatTime(row.importedAt) }}</template></el-table-column>
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" type="info">已归档</el-tag></template></el-table-column>
          </el-table>
          <el-empty v-if="!archivedCollections.length" description="还没有历史清单；下一次替换 Excel 后会自动保留旧版本" :image-size="72" />
        </template>
      </section>

    </div>

    <!-- 配一次就不动的三块：自动开爬、品类策略、黑名单。
         它们原来常驻在右侧栏里，和「要盯的型号」上下堆着——型号一多就得一路滚过
         它们才看得到表。设置不该为日常动作让路，收进抽屉。 -->
    <el-drawer v-model="settingsDrawer" title="采集设置" size="min(620px, 94vw)" :append-to-body="true">
      <div class="drawer-stack">
        <section class="panel-card schedule-card">
          <div class="panel-heading compact">
            <div><h2>自动开爬</h2></div>
          </div>
          <div class="schedule-main">
            <el-time-picker v-model="settings.dailyTime" format="HH:mm" value-format="HH:mm" @change="saveSettings" />
            <span>每天</span>
          </div>
          <div class="schedule-caption">这台电脑有行情采集权、又有启用的账号，就每天这个时间自动采；过了点才开机的，当天补采一轮。{{ nextScheduleLabel }}</div>
          <el-checkbox v-model="settings.launchAtLogin" @change="saveSettings">开机后自动驻留后台</el-checkbox>
          <el-checkbox v-model="settings.autoResumeExecutors" @change="saveSettings">开机后自动拉起执行端（工位机建议开）</el-checkbox>
        </section>
        <section class="panel-card strategy-card">
          <div class="panel-heading compact">
            <div><h2>品类搜索策略</h2></div>
            <div class="strategy-heading-meta">
              <el-tag size="small" effect="plain" type="success">按品类，不按品牌</el-tag>
              <small>{{ strategyModeSummary }}</small>
            </div>
          </div>
          <div class="strategy-plan" aria-label="实际查询计划">
            <div class="strategy-plan-heading"><b>实际查询计划</b><span>保存后立即刷新任务</span></div>
            <div class="strategy-plan-grid">
              <div><span>基础查询</span><b>按当前品类与模式</b></div>
              <div><span>人工别称</span><b>明确采纳后追加 1 条</b></div>
              <div><span>显式字段</span><b>最多保留 12 条</b></div>
            </div>
          </div>
          <div v-if="strategySaveError" class="strategy-save-error" role="status">保存失败：{{ strategySaveError }}</div>
          <div v-for="profile in categorySearchProfiles" :key="profile.category" class="strategy-row">
            <div class="strategy-copy">
              <b>{{ profile.category }}</b>
              <small>{{ categorySearchModeLabel(profile.mode) }} · {{ profile.compositionLabel }}</small>
              <span class="strategy-example">{{ strategyExample(profile) }}</span>
            </div>
            <div class="strategy-control">
              <el-select
                :model-value="profile.mode"
                size="small"
                style="width: 112px"
                :disabled="Boolean(strategySavingCategory)"
                :loading="strategySavingCategory === profile.category"
                @change="saveCategorySearchMode(profile.category, $event)"
              >
                <el-option v-for="option in searchModeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <small v-if="strategySavingCategory === profile.category" class="strategy-saving">保存中…</small>
            </div>
          </div>
        </section>
        <section class="panel-card filter-card">
          <div class="panel-heading compact">
            <div><h2>搜索词黑名单</h2></div>
            <el-tag size="small" effect="plain" type="info">{{ blacklistCount }} 个词</el-tag>
          </div>
          <el-input
            v-model="blacklistText"
            type="textarea"
            :rows="4"
            resize="none"
            placeholder="每行一个词，例如：芯片回收、维修、配件"
          />
          <div class="filter-foot">
            <span>命中的结果不参与比价</span>
            <el-button size="small" type="primary" plain @click="saveBlacklist">保存规则</el-button>
          </div>
        </section>
      </div>
    </el-drawer>

    <!-- 回看类：跑完之后才看的东西，不该占着进来就看见的位置。 -->
    <el-drawer v-model="historyDrawer" title="运行与榜单" size="min(620px, 94vw)" :append-to-body="true">
      <div class="drawer-stack">
        <section class="panel-card ranking-card">
          <div class="panel-heading compact">
            <div><h2>最近行情榜</h2></div>
            <el-button text :icon="Refresh" @click="loadAll">刷新</el-button>
          </div>
          <div v-if="rankings.length" class="ranking-list">
            <div v-for="row in rankings" :key="row.taskId" class="ranking-row">
              <span class="rank" :class="`rank-${row.rank}`">{{ String(row.rank).padStart(2, '0') }}</span>
              <div class="ranking-name"><b>{{ row.name }}</b><small>{{ row.category }} · {{ formatTime(row.at) }}</small></div>
              <strong>¥{{ row.price }}</strong>
            </div>
          </div>
          <el-empty v-else description="完成一轮采集后，这里会出现榜单" :image-size="62" />
        </section>
        <section class="panel-card run-card">
          <div class="panel-heading compact"><div><h2>运行历史</h2></div><span class="run-count">{{ runsTotal }} 轮</span></div>
          <div v-if="runs.length" class="run-list">
            <div v-for="run in runs.slice(0, 4)" :key="run.id" class="run-row">
              <span class="run-dot" :class="run.status"></span>
              <div><b>{{ run.status === 'stopped' ? '中断暂停' : (run.trigger === 'schedule' ? '自动采集' : '手动采集') }}</b><small>{{ formatTime(run.startedAt) }} · {{ run.collectionName }}{{ run.resumeOf ? ' · 断点继续' : '' }}</small></div>
              <span class="run-score">{{ run.success || 0 }}/{{ run.total || 0 }}</span>
            </div>
          </div>
          <el-empty v-else description="还没有运行记录" :image-size="62" />
        </section>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Document, Download, Refresh, Search, Upload, VideoPlay , Setting, Clock} from '@element-plus/icons-vue'
import {
  categorySearchModeExample,
  categorySearchModeLabel,
  categorySearchModeSummary,
  categorySearchProfileRows,
  SEARCH_MODE_OPTIONS
} from '../../../shared/category-search.js'
import searchRulesMarkdown from '../docs/search-rules.md?raw'

const loading = ref(false)
const isWeb = window.erp?.mode === 'web'
const running = ref(false)
const current = ref('')
const showSample = ref(true)
const showRules = ref(false)
// 设置与回看收进抽屉：前者配一次就不动，后者跑完才看，都不该占着进来就看见的位置
const settingsDrawer = ref(false)
const historyDrawer = ref(false)
const taskView = ref('current')
const currentCategory = ref('')
const taskQuery = ref('')
const summary = reactive({ active: null, activeCount: 0, totalCount: 0, categoryCount: 0, categories: {}, latestRun: null, resume: { available: false }, nextSchedule: null })
const sample = reactive({ sourceFile: '', sheetName: '', rowCount: 0, rows: [] })
const settings = reactive({ dailyEnabled: false, dailyTime: '02:00', launchAtLogin: true, autoResumeExecutors: true, blacklistKeywords: [], categorySearchModes: {} })
const blacklistText = ref('')
const tasks = ref([])
const collections = ref([])
const rankings = ref([])
const runs = ref([])
const runsTotal = ref(0)
const strategySavingCategory = ref('')
const strategySaveError = ref('')
const policyVisible = ref(false)
const policySaving = ref(false)
const policyTask = ref(null)
const policyForm = reactive({ search: { mode: 'inherit_category' }, searchText: '', blacklist: { mode: 'inherit' }, blacklistText: '', priceFence: { minListingPrice: null }, localization: { displayName: '' }, pageFilter: { enabled: false } })
let off = null
let loadGeneration = 0

const categoryList = computed(() => Object.entries(summary.categories || {}).map(([name, count]) => ({ name, count })))
const archivedCollections = computed(() => collections.value.filter((row) => row.status === 'archived'))
const resumeInfo = computed(() => summary.resume || { available: false, pendingCount: 0, completedCount: 0, nextTask: '' })
const latestRunTotal = computed(() => summary.latestRun?.total || '—')
const latestRunText = computed(() => {
  if (!summary.latestRun) return '还没有运行记录'
  const invalid = summary.latestRun.invalidPrice || summary.latestRun.invalid_price || 0
  const risk = summary.latestRun.riskControl || summary.latestRun.risk_control || 0
  return `${summary.latestRun.success || 0} 成功 · ${summary.latestRun.empty || 0} 无在售 · ${summary.latestRun.fail || 0} 失败${invalid ? ` · ${invalid} 条错误价格` : ''}${risk ? ` · ${risk} 次风控暂停` : ''}`
})
const latestInvalidCount = computed(() => summary.latestRun?.invalidPrice || summary.latestRun?.invalid_price || 0)
const blacklistCount = computed(() => blacklistText.value.split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean).length)
const nextScheduleLabel = computed(() => {
  if (!summary.nextSchedule) return ''
  return `下次：${formatTime(summary.nextSchedule)}`
})
const searchModeOptions = SEARCH_MODE_OPTIONS
const categorySearchProfiles = computed(() => categorySearchProfileRows(settings.categorySearchModes))
const strategyModeSummary = computed(() => categorySearchModeSummary(settings.categorySearchModes).text)

function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function searchKeywords(row) {
  const values = Array.isArray(row?.searchKeywords) ? row.searchKeywords.filter(Boolean) : []
  return values.length ? values : [row?.keyword || [row?.brand, row?.model].filter(Boolean).join(' ')]
}
function taskSpu(row) { return row?.spuCode || row?.spu_code || row?.spu || '' }
function splitPolicyText(value) { return String(value || '').split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean) }
async function openTaskPolicy(row) {
  policyTask.value = row
  const record = await window.erp.getSpuPolicy(taskSpu(row))
  const policy = record || row.spuSearchPolicy || {}
  policyForm.search.mode = policy.search?.mode || 'inherit_category'; policyForm.searchText = (policy.search?.queries || []).join('\n')
  policyForm.blacklist.mode = policy.blacklist?.mode || 'inherit'; policyForm.blacklistText = (policy.blacklist?.terms || []).join('\n')
  policyForm.priceFence.minListingPrice = policy.priceFence?.minListingPrice ?? null; policyForm.localization.displayName = policy.localization?.displayName || ''; policyForm.pageFilter.enabled = policy.pageFilter?.enabled === true
  policyVisible.value = true
}
async function saveTaskPolicy() {
  if (!policyTask.value) return
  policySaving.value = true
  try {
    const result = await window.erp.saveSpuPolicy(taskSpu(policyTask.value), { search: { mode: policyForm.search.mode, queries: splitPolicyText(policyForm.searchText) }, blacklist: { mode: policyForm.blacklist.mode, terms: splitPolicyText(policyForm.blacklistText) }, priceFence: policyForm.priceFence, pageFilter: policyForm.pageFilter, localization: { displayName: policyForm.localization.displayName } })
    if (!result?.ok) return ElMessage.warning(result?.reason || 'SPU 策略保存失败')
    ElMessage.success('SPU 独立策略已保存'); policyVisible.value = false; await loadAll()
  } catch (error) { ElMessage.warning(error?.message || 'SPU 策略保存失败') } finally { policySaving.value = false }
}
function apiSpu(row) { return row?.apiSpuCode || row?.wmsSpuCode || row?.wmsSpu || '' }
function apiProductName(row) { return row?.apiProductName || row?.apiSpuProductName || row?.wmsProductName || row?.wmsProduct || '' }
function apiSpuAlias(row) { return row?.apiSpuCleanedAlias || row?.apiSpuAlias || '' }
function effectiveAlias(row) { return row?.effectiveAlias || '' }
function aliasSourceLabel(row) { return row?.aliasSource === 'manual' ? '人工填写' : (row?.aliasSource === 'spu' ? 'SPU读取' : '') }
function apiAliasReason(row) { return row?.apiSpuAliasReason || '' }
function apiSpuAliasUsed(row) {
  if (typeof row?.apiSpuAliasUsed === 'boolean') return row.apiSpuAliasUsed
  return Boolean(row?.apiSpuAlias)
}
function apiSpuAliasStatus(row) { return apiSpuAliasUsed(row) ? '已用于搜索' : '未用于搜索（重复）' }
function apiSpuAliasTagType(row) { return apiSpuAliasUsed(row) ? 'success' : 'info' }
function searchCount(row) { return searchKeywords(row).length }
function searchText(row) { return searchKeywords(row).join(' · ') }
function searchFields(row) {
  const fields = Array.isArray(row?.searchFieldLabels) ? row.searchFieldLabels.filter(Boolean) : []
  return fields.length ? fields : ['兼容搜索词']
}
function strategyExample(profile) {
  return categorySearchModeExample(profile, profile?.mode) || '查询示例：按当前品类组合生成'
}

async function loadAll() {
  const generation = ++loadGeneration
  loading.value = true
  try {
    const [nextSummary, nextSample, nextSettings, taskPage, nextCollections, nextRankings, nextRuns] = await Promise.all([
      window.erp.getTaskSummary(),
      window.erp.getTaskSample(),
      window.erp.getTaskSettings(),
      window.erp.queryTasks({ page: 1, pageSize: 1000, category: currentCategory.value, q: taskQuery.value, includeDisabled: true }),
      window.erp.listTaskCollections(),
      window.erp.getTaskRankings({ limit: 6, order: 'asc' }),
      window.erp.queryTaskRuns({ page: 1, pageSize: 8 })
    ])
    // A refresh triggered by a newer search/event may finish before this
    // generation. Never let its late response overwrite current state.
    if (generation !== loadGeneration) return
    Object.assign(summary, nextSummary)
    Object.assign(sample, nextSample)
    Object.assign(settings, nextSettings)
    blacklistText.value = (nextSettings.blacklistKeywords || []).join('\n')
    tasks.value = taskPage.items
    collections.value = nextCollections
    rankings.value = nextRankings
    runs.value = nextRuns.items
    runsTotal.value = nextRuns.total
    running.value = (await window.erp.crawlStatus()).running
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function importExcel() {
  if (summary.active) {
    try {
      await ElMessageBox.confirm('替换后，旧 Excel 会自动归档并保留历史运行记录。继续选择文件吗？', '替换当前任务清单', { type: 'warning', confirmButtonText: '继续选择', cancelButtonText: '取消' })
    } catch {
      return
    }
  }
  const result = await window.erp.importTaskFile()
  if (result.canceled) return
  if (!result.ok) return ElMessage.error(result.reason || '导入失败')
  const ai = result.aiNormalization
  const aiText = ai?.configured
    ? (ai.ok ? `智谱已完成首轮型号清洗 ${ai.updated} 条` : `智谱暂未完成，已保留本地规则 ${ai.updated} 条`)
    : `本地规则已完成首轮型号清洗 ${ai?.updated || 0} 条`
  ElMessage.success(`已载入 ${result.rowCount} 条任务；旧清单已归档。${aiText}`)
  currentCategory.value = ''
  await loadAll()
}

async function downloadTaskTemplate() {
  const result = await window.erp.downloadTaskTemplate()
  if (!result || result.canceled) return
  if (!result.ok) return ElMessage.error(result.reason || '模板下载失败')
  ElMessage.success(`卖家工作台模板已保存${result.path ? `：${result.path}` : ''}`)
}

async function startCrawl(resume = false) {
  const result = await window.erp.startCrawl({ resume })
  if (!result.ok) ElMessage.warning(result.reason || '暂时无法开始')
  else ElMessage.success(result.resumedFrom ? `已继续上次中断，开始采集 ${result.total} 条未完成任务` : `已开始采集 ${result.total} 条任务`)
}

async function exportInvalidExcel(runId) {
  const result = await window.erp.exportInvalidPrices(runId)
  if (result.canceled) return
  if (!result.ok) return ElMessage.warning(result.reason || '没有可导出的错误价格')
  ElMessage.success(`已导出 ${result.count} 条错误型号 Excel`)
}

async function toggleTask(row) {
  await window.erp.setTaskEnabled(row.id, row.enabled)
  await loadAll()
}

watch([taskQuery, currentCategory], async () => {
  const generation = ++loadGeneration
  const result = await window.erp.queryTasks({ page: 1, pageSize: 1000, category: currentCategory.value, q: taskQuery.value, includeDisabled: true })
  if (generation !== loadGeneration) return
  tasks.value = result.items
})

async function saveSettings() {
  Object.assign(settings, await window.erp.setTaskSettings({ ...settings }))
  Object.assign(summary, await window.erp.getTaskSummary())
}

async function saveBlacklist() {
  const blacklistKeywords = [...new Set(blacklistText.value.split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean))]
  Object.assign(settings, await window.erp.setTaskSettings({ blacklistKeywords }))
  blacklistText.value = settings.blacklistKeywords.join('\n')
  ElMessage.success(`已保存 ${settings.blacklistKeywords.length} 个黑名单词`)
}

async function saveCategorySearchMode(category, mode) {
  if (!category || !mode || strategySavingCategory.value) return
  strategySavingCategory.value = category
  strategySaveError.value = ''
  try {
    const categorySearchModes = { ...(settings.categorySearchModes || {}), [category]: mode }
    const next = await window.erp.setTaskSettings({ categorySearchModes })
    Object.assign(settings, next)
    await loadAll()
    ElMessage.success(`${category} 已切换为${categorySearchModeLabel(mode)}`)
  } catch (error) {
    strategySaveError.value = error?.message || '请稍后重试'
    ElMessage.error(`${category} 策略保存失败，请重试`)
  } finally {
    strategySavingCategory.value = ''
  }
}

onMounted(async () => {
  await loadAll()
  off = window.erp.onCrawlEvent(async ({ type, payload }) => {
    if (type === 'start') { running.value = true; current.value = ''; await loadAll() }
    else if (type === 'progress') current.value = `${payload.accountName} · ${payload.current}`
    else if (type === 'done' || type === 'error') {
      running.value = false
      current.value = ''
      if (type === 'done' && payload?.invalidExcelPath) ElMessage.warning(`发现 ${payload.invalidExcelCount} 条低价错误，错误 Excel 已保存到下载文件夹`)
      await loadAll()
    }
    else if (type === 'daily-trigger') ElMessage.info('已按每日计划开始采集')
    else if (type === 'ai-normalization') {
      const message = payload?.ok
        ? `AI 首轮型号清洗完成：更新 ${payload.updated || 0} 条`
        : `AI 首轮型号清洗暂未完成：${(payload.errors || []).join('；') || '已保留本地规则，稍后自动补偿'}`
      payload?.ok ? ElMessage.success(message) : ElMessage.warning(message)
      await loadAll()
    }
    else if (type === 'risk-control') ElMessage.warning(`检测到闲鱼风控，已暂停本轮：${payload.reason || '请稍后再试'}`)
    else if (type === 'crawl-product-sync') {
      // 型号清单同步到 ERP 行情监控列表；失败不影响本轮采集，只提示
      if (payload?.ok) ElMessage.success(`型号清单已同步 ERP：送 ${payload.sent} 个，新增 ${payload.created}，更新 ${payload.updated}`)
      else ElMessage.warning(payload?.reason || '型号清单同步失败')
    }
    else if (type === 'counters' && !running.value) await loadAll()
  })
})
onUnmounted(() => off && off())
</script>

<style scoped>
.task-center { --ink: #21312b; --muted: #7c8983; --line: #e1e9e4; --mint: #b7e4c7; --mint-deep: #3c7e5b; --paper: #fbfdfb; color: var(--ink); min-width: 940px; }
.hero { display: grid; grid-template-columns: 1.5fr .9fr; gap: 24px; padding: 28px 30px; border: 1px solid #dce8df; border-radius: 16px; background: radial-gradient(circle at 84% 15%, rgba(183,228,199,.34), transparent 30%), linear-gradient(135deg, #fbfdfb 0%, #f1f8f3 100%); box-shadow: 0 14px 35px rgba(37, 71, 53, .06); }
.eyebrow { color: #8a9991; font-size: 11.5px; line-height: 1.6; margin-top: 3px; }
.section-label { color: var(--mint-deep); font-size: 10px; font-weight: 750; letter-spacing: 1.6px; }
h1 { margin: 8px 0 8px; font-size: 30px; line-height: 1.15; letter-spacing: -.8px; font-weight: 750; text-wrap: balance; }
h2 { margin: 5px 0 0; font-size: 17px; line-height: 1.2; font-weight: 700; }
.hero-copy p { max-width: 520px; margin: 0; color: #6f7d76; font-size: 14px; line-height: 1.7; }
.hero-actions { display: flex; gap: 10px; margin-top: 20px; }
.hero-note { display: flex; align-items: center; gap: 8px; margin-top: 16px; color: #6f7d76; font-size: 12px; }
.search-config-note { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; padding: 8px 10px; border: 1px solid #dcebe0; border-radius: 8px; background: rgba(255,255,255,.64); color: #557064; font-size: 12px; line-height: 1.45; }
.search-field-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }.search-field-tags :deep(.el-tag) { --el-tag-text-color: #4f7c61; --el-tag-border-color: #cfe5d5; --el-tag-bg-color: #f2faf4; font-size: 10px; }
.search-preview { overflow: hidden; color: #365b49; text-overflow: ellipsis; white-space: nowrap; }
.search-preview + small { color: #8a9890; }
.spu-code { color: #2f6f8f; font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }.api-alias-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }.api-alias-cell small { color: #5e856c; font-size: 10px; line-height: 1.2; }.api-alias-cell .api-alias-unused { color: #87948d; }
.spu-evidence { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 12px; color: #45564e; font-size: 12px; line-height: 1.5; }.spu-evidence b { color: #244133; }.spu-evidence span { overflow-wrap: anywhere; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: #a8b4ae; }.pulse.on { background: #4cae73; box-shadow: 0 0 0 4px rgba(76,174,115,.14); }
.hero-stats { display: grid; grid-template-columns: 1.15fr .85fr; gap: 10px; align-items: stretch; }
.hero-stat { display: flex; flex-direction: column; justify-content: center; padding: 18px; border-left: 1px solid rgba(120, 158, 135, .18); }.hero-stat span { color: #77867d; font-size: 12px; }.hero-stat strong { margin-top: 8px; color: #263b30; font-size: 38px; line-height: 1; font-variant-numeric: tabular-nums; }.hero-stat small { margin-top: 9px; color: #89978f; font-size: 11px; }.primary-stat { padding-left: 0; border-left: 0; }
.source-strip { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: 18px 0; padding: 15px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }.source-main, .source-actions { display: flex; align-items: center; gap: 12px; }.file-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; color: #276749; background: #e5f5e9; font-size: 10px; font-weight: 800; letter-spacing: .3px; }.source-kicker { color: var(--muted); font-size: 11px; }.source-name { margin-top: 3px; color: #293c32; font-size: 14px; font-weight: 650; }.source-meta { margin-top: 4px; color: #98a49e; font-size: 11px; }.source-actions { flex-shrink: 0; }
.panel-card { border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: 0 5px 16px rgba(37, 71, 53, .035); }.sample-card { padding: 18px; margin-bottom: 18px; }.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }.panel-heading.compact { align-items: center; margin-bottom: 12px; }.sample-heading-actions { display: flex; align-items: center; gap: 12px; }.sample-meta, .run-count { color: #98a49e; font-size: 11px; }.sample-table :deep(.el-table__header-wrapper th) { color: #7f8d85; background: #f5faf6; font-size: 11px; }.template-guide { margin: -2px 0 12px; padding: 11px 13px; border: 1px solid #d9eadf; border-radius: 9px; background: #f4fbf6; color: #557064; font-size: 11px; line-height: 1.55; }.template-guide-title { display: flex; align-items: center; gap: 8px; color: #365b49; }.api-output-example { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: -3px 0 12px; padding: 8px 10px; border-left: 3px solid #9ecbb0; background: #f8fbf8; color: #6d7f75; font-size: 10px; line-height: 1.45; }.api-output-example b { margin-right: 4px; color: #557064; }.api-output-example code { color: #426a53; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }.api-output-example small { color: #8a9890; }
.rules-markdown { max-height: 58vh; margin: 0; overflow: auto; white-space: pre-wrap; color: #53645a; font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
.side-stack { display: flex; flex-direction: column; gap: 18px; }.schedule-card, .strategy-card, .filter-card, .ranking-card, .run-card { padding: 18px; }.schedule-main { display: flex; align-items: center; gap: 9px; margin: 16px 0 8px; color: #75847b; font-size: 12px; }.schedule-main .el-date-editor { width: 122px; }.schedule-caption { min-height: 32px; color: #89978f; font-size: 11px; line-height: 1.5; }.schedule-card .el-checkbox { margin-top: 12px; }.schedule-card :deep(.el-checkbox__label) { color: #728078; font-size: 12px; }.strategy-heading-meta { display: flex; align-items: flex-end; flex-direction: column; gap: 3px; }.strategy-heading-meta small { color: #8b9a91; font-size: 10px; white-space: nowrap; }.strategy-plan { margin: -2px 0 8px; padding: 9px 10px; border: 1px solid #dcebe0; border-radius: 8px; background: #f5fbf6; color: #6c8174; font-size: 10px; line-height: 1.45; }.strategy-plan-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.strategy-plan-heading b { color: #3f644d; font-size: 11px; }.strategy-plan-heading span { color: #90a097; }.strategy-plan-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 8px 0 6px; }.strategy-plan-grid div { display: flex; flex-direction: column; gap: 2px; padding-right: 6px; border-right: 1px solid #e1eee4; }.strategy-plan-grid div:last-child { border-right: 0; }.strategy-plan-grid span { color: #93a199; }.strategy-plan-grid b { color: #557461; font-size: 10px; font-weight: 650; white-space: nowrap; }.strategy-plan > small { color: #83968a; }.strategy-save-error { margin: -1px 0 7px; padding: 6px 8px; border-radius: 6px; background: #fff4f1; color: #bd6a59; font-size: 10px; line-height: 1.45; }.strategy-row { display: flex; align-items: center; justify-content: space-between; gap: 9px; padding: 9px 0; border-top: 1px solid #edf2ee; }.strategy-copy { display: flex; flex-direction: column; min-width: 0; }.strategy-copy b { color: #53645a; font-size: 12px; font-weight: 650; }.strategy-copy small { margin-top: 3px; overflow: hidden; color: #98a49e; font-size: 10px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }.strategy-example { margin-top: 3px; overflow: hidden; color: #638671; font-size: 10px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }.strategy-control { display: flex; flex-shrink: 0; align-items: flex-end; flex-direction: column; gap: 3px; }.strategy-saving { color: #6b9b7b; font-size: 10px; line-height: 1; }.filter-card .el-textarea__inner { border-color: #dbe7de; background: #fff; color: #53645a; font-size: 12px; line-height: 1.65; }.filter-card .el-textarea__inner:focus { border-color: #8fcba0; box-shadow: 0 0 0 1px #8fcba0; }.filter-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-top: 10px; color: #98a49e; font-size: 10px; line-height: 1.5; }.ranking-list, .run-list { display: flex; flex-direction: column; }.ranking-row, .run-row { display: flex; align-items: center; min-width: 0; padding: 10px 0; border-top: 1px solid #edf2ee; }.rank { width: 28px; color: #a4b0a9; font-size: 11px; font-variant-numeric: tabular-nums; }.rank-1 { color: #c18b38; font-weight: 750; }.rank-2 { color: #7d9687; font-weight: 700; }.rank-3 { color: #a17158; font-weight: 700; }.ranking-name, .run-row > div { display: flex; flex-direction: column; flex: 1; min-width: 0; }.ranking-name b, .run-row b { overflow: hidden; color: #53645a; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }.ranking-name small, .run-row small { margin-top: 3px; overflow: hidden; color: #a1ada5; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.ranking-row > strong { margin-left: 8px; color: #347a53; font-size: 13px; font-variant-numeric: tabular-nums; }.run-dot { width: 7px; height: 7px; margin-right: 9px; border-radius: 50%; background: #aab5ae; }.run-dot.done { background: #62ad7d; }.run-dot.failed { background: #dc7777; }.run-dot.running { background: #d4a14b; }.run-score { margin-left: 8px; color: #688071; font-size: 11px; font-variant-numeric: tabular-nums; }
:deep(.el-button--primary) { --el-button-bg-color: #3c7e5b; --el-button-border-color: #3c7e5b; --el-button-hover-bg-color: #2f694a; --el-button-hover-border-color: #2f694a; }.task-center :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) { background: #edf8f0; border-color: #a4d8b3; color: #347a53; box-shadow: -1px 0 0 0 #a4d8b3; }.task-center :deep(.el-radio-button__inner) { color: #738178; border-color: #dbe6de; background: #fff; }
.price-comparison-label { display: block; margin-top: 3px; color: #718078; font-size: 10px; }
@media (max-width: 1100px) { .hero { grid-template-columns: 1fr; }.hero-stats { max-width: 540px; }.drawer-stack { display: flex; flex-direction: column; gap: 14px; }
.drawer-stack .panel-card { margin: 0; }
.content-grid { grid-template-columns: 1fr; }.side-stack { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }.task-center { min-width: 0; } }
.policy-dialog-note { margin-bottom: 16px; padding: 9px 11px; border-radius: 8px; background: #f4faf5; color: #5f7769; font-size: 12px; }
</style>
