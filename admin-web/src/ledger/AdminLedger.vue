<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import LedgerTree from './LedgerTree.vue'
import LedgerDesk from './LedgerDesk.vue'
import AuthLinkDialog from './AuthLinkDialog.vue'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const q = ref('')
const onlyCheck = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const size = ref(30) // 电脑上表格底下可以换；手机上沿用同一个（电脑上换过再拉窄，页码才对得上）
const loading = ref(false)
const current = ref(null) // 正在看的法人（整棵）
const opts = ref({ entity_types: {}, platforms: {}, statuses: {}, tax_payers: {}, tax_levies: {}, alipay_roles: {}, channels: {},
  carriers: {}, sim_categories: {}, sim_billings: {}, shop_roles: {}, role_channels: {}, invoice_modes: {}, currencies: {} })
const saleShops = ref([])
const staffOptions = ref([])
const devices = ref([]) // 店铺 / 账号能挂的设备

const LEVEL_LABEL = { legal_person: '法人', entity: '主体', alipay: '支付宝', shop: '店铺', sim: '手机卡' }

async function load(p = 1) {
  loading.value = true
  try {
    const params = { page: p, size: size.value }
    if (q.value.trim()) params.q = q.value.trim()
    if (onlyCheck.value) params.needs_check = true
    const { data } = await api.get('/ledger/legal-persons', { params })
    list.value = data.items
    total.value = data.total
    page.value = p
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function openLp(id) {
  try {
    current.value = (await api.get(`/ledger/legal-persons/${id}`)).data
  } catch (err) {
    ElMessage.error(errText(err, '打不开'))
  }
}

// 电脑上：这个法人整棵里有几处要核对
const checkCount = computed(() => {
  const lp = current.value
  if (!lp) return 0
  let n = lp.needs_check ? 1 : 0
  for (const c of lp.sims || []) if (c.needs_check) n++
  for (const e of lp.entities) {
    if (e.needs_check) n++
    for (const s of e.shops || []) if (s.needs_check) n++
    for (const a of e.alipays) {
      if (a.needs_check) n++
      for (const s of a.shops) if (s.needs_check) n++
    }
  }
  return n
})

function onSize(v) {
  size.value = v
  load(1)
}

function back() {
  current.value = null
  load(page.value)
}

// ---- 改 / 加 ----
const editOpen = ref(false)
const edit = ref({ level: '', id: null, data: {} })

const parentChoices = computed(() => {
  // 只在同一个法人下面挪：支付宝换主体；店铺换收款号（只有收款号能挂店铺）或换主体（不走支付宝的）
  const lp = current.value
  if (!lp) return []
  if (edit.value.level === 'alipay') return lp.entities.map((e) => ({ id: e.id, label: e.name }))
  return []
})
const salesAlipays = computed(() => {
  const lp = current.value
  if (!lp) return []
  return lp.entities.flatMap((e) => e.alipays.filter((a) => a.role === 'sales').map((a) => ({ id: a.id, label: `${a.account}（${e.name}）` })))
})
const purchaseAlipays = computed(() => {
  const lp = current.value
  if (!lp) return []
  return lp.entities.flatMap((e) => e.alipays.filter((a) => a.role === 'purchase').map((a) => ({ id: a.id, label: `${a.account}（${e.name}）` })))
})
// 引流号往哪家销售店引流（同一个法人下的）
const leadChoices = computed(() => {
  const lp = current.value
  if (!lp) return []
  return lp.entities.flatMap((e) => [...e.alipays.flatMap((a) => a.shops), ...(e.shops || [])])
    .filter((x) => x.role === 'sales' && x.id !== edit.value.id).map((x) => ({ id: x.id, label: `${x.platform_label} · ${x.name}` }))
})
const roleChannels = computed(() => (opts.value.role_channels || {})[edit.value.data.role] || [])
// 换了账号用途，结算方式跟着换成这种账号能用的第一个
function onRole() {
  const d = edit.value.data
  if (!roleChannels.value.includes(d.channel)) d.channel = roleChannels.value[0]
  d.alipay_id = ''
}
const entityChoices = computed(() => (current.value ? current.value.entities.map((e) => ({ id: e.id, label: e.name })) : []))
// 副卡挂在同一法人、同一运营商的主卡下
const masterChoices = computed(() => (current.value?.sims || []).filter(
  (c) => c.category === 'master' && c.status !== 'closed' && c.carrier === edit.value.data.carrier && c.id !== edit.value.id,
))
// 设备用途要和账号一致
const shopDevices = computed(() => devices.value.filter((d) => d.purpose === (edit.value.data.role || 'sales') && d.status !== 'closed'))

const PICK = {
  legal_person: ['name', 'phone', 'email', 'personal_cards', 'face_sla', 'agreement_end', 'status', 'note'],
  entity: ['name', 'entity_type', 'credit_code', 'tax_payer', 'tax_levy', 'tax_office', 'tax_phone', 'liaison_phone',
    'registered_on', 'report_year', 'report_filed_on', 'business_scope', 'invoice_quota', 'status', 'note'],
  alipay: ['entity_id', 'account', 'alias', 'phone', 'alipay_user_id', 'role', 'corporate_pay', 'daily_limit', 'single_limit',
    'frozen_reserve', 'book_code', 'cert_expires_on', 'transfer_scene', 'status', 'note'],
  shop: ['entity_id', 'alipay_id', 'role', 'channel', 'platform', 'name', 'sale_shop_id', 'merchant_no', 'fee_rate', 'deposit',
    'deposit_from', 'frozen', 'invoice_mode', 'book_code', 'lead_shop_id', 'phone', 'device_id', 'currency', 'status', 'note'],
  sim: ['legal_person_id', 'phone', 'carrier', 'category', 'master_id', 'billing', 'plan', 'monthly_rent', 'balance',
    'balance_on', 'iccid', 'holder', 'vendor', 'contract_end', 'custodian', 'staff_id', 'status', 'note'],
}
const NULLS = ['sale_shop_id', 'alipay_id', 'fee_rate', 'deposit', 'report_year', 'registered_on', 'report_filed_on', 'device_id',
  'master_id', 'monthly_rent', 'balance', 'balance_on', 'contract_end', 'agreement_end', 'lead_shop_id', 'frozen', 'daily_limit',
  'single_limit', 'frozen_reserve', 'invoice_mode', 'invoice_quota', 'cert_expires_on', 'staff_id']

function startEdit(level, row) {
  // 数字框空着要给 null：给 '' 会被 el-input-number 按最小值（2000）填上
  const data = Object.fromEntries(PICK[level].map((k) => [k, row[k] ?? (k === 'report_year' ? null : '')]))
  if (level === 'legal_person') data.personal_cards = { ...(row.personal_cards || {}) }
  edit.value = { level, id: row.id, data }
  editOpen.value = true
}

// shop 从收款号上加：销售店走支付宝；从采购支付宝上加：采购号因公付；
// 从主体上加：不走支付宝的销售店（微信小店、抖店……），viaEntity = 'marketing' 时是引流号
function startAdd(level, parent, viaEntity = false) {
  const base = { status: 'active', note: '' }
  const data = {
    entity: { legal_person_id: parent.id, name: '', entity_type: 'individual', credit_code: '', tax_payer: 'small', tax_levy: 'audit', ...base },
    alipay: { entity_id: parent.id, account: '', alias: '', role: 'sales', corporate_pay: false, ...base },
    shop: viaEntity === 'marketing'
      ? { entity_id: parent.id, alipay_id: '', role: 'marketing', channel: 'none', platform: 'xhs', name: '', lead_shop_id: '', ...base }
      : viaEntity
        ? { entity_id: parent.id, alipay_id: '', role: 'sales', channel: 'wechat', platform: 'wechat_shop', name: '', merchant_no: '', fee_rate: '', deposit: '', deposit_from: '', sale_shop_id: '', ...base }
        : parent.role === 'purchase'
          ? { entity_id: parent.entity_id, alipay_id: parent.id, role: 'purchase', channel: 'corporate_pay', platform: 'dianping', name: '', ...base }
          : { entity_id: parent.entity_id, alipay_id: parent.id, role: 'sales', channel: 'alipay', platform: 'xianyu', name: '', fee_rate: '', deposit: '', deposit_from: '', sale_shop_id: '', ...base },
    legal_person: { name: '', phone: '', email: '', personal_cards: {}, ...base },
    sim: { legal_person_id: parent.id, phone: '', carrier: '中国移动', category: 'master', master_id: '', billing: 'independent', plan: '',
      monthly_rent: '', balance: '', balance_on: '', iccid: '', holder: '', vendor: '', contract_end: '', custodian: '', ...base },
  }[level]
  if (level === 'shop') data.currency = 'CNY'
  edit.value = { level, id: null, data }
  editOpen.value = true
}

const saving = ref(false)
async function saveEdit() {
  saving.value = true
  const { level, id, data } = edit.value
  try {
    const body = { ...data }
    // 空着的选项、数字、日期传 null（空字符串过不了后端校验）
    for (const k of NULLS) {
      if (k in body && (body[k] === '' || body[k] === undefined)) body[k] = null
    }
    if (body.role && body.role !== 'purchase') body.corporate_pay = false
    if (level === 'sim' && body.category !== 'sub') Object.assign(body, { master_id: null, billing: 'independent' })
    if (level === 'sim' && body.category !== 'employee') body.staff_id = null
    const res = id
      ? await api.patch(`/ledger/rows/${level}/${id}`, body)
      : await api.post(`/ledger/rows/${level}`, body)
    editOpen.value = false
    ElMessage.success('已保存')
    await openLp(res.data.legal_person_id)
  } catch (err) {
    ElMessage.error(errText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(level, row) {
  try {
    await ElMessageBox.confirm(`删掉这个${LEVEL_LABEL[level]}？删了找不回来。`, '删除', {
      type: 'warning', confirmButtonText: '删', cancelButtonText: '不删',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/ledger/rows/${level}/${row.id}`)
    ElMessage.success('已删除')
    if (level === 'legal_person') back()
    else await openLp(current.value.id)
  } catch (err) {
    ElMessage.error(errText(err, '删除失败'))
  }
}

async function markChecked() {
  try {
    await api.post(`/ledger/legal-persons/${current.value.id}/checked`)
    ElMessage.success('已标核对完')
    await openLp(current.value.id)
  } catch (err) {
    ElMessage.error(errText(err, '操作失败'))
  }
}

// ---- 手机卡：充值、绑了什么、换号 ----
const rechargeOpen = ref(false)
const recharge = ref({ sim: null, amount: null, note: '' })
const usesOpen = ref(false)
const uses = ref({ phone: '', items: [] })
const rebindOpen = ref(false)
const rebind = ref({ sim: null, to: '', options: [] })

async function onSim(action, c) {
  if (action === 'recharge') {
    recharge.value = { sim: c, amount: null, note: '' }
    rechargeOpen.value = true
  } else if (action === 'uses') {
    try {
      uses.value = (await api.get(`/ledger/sims/${c.id}/uses`)).data
      usesOpen.value = true
    } catch (err) {
      ElMessage.error(errText(err, '查不了'))
    }
  } else if (action === 'rebind') {
    try {
      const items = (await api.get('/ledger/sim-options')).data.items.filter((x) => x.id !== c.id)
      rebind.value = { sim: c, to: '', options: items }
      rebindOpen.value = true
    } catch (err) {
      ElMessage.error(errText(err, '卡的名单加载失败'))
    }
  }
}

async function saveRecharge() {
  const { sim, amount, note } = recharge.value
  if (!amount) {
    ElMessage.warning('填充了多少钱')
    return
  }
  try {
    await api.post(`/ledger/sims/${sim.id}/recharge`, { amount, note })
    rechargeOpen.value = false
    ElMessage.success('已记上')
    await openLp(current.value.id)
  } catch (err) {
    ElMessage.error(errText(err, '充值没记上'))
  }
}

async function saveRebind() {
  const { sim, to, options } = rebind.value
  if (!to) {
    ElMessage.warning('选换成哪个号。新号要先在台账里加上')
    return
  }
  const label = options.find((x) => x.id === to)?.label || ''
  try {
    await ElMessageBox.confirm(`台账里记着 ${sim.phone} 的地方都换成 ${label}，${sim.phone} 停用。平台上的换绑要你们自己去做。`, '换号', {
      type: 'warning', confirmButtonText: '换', cancelButtonText: '不换',
    })
  } catch {
    return
  }
  try {
    const { data } = await api.post(`/ledger/sims/${sim.id}/rebind`, { to_sim_id: to })
    rebindOpen.value = false
    ElMessage.success(`改了 ${data.moved} 处`)
    if (data.logins.length) {
      ElMessageBox.alert(`这些支付宝的登录名就是旧号，台账没改，要去支付宝改：${data.logins.join('、')}`, '还要去支付宝改', { type: 'warning' })
    }
    await openLp(current.value.id)
  } catch (err) {
    ElMessage.error(errText(err, '换号失败'))
  }
}

// ---- 授权对账 ----
const authDlg = ref(null)
const startAuth = (a) => authDlg.value.open(a.id, a.account)

// ---- 临时开放 ----
const grantOpen = ref(false)
const grantForm = ref({ staff_id: '', hours: 24, reason: '' })

async function loadStaff() {
  if (!staffOptions.value.length) {
    try {
      staffOptions.value = (await api.get('/ledger/staff-options')).data.items
    } catch (err) {
      ElMessage.error(errText(err, '员工名单加载失败'))
    }
  }
}

async function startGrant() {
  grantForm.value = { staff_id: '', hours: 24, reason: '' }
  grantOpen.value = true
  await loadStaff()
}

async function saveGrant() {
  if (!grantForm.value.staff_id) {
    ElMessage.warning('选一个人')
    return
  }
  try {
    await api.post('/ledger/grants', { ...grantForm.value, legal_person_id: current.value.id })
    grantOpen.value = false
    ElMessage.success('已开放。他打开后只能看一会儿')
  } catch (err) {
    ElMessage.error(errText(err, '开放失败'))
  }
}

// ---- 合并 ----
const mergeOpen = ref(false)
const mergeQ = ref('')
const mergeHits = ref([])

async function searchMerge() {
  if (!mergeQ.value.trim()) return
  try {
    const { data } = await api.get('/ledger/legal-persons', { params: { q: mergeQ.value.trim(), size: 20 } })
    mergeHits.value = data.items.filter((x) => x.id !== current.value.id)
  } catch (err) {
    ElMessage.error(errText(err, '搜索失败'))
  }
}

async function mergeInto(target) {
  try {
    await ElMessageBox.confirm(
      `把「${current.value.name}」下面的主体都挪到「${target.name}${target.phone ? '（' + target.phone + '）' : ''}」，然后删掉「${current.value.name}」？`,
      '合并', { type: 'warning', confirmButtonText: '合并', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const { data } = await api.post(`/ledger/legal-persons/${current.value.id}/merge`, { into_id: target.id })
    mergeOpen.value = false
    ElMessage.success('已合并')
    await openLp(data.id)
  } catch (err) {
    ElMessage.error(errText(err, '合并失败'))
  }
}

onMounted(async () => {
  load()
  try {
    opts.value = (await api.get('/ledger/options')).data
    saleShops.value = (await api.get('/ledger/sale-shop-options')).data.items
    devices.value = (await api.get('/ledger/devices')).data.items
  } catch {
    /* 下拉缺了不挡看台账 */
  }
})
</script>

<template>
  <!-- 电脑：清单是表格；点进一个法人，左边树、右边选中层的详情和下面各层的表格 -->
  <template v-if="isDesktop">
    <div v-if="current">
      <div class="lgd-card">
        <div class="lgd-card__head">
          <div class="d-head">
            <a class="lgd-back" @click="back">‹ 法人清单</a>
            <el-divider direction="vertical" />
            <b class="d-head__name">{{ current.name }}</b>
            <el-tag v-if="checkCount" size="small" type="warning">要核对 {{ checkCount }} 处</el-tag>
            <span class="lgd-muted">{{ current.phone || '没填手机号' }}<span v-if="current.email"> · {{ current.email }}</span></span>
          </div>
          <div class="lgd-toolbar">
            <el-button @click="startGrant">临时开放</el-button>
            <el-button @click="mergeOpen = true; mergeHits = []; mergeQ = ''">合并到…</el-button>
            <el-button type="success" plain @click="markChecked">核对完</el-button>
            <el-button type="danger" plain @click="remove('legal_person', current)">删掉这个法人</el-button>
          </div>
        </div>
      </div>
      <LedgerDesk :lp="current" :statuses="opts.statuses" editable @edit="startEdit" @add="startAdd" @remove="remove" @auth="startAuth" @sim="onSim" />
    </div>

    <div v-else class="lgd-card">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">法人 <small>共 {{ total }} 个</small></h3>
        <div class="lgd-toolbar">
          <el-input v-model="q" placeholder="搜法人、手机号、主体、信用代码、支付宝、店铺" clearable style="width: 340px" @keyup.enter="load(1)" @clear="load(1)" />
          <el-button type="primary" plain @click="load(1)">查询</el-button>
          <el-checkbox v-model="onlyCheck" @change="load(1)">只看要核对的</el-checkbox>
          <el-button type="primary" @click="startAdd('legal_person', {})">新建法人</el-button>
        </div>
      </div>
      <div class="lgd-card__body--table">
        <el-table v-loading="loading" :data="list" stripe empty-text="没有" class="d-table" @row-click="(row) => openLp(row.id)">
          <el-table-column label="法人" min-width="200">
            <template #default="{ row }">
              <b>{{ row.name }}</b>
              <el-tag v-if="row.needs_check" size="small" type="warning" class="d-tag">要核对</el-tag>
              <el-tag v-if="row.alerts" size="small" type="danger" effect="plain" class="d-tag">{{ row.alerts }} 件事要办</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主设备手机号" min-width="150">
            <template #default="{ row }">
              <span v-if="row.phone" class="lgd-num">{{ row.phone }}</span>
              <span v-else class="lgd-muted">没填手机号</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="{ active: 'success', paused: 'warning' }[row.status] || 'info'" effect="light">{{ opts.statuses[row.status] || row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主体" prop="entities" width="90" align="right" />
          <el-table-column label="支付宝" prop="alipays" width="90" align="right" />
          <el-table-column label="店铺" prop="shops" width="90" align="right" />
          <el-table-column label="" width="90" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click.stop="openLp(row.id)">打开</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="lgd-pager">
          <el-pagination
            layout="total, sizes, prev, pager, next"
            :total="total"
            :page-size="size"
            :page-sizes="[30, 50, 100]"
            :current-page="page"
            background
            @current-change="load"
            @size-change="onSize"
          />
        </div>
      </div>
    </div>
  </template>

  <!-- 手机：原样 -->
  <template v-else>
    <!-- 详情：一个法人整棵 -->
    <div v-if="current">
      <div class="lg-row" style="margin-bottom: 10px">
        <a class="ad-back" @click="back">‹ 返回</a>
        <div class="ad-ops">
          <el-button size="small" @click="startGrant">临时开放</el-button>
          <el-button size="small" @click="mergeOpen = true; mergeHits = []; mergeQ = ''">合并到…</el-button>
          <el-button size="small" type="success" plain @click="markChecked">核对完</el-button>
        </div>
      </div>
      <div class="lg-card">
        <LedgerTree :lp="current" editable @edit="startEdit" @add="startAdd" @remove="remove" @auth="startAuth" @sim="onSim" />
      </div>
      <el-button size="small" type="danger" plain @click="remove('legal_person', current)">删掉这个法人</el-button>
    </div>

    <!-- 清单 -->
    <div v-else>
      <div class="lg-card ad-search">
        <el-input v-model="q" placeholder="搜法人、手机号、主体、信用代码、支付宝、店铺" clearable @keyup.enter="load(1)" @clear="load(1)" />
        <div class="lg-row">
          <el-checkbox v-model="onlyCheck" @change="load(1)">只看要核对的</el-checkbox>
          <el-button type="primary" size="small" @click="startAdd('legal_person', {})">新建法人</el-button>
        </div>
      </div>
      <div v-loading="loading">
        <div v-if="!list.length && !loading" class="lg-card lg-muted">没有</div>
        <div v-for="x in list" :key="x.id" class="lg-card ad-item" @click="openLp(x.id)">
          <div class="lg-row">
            <div>
              <b>{{ x.name }}</b><span v-if="x.needs_check" class="lg-tag">要核对</span><span v-if="x.alerts" class="lg-tag ad-alert">{{ x.alerts }} 件事要办</span>
              <div class="lg-muted">{{ x.phone || '没填手机号' }}</div>
            </div>
            <div class="lg-muted ad-counts">主体 {{ x.entities }} · 支付宝 {{ x.alipays }} · 店铺 {{ x.shops }}</div>
          </div>
        </div>
        <el-pagination
          v-if="total > size"
          layout="prev, pager, next"
          :total="total"
          :page-size="size"
          :current-page="page"
          small
          @current-change="load"
        />
      </div>
    </div>

  </template>

  <!-- 改 / 加 -->
  <el-dialog v-model="editOpen" :title="(edit.id ? '改' : '加') + (edit.level === 'shop' && edit.data.role && edit.data.role !== 'sales' ? opts.shop_roles[edit.data.role] : LEVEL_LABEL[edit.level])" width="92%" style="max-width: 520px">
    <el-form label-position="top" class="lg-form">
      <template v-if="edit.level === 'legal_person'">
        <el-form-item label="姓名"><el-input v-model="edit.data.name" /></el-form-item>
        <el-form-item label="主设备手机号"><el-input v-model="edit.data.phone" /></el-form-item>
        <el-form-item label="主邮箱"><el-input v-model="edit.data.email" /></el-form-item>
        <el-form-item label="平台要刷脸时他多久能响应"><el-input v-model="edit.data.face_sla" placeholder="比如 2 小时内" /></el-form-item>
        <el-form-item label="代持协议到期日">
          <el-date-picker v-model="edit.data.agreement_end" type="date" value-format="YYYY-MM-DD" placeholder="到期前 30 天提醒续签" style="width: 100%" />
        </el-form-item>
        <el-form-item label="名下原来就有的个人卡（一证五号要扣掉）">
          <div class="ad-cards">
            <div v-for="c in Object.keys(opts.carriers)" :key="c" class="ad-cards__one">
              <span class="lg-muted">{{ c.replace('中国', '') }}</span>
              <el-input-number v-model="edit.data.personal_cards[c]" :min="0" :max="opts.cards_per_person || 5" size="small" :value-on-clear="0" />
            </div>
          </div>
        </el-form-item>
      </template>
      <template v-else-if="edit.level === 'sim'">
        <el-form-item label="手机号"><el-input v-model="edit.data.phone" /></el-form-item>
        <el-form-item label="运营商">
          <el-radio-group v-model="edit.data.carrier">
            <el-radio v-for="c in Object.keys(opts.carriers)" :key="c" :value="c">{{ c.replace('中国', '') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="哪种卡">
          <el-radio-group v-model="edit.data.category">
            <el-radio v-for="(label, k) in opts.sim_categories" :key="k" :value="k">{{ label }}</el-radio>
          </el-radio-group>
          <div class="lg-muted ad-hint">主卡、副卡实名在法人本人名下，算一证五号；外部合约卡实名在别人名下；员工实名卡是员工用自己身份证办的，离职后能挂失补卡，尽快换掉</div>
        </el-form-item>
        <el-form-item v-if="edit.data.category === 'employee'" label="在哪个员工名下">
          <el-select v-model="edit.data.staff_id" filterable style="width: 100%" @visible-change="(v) => v && loadStaff()">
            <el-option v-for="s in staffOptions" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <template v-if="edit.data.category === 'sub'">
          <el-form-item label="挂在哪张主卡下">
            <el-select v-model="edit.data.master_id" placeholder="同一家运营商的主卡" style="width: 100%">
              <el-option v-for="c in masterChoices" :key="c.id" :label="c.phone" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="话费">
            <el-radio-group v-model="edit.data.billing">
              <el-radio v-for="(label, k) in opts.sim_billings" :key="k" :value="k">{{ label }}</el-radio>
            </el-radio-group>
          </el-form-item>
        </template>
        <template v-if="edit.data.category === 'external'">
          <el-form-item label="实名在谁名下"><el-input v-model="edit.data.holder" /></el-form-item>
          <el-form-item label="从哪来的"><el-input v-model="edit.data.vendor" /></el-form-item>
          <el-form-item label="合约到期日">
            <el-date-picker v-model="edit.data.contract_end" type="date" value-format="YYYY-MM-DD" placeholder="到期前 30 天提醒换绑" style="width: 100%" />
          </el-form-item>
        </template>
        <el-form-item label="套餐"><el-input v-model="edit.data.plan" /></el-form-item>
        <el-form-item label="月租（元）"><el-input v-model="edit.data.monthly_rent" /></el-form-item>
        <el-form-item v-if="edit.data.billing !== 'shared' || edit.data.category !== 'sub'" label="话费余额（元）和哪天查的">
          <div class="ad-two">
            <el-input v-model="edit.data.balance" />
            <el-date-picker v-model="edit.data.balance_on" type="date" value-format="YYYY-MM-DD" />
          </div>
        </el-form-item>
        <el-form-item label="ICCID"><el-input v-model="edit.data.iccid" /></el-form-item>
        <el-form-item label="卡在谁手里"><el-input v-model="edit.data.custodian" /></el-form-item>
      </template>
      <template v-else-if="edit.level === 'entity'">
        <el-form-item label="名称"><el-input v-model="edit.data.name" /></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="edit.data.entity_type">
            <el-radio v-for="(label, key) in opts.entity_types" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="edit.data.entity_type !== 'person'">
        <el-form-item label="统一社会信用代码"><el-input v-model="edit.data.credit_code" /></el-form-item>
        <el-form-item label="成立日期">
          <el-date-picker v-model="edit.data.registered_on" type="date" value-format="YYYY-MM-DD" placeholder="今年成立的不提醒报去年的年报" style="width: 100%" />
        </el-form-item>
        <el-form-item label="纳税人">
          <el-radio-group v-model="edit.data.tax_payer">
            <el-radio v-for="(label, key) in opts.tax_payers" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="征收方式">
          <el-radio-group v-model="edit.data.tax_levy">
            <el-radio v-for="(label, key) in opts.tax_levies" :key="key" :value="key" :disabled="key === 'assessed' && edit.data.entity_type === 'company'">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="主管税务局"><el-input v-model="edit.data.tax_office" /></el-form-item>
        <el-form-item label="办税人手机号"><el-input v-model="edit.data.tax_phone" /></el-form-item>
        <el-form-item label="工商联络员手机号"><el-input v-model="edit.data.liaison_phone" /></el-form-item>
        <el-form-item label="年报报到哪一年">
          <el-input-number v-model="edit.data.report_year" :min="2000" :max="2100" :controls="false" :value-on-clear="null" placeholder="比如 2025" style="width: 100%" />
        </el-form-item>
        <el-form-item label="年报报送日期">
          <el-date-picker v-model="edit.data.report_filed_on" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="经营范围"><el-input v-model="edit.data.business_scope" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="数电票每月授信额度（元）"><el-input v-model="edit.data.invoice_quota" placeholder="开到 80% 提醒" /></el-form-item>
        </template>
        <p v-else class="lg-muted">没执照的个人闲鱼号挂这里，不算进一张执照 3 家闲鱼店里，也没有年报、免税线提醒。</p>
      </template>
      <template v-else-if="edit.level === 'alipay'">
        <el-form-item v-if="edit.id && parentChoices.length > 1" label="属于哪个主体">
          <el-select v-model="edit.data.entity_id" style="width: 100%">
            <el-option v-for="p in parentChoices" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="登录账号"><el-input v-model="edit.data.account" /></el-form-item>
        <el-form-item label="叫法"><el-input v-model="edit.data.alias" placeholder="内部怎么叫它，可不填" /></el-form-item>
        <el-form-item label="绑定手机号"><el-input v-model="edit.data.phone" placeholder="收验证码的那张卡" /></el-form-item>
        <el-form-item v-if="edit.id" label="支付宝用户号（2088 开头）"><el-input v-model="edit.data.alipay_user_id" /></el-form-item>
        <el-form-item label="用途">
          <el-radio-group v-model="edit.data.role">
            <el-radio v-for="(label, key) in opts.alipay_roles" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="edit.data.role === 'purchase'" label="因公付（从本主体的主资金号扣钱）">
          <el-switch v-model="edit.data.corporate_pay" />
        </el-form-item>
        <el-form-item label="日累计限额 / 单笔限额（元）">
          <div class="ad-two">
            <el-input v-model="edit.data.daily_limit" placeholder="日累计" />
            <el-input v-model="edit.data.single_limit" placeholder="单笔" />
          </div>
        </el-form-item>
        <el-form-item label="冻结 / 不能动的钱（元）"><el-input v-model="edit.data.frozen_reserve" /></el-form-item>
        <el-form-item label="财务科目编码"><el-input v-model="edit.data.book_code" placeholder="比如 1012.ALI-E1-M1" /></el-form-item>
        <el-form-item label="无密转账证书到期 / 报备的转账场景">
          <div class="ad-two">
            <el-date-picker v-model="edit.data.cert_expires_on" type="date" value-format="YYYY-MM-DD" placeholder="三张证书最早到期的" />
            <el-input v-model="edit.data.transfer_scene" placeholder="比如 二手回收" />
          </div>
        </el-form-item>
      </template>
      <template v-else-if="edit.level === 'shop'">
        <el-form-item label="账号用途">
          <el-radio-group v-model="edit.data.role" @change="onRole">
            <el-radio v-for="(label, key) in opts.shop_roles" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
          <div class="lg-muted ad-hint">买卖分开：销售店收钱，采购号只花钱（因公付），引流号不收不付</div>
        </el-form-item>
        <el-form-item v-if="edit.data.role !== 'marketing'" label="钱怎么走">
          <el-select v-model="edit.data.channel" style="width: 100%">
            <el-option v-for="key in roleChannels" :key="key" :label="opts.channels[key]" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="edit.data.channel === 'alipay'" label="收款支付宝">
          <el-select v-model="edit.data.alipay_id" placeholder="只有收款号能挂店铺" style="width: 100%">
            <el-option v-for="p in salesAlipays" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="edit.data.channel === 'corporate_pay'" label="从哪个采购支付宝扣">
          <el-select v-model="edit.data.alipay_id" placeholder="只能挂在采购支付宝上" style="width: 100%">
            <el-option v-for="p in purchaseAlipays" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </el-form-item>
        <template v-else>
          <el-form-item v-if="entityChoices.length > 1" label="属于哪个主体">
            <el-select v-model="edit.data.entity_id" style="width: 100%">
              <el-option v-for="p in entityChoices" :key="p.id" :label="p.label" :value="p.id" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="edit.data.role === 'sales'" label="商户号"><el-input v-model="edit.data.merchant_no" /></el-form-item>
        </template>
        <el-form-item v-if="edit.data.role === 'marketing'" label="往哪家店引流">
          <el-select v-model="edit.data.lead_shop_id" clearable placeholder="只能选销售店" style="width: 100%">
            <el-option v-for="p in leadChoices" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="平台">
          <el-radio-group v-model="edit.data.platform">
            <el-radio v-for="(label, key) in opts.platforms" :key="key" :value="key">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="edit.data.role === 'sales' ? '店铺名' : '账号名'"><el-input v-model="edit.data.name" /></el-form-item>
        <template v-if="edit.data.role === 'sales'">
          <el-form-item label="对应 ERP 店铺（闲鱼号）">
            <el-select v-model="edit.data.sale_shop_id" clearable filterable placeholder="对不上就不选" style="width: 100%">
              <el-option v-for="s in saleShops" :key="s.id" :label="s.label" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="平台服务费（%）"><el-input v-model="edit.data.fee_rate" placeholder="比如鱼小铺 1.6" /></el-form-item>
          <el-form-item label="已交保证金（元）"><el-input v-model="edit.data.deposit" /></el-form-item>
          <el-form-item label="保证金从哪个账户交的"><el-input v-model="edit.data.deposit_from" placeholder="关店退保证金原路退回" /></el-form-item>
          <el-form-item label="平台冻结 / 在途的钱（元）"><el-input v-model="edit.data.frozen" /></el-form-item>
        </template>
        <el-form-item label="开票口径">
          <el-select v-model="edit.data.invoice_mode" clearable style="width: 100%">
            <el-option v-for="(label, key) in opts.invoice_modes" :key="key" :label="label" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item label="财务科目编码"><el-input v-model="edit.data.book_code" /></el-form-item>
        <el-form-item label="币种">
          <el-select v-model="edit.data.currency" style="width: 100%">
            <el-option v-for="c in Object.keys(opts.currencies)" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定手机号"><el-input v-model="edit.data.phone" /></el-form-item>
        <el-form-item label="跑在哪个设备上">
          <el-select v-model="edit.data.device_id" clearable filterable placeholder="群控同步会按闲鱼号自动挂上" style="width: 100%">
            <el-option v-for="d in shopDevices" :key="d.id" :label="`${d.name}${d.gc_nick ? '（' + d.gc_nick + '）' : ''}`" :value="d.id" />
          </el-select>
        </el-form-item>
      </template>
      <el-form-item label="状态">
        <el-radio-group v-model="edit.data.status">
          <el-radio v-for="(label, key) in opts.statuses" :key="key" :value="key">{{ label }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="edit.data.note" type="textarea" :rows="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>

  <!-- 话费充值 -->
  <el-dialog v-model="rechargeOpen" :title="`给 ${recharge.sim?.phone || ''} 充话费`" width="92%" style="max-width: 420px">
    <el-form label-position="top" class="lg-form">
      <el-form-item label="充了多少（元）">
        <el-input-number v-model="recharge.amount" :min="0.01" :precision="2" :controls="false" :value-on-clear="null" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="recharge.note" placeholder="比如 OA 审批单号" /></el-form-item>
      <div class="lg-muted">余额会加上这笔，查余额的日期记成今天</div>
    </el-form>
    <template #footer>
      <el-button @click="rechargeOpen = false">取消</el-button>
      <el-button type="primary" @click="saveRecharge">记上</el-button>
    </template>
  </el-dialog>

  <!-- 这个号绑了什么 -->
  <el-dialog v-model="usesOpen" :title="`${uses.phone} 绑了什么`" width="92%" style="max-width: 480px">
    <div v-if="!uses.items.length" class="lg-muted">台账里没有地方记着这个号</div>
    <div v-for="(x, i) in uses.items" :key="i" class="ad-hit lg-row">
      <span class="lg-muted">{{ x.what }}</span><b>{{ x.name }}</b>
    </div>
  </el-dialog>

  <!-- 换号 -->
  <el-dialog v-model="rebindOpen" :title="`换掉 ${rebind.sim?.phone || ''}`" width="92%" style="max-width: 480px">
    <p class="lg-muted">台账里记着这个号的地方（法人、办税、联络员、支付宝和店铺的绑定手机号）都换成新号，旧卡从手机上拔掉、停用。</p>
    <el-select v-model="rebind.to" filterable placeholder="换成哪个号（要先在台账里加上）" style="width: 100%">
      <el-option v-for="o in rebind.options" :key="o.id" :label="o.label" :value="o.id" />
    </el-select>
    <template #footer>
      <el-button @click="rebindOpen = false">取消</el-button>
      <el-button type="primary" @click="saveRebind">换号</el-button>
    </template>
  </el-dialog>

  <!-- 临时开放 -->
  <el-dialog v-model="grantOpen" title="临时开放给一个人" width="92%" style="max-width: 520px">
    <el-form label-position="top" class="lg-form">
      <el-form-item label="开放给谁">
        <el-select v-model="grantForm.staff_id" filterable placeholder="选员工" style="width: 100%">
          <el-option v-for="s in staffOptions" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="多少小时内要打开">
        <el-input-number v-model="grantForm.hours" :min="1" :max="168" />
      </el-form-item>
      <el-form-item label="开放原因（他打开前只看得到这句）">
        <el-input v-model="grantForm.reason" placeholder="比如：核对这几家店的收款支付宝" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="grantOpen = false">取消</el-button>
      <el-button type="primary" @click="saveGrant">开放</el-button>
    </template>
  </el-dialog>

  <AuthLinkDialog ref="authDlg" />

  <!-- 合并 -->
  <el-dialog v-model="mergeOpen" title="合并到另一个法人" width="92%" style="max-width: 520px">
    <el-input v-model="mergeQ" placeholder="搜姓名或手机号" @keyup.enter="searchMerge">
      <template #append><el-button @click="searchMerge">搜</el-button></template>
    </el-input>
    <div v-for="x in mergeHits" :key="x.id" class="ad-hit lg-row" @click="mergeInto(x)">
      <span><b>{{ x.name }}</b> <span class="lg-muted">{{ x.phone || '没填手机号' }}</span></span>
      <span class="lg-muted">主体 {{ x.entities }}</span>
    </div>
  </el-dialog>
</template>

<style scoped>
.d-head { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; }
.d-head__name { font-size: 16px; }
.d-table :deep(.el-table__row) { cursor: pointer; }
.d-tag { margin-left: 8px; }
.ad-back { color: var(--lg-accent); cursor: pointer; font-size: 15px; }
.ad-ops { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.ad-search { display: flex; flex-direction: column; gap: 10px; }
.ad-item { cursor: pointer; }
.ad-counts { text-align: right; flex-shrink: 0; }
.ad-alert { background: #fef2f2; color: var(--lg-danger); }
.ad-hit { padding: 12px 4px; border-bottom: 1px solid var(--lg-line); cursor: pointer; }
.ad-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; width: 100%; }
.ad-cards__one { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ad-hint { width: 100%; }
.ad-two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; }
</style>
