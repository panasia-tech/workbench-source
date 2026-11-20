<script setup>
// 其他台账（第四步，审计报告另外 12 个模块）：对公户、U 盾、印章、数电票、代账月结、商户号、外币卡、上游预存款、
// 同行、远控单、代开店客户、背调、服务器、房产……都按后端给的字段表（/ledger/records/catalog）画表单。
// 上面是雷达：所有要人去办的事，红的在前。密码、PIN、完整卡号不记，只记放在哪、谁知道。
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const cat = ref({ groups: [], kinds: {}, secrets: {}, know_targets: {} })
const refs = ref({ entities: [], legal_persons: [], shops: [], parents: {} })
const staff = ref([])
const statuses = ref({})
const radar = ref([])
const counts = ref({})
const group = ref('bank')
const kind = ref('bank_account')
const rows = ref([])
const q = ref('')
const loading = ref(false)
const showAllRadar = ref(false)

const STATUS_TYPE = { active: 'success', paused: 'warning', closed: 'info' }
const spec = computed(() => cat.value.kinds[kind.value] || { fields: [] })
const groupKinds = computed(() => (cat.value.groups.find((g) => g.key === group.value)?.kinds || []).filter((k) => cat.value.kinds[k]))
const listFields = computed(() => spec.value.fields.filter((f) => f.list).slice(0, 5))
const radarShown = computed(() => (showAllRadar.value ? radar.value : radar.value.slice(0, 8)))
const dangerCount = computed(() => radar.value.filter((x) => x.level === 'danger').length)
const groupAlerts = (g) => radar.value.filter((x) => x.group === g).length
const money = (v) => (v == null || v === '' ? '—' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)

function cell(row, f) {
  const v = row.view[f.key]
  if (v == null || v === '') return '—'
  return f.type === 'money' ? money(v) : v
}

async function loadRadar() {
  try {
    const { data } = await api.get('/ledger/records/radar')
    radar.value = data.items
    counts.value = data.counts
  } catch (err) {
    ElMessage.error(errText(err, '雷达加载失败'))
  }
}

async function loadRows() {
  loading.value = true
  try {
    const params = { kind: kind.value }
    if (q.value.trim()) params.q = q.value.trim()
    rows.value = (await api.get('/ledger/records', { params })).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function loadRefs() {
  try {
    refs.value = (await api.get('/ledger/records/refs')).data
  } catch {
    /* 下拉缺了不挡看清单 */
  }
}

function pickGroup(g) {
  group.value = g
  if (g === 'staff') {
    kind.value = 'rebind_check'
    loadStaffSide()
  } else {
    kind.value = groupKinds.value[0]
  }
  q.value = ''
  loadRows()
}

function pickKind(k) {
  kind.value = k
  q.value = ''
  loadRows()
}

async function refresh() {
  await Promise.all([loadRows(), loadRadar()])
  if (group.value === 'staff') loadStaffSide()
}

// 雷达上点一条：跳到那种台账，打开那一条
async function goto(x) {
  if (!x.record_id) {
    if (x.kind === 'knows' || x.kind === 'employee_sim') pickGroup('staff')
    return
  }
  group.value = x.group
  kind.value = x.kind
  q.value = ''
  if (x.group === 'staff') loadStaffSide()
  await loadRows()
  const row = rows.value.find((r) => r.id === x.record_id)
  if (row) (spec.value.checklist ? openChecklist(row) : startEdit(row))
}

// ---- 加 / 改 ----
const editOpen = ref(false)
const edit = ref({ id: null, data: {} })
const COLUMN_TYPES = ['entity', 'lp', 'parent']

function startAdd() {
  const data = { name: kind.value === 'close_month' ? '桐新' : '', status: 'active', note: '' }
  for (const f of spec.value.fields) data[f.key] = f.default ?? (f.type === 'bool' ? false : f.type === 'int' ? null : '')
  if (kind.value === 'supplier') data.warn_below = '150'
  if (kind.value === 'fx_card') data.currency = 'CNY'
  if (kind.value === 'peer') data.state = 'found'
  if (kind.value === 'property') data.state = 'idle'
  if (kind.value === 'client_project') data.stage = 'docs'
  edit.value = { id: null, data }
  editOpen.value = true
}

function startEdit(row) {
  const data = { name: row.name, status: row.status, note: row.note || '' }
  for (const f of spec.value.fields) {
    const v = COLUMN_TYPES.includes(f.type) ? row[f.key] : row.attrs[f.key]
    data[f.key] = v ?? (f.type === 'bool' ? false : f.type === 'int' ? null : '')
  }
  edit.value = { id: row.id, data }
  editOpen.value = true
}

// 商户号只能结算进同一主体的户：上一条按主体筛
function parentOptions(f) {
  const all = refs.value.parents[f.of] || []
  const ent = edit.value.data.entity_id
  return ent ? all.filter((p) => p.entity_id === ent) : all
}

const saving = ref(false)
async function saveEdit() {
  const body = { ...edit.value.data }
  for (const f of spec.value.fields) {
    if (f.type === 'readonly') delete body[f.key]
    else if (body[f.key] === '' && !['text', 'textarea', 'phone'].includes(f.type)) body[f.key] = null
  }
  saving.value = true
  try {
    if (edit.value.id) await api.patch(`/ledger/records/item/${edit.value.id}`, body)
    else await api.post(`/ledger/records/${kind.value}`, body)
    editOpen.value = false
    ElMessage.success('已保存')
    await refresh()
    if (spec.value.fields.some((f) => f.type === 'parent') || kind.value === 'bank_account') loadRefs()
  } catch (err) {
    ElMessage.error(errText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删掉「${row.name}」？连同它的流水一起删，找不回来。`, '删除', {
      type: 'warning', confirmButtonText: '删', cancelButtonText: '不删',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/ledger/records/item/${row.id}`)
    ElMessage.success('已删除')
    await refresh()
  } catch (err) {
    ElMessage.error(errText(err, '删除失败'))
  }
}

// ---- 流水（借出归还、充值、带看……）----
const evOpen = ref(false)
const ev = ref({ row: null, items: [], kind: '', data: {} })
// 印章借出去了只能归还、没借出只能借出；红字票批过了不再批
const evKinds = (row) => Object.entries(spec.value.events || {})
  .filter(([, s]) => !s.only || Object.entries(s.only).every(([k, v]) => row.attrs[k] === v))
  .filter(([k]) => !(row.kind === 'seal' && (k === 'lend' ? row.lent : k === 'return' ? !row.lent : false)))
  .filter(([k]) => !(k === 'approve' && row.attrs.approved_by))

function evForm(k) {
  const s = spec.value.events[k]
  ev.value.kind = k
  ev.value.data = Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? (f.type === 'bool' ? false : '')]))
}

async function openEvents(row, k = null) {
  ev.value = { row, items: [], kind: '', data: {} }
  const ks = evKinds(row).map(([key]) => key)
  // 印章借出去了默认就是「归还」
  evForm(k || (row.kind === 'seal' && row.lent ? 'return' : ks[0]))
  evOpen.value = true
  try {
    ev.value.items = (await api.get(`/ledger/records/item/${row.id}/events`)).data.items
  } catch (err) {
    ElMessage.error(errText(err, '流水加载失败'))
  }
}

async function saveEvent() {
  const body = { ...ev.value.data }
  for (const k of Object.keys(body)) if (body[k] === '') body[k] = null
  try {
    await api.post(`/ledger/records/item/${ev.value.row.id}/events/${ev.value.kind}`, body)
    ElMessage.success('记好了')
    evOpen.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(errText(err, '没记上'))
  }
}

// ---- 清单（代账月结、换号核验单）----
const ckOpen = ref(false)
const ck = ref(null)
function openChecklist(row) {
  ck.value = row
  ckOpen.value = true
}
async function tick(item, done) {
  try {
    await api.post(`/ledger/records/item/${ck.value.id}/tick`, { item: item.key, done })
    await refresh()
    ck.value = rows.value.find((r) => r.id === ck.value.id) || ck.value
  } catch (err) {
    ElMessage.error(errText(err, '没勾上'))
  }
}
const ckLeft = (row) => (row.checklist || []).filter((i) => !i.done).length

async function checkCert(row) {
  try {
    const { data } = await api.post(`/ledger/records/item/${row.id}/check-cert`)
    ElMessage.success(`证书 ${data.cert_expires_on} 到期`)
    await refresh()
  } catch (err) {
    ElMessage.error(errText(err, '没查到'))
  }
}

// ---- 员工与离职：谁知道哪些密码、员工实名卡 ----
const knows = ref([])
const empSims = ref([])
async function loadStaffSide() {
  try {
    const [k, s] = await Promise.all([api.get('/ledger/knows'), api.get('/ledger/employee-sims')])
    knows.value = k.data.items
    empSims.value = s.data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  }
}

const knowOpen = ref(false)
const knowForm = ref({ target: '', what: 'lock', staff_ids: [] })
const targetOpts = ref([])
async function searchTargets(text) {
  try {
    targetOpts.value = (await api.get('/ledger/knows/targets', { params: { q: text || '' } })).data.items
  } catch {
    targetOpts.value = []
  }
}
function startKnow() {
  knowForm.value = { target: '', what: 'lock', staff_ids: [] }
  searchTargets('')
  knowOpen.value = true
}
async function saveKnow() {
  const t = targetOpts.value.find((x) => `${x.type}:${x.id}` === knowForm.value.target)
  if (!t) {
    ElMessage.warning('选是哪个东西')
    return
  }
  try {
    const { data } = await api.post('/ledger/knows', { target_type: t.type, target_id: t.id, what: knowForm.value.what,
      staff_ids: knowForm.value.staff_ids })
    knowOpen.value = false
    ElMessage.success(data.added ? `记了 ${data.added} 人` : '都记过了')
    await refresh()
  } catch (err) {
    ElMessage.error(errText(err, '没记上'))
  }
}
async function rotated(k) {
  try {
    await ElMessageBox.confirm(`${k.target}的${k.what_label}改好了？改好后 ${k.staff} 就不再知道了。`, '改好了', {
      confirmButtonText: '改好了', cancelButtonText: '还没',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/ledger/knows/${k.id}`)
    await refresh()
  } catch (err) {
    ElMessage.error(errText(err, '没记上'))
  }
}

onMounted(async () => {
  try {
    const [c, o, s] = await Promise.all([api.get('/ledger/records/catalog'), api.get('/ledger/options'),
      api.get('/ledger/staff-options')])
    cat.value = c.data
    statuses.value = o.data.statuses
    staff.value = s.data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
    return
  }
  loadRefs()
  loadRadar()
  loadRows()
})
</script>

<template>
  <!-- 雷达 -->
  <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
    <div :class="isDesktop ? 'lgd-card__head' : 'lg-row ar-head'">
      <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section ar-title'">
        要办的事 <small v-if="radar.length">{{ radar.length }} 件<template v-if="dangerCount">，红的 {{ dangerCount }}</template></small>
      </h3>
      <el-button v-if="radar.length > 8" link type="primary" @click="showAllRadar = !showAllRadar">{{ showAllRadar ? '收起' : '全部' }}</el-button>
    </div>
    <div :class="isDesktop ? 'lgd-card__body ar-radar' : 'ar-radar'">
      <div v-if="!radar.length" class="lg-muted">没有要办的事</div>
      <div v-for="(x, i) in radarShown" :key="i" class="ar-alert" @click="goto(x)">
        <span :class="['ar-dot', 'ar-dot--' + x.level]" />
        <span class="ar-alert__title">{{ x.title }}</span>
        <span :class="x.level === 'danger' ? 'lgd-danger' : 'ar-warn'">{{ x.text }}</span>
      </div>
    </div>
  </div>

  <!-- 分组 -->
  <div class="ar-groups">
    <button v-for="g in cat.groups" :key="g.key" :class="['lg-tab', { 'lg-tab--on': group === g.key }]" @click="pickGroup(g.key)">
      {{ g.label }}<span v-if="groupAlerts(g.key)" class="ar-badge">{{ groupAlerts(g.key) }}</span>
    </button>
  </div>

  <!-- 员工与离职：谁知道哪些密码 + 员工实名卡 -->
  <template v-if="group === 'staff'">
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row ar-head'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section ar-title'">谁知道哪些密码 <small>{{ knows.length }} 条 · 只记谁知道，不记密码</small></h3>
        <el-button type="primary" size="small" @click="startKnow">记一条</el-button>
      </div>
      <div :class="isDesktop ? 'lgd-card__body--table' : ''">
        <el-table v-if="isDesktop" :data="knows" size="small" empty-text="还没记">
          <el-table-column label="东西" prop="target" min-width="200" />
          <el-table-column label="什么密码" prop="what_label" width="130" />
          <el-table-column label="谁知道" width="150">
            <template #default="{ row }">{{ row.staff }} <el-tag v-if="row.departed" size="small" type="danger">已离职</el-tag></template>
          </el-table-column>
          <el-table-column label="记的时间" prop="created_at" width="140" />
          <el-table-column label="操作" width="90">
            <template #default="{ row }"><el-button link type="primary" size="small" @click="rotated(row)">改好了</el-button></template>
          </el-table-column>
        </el-table>
        <template v-else>
          <div v-if="!knows.length" class="lg-muted">还没记</div>
          <div v-for="k in knows" :key="k.id" class="lg-row ar-line">
            <span>{{ k.target }}的{{ k.what_label }} · {{ k.staff }}<span v-if="k.departed" class="lgd-danger">（已离职）</span></span>
            <a class="ar-link" @click="rotated(k)">改好了</a>
          </div>
        </template>
      </div>
    </div>
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row ar-head'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section ar-title'">员工实名卡 <small>{{ empSims.length }} 张</small></h3>
        <span class="lg-muted">在「台账」里法人下面加卡，类别选员工实名卡；换成法人卡用卡上的「换号」</span>
      </div>
      <div :class="isDesktop ? 'lgd-card__body' : ''">
        <div v-if="!empSims.length" class="lg-muted">没有员工实名卡</div>
        <div v-for="c in empSims" :key="c.id" class="ar-line">
          <b>{{ c.phone }}</b> <span class="lg-muted">{{ c.carrier }} · 在 {{ c.staff_name }} 名下 · 给 {{ c.legal_person }} 用<template v-if="c.in_device"> · 插在 {{ c.in_device }}</template></span>
          <div v-for="(x, i) in c.alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ar-warn'">{{ x.text }}</div>
        </div>
      </div>
    </div>
  </template>

  <!-- 某一种台账 -->
  <div :class="isDesktop ? 'lgd-card' : ''">
    <div :class="isDesktop ? 'lgd-card__head' : 'ar-mhead'">
      <el-radio-group :model-value="kind" size="small" @update:model-value="pickKind">
        <el-radio-button v-for="k in groupKinds" :key="k" :value="k">{{ cat.kinds[k].label }} {{ counts[k] || 0 }}</el-radio-button>
      </el-radio-group>
      <div class="lgd-toolbar">
        <el-input v-model="q" size="small" clearable placeholder="搜名字" style="width: 160px" @change="loadRows" />
        <el-button v-if="!spec.auto" type="primary" size="small" @click="startAdd">加{{ spec.label }}</el-button>
      </div>
    </div>
    <div v-if="isDesktop" class="lgd-card__body--table">
      <el-table v-loading="loading" :data="rows" size="small" :empty-text="spec.auto ? '换号时自动建' : '还没有'">
        <el-table-column :label="spec.name_label" min-width="160">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <div v-if="row.lent" class="ar-warn">借给 {{ row.lent.to }}（{{ row.lent.purpose }}）</div>
          </template>
        </el-table-column>
        <el-table-column v-for="f in listFields" :key="f.key" :label="f.label" min-width="110">
          <template #default="{ row }">{{ cell(row, f) }}</template>
        </el-table-column>
        <el-table-column v-if="spec.checklist" label="清单" width="110">
          <template #default="{ row }">
            <a class="ar-link" @click="openChecklist(row)">{{ ckLeft(row) ? `还差 ${ckLeft(row)} 项` : '都齐了' }}</a>
          </template>
        </el-table-column>
        <el-table-column label="要办的事" min-width="200">
          <template #default="{ row }">
            <span v-if="!row.alerts.length" class="lgd-muted">—</span>
            <div v-for="(x, i) in row.alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ar-warn'">{{ x.text }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="76">
          <template #default="{ row }"><el-tag size="small" :type="STATUS_TYPE[row.status] || 'info'" effect="light">{{ statuses[row.status] || row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button v-if="!spec.auto" link type="primary" size="small" @click="startEdit(row)">改</el-button>
            <el-button v-for="[k, s] in evKinds(row)" :key="k" link type="primary" size="small" @click="openEvents(row, k)">{{ s.label }}</el-button>
            <el-button v-if="spec.events" link size="small" @click="openEvents(row)">流水</el-button>
            <el-button v-for="(label, a) in spec.actions || {}" :key="a" link type="primary" size="small" @click="checkCert(row)">{{ label }}</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div v-else v-loading="loading">
      <div v-if="!rows.length" class="lg-card lg-muted">{{ spec.auto ? '换号时自动建' : '还没有' }}</div>
      <div v-for="row in rows" :key="row.id" class="lg-card">
        <div class="lg-row">
          <div>
            <b>{{ row.name }}</b> <span v-if="row.status !== 'active'" class="lg-muted">{{ statuses[row.status] }}</span>
            <div class="lg-muted">{{ listFields.map((f) => cell(row, f)).filter((v) => v !== '—').join(' · ') }}</div>
            <div v-if="row.lent" class="ar-warn ar-small">借给 {{ row.lent.to }}（{{ row.lent.purpose }}）</div>
            <div v-for="(x, i) in row.alerts" :key="i" :class="['ar-small', x.level === 'danger' ? 'lgd-danger' : 'ar-warn']">{{ x.text }}</div>
          </div>
          <div class="ar-ops">
            <a v-if="spec.checklist" @click="openChecklist(row)">清单</a>
            <a v-if="!spec.auto" @click="startEdit(row)">改</a>
            <a v-for="[k, s] in evKinds(row)" :key="k" @click="openEvents(row, k)">{{ s.label }}</a>
            <a v-for="(label, a) in spec.actions || {}" :key="a" @click="checkCert(row)">{{ label }}</a>
            <a class="ar-del" @click="remove(row)">删</a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 加 / 改 -->
  <el-dialog v-model="editOpen" :title="(edit.id ? '改' : '加') + spec.label" width="92%" style="max-width: 560px">
    <el-form label-position="top" class="lg-form">
      <el-form-item :label="spec.name_label"><el-input v-model="edit.data.name" :placeholder="spec.name_hint || ''" /></el-form-item>
      <template v-for="f in spec.fields" :key="f.key">
        <el-form-item v-if="f.type !== 'readonly' || edit.id" :label="f.label + (f.required ? '' : '（可不填）')">
          <el-select v-if="f.type === 'entity'" v-model="edit.data[f.key]" filterable style="width: 100%" placeholder="先在「台账」里加主体">
            <el-option v-for="o in refs.entities" :key="o.id" :label="o.label" :value="o.id" />
          </el-select>
          <el-select v-else-if="f.type === 'lp'" v-model="edit.data[f.key]" filterable clearable style="width: 100%">
            <el-option v-for="o in refs.legal_persons" :key="o.id" :label="o.label" :value="o.id" />
          </el-select>
          <el-select v-else-if="f.type === 'parent'" v-model="edit.data[f.key]" filterable clearable style="width: 100%" :placeholder="`先加${cat.kinds[f.of]?.label || ''}`">
            <el-option v-for="o in parentOptions(f)" :key="o.id" :label="o.label" :value="o.id" />
          </el-select>
          <el-select v-else-if="f.type === 'shop'" v-model="edit.data[f.key]" filterable clearable style="width: 100%">
            <el-option v-for="o in refs.shops" :key="o.id" :label="o.label" :value="o.id" />
          </el-select>
          <el-select v-else-if="f.type === 'staff'" v-model="edit.data[f.key]" filterable clearable style="width: 100%">
            <el-option v-for="s in staff" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
          <el-radio-group v-else-if="f.type === 'select' && Object.keys(f.options).length <= 4" v-model="edit.data[f.key]">
            <el-radio v-for="(label, k) in f.options" :key="k" :value="k">{{ label }}</el-radio>
          </el-radio-group>
          <el-select v-else-if="f.type === 'select'" v-model="edit.data[f.key]" :clearable="!f.required" style="width: 100%">
            <el-option v-for="(label, k) in f.options" :key="k" :label="label" :value="k" />
          </el-select>
          <el-date-picker v-else-if="f.type === 'date'" v-model="edit.data[f.key]" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          <el-date-picker v-else-if="f.type === 'month'" v-model="edit.data[f.key]" type="month" value-format="YYYY-MM" style="width: 100%" />
          <el-date-picker v-else-if="f.type === 'datetime'" v-model="edit.data[f.key]" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
          <el-input-number v-else-if="f.type === 'int'" v-model="edit.data[f.key]" :min="f.min ?? 0" :max="f.max ?? 99999999" :controls="false" :value-on-clear="null" style="width: 100%" />
          <el-switch v-else-if="f.type === 'bool'" v-model="edit.data[f.key]" />
          <el-input v-else-if="f.type === 'textarea'" v-model="edit.data[f.key]" type="textarea" :rows="2" />
          <span v-else-if="f.type === 'readonly'">{{ edit.data[f.key] || '—' }}</span>
          <el-input v-else v-model="edit.data[f.key]" :placeholder="f.type === 'money' ? '元' : ''" />
          <div v-if="f.hint" class="lg-muted ar-hint">{{ f.hint }}</div>
        </el-form-item>
      </template>
      <el-form-item label="状态">
        <el-radio-group v-model="edit.data.status">
          <el-radio v-for="(label, k) in statuses" :key="k" :value="k">{{ label }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="备注（不要写密码）"><el-input v-model="edit.data.note" type="textarea" :rows="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>

  <!-- 流水 -->
  <el-dialog v-model="evOpen" :title="ev.row ? ev.row.name : ''" width="92%" style="max-width: 560px">
    <template v-if="ev.row && evKinds(ev.row).length">
      <el-radio-group v-model="ev.kind" size="small" class="ar-evkinds" @change="evForm">
        <el-radio-button v-for="[k, s] in evKinds(ev.row)" :key="k" :value="k">{{ s.label }}</el-radio-button>
      </el-radio-group>
      <el-form v-if="ev.kind" label-position="top" class="lg-form">
        <el-form-item v-for="f in spec.events[ev.kind].fields" :key="f.key" :label="f.label">
          <el-select v-if="f.type === 'staff'" v-model="ev.data[f.key]" filterable style="width: 100%">
            <el-option v-for="s in staff" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
          <el-date-picker v-else-if="f.type === 'date'" v-model="ev.data[f.key]" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          <el-switch v-else-if="f.type === 'bool'" v-model="ev.data[f.key]" />
          <el-input v-else v-model="ev.data[f.key]" :placeholder="f.hint || (f.type === 'money' ? '元' : '')" />
        </el-form-item>
        <el-button type="primary" @click="saveEvent">记下来</el-button>
      </el-form>
    </template>
    <div class="lg-section">记录</div>
    <div v-if="!ev.items.length" class="lg-muted">还没有记录</div>
    <div v-for="e in ev.items" :key="e.id" class="ar-line">
      <b>{{ e.label }}</b> <span class="lg-muted">{{ e.created_at }} · {{ e.staff }}</span>
      <div v-if="e.text">{{ e.text }}</div>
    </div>
  </el-dialog>

  <!-- 清单 -->
  <el-dialog v-model="ckOpen" :title="ck ? ck.name : ''" width="92%" style="max-width: 520px">
    <div v-for="i in ck?.checklist || []" :key="i.key" class="ar-line lg-row">
      <el-checkbox :model-value="i.done" @change="(v) => tick(i, v)">{{ i.label }}</el-checkbox>
      <span class="lg-muted ar-nowrap">{{ i.done ? `${i.done_on} 勾的` : i.due ? `${i.due} 前` : '' }}</span>
    </div>
  </el-dialog>

  <!-- 谁知道 -->
  <el-dialog v-model="knowOpen" title="记谁知道密码" width="92%" style="max-width: 480px">
    <el-form label-position="top" class="lg-form">
      <el-form-item label="哪个东西">
        <el-select v-model="knowForm.target" filterable remote :remote-method="searchTargets" placeholder="搜设备、支付宝、店铺、台账条目" style="width: 100%">
          <el-option v-for="t in targetOpts" :key="t.type + ':' + t.id" :label="t.label" :value="t.type + ':' + t.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="什么密码">
        <el-select v-model="knowForm.what" style="width: 100%">
          <el-option v-for="(label, k) in cat.secrets" :key="k" :label="label" :value="k" />
        </el-select>
        <div class="lg-muted ar-hint">密码本身不记；他离职了，雷达上会提醒去改</div>
      </el-form-item>
      <el-form-item label="谁知道">
        <el-select v-model="knowForm.staff_ids" multiple filterable style="width: 100%">
          <el-option v-for="s in staff" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="knowOpen = false">取消</el-button>
      <el-button type="primary" @click="saveKnow">记下来</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ar-warn { color: #b45309; }
.ar-small { font-size: 12px; }
.ar-hint { width: 100%; }
.ar-head { margin-bottom: 6px; flex-wrap: wrap; }
.ar-title { margin: 0; white-space: nowrap; }
.ar-line :deep(.el-checkbox) { white-space: normal; height: auto; align-items: flex-start; }
.ar-line :deep(.el-checkbox__label) { line-height: 1.5; }
.ar-title small { font-weight: 400; }
.ar-radar { display: flex; flex-direction: column; gap: 6px; }
.ar-alert { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-size: 13px; cursor: pointer; line-height: 1.5; }
.ar-alert:hover .ar-alert__title { color: var(--lg-accent); }
.ar-alert__title { flex-shrink: 0; font-weight: 600; }
.ar-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; transform: translateY(-1px); }
.ar-dot--danger { background: var(--lg-danger); }
.ar-dot--warn { background: #f59e0b; }
.ar-groups { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 12px; }
.ar-badge { display: inline-block; margin-left: 4px; min-width: 16px; padding: 0 4px; border-radius: 8px; background: var(--lg-danger); color: #fff; font-size: 11px; line-height: 16px; }
.ar-mhead { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; overflow-x: auto; }
.ar-line { padding: 8px 0; border-bottom: 1px solid var(--lg-line); font-size: 13px; gap: 12px; }
.ar-link, .ar-ops a { color: var(--lg-accent); cursor: pointer; white-space: nowrap; }
.ar-ops { display: flex; gap: 10px; flex-shrink: 0; font-size: 13px; flex-wrap: wrap; justify-content: flex-end; max-width: 45%; }
.ar-ops a.ar-del { color: var(--lg-danger); }
.ar-evkinds { margin-bottom: 12px; }
.ar-nowrap { white-space: nowrap; }
</style>
