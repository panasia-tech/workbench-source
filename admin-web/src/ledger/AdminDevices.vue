<script setup>
// 代理 IP 和设备（AdsPower 环境、手机、电脑）。设备从群控同步过来，人补用途、代理、卡槽、开在哪台电脑上。
// 增删改走 /ledger/rows/{proxy|device}，规矩在后端（同平台不共用代理、一卡一机……）。
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()

const opts = ref({ statuses: {}, proxy_protocols: {}, device_kinds: {}, device_purposes: {} })
const proxies = ref([])
const monthlyTotal = ref(null)
const devices = ref([])
const kind = ref('')
const simOptions = ref([])
const loading = ref(false)
const syncing = ref(false)

const STATUS_TYPE = { active: 'success', paused: 'warning', closed: 'info' }
const money = (v) => (v == null ? '—' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)
const shown = computed(() => (kind.value ? devices.value.filter((d) => d.kind === kind.value) : devices.value))
const pcs = computed(() => devices.value.filter((d) => d.kind === 'pc'))
const kindCount = (k) => devices.value.filter((d) => d.kind === k).length

async function load() {
  loading.value = true
  try {
    const [p, d, s] = await Promise.all([api.get('/ledger/proxies'), api.get('/ledger/devices'), api.get('/ledger/sim-options')])
    proxies.value = p.data.items
    monthlyTotal.value = p.data.monthly_total
    devices.value = d.data.items
    simOptions.value = s.data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function sync() {
  syncing.value = true
  try {
    const { data } = await api.post('/ledger/devices/sync')
    ElMessage.success(`同步完了：新加 ${data.created} 个，更新 ${data.updated} 个，挂上店铺 ${data.shops_linked} 家，插上卡 ${data.sims_put} 张`)
    await load()
  } catch (err) {
    ElMessage.error(errText(err, '同步失败'))
  } finally {
    syncing.value = false
  }
}

// ---- 改 / 加 ----
const editOpen = ref(false)
const edit = ref({ level: '', id: null, data: {} })
const PICK = {
  proxy: ['code', 'provider', 'protocol', 'host', 'port', 'exit_ip', 'region', 'monthly_cost', 'expires_on', 'status', 'note'],
  device: ['kind', 'name', 'purpose', 'ads_user_id', 'model', 'serial', 'imei1', 'imei2', 'host_id', 'proxy_id', 'sim1_id',
    'sim2_id', 'custodian', 'location', 'status', 'note'],
}
const NULLS = ['port', 'monthly_cost', 'expires_on', 'host_id', 'proxy_id', 'sim1_id', 'sim2_id', 'ads_user_id']

function startEdit(level, row) {
  edit.value = { level, id: row.id, data: Object.fromEntries(PICK[level].map((k) => [k, row[k] ?? (k === 'port' ? null : '')])) }
  editOpen.value = true
}

function startAdd(level) {
  const data = Object.fromEntries(PICK[level].map((k) => [k, k === 'port' ? null : '']))
  Object.assign(data, level === 'proxy' ? { protocol: 'socks5', status: 'active' } : { kind: kind.value || 'env', purpose: 'sales', status: 'active' })
  edit.value = { level, id: null, data }
  editOpen.value = true
}

const saving = ref(false)
async function saveEdit() {
  const { level, id, data } = edit.value
  const body = { ...data }
  for (const k of NULLS) if (k in body && (body[k] === '' || body[k] === undefined)) body[k] = null
  saving.value = true
  try {
    if (id) await api.patch(`/ledger/rows/${level}/${id}`, body)
    else await api.post(`/ledger/rows/${level}`, body)
    editOpen.value = false
    ElMessage.success('已保存')
    await load()
  } catch (err) {
    ElMessage.error(errText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(level, row) {
  try {
    await ElMessageBox.confirm(`删掉${level === 'proxy' ? '代理 ' + row.code : row.name}？删了找不回来。`, '删除', {
      type: 'warning', confirmButtonText: '删', cancelButtonText: '不删',
    })
  } catch {
    return
  }
  try {
    await api.delete(`/ledger/rows/${level}/${row.id}`)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    ElMessage.error(errText(err, '删除失败'))
  }
}

// ---- 续期 / 记录 ----
const renewOpen = ref(false)
const renew = ref({ proxy: null, months: 1, amount: null, note: '' })
function startRenew(p) {
  renew.value = { proxy: p, months: 1, amount: p.monthly_cost != null ? Number(p.monthly_cost) : null, note: '' }
  renewOpen.value = true
}
async function saveRenew() {
  const { proxy, months, amount, note } = renew.value
  try {
    const { data } = await api.post(`/ledger/proxies/${proxy.id}/renew`, { months, amount, note })
    renewOpen.value = false
    ElMessage.success(`已续到 ${data.expires_on}`)
    await load()
  } catch (err) {
    ElMessage.error(errText(err, '续期失败'))
  }
}

const chargesOpen = ref(false)
const charges = ref({ title: '', items: [] })
async function showCharges(p) {
  try {
    charges.value = { title: `代理 ${p.code} 的续期记录`, items: (await api.get('/ledger/charges', { params: { target_id: p.id } })).data.items }
    chargesOpen.value = true
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  }
}

onMounted(async () => {
  load()
  try {
    opts.value = (await api.get('/ledger/options')).data
  } catch {
    /* 下拉缺了不挡看清单 */
  }
})
</script>

<template>
  <!-- 电脑：两张表 -->
  <template v-if="isDesktop">
    <div class="lgd-card">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">代理 IP <small>{{ proxies.length }} 条 · 在用的每月 {{ money(monthlyTotal) }}</small></h3>
        <div class="lgd-toolbar">
          <span class="lgd-muted">同一平台的店不能共用一条代理，不同平台可以</span>
          <el-button type="primary" @click="startAdd('proxy')">加代理</el-button>
        </div>
      </div>
      <div class="lgd-card__body--table">
        <el-table v-loading="loading" :data="proxies" size="small" empty-text="还没有代理">
          <el-table-column label="编号" min-width="120">
            <template #default="{ row }"><b>{{ row.code }}</b><div v-if="row.provider" class="lgd-muted">{{ row.provider }}</div></template>
          </el-table-column>
          <el-table-column label="出口 IP / 地区" min-width="150">
            <template #default="{ row }">{{ row.exit_ip || '—' }}<div v-if="row.region" class="lgd-muted">{{ row.region }}</div></template>
          </el-table-column>
          <el-table-column label="地址" min-width="160">
            <template #default="{ row }">
              <span v-if="row.host">{{ row.protocol_label }} {{ row.host }}<span v-if="row.port">:{{ row.port }}</span></span>
              <span v-else class="lgd-muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="月费" width="80" align="right">
            <template #default="{ row }">{{ money(row.monthly_cost) }}</template>
          </el-table-column>
          <el-table-column label="到期" width="130">
            <template #default="{ row }">
              {{ row.expires_on || '—' }}
              <div v-for="(x, i) in row.alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ad-warn'">{{ x.text }}</div>
            </template>
          </el-table-column>
          <el-table-column label="谁在用" min-width="200">
            <template #default="{ row }">
              <span v-if="!row.devices.length" class="lgd-muted">没人用</span>
              <div v-else>{{ row.devices.map((d) => d.name).join('、') }}</div>
              <div v-if="row.shops.length" class="lgd-muted">{{ row.shops.map((s) => s.platform_label + '·' + s.name).join('、') }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="76">
            <template #default="{ row }"><el-tag size="small" :type="STATUS_TYPE[row.status] || 'info'" effect="light">{{ opts.statuses[row.status] || row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="startEdit('proxy', row)">改</el-button>
              <el-button link type="primary" size="small" @click="startRenew(row)">续期</el-button>
              <el-button link type="primary" size="small" @click="showCharges(row)">记录</el-button>
              <el-button link type="danger" size="small" @click="remove('proxy', row)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="lgd-card">
      <div class="lgd-card__head">
        <h3 class="lgd-card__title">设备 <small>{{ devices.length }} 个</small></h3>
        <div class="lgd-toolbar">
          <el-radio-group v-model="kind" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button v-for="(label, k) in opts.device_kinds" :key="k" :value="k">{{ label }} {{ kindCount(k) }}</el-radio-button>
          </el-radio-group>
          <el-tooltip content="只读群控：AdsPower 环境和手机没有的加上，人填过的不覆盖；店铺按闲鱼号挂到它现在登着的设备上" placement="top">
            <el-button :loading="syncing" @click="sync">从群控同步</el-button>
          </el-tooltip>
          <el-button type="primary" @click="startAdd('device')">加设备</el-button>
        </div>
      </div>
      <div class="lgd-card__body--table">
        <el-table v-loading="loading" :data="shown" size="small" empty-text="还没有设备，点「从群控同步」">
          <el-table-column label="名称" min-width="170">
            <template #default="{ row }">
              <b>{{ row.name }}</b>
              <div class="lgd-muted">{{ [row.ads_user_id, row.model !== row.name && row.model, row.gc_nick && '登着 ' + row.gc_nick].filter(Boolean).join(' · ') }}</div>
            </template>
          </el-table-column>
          <el-table-column label="类型 / 用途" width="120">
            <template #default="{ row }">{{ row.kind_label }}<div v-if="row.kind !== 'pc'" class="lgd-muted">{{ row.purpose_label }}</div></template>
          </el-table-column>
          <el-table-column label="代理" width="130">
            <template #default="{ row }">
              <span v-if="row.proxy_code">{{ row.proxy_code }}</span>
              <span v-else-if="row.kind === 'env'" class="ad-warn">没记代理</span>
              <span v-else class="lgd-muted">—</span>
              <div v-for="(x, i) in row.proxy_alerts" :key="i" :class="x.level === 'danger' ? 'lgd-danger' : 'ad-warn'">{{ x.text }}</div>
            </template>
          </el-table-column>
          <el-table-column label="卡槽 / 开在" min-width="170">
            <template #default="{ row }">
              <template v-if="row.kind === 'phone'">
                <div v-for="s in [row.sim1, row.sim2].filter(Boolean)" :key="s.id">{{ s.phone }} <span class="lgd-muted">{{ s.legal_person }}</span></div>
                <span v-if="!row.sim1 && !row.sim2" class="lgd-muted">没插卡</span>
              </template>
              <span v-else-if="row.kind === 'env'">{{ row.host_name || '—' }}</span>
              <span v-else class="lgd-muted">{{ row.location || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="店铺" min-width="150">
            <template #default="{ row }">
              <span v-if="!row.shops.length" class="lgd-muted">—</span>
              <div v-for="s in row.shops" :key="s.id">{{ s.platform_label }} · {{ s.name }}</div>
            </template>
          </el-table-column>
          <el-table-column label="最近在线" width="130">
            <template #default="{ row }">{{ row.last_online_at || '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="76">
            <template #default="{ row }"><el-tag size="small" :type="STATUS_TYPE[row.status] || 'info'" effect="light">{{ opts.statuses[row.status] || row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="startEdit('device', row)">改</el-button>
              <el-button link type="danger" size="small" @click="remove('device', row)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </template>

  <!-- 手机：卡片 -->
  <template v-else>
    <div v-loading="loading">
      <div class="lg-row ad-bar">
        <span class="lg-section">代理 IP · 每月 {{ money(monthlyTotal) }}</span>
        <el-button size="small" type="primary" @click="startAdd('proxy')">加代理</el-button>
      </div>
      <div v-if="!proxies.length" class="lg-card lg-muted">还没有代理</div>
      <div v-for="p in proxies" :key="p.id" class="lg-card">
        <div class="lg-row">
          <div>
            <b>{{ p.code }}</b><span class="lg-muted"> {{ [p.exit_ip, p.region].filter(Boolean).join(' · ') }}</span>
            <div class="lg-muted">到 {{ p.expires_on || '—' }} · {{ money(p.monthly_cost) }}/月</div>
            <div v-for="(x, i) in p.alerts" :key="i" :class="['ad-small', x.level === 'danger' ? 'lgd-danger' : 'ad-warn']">{{ x.text }}</div>
            <div class="lg-muted">{{ p.devices.length ? p.devices.map((d) => d.name).join('、') : '没人用' }}</div>
          </div>
          <div class="ad-ops">
            <a @click="startEdit('proxy', p)">改</a>
            <a @click="startRenew(p)">续期</a>
            <a class="ad-del" @click="remove('proxy', p)">删</a>
          </div>
        </div>
      </div>

      <div class="lg-row ad-bar">
        <span class="lg-section">设备 {{ devices.length }}</span>
        <span>
          <el-button size="small" :loading="syncing" @click="sync">从群控同步</el-button>
          <el-button size="small" type="primary" @click="startAdd('device')">加设备</el-button>
        </span>
      </div>
      <div v-if="!devices.length" class="lg-card lg-muted">还没有设备，点「从群控同步」</div>
      <div v-for="d in devices" :key="d.id" class="lg-card">
        <div class="lg-row">
          <div>
            <span class="lg-muted">{{ d.kind_label }}<template v-if="d.kind !== 'pc'"> · {{ d.purpose_label }}</template></span> <b>{{ d.name }}</b>
            <div v-if="d.gc_nick" class="lg-muted">登着 {{ d.gc_nick }}</div>
            <div class="lg-muted">{{ [d.proxy_code ? '代理 ' + d.proxy_code : d.kind === 'env' ? '没记代理' : '', [d.sim1, d.sim2].filter(Boolean).map((s) => s.phone).join(' / ') && '卡 ' + [d.sim1, d.sim2].filter(Boolean).map((s) => s.phone).join(' / '), d.host_name && '开在 ' + d.host_name].filter(Boolean).join(' · ') }}</div>
            <div v-if="d.shops.length" class="lg-muted">{{ d.shops.map((s) => s.platform_label + '·' + s.name).join('、') }}</div>
          </div>
          <div class="ad-ops">
            <a @click="startEdit('device', d)">改</a>
            <a class="ad-del" @click="remove('device', d)">删</a>
          </div>
        </div>
      </div>
    </div>
  </template>

  <!-- 改 / 加 -->
  <el-dialog v-model="editOpen" :title="(edit.id ? '改' : '加') + (edit.level === 'proxy' ? '代理' : '设备')" width="92%" style="max-width: 520px">
    <el-form label-position="top" class="lg-form">
      <template v-if="edit.level === 'proxy'">
        <el-form-item label="编号"><el-input v-model="edit.data.code" placeholder="比如 IP-HZ-01" /></el-form-item>
        <el-form-item label="服务商"><el-input v-model="edit.data.provider" /></el-form-item>
        <el-form-item label="协议">
          <el-radio-group v-model="edit.data.protocol">
            <el-radio v-for="(label, k) in opts.proxy_protocols" :key="k" :value="k">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="地址和端口">
          <div class="ad-hostport">
            <el-input v-model="edit.data.host" placeholder="主机" />
            <el-input-number v-model="edit.data.port" :min="1" :max="65535" :controls="false" :value-on-clear="null" placeholder="端口" />
          </div>
          <div class="lg-muted ad-hint">代理的账号密码不记在这里</div>
        </el-form-item>
        <el-form-item label="出口 IP"><el-input v-model="edit.data.exit_ip" /></el-form-item>
        <el-form-item label="地区"><el-input v-model="edit.data.region" placeholder="比如 浙江杭州电信家宽" /></el-form-item>
        <el-form-item label="月费（元）"><el-input v-model="edit.data.monthly_cost" /></el-form-item>
        <el-form-item label="到期日">
          <el-date-picker v-model="edit.data.expires_on" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </template>
      <template v-else>
        <el-form-item label="类型">
          <el-radio-group v-model="edit.data.kind">
            <el-radio v-for="(label, k) in opts.device_kinds" :key="k" :value="k">{{ label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="名称"><el-input v-model="edit.data.name" /></el-form-item>
        <el-form-item label="用途">
          <el-radio-group v-model="edit.data.purpose">
            <el-radio v-for="(label, k) in opts.device_purposes" :key="k" :value="k">{{ label }}</el-radio>
          </el-radio-group>
          <div class="lg-muted ad-hint">只有销售用的设备能挂店铺</div>
        </el-form-item>
        <el-form-item v-if="edit.data.kind === 'env'" label="AdsPower 环境编号"><el-input v-model="edit.data.ads_user_id" /></el-form-item>
        <el-form-item v-if="edit.data.kind === 'env'" label="开在哪台电脑上">
          <el-select v-model="edit.data.host_id" clearable placeholder="先在这里加一台电脑" style="width: 100%">
            <el-option v-for="p in pcs" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="代理">
          <el-select v-model="edit.data.proxy_id" clearable filterable placeholder="没用代理就不选" style="width: 100%">
            <el-option v-for="p in proxies.filter((x) => x.status !== 'closed')" :key="p.id" :label="`${p.code}${p.exit_ip ? ' · ' + p.exit_ip : ''}`" :value="p.id" />
          </el-select>
        </el-form-item>
        <template v-if="edit.data.kind === 'phone'">
          <el-form-item label="卡槽 1">
            <el-select v-model="edit.data.sim1_id" clearable filterable placeholder="手机卡在法人下面加" style="width: 100%">
              <el-option v-for="s in simOptions" :key="s.id" :label="s.label" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="卡槽 2">
            <el-select v-model="edit.data.sim2_id" clearable filterable style="width: 100%">
              <el-option v-for="s in simOptions" :key="s.id" :label="s.label" :value="s.id" />
            </el-select>
          </el-form-item>
        </template>
        <template v-if="edit.data.kind !== 'env'">
          <el-form-item label="型号"><el-input v-model="edit.data.model" /></el-form-item>
          <el-form-item label="序列号"><el-input v-model="edit.data.serial" /></el-form-item>
        </template>
        <template v-if="edit.data.kind === 'phone'">
          <el-form-item label="IMEI 1"><el-input v-model="edit.data.imei1" /></el-form-item>
          <el-form-item label="IMEI 2"><el-input v-model="edit.data.imei2" /></el-form-item>
        </template>
        <el-form-item label="保管人"><el-input v-model="edit.data.custodian" /></el-form-item>
        <el-form-item v-if="edit.data.kind !== 'env'" label="放在哪"><el-input v-model="edit.data.location" placeholder="比如 2 号工位" /></el-form-item>
      </template>
      <el-form-item label="状态">
        <el-radio-group v-model="edit.data.status">
          <el-radio v-for="(label, k) in opts.statuses" :key="k" :value="k">{{ label }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="edit.data.note" type="textarea" :rows="2" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>

  <!-- 续期 -->
  <el-dialog v-model="renewOpen" :title="`续期 ${renew.proxy?.code || ''}`" width="92%" style="max-width: 420px">
    <el-form label-position="top" class="lg-form">
      <el-form-item label="续几个月"><el-input-number v-model="renew.months" :min="1" :max="36" /></el-form-item>
      <el-form-item label="花了多少（元）">
        <el-input-number v-model="renew.amount" :min="0" :precision="2" :controls="false" :value-on-clear="null" style="width: 100%" />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="renew.note" placeholder="比如 OA 审批单号" /></el-form-item>
      <div class="lg-muted">没过期的从到期日往后续，过期了从今天起算</div>
    </el-form>
    <template #footer>
      <el-button @click="renewOpen = false">取消</el-button>
      <el-button type="primary" @click="saveRenew">续期</el-button>
    </template>
  </el-dialog>

  <!-- 记录 -->
  <el-dialog v-model="chargesOpen" :title="charges.title" width="92%" style="max-width: 560px">
    <div v-if="!charges.items.length" class="lg-muted">还没有记录</div>
    <div v-for="c in charges.items" :key="c.id" class="ad-charge lg-row">
      <span>{{ c.created_at }} · {{ c.staff }}<span v-if="c.note" class="lg-muted"> · {{ c.note }}</span></span>
      <span>{{ c.kind_label }} {{ c.months ? c.months + ' 个月' : '' }} {{ money(c.amount) }}<span class="lg-muted"> {{ c.before || '—' }} → {{ c.after }}</span></span>
    </div>
  </el-dialog>
</template>

<style scoped>
.ad-warn { color: #b45309; }
.ad-small { font-size: 12px; }
.ad-hint { width: 100%; }
.ad-bar { margin: 4px 0 8px; }
.ad-ops { display: flex; gap: 10px; flex-shrink: 0; font-size: 13px; }
.ad-ops a { color: var(--lg-accent); cursor: pointer; white-space: nowrap; }
.ad-ops a.ad-del { color: var(--lg-danger); }
.ad-hostport { display: grid; grid-template-columns: 1fr 110px; gap: 8px; width: 100%; }
.ad-charge { padding: 8px 0; border-bottom: 1px solid var(--lg-line); font-size: 13px; gap: 12px; }
</style>
