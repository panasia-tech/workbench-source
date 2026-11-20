<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'
import { staffRoleLabels, staffStatusLabels } from '../utils/labels'

// 真人员工的角色（服务端 enums.HUMAN_ROLES）；设备账号不进统一登录
const HUMAN_ROLES = ['ADMIN', 'PURCHASER', 'WAREHOUSE', 'NEGOTIATOR', 'BUSINESS', 'SALES', 'FINANCE']

const loading = ref(false)
const status = ref(null)
const groups = ref([])
const staff = ref([])
const keyword = ref('')

const dialogVisible = ref(false)
const saving = ref(false)
const editing = ref(null)
const form = ref({ name: '', description: '', roles: [], member_ids: [] })

const syncing = ref(false)
const report = ref(null)
const reportVisible = ref(false)

// Frappe：平台分组 → Frappe 角色（第一行是所有员工）
const frappeRows = ref([])
const frappeDirty = ref(false)
const frappeSaving = ref(false)
const frappeSyncing = ref(false)
const roleOptions = ref([])

// 改到一半又去改了分组：保住没保存的角色，分组的增删照服务端的
function mergeFrappeRows(fresh) {
  if (!frappeDirty.value) return fresh
  const edited = new Map(frappeRows.value.map((r) => [r.group_id, r.roles]))
  return fresh.map((r) => (edited.has(r.group_id) ? { ...r, roles: edited.get(r.group_id) } : r))
}

// 能进哪些系统：平台分组 → 统一登录里的系统（第一行是所有员工）。员工工作台固定给所有员工，
// 在所有员工那一行里显示成去不掉的一项，保存时不发
const accessSystems = ref([])
const accessFixed = ref([])
const accessRows = ref([])
const accessDirty = ref(false)
const accessSaving = ref(false)
const accessSyncing = ref(false)

const fixedKeys = computed(() => accessFixed.value.map((s) => s.key))
const systemByKey = computed(() => new Map([...accessFixed.value, ...accessSystems.value].map((s) => [s.key, s])))

function systemName(key) {
  return systemByKey.value.get(key)?.name || key
}

function systemTip(key) {
  const s = systemByKey.value.get(key)
  return s ? [s.description, s.note].filter(Boolean).join('；') : ''
}

function withFixed(rows) {
  return rows.map((r) => (r.group_id ? r : { ...r, systems: [...fixedKeys.value, ...r.systems] }))
}

function mergeAccessRows(fresh) {
  const rows = withFixed(fresh)
  if (!accessDirty.value) return rows
  const edited = new Map(accessRows.value.map((r) => [r.group_id, r.systems]))
  return rows.map((r) => (edited.has(r.group_id) ? { ...r, systems: edited.get(r.group_id) } : r))
}

function applyAccess(data) {
  accessSystems.value = data.systems
  accessFixed.value = data.fixed
  accessRows.value = mergeAccessRows(data.rows)
}

// 部门 → 分组：Frappe HR 员工档案上的部门 → 平台分组。配了的部门一行，配在上级部门上，下级部门的人也算。
// 部门下拉现查 Frappe，查不到也能手填部门名
const deptRows = ref([])
const deptSaved = ref([])
const deptDirty = ref(false)
const deptSaving = ref(false)
const deptSyncing = ref(false)
const deptOptions = ref([])
const deptProblem = ref('')
const deptAdding = ref('')

function applyDepartments(data) {
  deptSaved.value = data
  deptRows.value = data.map((r) => ({ department: r.department, group_ids: [...r.group_ids] }))
}

// 改到一半又去改了分组：保住没保存的，删掉了的分组从各行里去掉
function mergeDepartments(fresh) {
  if (!deptDirty.value) {
    applyDepartments(fresh)
    return
  }
  deptSaved.value = fresh
  const alive = new Set(groups.value.map((g) => g.id))
  deptRows.value = deptRows.value.map((r) => ({ ...r, group_ids: r.group_ids.filter((id) => alive.has(id)) }))
}

async function load() {
  loading.value = true
  try {
    const [s, g, p, f, a, d] = await Promise.all([
      api.get('/sso/status'),
      api.get('/sso/groups'),
      api.get('/sso/staff'),
      api.get('/sso/frappe/roles'),
      api.get('/sso/access'),
      api.get('/sso/frappe/departments'),
    ])
    status.value = s.data
    groups.value = g.data
    staff.value = p.data
    frappeRows.value = mergeFrappeRows(f.data)
    applyAccess(a.data)
    mergeDepartments(d.data)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    loading.value = false
  }
}

// 现查 Frappe 有哪些角色，查不到就只能手填（下拉里照样能直接输入）
async function loadRoleOptions() {
  try {
    const { data } = await api.get('/sso/frappe/role-options')
    roleOptions.value = data.roles
  } catch {
    roleOptions.value = []
  }
}

// 现查 Frappe 有哪些部门（按树排好、带深度），查不到就只能手填
async function loadDeptOptions() {
  try {
    const { data } = await api.get('/sso/frappe/department-options')
    deptOptions.value = data.departments
    deptProblem.value = data.problem || ''
  } catch {
    deptOptions.value = []
    deptProblem.value = '读 Frappe 失败'
  }
}

const oidcState = computed(() => {
  const s = status.value
  if (!s) return { text: '…', type: 'info', tip: '' }
  if (!s.oidc_enabled) return { text: '没开', type: 'info', tip: 'OIDC_ENABLED' }
  if (s.oidc_problem) return { text: '没配好', type: 'danger', tip: s.oidc_problem }
  return { text: '已启用', type: 'success', tip: s.discovery_url }
})

const syncState = computed(() => {
  const s = status.value
  if (!s) return { text: '…', type: 'info', tip: '' }
  if (s.sync_problem) return { text: '没配好', type: 'danger', tip: s.sync_problem }
  if (!s.sync_enabled) return { text: '只能预演', type: 'warning', tip: 'AUTHENTIK_SYNC_ENABLED 没开' }
  return { text: '每 5 分钟一轮', type: 'success', tip: s.authentik_url }
})

const frappeState = computed(() => {
  const s = status.value
  if (!s) return { text: '…', type: 'info', tip: '' }
  if (s.frappe_problem) return { text: '没配好', type: 'danger', tip: s.frappe_problem }
  if (!s.frappe_enabled) return { text: '只能预演', type: 'warning', tip: 'FRAPPE_SYNC_ENABLED 没开' }
  return { text: '每 5 分钟一轮', type: 'success', tip: s.frappe_url }
})

const accessState = computed(() => {
  const s = status.value
  if (!s) return { text: '…', type: 'info', tip: '' }
  if (s.sync_problem) return { text: '没配好', type: 'danger', tip: s.sync_problem }
  if (!s.sync_enabled) return { text: '只能预演', type: 'warning', tip: 'AUTHENTIK_SYNC_ENABLED 没开' }
  if (!s.access_enabled) return { text: '只能预演', type: 'warning', tip: 'AUTHENTIK_ACCESS_SYNC_ENABLED 没开' }
  return { text: '每 5 分钟一轮', type: 'success', tip: '跟着统一登录同步一起跑' }
})

// 这张卡片的「立即同步」两个同步一起跑，能点的时候也说一句
const deptSyncTip = computed(() => {
  if (deptDirty.value) return '先保存'
  if (!status.value?.frappe_enabled) return 'FRAPPE_SYNC_ENABLED 没开'
  return '先读 Frappe 的部门，再把组员推到统一登录'
})

const accessSyncTip = computed(() => {
  if (accessDirty.value) return '先保存'
  if (!status.value?.sync_enabled) return 'AUTHENTIK_SYNC_ENABLED 没开'
  return 'AUTHENTIK_ACCESS_SYNC_ENABLED 没开'
})

const roleChoices = computed(() => {
  const all = new Set(roleOptions.value)
  frappeRows.value.forEach((r) => r.roles.forEach((x) => all.add(x)))
  return [...all].sort()
})

function missingRole(role) {
  return roleOptions.value.length > 0 && !roleOptions.value.includes(role)
}

const groupById = computed(() => new Map(groups.value.map((g) => [g.id, g])))
const deptByName = computed(() => new Map(deptOptions.value.map((d) => [d.name, d])))
const deptChoices = computed(() => {
  const taken = new Set(deptRows.value.map((r) => r.department))
  return deptOptions.value.filter((d) => !taken.has(d.name))
})

function deptPath(name) {
  const out = []
  let cur = name
  while (cur && !out.includes(cur)) {
    out.push(cur)
    cur = deptByName.value.get(cur)?.parent
  }
  return out
}

function missingDept(name) {
  return deptOptions.value.length > 0 && !deptByName.value.has(name)
}

function deptTip(name) {
  if (missingDept(name)) return 'Frappe 里没有这个部门（改了名或者删了？）'
  const path = deptPath(name)
  return path.length > 1 ? path.reverse().join(' / ') : ''
}

// 进了这个组有什么：Frappe 角色、能进的系统（按上面两张卡片现在的样子）
function groupTip(id) {
  const g = groupById.value.get(id)
  if (!g) return ''
  const roles = frappeRows.value.find((r) => r.group_id === id)?.roles || []
  const systems = accessRows.value.find((r) => r.group_id === id)?.systems || []
  const grants = [
    roles.length ? `Frappe 给 ${roles.join('、')}` : '',
    systems.length ? `能进 ${systems.map(systemName).join('、')}` : '',
  ].filter(Boolean)
  if (g.powerful) grants.unshift(`权限大：${g.powerful}，HR 把谁调进这个部门谁就有`)
  return grants.join('；')
}

// 这个部门（含下级部门）现在有哪些在职员工：按 Frappe 同步上一轮读到的员工档案
function peopleIn(name) {
  const out = []
  for (const s of staff.value) {
    if (s.status !== 'ACTIVE') continue
    const hit = (s.frappe_employees || []).find((e) => e.status === 'Active' && e.department && e.path.includes(name))
    if (hit) out.push({ id: s.id, name: s.name || s.username, department: hit.department })
  }
  return out
}

const SOURCE_MARKS = { role: '角色', manual: '手挂', department: '部门' }

function sourceMark(row, group) {
  const kinds = [...new Set((row.group_sources?.[group] || []).map((x) => x.kind))]
  return kinds.map((k) => SOURCE_MARKS[k] || k).join('、')
}

function sourceTip(row, group, pending) {
  const words = (row.group_sources?.[group] || []).map((x) => {
    if (x.kind === 'role') return `按 ERP 角色（${staffRoleLabels[x.detail] || x.detail}）`
    if (x.kind === 'manual') return '手工挂的'
    const own = (row.frappe_employees || []).some((e) => e.department === x.detail)
    return own ? `按部门（${x.detail}）` : `按部门（${x.detail}，他在下级部门）`
  })
  if (pending) words.unshift('等同步')
  return words.join('；')
}

function employeeTip(e) {
  const at = (e.synced_at || '').replace('T', ' ').slice(0, 16)
  const off = e.status === 'Active' ? '' : `，${e.status}，不算`
  return `员工档案 ${e.employee}（${e.employee_name || '没填姓名'}）${off}${at ? `；${at} 读到` : ''}`
}

const filteredStaff = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return staff.value
  return staff.value.filter((s) => [s.username, s.name, s.staff_no].some((v) => (v || '').toLowerCase().includes(k)))
})

function groupState(row) {
  if (row.synced) {
    const at = (row.authentik_synced_at || '').replace('T', ' ').slice(0, 16)
    return { text: '已对上', type: 'success', tip: at ? `最近同步 ${at}` : '' }
  }
  if (row.authentik_note) return { text: '没对上', type: 'danger', tip: row.authentik_note }
  return { text: '等同步', type: 'info', tip: '同步过之后登录才带这个组' }
}

function openCreate() {
  editing.value = null
  form.value = { name: '', description: '', roles: [], member_ids: [] }
  dialogVisible.value = true
}

function openEdit(row) {
  editing.value = row
  form.value = {
    name: row.name,
    description: row.description || '',
    roles: [...row.roles],
    member_ids: row.members.map((m) => m.id),
  }
  dialogVisible.value = true
}

async function save() {
  if (!form.value.name.trim()) {
    ElMessage.warning('填组名')
    return
  }
  const body = {
    name: form.value.name.trim(),
    description: form.value.description.trim() || null,
    roles: form.value.roles,
    member_ids: form.value.member_ids,
  }
  saving.value = true
  try {
    if (editing.value) await api.patch(`/sso/groups/${editing.value.id}`, body)
    else await api.post('/sso/groups', body)
    ElMessage.success('已保存')
    dialogVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `删除分组「${row.name}」？统一登录里的同名组留着，下一轮同步把 ERP 的人移出去；这个组给的 Frappe 角色、能进的系统、按部门进组的配置也一起收回。`,
      '删除分组',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    await api.delete(`/sso/groups/${row.id}`)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    if (err === 'cancel' || err === 'close' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

async function runSync(dryRun) {
  syncing.value = true
  try {
    const { data } = await api.post('/sso/authentik-sync', { dry_run: dryRun })
    report.value = data
    reportVisible.value = true
    if (!dryRun) await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '同步失败')
  } finally {
    syncing.value = false
  }
}

async function saveFrappeRoles() {
  frappeSaving.value = true
  try {
    const rows = frappeRows.value.map((r) => ({ group_id: r.group_id, roles: r.roles }))
    const { data } = await api.put('/sso/frappe/roles', { rows })
    frappeRows.value = data
    frappeDirty.value = false
    ElMessage.success('已保存')
    staff.value = (await api.get('/sso/staff')).data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    frappeSaving.value = false
  }
}

async function runFrappeSync(dryRun) {
  frappeSyncing.value = true
  try {
    const { data } = await api.post('/sso/frappe/sync', { dry_run: dryRun })
    report.value = data
    reportVisible.value = true
    if (!dryRun) await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '同步失败')
  } finally {
    frappeSyncing.value = false
  }
}

function addDept(name) {
  const dept = (name || '').trim()
  deptAdding.value = ''
  if (!dept || deptRows.value.some((r) => r.department === dept)) return
  deptRows.value.push({ department: dept, group_ids: [] })
  deptDirty.value = true
}

function removeDept(row) {
  deptRows.value = deptRows.value.filter((r) => r !== row)
  deptDirty.value = true
}

async function saveDepartments() {
  // 新配上权限大的组，先确认一下：HR 在 Frappe 里改谁的部门，谁就有这个组的权限
  const saved = new Set(deptSaved.value.flatMap((r) => r.group_ids.map((id) => `${r.department}\n${id}`)))
  const risky = []
  deptRows.value.forEach((r) =>
    r.group_ids.forEach((id) => {
      const g = groupById.value.get(id)
      if (g?.powerful && !saved.has(`${r.department}\n${id}`)) risky.push(`${r.department} → ${g.name}`)
    }),
  )
  if (risky.length) {
    try {
      await ElMessageBox.confirm(
        `${risky.join('；')}。这几个组权限大，HR 在 Frappe 里把谁调进这些部门，谁就有。`,
        '权限大的组',
        { type: 'warning', confirmButtonText: '保存', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  deptSaving.value = true
  try {
    const rows = deptRows.value
      .filter((r) => r.group_ids.length)
      .map((r) => ({ department: r.department, group_ids: r.group_ids }))
    const { data } = await api.put('/sso/frappe/departments', { rows })
    deptDirty.value = false
    applyDepartments(data)
    ElMessage.success('已保存')
    const [g, p] = await Promise.all([api.get('/sso/groups'), api.get('/sso/staff')])
    groups.value = g.data
    staff.value = p.data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    deptSaving.value = false
  }
}

// 先跑 Frappe 同步（读部门、给角色），接着跑统一登录同步（推组员），报告里四段
async function runDeptSync(dryRun) {
  deptSyncing.value = true
  try {
    const { data } = await api.post('/sso/frappe/departments/sync', { dry_run: dryRun })
    report.value = data
    reportVisible.value = true
    if (!dryRun) await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '同步失败')
  } finally {
    deptSyncing.value = false
  }
}

async function saveAccess() {
  accessSaving.value = true
  try {
    const rows = accessRows.value.map((r) => ({
      group_id: r.group_id,
      systems: r.systems.filter((k) => !fixedKeys.value.includes(k)),
    }))
    const { data } = await api.put('/sso/access', { rows })
    accessDirty.value = false
    applyAccess(data)
    ElMessage.success('已保存')
    staff.value = (await api.get('/sso/staff')).data
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    accessSaving.value = false
  }
}

// 和上面「接入状态」的两个按钮是同一轮同步：报告里号和组一段、能进哪些系统一段
async function runAccessSync(dryRun) {
  accessSyncing.value = true
  try {
    const { data } = await api.post('/sso/authentik-sync', { dry_run: dryRun })
    report.value = data
    reportVisible.value = true
    if (!dryRun) await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '同步失败')
  } finally {
    accessSyncing.value = false
  }
}

onMounted(() => {
  load()
  loadRoleOptions()
  loadDeptOptions()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">接入状态</h3>
      <div class="header-actions">
        <el-button :loading="syncing" :disabled="!status || !!status.sync_problem" @click="runSync(true)">
          预演同步
        </el-button>
        <el-tooltip :disabled="!!status?.sync_enabled" content="AUTHENTIK_SYNC_ENABLED 没开" placement="top">
          <span>
            <el-button
              type="primary"
              :loading="syncing"
              :disabled="!status?.sync_enabled || !!status?.sync_problem"
              @click="runSync(false)"
            >
              立即同步
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>
    <div class="page-card__body status-body">
      <div class="status-item">
        <span class="status-label">ERP 账号登录</span>
        <el-tooltip :content="oidcState.tip" :disabled="!oidcState.tip" placement="top">
          <el-tag :type="oidcState.type">{{ oidcState.text }}</el-tag>
        </el-tooltip>
      </div>
      <div class="status-item">
        <span class="status-label">同步到统一登录</span>
        <el-tooltip :content="syncState.tip" :disabled="!syncState.tip" placement="top">
          <el-tag :type="syncState.type">{{ syncState.text }}</el-tag>
        </el-tooltip>
      </div>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">平台分组</h3>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建分组</el-button>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="groups" stripe empty-text="还没有分组">
        <el-table-column label="组名" min-width="140">
          <template #default="{ row }">
            <el-tooltip :content="row.description || ''" :disabled="!row.description" placement="top">
              <span>{{ row.name }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="按角色进组" min-width="150">
          <template #default="{ row }">
            <el-tag v-for="r in row.roles" :key="r" size="small" class="tag-gap">{{ staffRoleLabels[r] || r }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="手工挂的人" min-width="220">
          <template #default="{ row }">
            <el-tag v-for="m in row.members" :key="m.id" size="small" type="info" class="tag-gap">
              {{ m.name || m.username }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="按部门进组" min-width="160">
          <template #default="{ row }">
            <el-tag v-for="d in row.departments" :key="d" size="small" type="success" effect="plain" class="tag-gap">
              {{ d }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="统一登录" width="110">
          <template #default="{ row }">
            <el-tooltip :content="groupState(row).tip" :disabled="!groupState(row).tip" placement="top">
              <el-tag size="small" :type="groupState(row).type">{{ groupState(row).text }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <div class="title-with-tag">
        <h3 class="page-card__title">部门 → 分组</h3>
        <el-tooltip :content="frappeState.tip" :disabled="!frappeState.tip" placement="top">
          <el-tag size="small" :type="frappeState.type">{{ frappeState.text }}</el-tag>
        </el-tooltip>
      </div>
      <div class="header-actions">
        <el-tooltip :disabled="!deptDirty" content="先保存" placement="top">
          <span>
            <el-button
              :loading="deptSyncing"
              :disabled="deptDirty || !status || !!status.frappe_problem"
              @click="runDeptSync(true)"
            >
              预演同步
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip :content="deptSyncTip" placement="top">
          <span>
            <el-button
              :loading="deptSyncing"
              :disabled="deptDirty || !status?.frappe_enabled || !!status?.frappe_problem"
              @click="runDeptSync(false)"
            >
              立即同步
            </el-button>
          </span>
        </el-tooltip>
        <el-button type="primary" :loading="deptSaving" :disabled="!deptDirty" @click="saveDepartments">
          保存
        </el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="deptRows" stripe empty-text="还没配，部门不带分组">
        <el-table-column label="部门（含下级部门）" min-width="200">
          <template #default="{ row }">
            <el-tooltip :content="deptTip(row.department)" :disabled="!deptTip(row.department)" placement="top">
              <span :class="{ 'role-missing': missingDept(row.department) }">{{ row.department }}</span>
            </el-tooltip>
            <el-tag v-if="deptByName.get(row.department)?.disabled" size="small" type="info" class="tag-after">
              停用
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进的组" min-width="300">
          <template #default="{ row }">
            <el-select
              v-model="row.group_ids"
              multiple
              filterable
              placeholder="不进组"
              class="full-width"
              @change="deptDirty = true"
            >
              <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id">
                <span>{{ g.name }}</span>
                <span v-if="g.powerful" class="system-desc power-desc">权限大</span>
              </el-option>
              <template #label="{ value }">
                <el-tooltip :content="groupTip(value)" :disabled="!groupTip(value)" placement="top">
                  <span :class="{ 'group-powerful': groupById.get(value)?.powerful }">
                    {{ groupById.get(value)?.name || value }}
                  </span>
                </el-tooltip>
              </template>
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="现在在里面的员工" min-width="200">
          <template #default="{ row }">
            <el-tooltip
              v-for="p in peopleIn(row.department)"
              :key="p.id"
              :content="`在 ${p.department}`"
              :disabled="p.department === row.department"
              placement="top"
            >
              <el-tag size="small" type="info" class="tag-gap">{{ p.name }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80" align="center">
          <template #default="{ row }">
            <el-button link type="danger" @click="removeDept(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="dept-add">
        <el-select
          v-model="deptAdding"
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="加部门"
          class="dept-select"
          @change="addDept"
        >
          <el-option v-for="d in deptChoices" :key="d.name" :label="d.name" :value="d.name">
            <span :style="{ paddingLeft: `${d.depth * 16}px` }">{{ d.name }}</span>
            <span v-if="d.disabled" class="system-desc">停用</span>
          </el-option>
        </el-select>
        <el-tooltip v-if="deptProblem" :content="deptProblem" placement="top">
          <el-tag size="small" type="info">Frappe 的部门读不到，可以手填</el-tag>
        </el-tooltip>
      </div>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <div class="title-with-tag">
        <h3 class="page-card__title">Frappe 角色</h3>
        <el-tooltip :content="frappeState.tip" :disabled="!frappeState.tip" placement="top">
          <el-tag size="small" :type="frappeState.type">{{ frappeState.text }}</el-tag>
        </el-tooltip>
      </div>
      <div class="header-actions">
        <el-tooltip :disabled="!frappeDirty" content="先保存" placement="top">
          <span>
            <el-button
              :loading="frappeSyncing"
              :disabled="frappeDirty || !status || !!status.frappe_problem"
              @click="runFrappeSync(true)"
            >
              预演同步
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :disabled="!frappeDirty && !!status?.frappe_enabled"
          :content="frappeDirty ? '先保存' : 'FRAPPE_SYNC_ENABLED 没开'"
          placement="top"
        >
          <span>
            <el-button
              :loading="frappeSyncing"
              :disabled="frappeDirty || !status?.frappe_enabled || !!status?.frappe_problem"
              @click="runFrappeSync(false)"
            >
              立即同步
            </el-button>
          </span>
        </el-tooltip>
        <el-button type="primary" :loading="frappeSaving" :disabled="!frappeDirty" @click="saveFrappeRoles">
          保存
        </el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="frappeRows" stripe empty-text="还没有分组">
        <el-table-column label="分组" min-width="140">
          <template #default="{ row }">
            <el-tooltip v-if="!row.group_id" content="能用 ERP 账号登录统一登录的在职员工" placement="top">
              <span>所有员工</span>
            </el-tooltip>
            <span v-else>{{ row.group_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="给的角色" min-width="420">
          <template #default="{ row }">
            <el-select
              v-model="row.roles"
              multiple
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              placeholder="不给"
              class="full-width"
              @change="frappeDirty = true"
            >
              <el-option v-for="r in roleChoices" :key="r" :label="r" :value="r" />
              <template #label="{ value }">
                <el-tooltip v-if="missingRole(value)" content="Frappe 里没有这个角色" placement="top">
                  <span class="role-missing">{{ value }}</span>
                </el-tooltip>
                <span v-else>{{ value }}</span>
              </template>
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <div class="title-with-tag">
        <h3 class="page-card__title">能进哪些系统</h3>
        <el-tooltip :content="accessState.tip" :disabled="!accessState.tip" placement="top">
          <el-tag size="small" :type="accessState.type">{{ accessState.text }}</el-tag>
        </el-tooltip>
      </div>
      <div class="header-actions">
        <el-tooltip :disabled="!accessDirty" content="先保存" placement="top">
          <span>
            <el-button
              :loading="accessSyncing"
              :disabled="accessDirty || !status || !!status.sync_problem"
              @click="runAccessSync(true)"
            >
              预演同步
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :disabled="!accessDirty && !!status?.sync_enabled && !!status?.access_enabled"
          :content="accessSyncTip"
          placement="top"
        >
          <span>
            <el-button
              :loading="accessSyncing"
              :disabled="accessDirty || !status?.sync_enabled || !status?.access_enabled || !!status?.sync_problem"
              @click="runAccessSync(false)"
            >
              立即同步
            </el-button>
          </span>
        </el-tooltip>
        <el-button type="primary" :loading="accessSaving" :disabled="!accessDirty" @click="saveAccess">
          保存
        </el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="accessRows" stripe empty-text="还没有分组">
        <el-table-column label="分组" min-width="140">
          <template #default="{ row }">
            <el-tooltip v-if="!row.group_id" content="能用 ERP 账号登录统一登录的在职员工" placement="top">
              <span>所有员工</span>
            </el-tooltip>
            <span v-else>{{ row.group_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="能进的系统" min-width="420">
          <template #default="{ row }">
            <el-select
              v-model="row.systems"
              multiple
              filterable
              placeholder="哪个都不进"
              class="full-width"
              @change="accessDirty = true"
            >
              <template v-if="!row.group_id">
                <el-option v-for="s in accessFixed" :key="s.key" :label="s.name" :value="s.key" disabled>
                  <span>{{ s.name }}</span>
                  <span class="system-desc">固定</span>
                </el-option>
              </template>
              <el-option v-for="s in accessSystems" :key="s.key" :label="s.name" :value="s.key">
                <span>{{ s.name }}</span>
                <span class="system-desc">{{ s.description }}</span>
              </el-option>
              <template #label="{ value }">
                <el-tooltip :content="systemTip(value)" :disabled="!systemTip(value)" placement="top">
                  <span>{{ systemName(value) }}</span>
                </el-tooltip>
              </template>
            </el-select>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">员工</h3>
      <el-input v-model="keyword" placeholder="账号 / 姓名 / 工号" clearable class="search-input" />
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table v-loading="loading" :data="filteredStaff" stripe empty-text="没有员工">
        <el-table-column prop="staff_no" label="工号" min-width="90" />
        <el-table-column label="账号" min-width="110">
          <template #default="{ row }">
            <el-tooltip :content="`员工 ID：${row.id}`" placement="top">
              <span>{{ row.username }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="姓名" min-width="90" />
        <el-table-column label="角色" min-width="90">
          <template #default="{ row }">
            {{ staffRoleLabels[row.role] || row.role }}
            <span v-if="row.status !== 'ACTIVE'" class="text-muted">（{{ staffStatusLabels[row.status] || row.status }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="Frappe 部门" min-width="140">
          <template #default="{ row }">
            <el-tooltip v-for="e in row.frappe_employees" :key="e.employee" :content="employeeTip(e)" placement="top">
              <el-tag
                size="small"
                :type="e.status === 'Active' ? 'success' : 'info'"
                effect="plain"
                class="tag-gap"
                :class="{ 'employee-off': e.status !== 'Active' }"
              >
                {{ e.department || '没填部门' }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="进的组" min-width="260">
          <template #default="{ row }">
            <el-tooltip v-for="g in row.groups" :key="g" :content="sourceTip(row, g, false)" placement="top">
              <el-tag size="small" class="tag-gap">
                {{ g }}<span class="group-src">{{ sourceMark(row, g) }}</span>
              </el-tag>
            </el-tooltip>
            <el-tooltip v-for="g in row.groups_pending" :key="`p-${g}`" :content="sourceTip(row, g, true)" placement="top">
              <el-tag size="small" type="info" effect="plain" class="tag-gap">
                {{ g }}<span class="group-src">{{ sourceMark(row, g) }}</span>
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="统一登录" min-width="120">
          <template #default="{ row }">
            <el-tag v-if="row.can_login" size="small" type="success">能登录</el-tag>
            <el-tooltip v-else :content="row.reason || ''" placement="top">
              <el-tag size="small" type="info">不能登录</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="Frappe 角色" min-width="200">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.frappe_roles.length"
              :content="row.frappe_user ? `Frappe 账号：${row.frappe_user}` : '还没开 Frappe 号'"
              placement="top"
            >
              <span v-if="row.frappe_user">
                <el-tag v-for="r in row.frappe_roles" :key="r" size="small" class="tag-gap">{{ r }}</el-tag>
              </span>
              <span v-else>
                <el-tag v-for="r in row.frappe_roles" :key="r" size="small" type="info" effect="plain" class="tag-gap">
                  {{ r }}
                </el-tag>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="能进的系统" min-width="240">
          <template #default="{ row }">
            <span v-if="row.can_login">
              <el-tag v-for="k in row.systems" :key="k" size="small" class="tag-gap">{{ systemName(k) }}</el-tag>
            </span>
            <el-tooltip v-else-if="row.systems.length" content="统一登录的号还没开好，开好了才进得去" placement="top">
              <span>
                <el-tag v-for="k in row.systems" :key="k" size="small" type="info" effect="plain" class="tag-gap">
                  {{ systemName(k) }}
                </el-tag>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑分组' : '新建分组'" width="560px">
    <el-form label-width="96px">
      <el-form-item label="组名">
        <el-input v-model="form.name" maxlength="80" placeholder="各系统按这个名字给角色" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input v-model="form.description" maxlength="255" />
      </el-form-item>
      <el-form-item label="按角色进组">
        <el-checkbox-group v-model="form.roles">
          <el-checkbox v-for="r in HUMAN_ROLES" :key="r" :value="r">{{ staffRoleLabels[r] || r }}</el-checkbox>
        </el-checkbox-group>
      </el-form-item>
      <el-form-item label="手工挂人">
        <el-select v-model="form.member_ids" multiple filterable placeholder="选员工" class="full-width">
          <el-option v-for="s in staff" :key="s.id" :label="`${s.name || s.username}（${s.username}）`" :value="s.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="reportVisible" :title="report?.dry_run ? '同步预演' : '同步结果'" width="680px">
    <pre class="report">{{ (report?.lines || []).join('\n') }}</pre>
  </el-dialog>
</template>

<style scoped>
/* 窄屏上标题和按钮放不下一行就折下去，标题自己不拆字 */
.page-card__header {
  flex-wrap: wrap;
  gap: 8px 12px;
}

.page-card__title {
  white-space: nowrap;
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.system-desc {
  float: right;
  margin-left: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.title-with-tag {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.role-missing {
  color: var(--el-color-danger);
  text-decoration: line-through;
}

.power-desc {
  color: var(--el-color-danger);
}

.group-powerful {
  color: var(--el-color-danger);
}

/* 员工列表里组名后面的来源：角色 / 手挂 / 部门 */
.group-src {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.6;
}

.employee-off {
  text-decoration: line-through;
}

.tag-after {
  margin-left: 6px;
}

.dept-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
}

.dept-select {
  width: 260px;
  max-width: 100%;
}

.status-body {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 32px;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-label {
  font-size: 14px;
  color: var(--text-secondary);
}

.tag-gap {
  margin: 2px 4px 2px 0;
}

.search-input {
  width: 220px;
}

.full-width {
  width: 100%;
}

.text-muted {
  font-size: 12px;
  color: var(--text-secondary);
}

.report {
  max-height: 60vh;
  margin: 0;
  overflow: auto;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}
</style>
