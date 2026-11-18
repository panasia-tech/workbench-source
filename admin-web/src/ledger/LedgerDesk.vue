<script setup>
// 电脑上看一个法人：左边四层树，右边选中那一层的详情 + 它下面各层的表格。
// 和 LedgerTree.vue（手机）同一套事件：edit / add / remove / auth / sim；editable=false 时只读（临时开放给业务员看）。
import { computed, nextTick, ref, watch } from 'vue'
import api from './api'

const props = defineProps({
  lp: { type: Object, required: true },
  editable: { type: Boolean, default: false },
  statuses: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['edit', 'add', 'remove', 'auth', 'sim'])

const AUTH = { none: '没授权对账', authorized: '已授权对账', expired: '授权过期', error: '授权出错' }
const AUTH_TYPE = { none: 'info', authorized: 'success', expired: 'danger', error: 'danger' }
const STATUS_TYPE = { active: 'success', paused: 'warning', closed: 'info' }
const LEVEL_LABEL = { legal_person: '法人', entity: '主体', alipay: '支付宝', shop: '店铺' }
const CHILD = { legal_person: ['entity', '加主体'], entity: ['alipay', '加支付宝'], alipay: ['shop', '加店铺'] }
// 收款号挂销售店，采购支付宝挂采购号，主资金号什么都不挂
const canAddShop = (a) => a.role === 'sales' || a.role === 'purchase'
const shopWord = (a) => (a.role === 'purchase' ? '加采购号' : '加店铺')
const childLabel = (level, row) => (level === 'alipay' ? shopWord(row) : CHILD[level][1])
const roleTag = (s) => (s.role && s.role !== 'sales' ? s.role_label : '')

const statusLabel = (s) => props.statuses[s] || s || '—'
const key = (level, id) => `${level}:${id}`

// 拍平：每个支付宝 / 店铺都带上它的上级，表格里要显示
const flat = computed(() => {
  const lp = props.lp
  const entities = lp.entities || []
  const alipays = entities.flatMap((e) => (e.alipays || []).map((a) => ({ a, e })))
  // 不走支付宝的店铺直接挂在主体上，a 为空
  const shops = [
    ...alipays.flatMap(({ a, e }) => (a.shops || []).map((s) => ({ s, a, e }))),
    ...entities.flatMap((e) => (e.shops || []).map((s) => ({ s, a: null, e }))),
  ]
  return { entities, alipays, shops }
})

const treeData = computed(() => [{
  key: key('legal_person', props.lp.id), level: 'legal_person', row: props.lp,
  children: flat.value.entities.map((e) => ({
    key: key('entity', e.id), level: 'entity', row: e,
    children: [
      ...(e.alipays || []).map((a) => ({
        key: key('alipay', a.id), level: 'alipay', row: a,
        children: (a.shops || []).map((s) => ({ key: key('shop', s.id), level: 'shop', row: s })),
      })),
      ...(e.shops || []).map((s) => ({ key: key('shop', s.id), level: 'shop', row: s })),
    ],
  })),
}])

// ---- 选中哪一层 ----
const selKey = ref(key('legal_person', props.lp.id))
const tree = ref(null)

function findByKey(k) {
  const [level, id] = k.split(':')
  if (level === 'legal_person') return props.lp.id === id ? { level, row: props.lp } : null
  if (level === 'entity') {
    const e = flat.value.entities.find((x) => x.id === id)
    return e ? { level, row: e } : null
  }
  if (level === 'alipay') {
    const hit = flat.value.alipays.find((x) => x.a.id === id)
    return hit ? { level, row: hit.a, entity: hit.e } : null
  }
  const hit = flat.value.shops.find((x) => x.s.id === id)
  return hit ? { level, row: hit.s, alipay: hit.a, entity: hit.e } : null
}

const sel = computed(() => findByKey(selKey.value) || { level: 'legal_person', row: props.lp })

function select(level, row) {
  selKey.value = key(level, row.id)
  tree.value?.setCurrentKey(selKey.value)
}

// 保存 / 删除后整棵重新拿：选中的还在就留着，没了就回到法人
watch(() => props.lp, async () => {
  if (!findByKey(selKey.value)) selKey.value = key('legal_person', props.lp.id)
  await nextTick()
  tree.value?.setCurrentKey(selKey.value)
})

// 选中层下面的各层（法人：主体 + 支付宝 + 店铺；主体：支付宝 + 店铺；支付宝：店铺）
const below = computed(() => {
  const { level, row } = sel.value
  const f = flat.value
  if (level === 'legal_person') return { entities: f.entities, alipays: f.alipays, shops: f.shops }
  if (level === 'entity') return { alipays: f.alipays.filter((x) => x.e.id === row.id), shops: f.shops.filter((x) => x.e.id === row.id) }
  if (level === 'alipay') return { shops: f.shops.filter((x) => x.a && x.a.id === row.id) }
  return {}
})

function shopCount(e) {
  return (e.alipays || []).reduce((n, a) => n + (a.shops || []).length, (e.shops || []).length)
}

const money = (v) => (v == null ? '—' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)

// 一证五号：每家运营商 公司开的卡（主卡 + 副卡）+ 原有个人卡 / 5
const quota = computed(() => {
  const mine = props.lp.personal_cards || {}
  const used = { ...mine }
  for (const c of props.lp.sims || []) {
    if (c.status !== 'closed' && c.category !== 'external') used[c.carrier] = (used[c.carrier] || 0) + 1
  }
  return Object.entries(used).map(([carrier, n]) => ({ carrier: carrier.replace('中国', ''), n, mine: mine[carrier] || 0 }))
})
const simAlerts = computed(() => [...(props.lp.alerts || []), ...(props.lp.sims || []).flatMap((c) => c.alerts || [])])

// 选中一家对上了 ERP 店铺的销售店：拉最近 6 个月损益
const months = ref([])
watch(() => (sel.value.level === 'shop' ? sel.value.row : null), async (s) => {
  months.value = []
  if (!props.editable || !s || s.role !== 'sales' || !s.sale_shop_id) return
  try {
    months.value = (await api.get(`/ledger/shops/${s.id}/months`, { params: { n: 6 } })).data.items
  } catch {
    /* 损益拉不到不挡看店铺 */
  }
}, { immediate: true })
function simKind(c) {
  if (c.category === 'sub') return `副卡 · ${c.master_phone || '?'}${c.billing === 'shared' ? ' 共用话费' : ''}`
  if (c.category === 'external') return `外部合约卡 · ${c.holder || ''}`
  return c.category_label
}
</script>

<template>
  <div class="ldk">
    <!-- 左：树 -->
    <div class="lgd-card ldk-tree">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">结构 <small>主体 {{ flat.entities.length }} · 支付宝 {{ flat.alipays.length }} · 店铺 {{ flat.shops.length }}</small></h3>
      </div>
      <div class="ldk-tree__body">
        <el-tree
          ref="tree"
          :data="treeData"
          node-key="key"
          :current-node-key="selKey"
          highlight-current
          default-expand-all
          :expand-on-click-node="false"
          @node-click="(d) => select(d.level, d.row)"
        >
          <template #default="{ data }">
            <span class="ldk-node">
              <span class="ldk-node__level">{{ data.level === 'shop' ? data.row.platform_label + (roleTag(data.row) ? '·' + roleTag(data.row) : '') : data.level === 'alipay' ? data.row.role_label : LEVEL_LABEL[data.level] }}</span>
              <span :class="['ldk-node__name', { 'ldk-node__name--b': data.level !== 'shop' }]" :title="data.level === 'alipay' ? data.row.account : data.row.name">{{ data.level === 'alipay' ? data.row.account : data.row.name }}</span>
              <span v-if="editable && data.row.needs_check" class="ldk-dot" title="要核对" />
              <span v-if="data.level !== 'legal_person' && (data.row.alerts || []).length" class="ldk-dot ldk-dot--alert" :title="data.row.alerts.map((x) => x.text).join('；')" />
              <span v-if="editable && data.level === 'alipay'" :class="['ldk-auth', 'ldk-auth--' + (data.row.auth_status || 'none')]">{{ AUTH[data.row.auth_status || 'none'] }}</span>
            </span>
          </template>
        </el-tree>
        <div v-if="!flat.entities.length" class="lgd-muted ldk-tree__empty">还没有主体</div>
      </div>
    </div>

    <!-- 右：选中层的详情 + 下面各层 -->
    <div class="ldk-main">
      <div class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">
            <el-tag size="small" effect="plain" type="info">{{ sel.level === 'shop' ? sel.row.platform_label + (sel.row.role_label || '店铺') : LEVEL_LABEL[sel.level] }}</el-tag>
            {{ sel.level === 'alipay' ? sel.row.account : sel.row.name }}
            <el-tag v-if="editable && sel.row.needs_check" size="small" type="warning">要核对</el-tag>
            <el-tag v-if="sel.row.status" size="small" :type="STATUS_TYPE[sel.row.status] || 'info'" effect="light">{{ statusLabel(sel.row.status) }}</el-tag>
          </h3>
          <div v-if="editable" class="lgd-toolbar">
            <el-button size="small" type="primary" plain @click="emit('edit', sel.level, sel.row)">改</el-button>
            <el-button v-if="CHILD[sel.level] && (sel.level !== 'alipay' || canAddShop(sel.row))" size="small" @click="emit('add', CHILD[sel.level][0], sel.row)">{{ childLabel(sel.level, sel.row) }}</el-button>
            <el-button v-if="sel.level === 'entity'" size="small" @click="emit('add', 'shop', sel.row, true)">加不走支付宝的店铺</el-button>
            <el-button v-if="sel.level === 'entity'" size="small" @click="emit('add', 'shop', sel.row, 'marketing')">加引流号</el-button>
            <el-button v-if="sel.level === 'alipay' && sel.row.auth_status !== 'authorized'" size="small" @click="emit('auth', sel.row)">授权对账</el-button>
            <el-button v-if="sel.level !== 'legal_person'" size="small" type="danger" plain @click="emit('remove', sel.level, sel.row)">删</el-button>
          </div>
        </div>
        <div class="lgd-card__body">
          <div v-if="sel.level !== 'legal_person' && (sel.row.alerts || []).length" class="ldk-alerts">
            <el-alert v-for="(x, i) in sel.row.alerts" :key="i" :title="x.text" :type="x.level === 'danger' ? 'error' : 'warning'" :closable="false" show-icon />
          </div>
          <div v-if="sel.level === 'legal_person' && simAlerts.length" class="ldk-alerts">
            <el-alert v-for="(x, i) in simAlerts" :key="i" :title="x.text" :type="x.level === 'danger' ? 'error' : 'warning'" :closable="false" show-icon />
          </div>
          <el-descriptions :column="2" border size="small" class="ldk-desc">
            <template v-if="sel.level === 'legal_person'">
              <el-descriptions-item label="姓名">{{ sel.row.name }}</el-descriptions-item>
              <el-descriptions-item label="状态">{{ statusLabel(sel.row.status) }}</el-descriptions-item>
              <el-descriptions-item label="主设备手机号">{{ sel.row.phone || '没填手机号' }}</el-descriptions-item>
              <el-descriptions-item label="主邮箱">{{ sel.row.email || '—' }}</el-descriptions-item>
              <el-descriptions-item label="刷脸响应">{{ sel.row.face_sla || '—' }}</el-descriptions-item>
              <el-descriptions-item label="代持协议到期">{{ sel.row.agreement_end || '—' }}</el-descriptions-item>
              <el-descriptions-item label="一证五号" :span="2">
                <span v-if="!quota.length" class="lgd-muted">名下还没有卡</span>
                <span v-for="q in quota" :key="q.carrier" :class="['ldk-quota', { 'lgd-danger': q.n >= 5 }]">
                  {{ q.carrier }} {{ q.n }}/5<span v-if="q.mine" class="lgd-muted">（原有个人卡 {{ q.mine }}）</span>
                </span>
              </el-descriptions-item>
            </template>
            <template v-else-if="sel.level === 'entity'">
              <el-descriptions-item label="名称" :span="2">{{ sel.row.name }}</el-descriptions-item>
              <el-descriptions-item label="类型">{{ sel.row.entity_type_label }}</el-descriptions-item>
              <el-descriptions-item label="统一社会信用代码">{{ sel.row.credit_code || '—' }}</el-descriptions-item>
              <el-descriptions-item label="成立日期">{{ sel.row.registered_on || '—' }}</el-descriptions-item>
              <el-descriptions-item label="纳税">{{ sel.row.tax_payer_label }} · {{ sel.row.tax_levy_label }}</el-descriptions-item>
              <el-descriptions-item label="主管税务局">{{ sel.row.tax_office || '—' }}</el-descriptions-item>
              <el-descriptions-item label="办税人手机号">{{ sel.row.tax_phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="工商联络员手机号">{{ sel.row.liaison_phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="年报">{{ sel.row.report_year ? `报到 ${sel.row.report_year} 年` : '没记' }}<span v-if="sel.row.report_filed_on" class="lgd-muted">（{{ sel.row.report_filed_on }} 报的）</span></el-descriptions-item>
              <el-descriptions-item v-if="sel.row.entity_type !== 'person'" label="闲鱼店">{{ sel.row.xianyu_shops || 0 }} / 3 家</el-descriptions-item>
              <el-descriptions-item v-if="sel.row.entity_type === 'individual'" label="本月卖货额">
                {{ money(sel.row.month_sales) }}<span v-if="sel.row.tax_payer === 'small'" class="lgd-muted"> / 月 10 万</span>
              </el-descriptions-item>
              <el-descriptions-item v-if="sel.row.tax_payer === 'small' && sel.row.entity_type !== 'person'" label="连续 12 个月">
                {{ money(sel.row.year_sales) }}<span class="lgd-muted"> / 500 万转一般纳税人</span>
              </el-descriptions-item>
              <el-descriptions-item label="本季度卖货额" :span="2">
                {{ money(sel.row.quarter_sales) }}
                <el-tooltip content="ERP 出库单按这件货在哪家店记了售出、归到挂着那家店的主体；平台上成交但没进 ERP 的不算" placement="top">
                  <span class="lgd-muted ldk-q">至少</span>
                </el-tooltip>
                <span v-if="sel.row.tax_payer === 'small'" class="lgd-muted">/ 30 万免税线</span>
              </el-descriptions-item>
              <el-descriptions-item label="经营范围" :span="2">{{ sel.row.business_scope || '—' }}</el-descriptions-item>
              <el-descriptions-item label="每月开票额度">{{ money(sel.row.invoice_quota) }}</el-descriptions-item>
            </template>
            <template v-else-if="sel.level === 'alipay'">
              <el-descriptions-item label="登录账号">{{ sel.row.account }}</el-descriptions-item>
              <el-descriptions-item label="叫法">{{ sel.row.alias || '—' }}</el-descriptions-item>
              <el-descriptions-item label="支付宝用户号">{{ sel.row.alipay_user_id || '—' }}</el-descriptions-item>
              <el-descriptions-item label="绑定手机号">{{ sel.row.phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="限额">日 {{ money(sel.row.daily_limit) }} · 单笔 {{ money(sel.row.single_limit) }}</el-descriptions-item>
              <el-descriptions-item label="冻结 / 不能动">{{ money(sel.row.frozen_reserve) }}</el-descriptions-item>
              <el-descriptions-item label="财务科目">{{ sel.row.book_code || '—' }}</el-descriptions-item>
              <el-descriptions-item label="转账证书到期">{{ sel.row.cert_expires_on || '—' }}<span v-if="sel.row.transfer_scene" class="lgd-muted"> · {{ sel.row.transfer_scene }}</span></el-descriptions-item>
              <el-descriptions-item v-if="sel.row.role === 'purchase'" label="本月采购净支出">
                {{ sel.row.month_purchase != null ? money(sel.row.month_purchase) : '—' }}
                <el-tooltip content="对账账单里的采购付款 − 采购退款（团购券过期退回来的冲成本）；要先授权对账才有" placement="top">
                  <span class="lgd-muted ldk-q">怎么算</span>
                </el-tooltip>
              </el-descriptions-item>
              <el-descriptions-item label="用途">{{ sel.row.role_label }}<span v-if="sel.row.corporate_pay" class="lgd-muted"> · 因公付（从主资金号扣）</span></el-descriptions-item>
              <el-descriptions-item label="属于主体">
                <a class="ldk-link" @click="select('entity', sel.entity)">{{ sel.entity.name }}</a>
              </el-descriptions-item>
              <el-descriptions-item v-if="editable" label="授权对账" :span="2">
                <el-tag size="small" :type="AUTH_TYPE[sel.row.auth_status || 'none']">{{ AUTH[sel.row.auth_status || 'none'] }}</el-tag>
                <span v-if="sel.row.auth_error" class="lgd-danger ldk-autherr">{{ sel.row.auth_error }}</span>
              </el-descriptions-item>
            </template>
            <template v-else>
              <el-descriptions-item label="平台">{{ sel.row.platform_label }} · {{ sel.row.role_label }}</el-descriptions-item>
              <el-descriptions-item label="名称">{{ sel.row.name }}</el-descriptions-item>
              <el-descriptions-item v-if="sel.row.role === 'sales'" label="ERP 店铺">{{ sel.row.sale_shop_label || '没对上' }}</el-descriptions-item>
              <el-descriptions-item v-if="sel.row.role === 'marketing'" label="往哪引流">{{ sel.row.lead_shop_name || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="sel.alipay" :label="sel.row.role === 'purchase' ? '从这个支付宝扣' : '收款支付宝'">
                <a class="ldk-link" @click="select('alipay', sel.alipay)">{{ sel.alipay.account }}</a>
              </el-descriptions-item>
              <el-descriptions-item v-else label="结算">{{ sel.row.channel_label }}<span v-if="sel.row.merchant_no"> · {{ sel.row.merchant_no }}</span></el-descriptions-item>
              <el-descriptions-item label="平台服务费">{{ sel.row.fee_rate != null ? sel.row.fee_rate + '%' : '—' }}</el-descriptions-item>
              <el-descriptions-item label="保证金">{{ money(sel.row.deposit) }}<span v-if="sel.row.deposit_from" class="lgd-muted"> · 从 {{ sel.row.deposit_from }} 交</span></el-descriptions-item>
              <el-descriptions-item v-if="sel.row.role === 'sales'" label="冻结 / 在途">{{ money(sel.row.frozen) }}</el-descriptions-item>
              <el-descriptions-item label="开票口径">{{ sel.row.invoice_label || '—' }}</el-descriptions-item>
              <el-descriptions-item label="币种">{{ sel.row.currency || 'CNY' }}</el-descriptions-item>
              <el-descriptions-item label="财务科目">{{ sel.row.book_code || '—' }}</el-descriptions-item>
              <el-descriptions-item label="绑定手机号">{{ sel.row.phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="跑在">{{ sel.row.device_name || '—' }}</el-descriptions-item>
              <el-descriptions-item label="属于主体" :span="2">
                <a class="ldk-link" @click="select('entity', sel.entity)">{{ sel.entity.name }}</a>
              </el-descriptions-item>
            </template>
            <el-descriptions-item v-if="sel.level !== 'legal_person'" label="状态">{{ statusLabel(sel.row.status) }}</el-descriptions-item>
            <el-descriptions-item label="备注" :span="sel.level === 'legal_person' ? 2 : 1">{{ sel.row.note || '—' }}</el-descriptions-item>
          </el-descriptions>
        </div>
      </div>

      <!-- 单店月度损益：选中对上了 ERP 店铺的销售店 -->
      <div v-if="sel.level === 'shop' && months.length" class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">每月损益
            <el-tooltip content="按 ERP 出库算，和经营账单同一口径：卖了多少 − 成本 − 闲鱼服务费 − 本月退货回冲的毛利。平台上成交但没进 ERP 的不算" placement="top">
              <small class="ldk-q">怎么算</small>
            </el-tooltip>
          </h3>
        </div>
        <div class="lgd-card__body--table">
          <el-table :data="months" size="small">
            <el-table-column label="月份" prop="month" width="90" />
            <el-table-column label="卖了" align="right"><template #default="{ row }">{{ money(row.gmv) }}<span class="lgd-muted"> · {{ row.count }} 件</span></template></el-table-column>
            <el-table-column label="成本" align="right"><template #default="{ row }">{{ money(row.cost) }}</template></el-table-column>
            <el-table-column label="服务费" align="right"><template #default="{ row }">{{ money(row.fee) }}</template></el-table-column>
            <el-table-column label="退货" align="right"><template #default="{ row }">{{ row.returns ? money(row.refund) + ' · ' + row.returns + ' 件' : '—' }}</template></el-table-column>
            <el-table-column label="净毛利" align="right"><template #default="{ row }"><b :class="{ 'lgd-danger': Number(row.net) < 0 }">{{ money(row.net) }}</b></template></el-table-column>
          </el-table>
        </div>
      </div>

      <!-- 手机卡：只在法人这一层 -->
      <div v-if="sel.level === 'legal_person'" class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">手机卡 <small>{{ (lp.sims || []).length }}</small></h3>
          <el-button v-if="editable" size="small" @click="emit('add', 'sim', lp)">加手机卡</el-button>
        </div>
        <div class="lgd-card__body--table">
          <el-table :data="lp.sims || []" size="small" empty-text="还没有手机卡">
            <el-table-column label="号码" min-width="140">
              <template #default="{ row }">
                <b class="lgd-num">{{ row.phone }}</b>
                <el-tag v-if="editable && row.needs_check" size="small" type="warning" class="ldk-tag">要核对</el-tag>
                <div v-for="(x, i) in row.alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ldk-warn'">{{ x.text.replace(row.phone + ' ', '') }}</div>
              </template>
            </el-table-column>
            <el-table-column label="运营商" width="80">
              <template #default="{ row }">{{ row.carrier.replace('中国', '') }}</template>
            </el-table-column>
            <el-table-column label="哪种卡" min-width="150">
              <template #default="{ row }">{{ simKind(row) }}<div v-if="row.contract_end" class="lgd-muted">合约到 {{ row.contract_end }}</div></template>
            </el-table-column>
            <el-table-column label="话费" width="130">
              <template #default="{ row }">
                <span v-if="row.billing === 'shared'" class="lgd-muted">共用主卡</span>
                <template v-else>{{ money(row.balance) }}<span v-if="row.monthly_rent" class="lgd-muted"> / 月租 {{ money(row.monthly_rent) }}</span></template>
                <div v-if="row.balance_on" class="lgd-muted">{{ row.balance_on }} 查的</div>
              </template>
            </el-table-column>
            <el-table-column label="插在" min-width="110">
              <template #default="{ row }">{{ row.in_device || '—' }}<div v-if="row.custodian" class="lgd-muted">{{ row.custodian }} 拿着</div></template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">{{ statusLabel(row.status) }}</template>
            </el-table-column>
            <el-table-column v-if="editable" label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="emit('edit', 'sim', row)">改</el-button>
                <el-button v-if="row.billing !== 'shared'" link type="primary" size="small" @click="emit('sim', 'recharge', row)">充值</el-button>
                <el-button link type="primary" size="small" @click="emit('sim', 'uses', row)">绑了什么</el-button>
                <el-button v-if="row.status !== 'closed'" link type="primary" size="small" @click="emit('sim', 'rebind', row)">换号</el-button>
                <el-button link type="danger" size="small" @click="emit('remove', 'sim', row)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- 主体 -->
      <div v-if="below.entities" class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">主体 <small>{{ below.entities.length }}</small></h3>
          <el-button v-if="editable" size="small" @click="emit('add', 'entity', lp)">加主体</el-button>
        </div>
        <div class="lgd-card__body--table">
          <el-table :data="below.entities" size="small" empty-text="还没有主体">
            <el-table-column label="名称" min-width="170">
              <template #default="{ row }">
                <a class="ldk-link" @click="select('entity', row)">{{ row.name }}</a>
                <el-tag v-if="editable && row.needs_check" size="small" type="warning" class="ldk-tag">要核对</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="类型" prop="entity_type_label" width="70" />
            <el-table-column label="纳税" width="90">
              <template #default="{ row }">{{ row.tax_payer_label }}</template>
            </el-table-column>
            <el-table-column label="要办的事" min-width="160">
              <template #default="{ row }">
                <span v-if="!(row.alerts || []).length" class="lgd-muted">—</span>
                <div v-for="(x, i) in row.alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ldk-warn'">{{ x.text }}</div>
              </template>
            </el-table-column>
            <el-table-column label="统一社会信用代码" min-width="160">
              <template #default="{ row }">{{ row.credit_code || '—' }}</template>
            </el-table-column>
            <el-table-column label="支付宝" width="64" align="right">
              <template #default="{ row }">{{ (row.alipays || []).length }}</template>
            </el-table-column>
            <el-table-column label="店铺" width="60" align="right">
              <template #default="{ row }">{{ shopCount(row) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">{{ statusLabel(row.status) }}</template>
            </el-table-column>
            <el-table-column v-if="editable" label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="emit('edit', 'entity', row)">改</el-button>
                <el-button link type="primary" size="small" @click="emit('add', 'alipay', row)">加支付宝</el-button>
                <el-button link type="danger" size="small" @click="emit('remove', 'entity', row)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- 支付宝 -->
      <div v-if="below.alipays" class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">支付宝 <small>{{ below.alipays.length }}</small></h3>
          <el-button v-if="editable && sel.level === 'entity'" size="small" @click="emit('add', 'alipay', sel.row)">加支付宝</el-button>
        </div>
        <div class="lgd-card__body--table">
          <el-table :data="below.alipays" size="small" empty-text="还没有支付宝">
            <el-table-column label="登录账号 / 叫法 / 用户号" min-width="170">
              <template #default="{ row }">
                <a class="ldk-link" @click="select('alipay', row.a)">{{ row.a.account }}</a>
                <el-tag v-if="editable && row.a.needs_check" size="small" type="warning" class="ldk-tag">要核对</el-tag>
                <div v-if="row.a.alias || row.a.alipay_user_id" class="lgd-muted">{{ [row.a.alias, row.a.alipay_user_id].filter(Boolean).join(' · ') }}</div>
              </template>
            </el-table-column>
            <el-table-column v-if="sel.level === 'legal_person'" label="主体" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.e.name }}</template>
            </el-table-column>
            <el-table-column label="用途" width="110">
              <template #default="{ row }">{{ row.a.role_label }}<div v-if="row.a.corporate_pay" class="lgd-muted">因公付</div></template>
            </el-table-column>
            <el-table-column v-if="editable" label="授权对账" width="100">
              <template #default="{ row }">
                <el-tooltip :disabled="!row.a.auth_error" :content="row.a.auth_error || ''" placement="top">
                  <el-tag size="small" :type="AUTH_TYPE[row.a.auth_status || 'none']">{{ AUTH[row.a.auth_status || 'none'] }}</el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="店铺" width="60" align="right">
              <template #default="{ row }">{{ (row.a.shops || []).length }}</template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">{{ statusLabel(row.a.status) }}</template>
            </el-table-column>
            <el-table-column v-if="editable" label="操作" width="190" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="emit('edit', 'alipay', row.a)">改</el-button>
                <el-button v-if="canAddShop(row.a)" link type="primary" size="small" @click="emit('add', 'shop', row.a)">{{ shopWord(row.a) }}</el-button>
                <el-button v-if="row.a.auth_status !== 'authorized'" link type="primary" size="small" @click="emit('auth', row.a)">授权对账</el-button>
                <el-button link type="danger" size="small" @click="emit('remove', 'alipay', row.a)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <!-- 店铺 -->
      <div v-if="below.shops" class="lgd-card">
        <div class="lgd-card__head">
          <h3 class="lgd-card__title">店铺 <small>{{ below.shops.length }}</small></h3>
          <el-button v-if="editable && sel.level === 'alipay' && canAddShop(sel.row)" size="small" @click="emit('add', 'shop', sel.row)">{{ shopWord(sel.row) }}</el-button>
          <el-button v-if="editable && sel.level === 'entity'" size="small" @click="emit('add', 'shop', sel.row, true)">加不走支付宝的店铺</el-button>
        </div>
        <div class="lgd-card__body--table">
          <el-table :data="below.shops" size="small" empty-text="还没有店铺">
            <el-table-column label="平台" width="86">
              <template #default="{ row }">{{ row.s.platform_label }}<div v-if="roleTag(row.s)" class="lgd-muted">{{ roleTag(row.s) }}</div></template>
            </el-table-column>
            <el-table-column label="店铺名" min-width="150">
              <template #default="{ row }">
                <a class="ldk-link" @click="select('shop', row.s)">{{ row.s.name }}</a>
                <el-tag v-if="editable && row.s.needs_check" size="small" type="warning" class="ldk-tag">要核对</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="ERP 店铺" min-width="130">
              <template #default="{ row }">
                <span v-if="row.s.sale_shop_label">{{ row.s.sale_shop_label }}</span>
                <span v-else class="lgd-muted">没对上</span>
              </template>
            </el-table-column>
            <el-table-column v-if="sel.level !== 'alipay'" :label="sel.level === 'legal_person' ? '结算到 / 主体' : '结算到'" min-width="170">
              <template #default="{ row }">
                <template v-if="row.a">{{ row.a.account }}</template>
                <template v-else>{{ row.s.channel_label }}<span v-if="row.s.merchant_no" class="lgd-muted"> {{ row.s.merchant_no }}</span></template>
                <div v-if="sel.level === 'legal_person'" class="lgd-muted ldk-ell">{{ row.e.name }}</div>
              </template>
            </el-table-column>
            <el-table-column label="服务费" width="76" align="right">
              <template #default="{ row }">{{ row.s.fee_rate != null ? row.s.fee_rate + '%' : '—' }}</template>
            </el-table-column>
            <el-table-column label="保证金" width="96" align="right">
              <template #default="{ row }">{{ money(row.s.deposit) }}</template>
            </el-table-column>
            <el-table-column label="本月净毛利" width="104" align="right">
              <template #default="{ row }">
                <span v-if="row.s.month" :class="{ 'lgd-danger': Number(row.s.month.net) < 0 }">{{ money(row.s.month.net) }}</span>
                <span v-else class="lgd-muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="70">
              <template #default="{ row }">{{ statusLabel(row.s.status) }}</template>
            </el-table-column>
            <el-table-column v-if="editable" label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="emit('edit', 'shop', row.s)">改</el-button>
                <el-button link type="danger" size="small" @click="emit('remove', 'shop', row.s)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ldk { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; align-items: start; }
/* 1024～1199 的窄电脑屏：树收窄，右边表格少横向滚动 */
@media (max-width: 1199px) { .ldk { grid-template-columns: 240px minmax(0, 1fr); } }
.ldk-tree { position: sticky; top: 0; margin-bottom: 0; }
.ldk-tree__body { padding: 8px; max-height: calc(100vh - 260px); overflow: auto; }
.ldk-tree__empty { padding: 8px 12px; }
.ldk-tree :deep(.el-tree-node__content) { height: 32px; border-radius: 6px; }
.ldk-tree :deep(.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content) { background: #e6f4ff; }
.ldk-node { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; }
.ldk-node__level { font-size: 12px; color: var(--lgd-ink-2); flex-shrink: 0; }
.ldk-node__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ldk-node__name--b { font-weight: 600; }
.ldk-dot { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; flex-shrink: 0; }
.ldk-auth { font-size: 11px; padding: 0 5px; border-radius: 4px; background: #f3f4f6; color: var(--lgd-ink-2); flex-shrink: 0; }
.ldk-auth--authorized { background: #ecfdf5; color: #047857; }
.ldk-auth--expired, .ldk-auth--error { background: #fef2f2; color: var(--lg-danger); }
.ldk-main { min-width: 0; }
.ldk-desc :deep(.el-descriptions__label) { width: 130px; }
.ldk-link { color: var(--lgd-primary); cursor: pointer; }
.ldk-link:hover { text-decoration: underline; }
.ldk-tag { margin-left: 6px; }
.ldk-ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ldk-autherr { margin-left: 8px; font-size: 12px; }
.ldk-dot--alert { background: var(--lg-danger); }
.ldk-alerts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.ldk-warn { color: #b45309; }
.ldk-q { margin: 0 4px; border-bottom: 1px dashed currentColor; cursor: help; }
.ldk-quota + .ldk-quota { margin-left: 14px; }
</style>
