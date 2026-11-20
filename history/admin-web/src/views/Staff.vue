<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import api from '../api'
import {
  staffRoleLabels,
  staffRoleTypes,
  staffStatusLabels,
  staffStatusTypes,
} from '../utils/labels'

const DEFAULT_RESET_PASSWORD = 'DEMO_ONLY_REDACTED'
const PHONE_RE = /^1[3-9]\d{9}$/
const ICCID_MAX_LEN = 50

const loading = ref(false)
const submitting = ref(false)
const currentUserId = ref('')
const list = ref([])
const formRef = ref()
const form = ref({ username: '', password: '', name: '', role: 'PURCHASER' })
const createVisible = ref(false)
const pagination = ref({ page: 1, size: 10, total: 0 })
const sortOrder = ref('ascending')

const cardsDialogVisible = ref(false)
const cardsLoading = ref(false)
const cardsSaving = ref(false)
const cardsRow = ref(null)
const cards = ref([])

const rules = {
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
}

function isSelf(row) {
  return row.id === currentUserId.value
}

async function loadCurrentUser() {
  try {
    const { data } = await api.get('/auth/me')
    currentUserId.value = data.staff?.id || ''
  } catch {
    currentUserId.value = ''
  }
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/staff', {
      params: {
        page: pagination.value.page,
        size: pagination.value.size,
        sort_by: 'staff_no',
        sort_order: sortOrder.value === 'ascending' ? 'asc' : 'desc',
      },
    })
    list.value = data.items
    pagination.value.total = data.total
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载员工列表失败')
  } finally {
    loading.value = false
  }
}

function onPageChange(page) {
  pagination.value.page = page
  load()
}

function onSizeChange(size) {
  pagination.value.size = size
  pagination.value.page = 1
  load()
}

function onSortChange({ prop, order }) {
  if (prop !== 'staff_no') return
  sortOrder.value = order || 'ascending'
  pagination.value.page = 1
  load()
}

function openCreate() {
  form.value = { username: '', password: '', name: '', role: 'PURCHASER' }
  createVisible.value = true
  formRef.value?.clearValidate()
}

async function create() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    await api.post('/staff', form.value)
    ElMessage.success('员工创建成功')
    createVisible.value = false
    pagination.value.page = 1
    await load()
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '创建失败')
  } finally {
    submitting.value = false
  }
}

async function resetPassword(row) {
  try {
    await ElMessageBox.confirm(
      `确定将「${row.name}（${row.username}）」的密码重置为 ${DEFAULT_RESET_PASSWORD} 吗？`,
      '重置密码',
      { type: 'warning', confirmButtonText: '确定重置', cancelButtonText: '取消' },
    )
    await api.post(`/staff/${row.id}/reset-password`)
    ElMessage.success(`已重置密码为 ${DEFAULT_RESET_PASSWORD}`)
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '重置密码失败')
  }
}

async function updateStatus(row, status) {
  if (status === row.status) return
  try {
    await api.patch(`/staff/${row.id}`, { status })
    row.status = status
    ElMessage.success('状态已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新状态失败')
  }
}

async function editWecom(row) {
  let value
  try {
    ;({ value } = await ElMessageBox.prompt(
      '企微通讯录里的账号（UserID），验货异常等通知会推到这个账号。留空就是解绑。',
      `企微账号 · ${row.name}`,
      { inputValue: row.wecom_userid || '', inputPlaceholder: '例如 ZhangSan', confirmButtonText: '保存', cancelButtonText: '取消' },
    ))
  } catch {
    return
  }
  try {
    const { data } = await api.patch(`/staff/${row.id}`, { wecom_userid: value || '' })
    row.wecom_userid = data.wecom_userid
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

// GitHub 邮箱或用户名：保存就自动邀请进代码仓库；结果写在 github_status
async function editGithub(row) {
  let value
  try {
    ;({ value } = await ElMessageBox.prompt(
      `填 GitHub 邮箱或用户名，保存后自动邀请进代码仓库（邮箱要对方在 GitHub 公开了才查得到，查不到就填用户名）。留空就是清空。${row.github_status ? ' 上次结果：' + row.github_status : ''}`,
      `GitHub · ${row.name}`,
      { inputValue: row.github_account || '', inputPlaceholder: '邮箱或用户名', confirmButtonText: '保存并邀请', cancelButtonText: '取消' },
    ))
  } catch {
    return
  }
  try {
    const { data } = await api.patch(`/staff/${row.id}`, { github_account: value || '' })
    row.github_account = data.github_account
    row.github_status = data.github_status
    ElMessage.success(data.github_status || '已清空')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  }
}

// ---------- 钉钉关联：通知发到他的钉钉；他在钉钉离职时 ERP 号自动删除 ----------
const dingMembers = ref([])
const dingError = ref('')
const dingDlg = ref({ open: false, row: null, userid: '', saving: false })
const dingName = (id) => dingMembers.value.find((m) => m.userid === id)?.name

async function loadDingMembers() {
  if (dingMembers.value.length) return
  try {
    const { data } = await api.get('/staff/settings/dingtalk-members')
    dingMembers.value = data.items
    dingError.value = data.error || ''
  } catch {
    dingError.value = '读不到钉钉通讯录'
  }
}

async function editDing(row) {
  dingDlg.value = { open: true, row, userid: row.dingtalk_userid || '', saving: false }
  await loadDingMembers()
}

async function saveDing() {
  const d = dingDlg.value
  d.saving = true
  try {
    const { data } = await api.patch(`/staff/${d.row.id}`, { dingtalk_userid: d.userid || '' })
    d.row.dingtalk_userid = data.dingtalk_userid
    d.open = false
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    d.saving = false
  }
}

async function updateRole(row, role) {
  if (role === row.role) return
  try {
    await api.patch(`/staff/${row.id}`, { role })
    row.role = role
    ElMessage.success('角色已更新')
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '更新角色失败')
  }
}

const BLANK_SERIAL_MAX_LEN = 64

// 本人的卡片走自助接口(/auth/sim-cards)，他人走后台接口(/staff/{id}/sim-cards)
function cardBase(row) {
  return isSelf(row) ? '/auth/sim-cards' : `/staff/${row.id}/sim-cards`
}

async function manageCards(row) {
  cardsRow.value = row
  cards.value = []
  cardsDialogVisible.value = true
  cardsLoading.value = true
  try {
    const { data } = await api.get(cardBase(row))
    cards.value = data.map((c) => ({
      id: c.id,
      phone: c.phone || '',
      iccid: c.iccid || '',
      blank_serial: c.blank_serial || '',
    }))
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载卡片失败')
  } finally {
    cardsLoading.value = false
  }
}

function addCard() {
  cards.value.push({ id: '', phone: '', iccid: '', blank_serial: '' })
}

async function removeCard(index) {
  const card = cards.value[index]
  if (!card.id) {
    cards.value.splice(index, 1)
    return
  }
  try {
    await ElMessageBox.confirm('确定删除这张卡片吗？', '删除卡片', {
      type: 'warning',
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
    })
    await api.delete(`${cardBase(cardsRow.value)}/${card.id}`)
    cards.value.splice(index, 1)
    ElMessage.success('已删除')
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

function validateCard(card, order) {
  const phone = (card.phone || '').trim()
  const iccid = (card.iccid || '').trim()
  const blank = (card.blank_serial || '').trim()
  if (!phone && !iccid && !blank) {
    if (card.id) throw new Error(`卡片 ${order} 至少填写一项`)
    return null
  }
  if (phone && !PHONE_RE.test(phone)) throw new Error(`卡片 ${order} 手机号格式不正确`)
  if (iccid.length > ICCID_MAX_LEN) throw new Error(`卡片 ${order} ICCID 不能超过 ${ICCID_MAX_LEN} 位`)
  if (blank.length > BLANK_SERIAL_MAX_LEN) throw new Error(`卡片 ${order} 空卡序列号不能超过 ${BLANK_SERIAL_MAX_LEN} 位`)
  return { phone, iccid, blank_serial: blank }
}

async function saveCards() {
  const row = cardsRow.value
  if (!row) return
  const base = cardBase(row)
  const ops = []
  try {
    cards.value.forEach((card, i) => {
      const payload = validateCard(card, i + 1)
      if (!payload) return
      ops.push(card.id ? api.patch(`${base}/${card.id}`, payload) : api.post(base, payload))
    })
  } catch (err) {
    ElMessage.warning(err.message)
    return
  }
  cardsSaving.value = true
  try {
    await Promise.all(ops)
    ElMessage.success('已保存')
    await manageCards(row)
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    cardsSaving.value = false
  }
}

async function removeStaff(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除员工「${row.name}（${row.username}）」吗？删除后该账号立即停用、从列表消失，历史单据上的制单人/操作人仍正常显示。用户名「${row.username}」将被释放，可再次用于新建员工。`,
      '删除员工',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消' },
    )
    await api.delete(`/staff/${row.id}`)
    ElMessage.success('员工已删除')
    if (list.value.length === 1 && pagination.value.page > 1) {
      pagination.value.page -= 1
    }
    await load()
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error(err.response?.data?.detail || '删除失败')
  }
}

onMounted(async () => {
  loadDingMembers()
  await loadCurrentUser()
  await load()
})

// ---------- 钉钉部门 / 职位 → ERP 角色（钉钉入职自动建号用；先看部门，再看职位） ----------
const TITLE_ROLE_LABELS = { ADMIN: '管理员', WAREHOUSE: '仓管', PURCHASER: '采购', NEGOTIATOR: '议价员', BUSINESS: '业务员', SALES: '销售', FINANCE: '财务' }
const titleVisible = ref(false)
const titleLoading = ref(false)
const titleSaving = ref(false)
const titleRules = ref([])
const titleRoles = ref([])
const deptRules = ref([])
const deptRoles = ref([])
const splitWords = (text) => text.split(/[、,，\s]+/).map((w) => w.trim()).filter(Boolean)

async function openTitleRoles() {
  titleVisible.value = true
  titleLoading.value = true
  try {
    const [title, dept] = await Promise.all([
      api.get('/staff/settings/dingtalk-title-roles'),
      api.get('/staff/settings/dingtalk-dept-roles'),
    ])
    titleRoles.value = title.data.roles
    titleRules.value = title.data.rules.map((r) => ({ words: r.keywords.join('、'), role: r.role }))
    deptRoles.value = dept.data.roles
    deptRules.value = dept.data.rules.map((r) => ({ words: r.keywords.join('、'), role: r.role, github: !!r.github }))
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '加载失败')
  } finally {
    titleLoading.value = false
  }
}

function addTitleRule() {
  titleRules.value.push({ words: '', role: 'WAREHOUSE' })
}

function addDeptRule() {
  deptRules.value.push({ words: '', role: 'WAREHOUSE', github: false })
}

async function saveTitleRoles() {
  titleSaving.value = true
  try {
    const [dept, title] = await Promise.all([
      api.put('/staff/settings/dingtalk-dept-roles', {
        rules: deptRules.value.map((r) => ({ keywords: splitWords(r.words), role: r.role, github: r.github })),
      }),
      api.put('/staff/settings/dingtalk-title-roles', {
        rules: titleRules.value.map((r) => ({ keywords: splitWords(r.words), role: r.role })),
      }),
    ])
    deptRules.value = dept.data.rules.map((r) => ({ words: r.keywords.join('、'), role: r.role, github: !!r.github }))
    titleRules.value = title.data.rules.map((r) => ({ words: r.keywords.join('、'), role: r.role }))
    ElMessage.success('已保存，之后入职的员工按这个开号')
    titleVisible.value = false
  } catch (err) {
    ElMessage.error(err.response?.data?.detail || '保存失败')
  } finally {
    titleSaving.value = false
  }
}
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">员工列表</h3>
      <span class="page-card__count">共 {{ pagination.total }} 人</span>
      <div class="header-actions">
        <el-button @click="openTitleRoles">钉钉部门/职位对应</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增员工</el-button>
      </div>
    </div>
    <div class="page-card__body page-card__body--table">
      <el-table
        v-loading="loading"
        :data="list"
        stripe
        empty-text="暂无员工"
        @sort-change="onSortChange"
      >
        <el-table-column
          prop="staff_no"
          label="工号"
          min-width="100"
          sortable="custom"
          :sort-orders="['ascending', 'descending']"
        />
        <el-table-column prop="username" label="账号" min-width="120" />
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column label="角色" min-width="100">
          <template #default="{ row }">
            <el-tag :type="staffRoleTypes[row.role] || 'info'" size="small">
              {{ staffRoleLabels[row.role] || row.role }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="钉钉关联" min-width="120">
          <template #default="{ row }">
            <el-button link :type="row.dingtalk_userid ? 'default' : 'primary'" @click="editDing(row)">
              {{ row.dingtalk_userid ? dingName(row.dingtalk_userid) || '已关联' : '关联' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="企微账号" min-width="120">
          <template #default="{ row }">
            <el-button link :type="row.wecom_userid ? 'default' : 'primary'" @click="editWecom(row)">
              {{ row.wecom_userid || '填写' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="GitHub" min-width="130">
          <template #default="{ row }">
            <el-tooltip v-if="row.github_status" :content="row.github_status" placement="top">
              <el-button link @click="editGithub(row)">{{ row.github_account || '填写' }}</el-button>
            </el-tooltip>
            <el-button v-else link :type="row.github_account ? 'default' : 'primary'" @click="editGithub(row)">
              {{ row.github_account || '填写' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="90">
          <template #default="{ row }">
            <el-tag :type="staffStatusTypes[row.status] || 'info'" size="small">
              {{ staffStatusLabels[row.status] || row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" min-width="340" fixed="right" align="center">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link type="primary" @click="manageCards(row)">卡片管理</el-button>
              <span v-if="isSelf(row)" class="text-muted">当前账号</span>
              <template v-else>
              <el-dropdown trigger="click" @command="(cmd) => updateRole(row, cmd)">
                <el-button link type="primary">修改角色</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="ADMIN" :disabled="row.role === 'ADMIN'">
                      管理员
                    </el-dropdown-item>
                    <el-dropdown-item command="PURCHASER" :disabled="row.role === 'PURCHASER'">
                      采购
                    </el-dropdown-item>
                    <el-dropdown-item command="WAREHOUSE" :disabled="row.role === 'WAREHOUSE'">
                      仓管
                    </el-dropdown-item>
                    <el-dropdown-item command="NEGOTIATOR" :disabled="row.role === 'NEGOTIATOR'">
                      议价员
                    </el-dropdown-item>
                    <el-dropdown-item command="BUSINESS" :disabled="row.role === 'BUSINESS'">
                      业务员
                    </el-dropdown-item>
                    <el-dropdown-item command="SALES" :disabled="row.role === 'SALES'">
                      销售
                    </el-dropdown-item>
                    <el-dropdown-item command="FINANCE" :disabled="row.role === 'FINANCE'">
                      财务
                    </el-dropdown-item>
                    <el-dropdown-item command="RFID_DEVICE" :disabled="row.role === 'RFID_DEVICE'">
                      RFID设备
                    </el-dropdown-item>
                    <el-dropdown-item command="CRAWLER" :disabled="row.role === 'CRAWLER'">
                      行情爬虫
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-dropdown trigger="click" @command="(cmd) => updateStatus(row, cmd)">
                <el-button link type="primary">修改状态</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="ACTIVE" :disabled="row.status === 'ACTIVE'">
                      正常
                    </el-dropdown-item>
                    <el-dropdown-item command="PENDING" :disabled="row.status === 'PENDING'">
                      待激活
                    </el-dropdown-item>
                    <el-dropdown-item command="DISABLED" :disabled="row.status === 'DISABLED'">
                      已禁用
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button link type="primary" @click="resetPassword(row)">重置密码</el-button>
              <el-button link type="danger" @click="removeStaff(row)">删除</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-dialog
        v-model="cardsDialogVisible"
        :title="`手机卡信息 · ${cardsRow?.name || cardsRow?.username || ''}`"
        width="640px"
      >
        <div v-loading="cardsLoading">
          <p class="cards-tip">每张卡片含手机号 / ICCID / 空卡序列号，可绑定多张；每张至少填一项，留空的字段视为清除。</p>
          <div v-for="(card, index) in cards" :key="card.id || `new_${index}`" class="card-block">
            <div class="card-block__head">
              <span class="card-block__title">卡片 {{ index + 1 }}</span>
              <el-button link type="danger" @click="removeCard(index)">删除</el-button>
            </div>
            <el-row :gutter="12">
              <el-col :span="8">
                <el-input v-model="card.phone" maxlength="11" placeholder="手机号" clearable />
              </el-col>
              <el-col :span="8">
                <el-input v-model="card.iccid" maxlength="50" placeholder="ICCID" clearable />
              </el-col>
              <el-col :span="8">
                <el-input v-model="card.blank_serial" maxlength="64" placeholder="空卡序列号" clearable />
              </el-col>
            </el-row>
          </div>
          <el-button class="cards-add" :icon="Plus" @click="addCard">添加卡片</el-button>
        </div>
        <template #footer>
          <el-button @click="cardsDialogVisible = false">关闭</el-button>
          <el-button type="primary" :loading="cardsSaving" @click="saveCards">保存</el-button>
        </template>
      </el-dialog>

      <div class="table-pagination">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.size"
          :total="pagination.total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="onPageChange"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>
  <el-dialog v-model="createVisible" title="新增员工" width="420px" append-to-body>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="create-form" @submit.prevent>
      <el-form-item label="账号" prop="username">
        <el-input v-model="form.username" placeholder="登录账号" clearable />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input v-model="form.password" type="password" placeholder="初始密码" show-password />
      </el-form-item>
      <el-form-item label="姓名" prop="name">
        <el-input v-model="form.name" placeholder="员工姓名" clearable />
      </el-form-item>
      <el-form-item label="角色" prop="role">
        <el-select v-model="form.role" placeholder="选择角色" style="width: 100%">
          <el-option label="管理员" value="ADMIN" />
          <el-option label="采购" value="PURCHASER" />
          <el-option label="仓管" value="WAREHOUSE" />
          <el-option label="议价员" value="NEGOTIATOR" />
          <el-option label="业务员" value="BUSINESS" />
          <el-option label="销售" value="SALES" />
          <el-option label="财务" value="FINANCE" />
          <el-option label="RFID设备" value="RFID_DEVICE" />
          <el-option label="行情爬虫" value="CRAWLER" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="createVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="create">创建</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="titleVisible" title="钉钉部门 / 职位对应 ERP 角色" width="620px" append-to-body>
    <p class="cards-tip">
      钉钉里新员工入职时自动开号：<b>先看部门</b>（上级部门也算，比如技术部下面的小组也按技术部），部门名里含哪一行的词就开成那个角色（开成<b>管理员</b>的那几行要部门名整个对上：写「技术」认「技术」「技术部」，不认「技术支持」）；
      部门都对不上再看<b>职位</b>。从上往下取第一条，对上了直接能登录；都对不上的建成「待分配」，等管理员手动分配。
      管理员只能按部门给，不能按职位给；调部门不会自动改角色，按部门开的管理员调走了会通知你。离职或换了 GitHub 账号，旧账号自动移出代码仓库。勾了「要填 GitHub」的部门，新人会被提醒在「我的信息」填 GitHub，填了自动邀请进代码仓库。
    </p>
    <div v-loading="titleLoading">
      <div class="rule-head">按部门（先看）</div>
      <div v-for="(r, i) in deptRules" :key="'d' + i" class="title-rule">
        <el-input v-model="r.words" placeholder="部门名里的词，多个用顿号隔开，如 技术、研发" />
        <el-select v-model="r.role" style="width: 120px">
          <el-option v-for="role in deptRoles" :key="role" :label="TITLE_ROLE_LABELS[role] || role" :value="role" />
        </el-select>
        <el-checkbox v-model="r.github">要填 GitHub</el-checkbox>
        <el-button link type="danger" @click="deptRules.splice(i, 1)">删除</el-button>
      </div>
      <el-button size="small" :icon="Plus" @click="addDeptRule">加一行</el-button>
      <div class="rule-head">按职位</div>
      <div v-for="(r, i) in titleRules" :key="'t' + i" class="title-rule">
        <el-input v-model="r.words" placeholder="职位里的词，多个用顿号隔开，如 仓管、仓库" />
        <el-select v-model="r.role" style="width: 120px">
          <el-option v-for="role in titleRoles" :key="role" :label="TITLE_ROLE_LABELS[role] || role" :value="role" />
        </el-select>
        <el-button link type="danger" @click="titleRules.splice(i, 1)">删除</el-button>
      </div>
      <el-button size="small" :icon="Plus" @click="addTitleRule">加一行</el-button>
    </div>
    <template #footer>
      <el-button @click="titleVisible = false">取消</el-button>
      <el-button type="primary" :loading="titleSaving" @click="saveTitleRoles">保存</el-button>
    </template>
  </el-dialog>
  <el-dialog v-model="dingDlg.open" :title="`钉钉关联 · ${dingDlg.row?.name || ''}`" width="420px" append-to-body>
    <p class="cards-tip">
      选他在钉钉里的名字。关联后：验货异常、消息超时等通知发到他的钉钉；他在钉钉里离职时，这个 ERP 账号会自动删除（保留历史单据）。
      清空就是取消关联。钉钉工作通知只能发给 ERP 应用「可使用范围」里的人。
    </p>
    <el-alert v-if="dingError" :title="dingError" type="warning" :closable="false" style="margin-bottom: 8px" />
    <el-select v-model="dingDlg.userid" filterable clearable placeholder="搜名字" style="width: 100%">
      <el-option v-for="m in dingMembers" :key="m.userid" :value="m.userid" :label="m.title ? `${m.name}（${m.title}）` : m.name" />
    </el-select>
    <template #footer>
      <el-button @click="dingDlg.open = false">取消</el-button>
      <el-button type="primary" :loading="dingDlg.saving" @click="saveDing">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.page-card__count {
  font-size: 13px;
  color: var(--text-secondary);
}

.header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.rule-head {
  margin: 4px 0 8px;
  font-weight: 600;
}
.rule-head ~ .rule-head {
  margin-top: 16px;
}
.title-rule {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.create-form :deep(.el-form-item) {
  margin-bottom: 16px;
}

.create-form :deep(.el-form-item__label) {
  font-weight: 500;
  color: var(--text-primary);
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.text-muted {
  font-size: 13px;
  color: var(--text-secondary);
}

.cards-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.card-block {
  padding: 12px 0;
  border-top: 1px dashed var(--el-border-color, #dcdfe6);
}

.card-block:first-of-type {
  border-top: none;
}

.card-block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.card-block__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.cards-add {
  margin-top: 12px;
}
</style>
