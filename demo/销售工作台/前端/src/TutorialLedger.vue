<template>
  <div class="page tl">
    <header class="head">
      <div>
        <p class="eyebrow">原生教程与视频台账 · 同版 Wiki / H5 / PDF 联动</p>
        <h1>教程与视频台账<Q k="tutorials" /></h1>
        <p class="sub">
          按业务节点追踪通用视频与时间码、Codex 已核 Skill、主管人工兜底说明、岗位可见权限及覆盖缺口。
          外部客服节点保留独立视图并物理隔离内部采购价与选品规则。
        </p>
      </div>
      <div class="sum">
        <span class="tag acc">总节点 {{ summary.total }}</span>
        <span class="tag grn">已可用 {{ summary.usable }}</span>
        <span class="tag amb">待更新/复核 {{ summary.gaps }}</span>
        <span class="tag">Skill 已核 {{ summary.skillVerified }}</span>
        <span class="tag">已配兜底 {{ summary.withFallback }}</span>
        <span class="tag">客服独立 {{ summary.csCount }}</span>
        <button class="btn sm" @click="coverageModal = true">导出 tutorial_coverage</button>
        <button class="btn sm" @click="loadLedger(true)"><Icon name="refresh" />刷新</button>
      </div>
    </header>

    <section class="toolbar card">
      <div class="role-badge">
        <span class="tag" :class="role === 'supervisor' ? 'grn' : role === 'outsource_cs' ? 'amb' : 'acc'">
          {{ roleLabel }}
        </span>
        <span class="muted sm">适用版本：<code>{{ meta.version }}</code></span>
        <a v-if="meta.indexUrl" :href="meta.indexUrl" target="_blank" rel="noopener" class="btn sm">Wiki 节点索引 ↗</a>
        <a v-if="meta.employeePdfUrl" :href="meta.employeePdfUrl" target="_blank" rel="noopener" class="btn sm">员工小动物 PDF ↗</a>
      </div>

      <div class="tb-right">
        <div class="tabs2" role="group" aria-label="台账视角">
          <button
            v-for="t in visibleViewTabs"
            :key="t.k"
            :class="{ on: viewScope === t.k }"
            @click="switchView(t.k)"
          >
            {{ t.label }}
          </button>
        </div>
        <label class="search">
          <Icon name="search" />
          <input v-model="kw" placeholder="搜节点 / CAD / 三角洲 / Skill / 客服 / 时间码" />
        </label>
      </div>
    </section>

    <div v-if="errorMsg" class="errbar" style="border-radius: 12px; margin-bottom: 14px">
      <span>{{ errorMsg }}</span>
      <button class="btn sm" @click="loadLedger(true)">重试</button>
    </div>

    <div class="cols">
      <aside class="tree card">
        <button class="all" :class="{ on: !selectedGroup && !onlyGap && !onlyTemplate }" @click="clearTree">
          全部可见节点 <em>{{ allVisibleNodes.length }}</em>
        </button>
        <button class="all" :class="{ on: onlyTemplate }" @click="filterTemplates">
          两个验证模板（CAD / 三角洲） <em>2</em>
        </button>
        <button class="all" :class="{ on: onlyGap }" @click="filterGaps">
          仅看缺口与待复核 <em>{{ allVisibleNodes.filter((x) => x.coverage_status !== '可用').length }}</em>
        </button>
        <div class="tree-sep" />
        <p class="tree-cap">按业务路径浏览</p>
        <button
          v-for="g in groupStats"
          :key="g.name"
          class="lf"
          :class="{ on: selectedGroup === g.name }"
          @click="pickGroup(g.name)"
        >
          <span>{{ g.name }}</span>
          <em>{{ g.usable }}/{{ g.total }}</em>
        </button>
      </aside>

      <section class="list-col">
        <div class="card tbl-wrap">
          <table class="tbl2">
            <thead>
              <tr>
                <th>节点 ID / 业务模块</th>
                <th>适用岗位与负责人</th>
                <th>通用视频与时间码</th>
                <th>Wiki / H5 / PDF</th>
                <th>日常 Codex · Skill</th>
                <th>人工兜底入口</th>
                <th>核验状态与操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="n in shownNodes"
                :key="n.node_id"
                :class="{
                  selrow: activeNode?.node_id === n.node_id,
                  gaprow: n.coverage_status !== '可用',
                }"
                @click="openDetail(n)"
              >
                <td class="col-node">
                  <div class="node-badges">
                    <code>{{ n.node_id }}</code>
                    <span class="tag sm" :class="scopeCls(n.scope)">{{ scopeText(n.scope) }}</span>
                    <span class="tag sm">{{ n.applicable_version }}</span>
                  </div>
                  <b>{{ n.title }}</b>
                  <small class="muted">{{ n.parent_group }} · 入口 {{ n.route_entry }}</small>
                </td>
                <td class="col-role">
                  <div>{{ n.roles.join(' / ') }}</div>
                  <small class="muted">负责：{{ n.owner }}</small>
                </td>
                <td class="col-vid" @click.stop>
                  <div class="vid-row">
                    <span class="tc-pill">{{ n.timecode }}</span>
                    <a
                      v-if="n.video_wiki_url"
                      :href="n.video_wiki_url"
                      target="_blank"
                      rel="noopener"
                      class="link"
                    >
                      播放章节 ↗
                    </a>
                    <span v-else class="tag amb sm">待录</span>
                  </div>
                  <small class="muted">{{ n.video_title }}</small>
                </td>
                <td class="col-links" @click.stop>
                  <div class="mini-links">
                    <a v-if="n.wiki_url" :href="n.wiki_url" target="_blank" rel="noopener" class="chip-link">Wiki ↗</a>
                    <a v-if="n.h5_url" :href="n.h5_url" target="_blank" rel="noopener" class="chip-link">H5 ↗</a>
                    <a v-if="n.pdf_url" :href="n.pdf_url" target="_blank" rel="noopener" class="chip-link">PDF ↗</a>
                    <span v-else class="tag sm">PDF 见 Wiki 索引</span>
                  </div>
                </td>
                <td>
                  <span class="tag sm" :class="n.skill_status === 'Skill 已核' ? 'grn' : 'amb'">
                    {{ n.skill_status }}
                  </span>
                  <div class="skill-code">{{ n.skill_name }}</div>
                </td>
                <td>
                  <span
                    class="tag sm"
                    :class="n.fallback_status === '已配兜底' ? 'acc' : n.fallback_status === '待主管按需补录' ? 'amb' : 'grn'"
                  >
                    {{ n.fallback_status }}
                  </span>
                  <small class="muted clamp2">{{ n.manual_trigger }}</small>
                </td>
                <td class="col-act" @click.stop>
                  <span class="tag sm" :class="statusCls(n.coverage_status)">{{ n.coverage_status }}</span>
                  <small class="muted">{{ n.last_verified_at }}</small>
                  <div class="act-btns">
                    <button class="btn sm pri" @click="openDetail(n)">详情</button>
                    <button class="btn sm" @click="jumpRoute(n.route_entry)">去页面</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!shownNodes.length" class="empty">
            当前筛选下没有匹配的节点。
            <button class="btn sm" @click="clearTree">查看全部可见节点</button>
          </p>
        </div>

        <section class="card hist-card">
          <h3>最近修订与缺口修复记录（只追加留痕，不覆盖历史）</h3>
          <div v-for="h in historyList" :key="h.seq" class="hist-row">
            <code>{{ h.nodeId }}</code>
            <span class="tag sm">{{ h.actor }}</span>
            <span>{{ h.summary }}</span>
            <small class="muted">{{ h.createdAt }}</small>
          </div>
        </section>
      </section>
    </div>

    <!-- 右侧详情与主管核验维护抽屉 -->
    <div v-if="activeNode" class="mask" @click.self="activeNode = null">
      <aside class="drawer">
        <div class="top">
          <div>
            <code>{{ activeNode.node_id }}</code>
            <span class="tag sm" :class="scopeCls(activeNode.scope)" style="margin-left: 8px">{{ scopeText(activeNode.scope) }}</span>
            <h2>{{ activeNode.title }}</h2>
          </div>
          <button class="x" @click="activeNode = null"><Icon name="close" /></button>
        </div>

        <div class="quick-three">
          <a v-if="activeNode.wiki_url" :href="activeNode.wiki_url" target="_blank" rel="noopener" class="btn sm pri">怎么做（Wiki）↗</a>
          <a v-if="activeNode.h5_url" :href="activeNode.h5_url" target="_blank" rel="noopener" class="btn sm">双视角 H5 ↗</a>
          <a v-if="activeNode.pdf_url" :href="activeNode.pdf_url" target="_blank" rel="noopener" class="btn sm">员工小动物 PDF ↗</a>
          <a v-if="activeNode.video_wiki_url" :href="activeNode.video_wiki_url" target="_blank" rel="noopener" class="btn sm">
            通用讲解（{{ activeNode.timecode }}）↗
          </a>
          <a v-if="activeNode.manual_fallback_doc" :href="activeNode.manual_fallback_doc" target="_blank" rel="noopener" class="btn sm">
            人工兜底说明 ↗
          </a>
          <a v-if="activeNode.manual_fallback_video" :href="activeNode.manual_fallback_video" target="_blank" rel="noopener" class="btn sm">
            专项兜底视频 ↗
          </a>
          <button class="btn sm" @click="jumpRoute(activeNode.route_entry)">进实操页（{{ activeNode.route_entry }}）</button>
        </div>

        <dl class="kv" style="margin-top: 14px">
          <dt>业务依据</dt><dd>{{ activeNode.business_basis }}</dd>
          <dt>适用岗位</dt><dd>{{ activeNode.roles.join('、') }}</dd>
          <dt>负责主管</dt><dd>{{ activeNode.owner }} · 版本 <code>{{ activeNode.applicable_version }}</code></dd>
          <dt>视频来源状态</dt><dd>{{ activeNode.video_source_status }}</dd>
          <dt>最后核验</dt><dd>{{ activeNode.last_verified_by }}（{{ activeNode.last_verified_at }}）</dd>
        </dl>

        <section class="dsec">
          <h4>日常执行：Codex + Skill 协作</h4>
          <div class="box">
            <p><b>工作台入口：</b>{{ activeNode.codex_entry }}</p>
            <p>
              <b>关联 Skill：</b><code>{{ activeNode.skill_name }}</code>
              <span class="tag sm" :class="activeNode.skill_status === 'Skill 已核' ? 'grn' : 'amb'" style="margin-left: 6px">
                {{ activeNode.skill_status }}
              </span>
            </p>
            <p><b>向 Codex 交代：</b>{{ activeNode.codex_prompt_hint }}</p>
            <p><b>预期完成证据：</b>{{ activeNode.expected_evidence }}</p>
            <button class="btn sm" @click="copyText(activeNode.codex_prompt_hint)">复制 Codex 交办词</button>
          </div>
        </section>

        <section class="dsec">
          <h4>异常停止条件与人工兜底</h4>
          <div class="box warnbox">
            <p><b>触发人工接管条件：</b>{{ activeNode.manual_trigger }}</p>
            <p><b>兜底状态：</b>{{ activeNode.fallback_status }}</p>
            <p v-if="activeNode.gap_reason"><b>当前缺口原因：</b>{{ activeNode.gap_reason }}</p>
          </div>
        </section>

        <section class="dsec">
          <h4>主管核验与状态更新</h4>
          <div v-if="!canEdit" class="lockbox">
            <Icon name="lock" />
            <span>当前身份「{{ roleLabel }}」仅可消费查看教程与复制 Codex 交办，不可修改台账核验状态（服务端 POST /update 校验 403）。</span>
          </div>
          <div v-else class="edit-form">
            <div class="fg2">
              <label>通用覆盖状态
                <select v-model="editForm.coverage_status">
                  <option>可用</option>
                  <option>待复核</option>
                  <option>待更新</option>
                  <option>缺通用讲解</option>
                  <option>待盘点</option>
                </select>
              </label>
              <label>Skill 状态
                <select v-model="editForm.skill_status">
                  <option>Skill 已核</option>
                  <option>待核</option>
                  <option>人工处理</option>
                </select>
              </label>
              <label>人工兜底状态
                <select v-model="editForm.fallback_status">
                  <option>Skill 已覆盖无需兜底</option>
                  <option>已配兜底</option>
                  <option>待主管按需补录</option>
                </select>
              </label>
              <label>章节时间码（MM:SS）
                <input v-model="editForm.timecode" placeholder="例如 55:10" />
              </label>
            </div>
            <label>缺口说明 / 更新备注
              <textarea v-model="editForm.gap_reason" rows="2" />
            </label>
            <label>本次核验留痕说明（写入只追加历史表）
              <input v-model="editForm.note" placeholder="例如：主管实跑 CAD 样图正常与缺尺寸分支通过" />
            </label>
            <div style="display: flex; gap: 8px; align-items: center">
              <button class="btn pri sm" :disabled="saving" @click="saveUpdate">
                {{ saving ? '保存中...' : '保存主管核验记录' }}
              </button>
              <span v-if="saveErr" class="muted" style="color: var(--red-ink)">{{ saveErr }}</span>
            </div>
          </div>
        </section>

        <section class="dsec">
          <h4>本节点历史修订留痕（{{ nodeHistory.length }}）</h4>
          <p v-if="!nodeHistory.length" class="muted sm">暂无单节点追加变更记录。</p>
          <div v-for="h in nodeHistory" :key="h.seq" class="hist-row">
            <span class="tag sm">{{ h.actor }}</span>
            <span>{{ h.summary }}</span>
            <small class="muted">{{ h.createdAt }}</small>
          </div>
        </section>
      </aside>
    </div>

    <!-- MCP tutorial_coverage 结构预览弹窗 -->
    <div v-if="coverageModal" class="mask" @click.self="coverageModal = false">
      <div class="modal-cov card">
        <div class="top">
          <h3>MCP demo_materials.tutorial_coverage 实时导出</h3>
          <button class="btn sm" @click="coverageModal = false">关闭</button>
        </div>
        <p class="muted sm">按本次可见节点生成，同一视频可对应不同时间码，可直接对照发单门禁检查。</p>
        <pre class="cov-pre">{{ JSON.stringify(coverageJson, null, 2) }}</pre>
        <div style="display: flex; gap: 8px; justify-content: flex-end">
          <button class="btn sm pri" @click="copyText(JSON.stringify(coverageJson, null, 2))">复制 JSON</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import Q from './Q.vue'
import Icon from './Icon.vue'
import { toast } from './ui.js'

const actorName = () => localStorage.getItem('erp_user') || 'chenxm'

const nodes = ref([])
const historyList = ref([])
const summary = reactive({ total: 0, usable: 0, gaps: 0, skillVerified: 0, withFallback: 0, csCount: 0 })
const meta = reactive({ version: 'V6-20261124-merged-cs', indexUrl: '', employeePdfUrl: '' })
const role = ref('sales')
const roleLabel = ref('读取中')
const canEdit = ref(false)
const allowedViews = ref(['all', 'sales', 'cs', 'gaps'])
const viewScope = ref('all')
const selectedGroup = ref('')
const onlyGap = ref(false)
const onlyTemplate = ref(false)
const kw = ref('')
const errorMsg = ref('')

const activeNode = ref(null)
const nodeHistory = ref([])
const saving = ref(false)
const saveErr = ref('')
const coverageModal = ref(false)

const editForm = reactive({
  coverage_status: '可用',
  skill_status: 'Skill 已核',
  fallback_status: '已配兜底',
  timecode: '00:00',
  gap_reason: '',
  note: '',
})

const VIEW_LABELS = {
  all: '全工作台总览',
  sales: '销售业务节点',
  cs: '外部客服独立视图',
  gaps: '缺口与待复核',
}

const visibleViewTabs = computed(() =>
  allowedViews.value.map((k) => ({ k, label: VIEW_LABELS[k] || k })),
)

const allVisibleNodes = computed(() => nodes.value)

const groupStats = computed(() => {
  const map = new Map()
  for (const n of nodes.value) {
    if (!map.has(n.parent_group)) map.set(n.parent_group, { name: n.parent_group, total: 0, usable: 0 })
    const g = map.get(n.parent_group)
    g.total += 1
    if (n.coverage_status === '可用') g.usable += 1
  }
  return [...map.values()]
})

const shownNodes = computed(() => {
  const word = kw.value.trim().toLowerCase()
  return nodes.value.filter((n) => {
    if (selectedGroup.value && n.parent_group !== selectedGroup.value) return false
    if (onlyGap.value && n.coverage_status === '可用') return false
    if (onlyTemplate.value && !['SALES-VIRT-CAD-09', 'SALES-SVC-DELTA-11'].includes(n.node_id)) return false
    if (!word) return true
    return [n.node_id, n.title, n.parent_group, n.skill_name, n.timecode, n.owner, ...n.roles]
      .join(' ')
      .toLowerCase()
      .includes(word)
  })
})

const coverageJson = computed(() => ({
  index_url: meta.indexUrl || '#/tutorials',
  required_nodes: nodes.value.map((n) => n.node_id),
  entries: nodes.value.map((n) => ({
    node_id: n.node_id,
    video_url: n.video_wiki_url,
    timecode: n.timecode,
  })),
}))

const scopeText = (s) => (s === 'shared' ? '全司共用' : s === 'cs' ? '外部客服独立' : '销售主链')
const scopeCls = (s) => (s === 'shared' ? 'acc' : s === 'cs' ? 'amb' : '')
const statusCls = (s) => (s === '可用' ? 'grn' : s === '缺通用讲解' ? 'red' : 'amb')

async function loadLedger(quiet = false) {
  errorMsg.value = ''
  try {
    const r = await fetch(
      `/api/tutorials/ledger?actor=${encodeURIComponent(actorName())}&scope=${encodeURIComponent(viewScope.value)}`,
    )
    const d = await r.json()
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`)
    nodes.value = d.nodes || []
    historyList.value = d.history || []
    Object.assign(summary, d.summary || {})
    meta.version = d.version || meta.version
    meta.indexUrl = d.indexUrl || ''
    meta.employeePdfUrl = d.employeePdfUrl || ''
    role.value = d.role || 'sales'
    roleLabel.value = d.roleLabel || ''
    canEdit.value = Boolean(d.canEdit)
    allowedViews.value = d.allowedViews || ['all', 'sales', 'cs', 'gaps']
    if (!allowedViews.value.includes(viewScope.value)) {
      viewScope.value = allowedViews.value[0] || 'cs'
    }
    if (!quiet) toast('台账已更新')
  } catch (e) {
    errorMsg.value = String(e.message || e)
  }
}

async function switchView(scope) {
  viewScope.value = scope
  await loadLedger(true)
}

function clearTree() {
  selectedGroup.value = ''
  onlyGap.value = false
  onlyTemplate.value = false
}

function filterTemplates() {
  selectedGroup.value = ''
  onlyGap.value = false
  onlyTemplate.value = !onlyTemplate.value
}

function filterGaps() {
  selectedGroup.value = ''
  onlyTemplate.value = false
  onlyGap.value = !onlyGap.value
}

function pickGroup(name) {
  onlyGap.value = false
  onlyTemplate.value = false
  selectedGroup.value = selectedGroup.value === name ? '' : name
}

async function openDetail(n) {
  activeNode.value = n
  saveErr.value = ''
  editForm.coverage_status = n.coverage_status
  editForm.skill_status = n.skill_status
  editForm.fallback_status = n.fallback_status
  editForm.timecode = n.timecode
  editForm.gap_reason = n.gap_reason
  editForm.note = ''
  try {
    const r = await fetch(`/api/tutorials/node/${encodeURIComponent(n.node_id)}?actor=${encodeURIComponent(actorName())}`)
    const d = await r.json()
    if (r.ok && d.ok) {
      activeNode.value = d.node
      nodeHistory.value = d.history || []
    }
  } catch {
    nodeHistory.value = []
  }
}

async function saveUpdate() {
  if (!activeNode.value) return
  saving.value = true
  saveErr.value = ''
  try {
    const r = await fetch(
      `/api/tutorials/node/${encodeURIComponent(activeNode.value.node_id)}/update?actor=${encodeURIComponent(actorName())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coverage_status: editForm.coverage_status,
          skill_status: editForm.skill_status,
          fallback_status: editForm.fallback_status,
          timecode: editForm.timecode,
          gap_reason: editForm.gap_reason,
          note: editForm.note,
        }),
      },
    )
    const d = await r.json()
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`)
    activeNode.value = d.node
    nodeHistory.value = d.history || []
    toast('主管核验记录已保存并追加审计留痕')
    await loadLedger(true)
  } catch (e) {
    saveErr.value = String(e.message || e)
  } finally {
    saving.value = false
  }
}

function jumpRoute(route) {
  if (!route) return
  location.hash = route.split(' ')[0]
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制到剪贴板')
  } catch {
    toast('请手动选中复制')
  }
}

async function syncFromHash() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '')
  const wantView = qs.get('view') === 'cs' ? 'cs' : null
  if (wantView && wantView !== viewScope.value) {
    viewScope.value = wantView
    await loadLedger(true)
  } else if (!nodes.value.length) {
    await loadLedger(true)
  }
  const targetId = qs.get('node')
  if (targetId) {
    const hit = nodes.value.find((x) => x.node_id === targetId)
    if (hit) await openDetail(hit)
  }
}

onMounted(async () => {
  await syncFromHash()
  window.addEventListener('hashchange', syncFromHash)
})

onUnmounted(() => {
  window.removeEventListener('hashchange', syncFromHash)
})
</script>

<style scoped>
.tl { padding: 18px 22px 72px; max-width: 1620px; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.eyebrow { color: var(--acc); font-weight: 700; font-size: 13px; margin: 0; }
.tl h1 { font-size: 30px; margin: 4px 0; letter-spacing: -.02em; }
.sub { color: var(--mute); max-width: 780px; font-size: 13px; line-height: 1.5; margin: 0; }
.sum { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.toolbar { margin: 14px 0; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.role-badge, .tb-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tabs2 { display: inline-flex; gap: 4px; background: var(--soft); padding: 4px; border-radius: 12px; }
.tabs2 button { height: 30px; padding: 0 11px; border-radius: 8px; font-weight: 700; font-size: 12.5px; color: var(--ink2); }
.tabs2 button.on { background: var(--panel); color: var(--ink); box-shadow: var(--sh); }
.search { display: flex; align-items: center; gap: 7px; background: var(--soft); border-radius: 10px; padding: 0 10px; height: 34px; min-width: 240px; border: 1px solid var(--line); }
.search svg { width: 15px; height: 15px; color: var(--mute); }
.search input { border: 0; outline: none; background: transparent; width: 100%; font-size: 13px; }

.cols { display: grid; grid-template-columns: 224px minmax(0, 1fr); gap: 14px; align-items: start; }
.tree { padding: 10px; position: sticky; top: 12px; display: grid; gap: 3px; }
.tree-sep { height: 1px; background: var(--line); margin: 5px 0; }
.tree-cap { font-size: 11.5px; font-weight: 700; color: var(--mute); padding: 2px 8px; }
.all, .lf { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 7px 9px; border-radius: 9px; text-align: left; font-size: 12px; font-weight: 600; color: var(--ink2); line-height: 1.35; }
.all:hover, .lf:hover { background: var(--soft); }
.all.on, .lf.on { background: var(--acc-soft); color: var(--acc); font-weight: 700; }
.all em, .lf em { font-style: normal; font-size: 11.5px; color: var(--mute); flex: none; }

.list-col { display: grid; gap: 14px; min-width: 0; }
.tbl-wrap { padding: 0; overflow-x: auto; }
.tbl2 { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 0; }
.tbl2 th { text-align: left; padding: 9px 7px; color: var(--mute); font-size: 11.5px; border-bottom: 1px solid var(--line); background: var(--soft); white-space: nowrap; }
.tbl2 td { padding: 9px 7px; border-top: 1px solid var(--line); vertical-align: top; }
.tbl2 tbody tr { cursor: pointer; }
.tbl2 tbody tr:hover td { background: var(--soft); }
.tbl2 tbody tr.selrow td { background: var(--acc-soft); }
.tbl2 tbody tr.gaprow td:first-child { border-left: 4px solid var(--amb); }

.col-node { max-width: 215px; display: grid; gap: 3px; word-break: break-word; }
.col-role { max-width: 115px; line-height: 1.4; }
.col-vid { max-width: 135px; }
.col-links { max-width: 96px; }
.node-badges { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.tag.sm { height: 20px; padding: 0 6px; font-size: 10.5px; }
.vid-row { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin-bottom: 3px; }
.tc-pill { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; font-weight: 700; padding: 2px 6px; border-radius: 5px; background: var(--acc-soft); color: var(--acc); }
.link, .chip-link { color: var(--acc); font-weight: 700; font-size: 11.5px; }
.mini-links { display: flex; gap: 4px; flex-wrap: wrap; }
.chip-link { padding: 1px 6px; border-radius: 5px; background: var(--soft); border: 1px solid var(--line); }
.skill-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--mute); margin-top: 3px; word-break: break-all; max-width: 120px; }
.clamp2 { display: block; margin-top: 3px; max-width: 145px; line-height: 1.35; }
.col-act { width: 110px; }
.act-btns { display: flex; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
.act-btns .btn.sm { height: 26px; min-height: 26px; padding: 0 8px; font-size: 11.5px; }
.empty { padding: 28px; text-align: center; color: var(--mute); display: grid; gap: 10px; justify-items: center; }

.hist-card h3 { margin: 0 0 10px; font-size: 16px; }
.hist-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
.hist-row small { margin-left: auto; }

.mask { position: fixed; inset: 0; background: rgba(8, 12, 22, .5); z-index: 80; display: flex; justify-content: flex-end; }
.drawer { width: min(620px, 100%); height: 100%; background: var(--panel); overflow-y: auto; padding: 24px 28px 44px; box-shadow: var(--sh-up); }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.top h2 { font-size: 21px; margin: 6px 0 0; }
.x { width: 34px; height: 34px; border-radius: 50%; background: var(--soft); display: grid; place-items: center; flex: none; }
.x svg { width: 16px; height: 16px; }
.quick-three { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; padding: 12px; border-radius: 14px; background: var(--soft); }
.dsec { margin-top: 18px; }
.dsec h4 { margin: 0 0 8px; font-size: 14.5px; }
.box { background: var(--soft); border-radius: 14px; padding: 12px 14px; display: grid; gap: 6px; font-size: 13.5px; line-height: 1.55; }
.warnbox { border-left: 4px solid var(--amb); }
.lockbox { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 12px; background: var(--amb-soft); color: var(--amb-ink); font-size: 13px; }
.lockbox svg { width: 18px; height: 18px; flex: none; }
.edit-form { background: var(--soft); padding: 14px; border-radius: 14px; display: grid; gap: 10px; font-size: 13px; }
.fg2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.edit-form label { display: grid; gap: 4px; font-weight: 600; color: var(--ink2); }
.edit-form input, .edit-form select, .edit-form textarea { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; background: var(--panel); color: var(--ink); font: inherit; }

.modal-cov { margin: auto; width: min(760px, 92vw); max-height: 85vh; display: grid; gap: 12px; }
.cov-pre { max-height: 55vh; overflow: auto; background: var(--soft); padding: 14px; border-radius: 12px; font-size: 12px; line-height: 1.5; margin: 0; }
</style>
