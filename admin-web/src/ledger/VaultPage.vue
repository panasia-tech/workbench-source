<script setup>
// 密码库（第五步）。只有密码库主人（服务器 .env 里的 LEDGER_VAULT_OWNERS）能看明文、能增改删：
// 第一次先用手机扫码绑验证器（iPhone 自带「密码」App、Google / Microsoft Authenticator 都行），以后输 6 位码解锁 15 分钟。
// 解锁令牌只放在这个页面的内存里：刷新、关页面、倒计时到了、点「立即上锁」就没了。一次只解开点的那一项，30 秒后自动盖住。
// 别的管理员只看得到清单（没有任何密码）。
// 填进 AdsPower：工位上的巡航台登记这台电脑的公钥，主人在下面「能填密码的工位」对着指纹批准；条目挂了环境就自动去填，
// 内容按那台电脑的公钥加密，只有它解得开（services/ledger_vault_ads.py）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const isDesktop = useDesktop()
const st = ref({ ready: true, is_owner: false, owners_set: true, bound: false, categories: {} })
const items = ref([])
const q = ref('')
const token = ref('')
const left = ref(0)
let timer = null
const code = ref('')
const shown = ref({}) // `${id}:${field}` → 明文，30 秒后删掉
const codes = ref({})

const unlocked = computed(() => !!token.value && left.value > 0)
const hdr = () => ({ headers: { 'X-Vault-Token': token.value } })
const mmss = computed(() => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, '0')}`)

const stations = ref([])
const ADS_TYPE = { pending: 'warning', synced: 'success', error: 'danger' }
const ADS_LABEL = { pending: '等工位来填', synced: '已填好', error: '填失败' }

async function load() {
  try {
    stations.value = (await api.get('/ledger/vault/stations')).data.items
    st.value = (await api.get('/ledger/vault/state')).data
    const params = q.value.trim() ? { q: q.value.trim() } : {}
    items.value = (await api.get('/ledger/vault/items', { params })).data.items
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  }
}

function clearSecrets() {
  token.value = ''
  left.value = 0
  shown.value = {}
  codes.value = {}
  clearInterval(timer)
}

function onAuthErr(err, fallback) {
  if (err?.response?.status === 401) clearSecrets()
  ElMessage.error(errText(err, fallback))
}

// ---------------- 绑验证器
const bind = ref(null)
const bindCode = ref('')
const bindOld = ref('')
async function startBind() {
  try {
    const { data } = await api.post('/ledger/vault/bind/start')
    bind.value = { ...data, qr: await QRCode.toDataURL(data.uri, { width: 220, margin: 1 }) }
    bindCode.value = ''
    bindOld.value = ''
  } catch (err) {
    ElMessage.error(errText(err, '生成不了'))
  }
}
async function confirmBind() {
  try {
    await api.post('/ledger/vault/bind/confirm', { code: bindCode.value, current_code: bindOld.value || null })
    bind.value = null
    ElMessage.success('绑好了。以后用这个验证器上的 6 位码解锁（这次的码不能再用，等下一个）')
    load()
  } catch (err) {
    ElMessage.error(errText(err, '没绑上'))
  }
}

// ---------------- 解锁 / 上锁
async function unlock() {
  try {
    const { data } = await api.post('/ledger/vault/unlock', { code: code.value })
    token.value = data.token
    left.value = data.seconds
    code.value = ''
    clearInterval(timer)
    timer = setInterval(() => {
      left.value -= 1
      if (left.value <= 0) clearSecrets()
    }, 1000)
  } catch (err) {
    ElMessage.error(errText(err, '没解开'))
  }
}
async function lockNow() {
  try {
    await api.post('/ledger/vault/lock', null, hdr())
  } catch {
    /* 上锁失败也把本页的令牌丢了 */
  }
  clearSecrets()
}

async function reveal(row, field) {
  const k = `${row.id}:${field}`
  try {
    const { data } = await api.post(`/ledger/vault/items/${row.id}/reveal`, { field }, hdr())
    shown.value = { ...shown.value, [k]: data.value || '（空）' }
    setTimeout(() => {
      const { [k]: _, ...rest } = shown.value
      shown.value = rest
    }, 30000)
  } catch (err) {
    onAuthErr(err, '看不了')
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('复制了')
  } catch {
    ElMessage.warning('浏览器不让复制，手动选中复制')
  }
}

async function getCode(row) {
  try {
    const { data } = await api.post(`/ledger/vault/items/${row.id}/code`, null, hdr())
    codes.value = { ...codes.value, [row.id]: data }
  } catch (err) {
    onAuthErr(err, '领不了')
  }
}

async function decide(row, trust) {
  try {
    if (trust) await ElMessageBox.confirm(`批准「${row.name}」？先核对巡航台上显示的指纹是不是 ${row.fingerprint}。批准后这台电脑能领到要填进 AdsPower 的密码（只有它解得开）。`, '批准工位')
    await api.post(`/ledger/vault/stations/${row.id}/decide`, { trust }, hdr())
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') onAuthErr(err, '没成功')
  }
}

async function adsSync(row) {
  try {
    await api.post(`/ledger/vault/items/${row.id}/ads-sync`, null, hdr())
    ElMessage.success('等工位来填')
    load()
  } catch (err) {
    onAuthErr(err, '没成功')
  }
}

// ---------------- 增改删
const eOpen = ref(false)
const e = ref({})
const staff = ref([])
const envs = ref([])
const targets = ref([])
async function loadRefs() {
  if (staff.value.length) return
  const [s, d] = await Promise.all([api.get('/ledger/staff-options'), api.get('/ledger/devices', { params: { kind: 'env' } })])
  staff.value = s.data.items
  envs.value = (d.data.items || d.data).filter?.((x) => x.kind === 'env') || []
}
async function searchTargets(kw) {
  try {
    targets.value = (await api.get('/ledger/vault/targets', { params: { q: kw } })).data.items
  } catch {
    targets.value = []
  }
}
async function startEdit(row) {
  try {
    await loadRefs()
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
    return
  }
  e.value = row
    ? { ...row, target: row.target_id ? `${row.target_type}:${row.target_id}` : '', password: '', secondary: '', totp: '' }
    : { category: 'platform', title: '', target: '', login_name: '', password: '', secondary: '', totp: '', assignee_id: '', employee_totp: false, device_id: '', note: '' }
  if (row?.target_id) targets.value = [{ type: row.target_type, id: row.target_id, label: row.target_label || '（原来挂的）' }]
  eOpen.value = true
}
async function saveEdit() {
  const v = e.value
  const [tt, tid] = v.target ? v.target.split(':') : [null, null]
  const body = { category: v.category, title: v.title, login_name: v.login_name, assignee_id: v.assignee_id || null, ads_domain: v.ads_domain || null,
    employee_totp: v.employee_totp, device_id: v.device_id || null, note: v.note, target_type: tt, target_id: tid }
  // 密码那几项：空着 = 不改
  for (const k of ['password', 'secondary', 'totp']) if (v[k]) body[k] = v[k]
  try {
    if (v.id) await api.patch(`/ledger/vault/items/${v.id}`, body, hdr())
    else await api.post('/ledger/vault/items', body, hdr())
    eOpen.value = false
    ElMessage.success('存好了')
    load()
  } catch (err) {
    onAuthErr(err, '没存上')
  }
}
async function remove(row) {
  try {
    await ElMessageBox.confirm(`删掉「${row.title}」？删了找不回来。`, '删除', { type: 'warning' })
    await api.delete(`/ledger/vault/items/${row.id}`, hdr())
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') onAuthErr(err, '没删掉')
  }
}

onMounted(load)
onBeforeUnmount(clearSecrets)
</script>

<template>
  <div v-if="!st.ready" :class="isDesktop ? 'lgd-card lgd-card__body' : 'lg-card'">
    密码库还没配主密钥（服务器 .env 的 LEDGER_VAULT_KEK），现在存不了也看不了。
  </div>
  <template v-else>
    <!-- 解锁区 -->
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__body' : ''" class="vp-lockbar">
        <template v-if="!st.owners_set">还没指定密码库主人（服务器 .env 的 LEDGER_VAULT_OWNERS），谁都看不了明文。</template>
        <template v-else-if="!st.is_owner">你不是密码库主人：只看得到清单，看不到任何密码。</template>
        <template v-else-if="!st.bound || bind">
          <div v-if="!bind">
            第一次用：先绑手机验证器。<el-button type="primary" size="small" @click="startBind">绑定手机验证器</el-button>
          </div>
          <div v-else class="vp-bind">
            <img :src="bind.qr" alt="验证器二维码" width="220" height="220" />
            <div>
              <p>用 iPhone 相机扫这个码，点「在『密码』中添加验证码」；或者用 Google / Microsoft Authenticator 扫。</p>
              <p class="lg-muted">扫不了就手动输入：<code>{{ bind.secret }}</code></p>
              <el-input v-if="bind.rebinding" v-model="bindOld" maxlength="6" placeholder="旧验证器上现在的 6 位码" class="vp-code" />
              <el-input v-model="bindCode" maxlength="6" placeholder="新验证器上现在的 6 位码" class="vp-code" @keyup.enter="confirmBind" />
              <el-button type="primary" @click="confirmBind">绑定</el-button>
              <el-button @click="bind = null">取消</el-button>
            </div>
          </div>
        </template>
        <template v-else-if="!unlocked">
          🔒 已上锁。输手机验证器上的 6 位码解锁 15 分钟：
          <el-input v-model="code" maxlength="6" class="vp-code" @keyup.enter="unlock" />
          <el-button type="primary" @click="unlock">解锁</el-button>
          <el-button link @click="startBind">换手机</el-button>
        </template>
        <template v-else>
          🔓 已解锁，还剩 <b class="lgd-num">{{ mmss }}</b>
          <el-button type="danger" size="small" @click="lockNow">立即上锁</el-button>
          <el-button type="primary" size="small" @click="startEdit(null)">新建一条</el-button>
        </template>
      </div>
    </div>

    <!-- 清单 -->
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">密码库 <small>{{ items.length }} 条 · 清单里没有任何密码，点哪项解哪项</small></h3>
        <el-input v-model="q" size="small" placeholder="搜名称 / 登录名" clearable style="width: 200px" @change="load" />
      </div>
      <div :class="isDesktop ? 'lgd-card__body--table' : ''">
        <el-table :data="items" size="small" empty-text="还没有">
          <el-table-column label="分类" prop="category_label" width="100" />
          <el-table-column label="名称" min-width="160"><template #default="{ row }">{{ row.title }}<div v-if="row.target_label" class="lg-muted">台账：{{ row.target_label }}</div></template></el-table-column>
          <el-table-column label="登录名" prop="login_name" min-width="140" />
          <el-table-column label="密码" min-width="230">
            <template #default="{ row }">
              <div v-for="[f, l, has] in [['password', '登录', row.has_password], ['secondary', '二级', row.has_secondary], ['totp', '种子', row.has_totp]]" v-show="has" :key="f" class="vp-sec">
                <span class="lg-muted">{{ l }}</span>
                <template v-if="shown[row.id + ':' + f]"><code>{{ shown[row.id + ':' + f] }}</code><el-button link size="small" @click="copy(shown[row.id + ':' + f])">复制</el-button></template>
                <template v-else>••••••<el-button v-if="unlocked" link type="primary" size="small" @click="reveal(row, f)">看</el-button></template>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="动态码" width="120">
            <template #default="{ row }">
              <template v-if="row.has_totp && unlocked">
                <span v-if="codes[row.id]" class="lgd-num"><b>{{ codes[row.id].code }}</b> <small class="lg-muted">{{ codes[row.id].seconds_left }}s</small></span>
                <el-button link type="primary" size="small" @click="getCode(row)">{{ codes[row.id] ? '刷新' : '领码' }}</el-button>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="给谁用" width="130"><template #default="{ row }">{{ row.assignee_name || '—' }}<el-tag v-if="row.employee_totp" size="small" class="vp-tag">能领码</el-tag></template></el-table-column>
          <el-table-column label="AdsPower" width="150">
            <template #default="{ row }">
              <template v-if="row.device_name">
                <el-tooltip :content="row.ads_error || `环境 ${row.device_name}${row.ads_synced_at ? '，' + row.ads_synced_at + ' 填的' : ''}`" placement="top">
                  <el-tag v-if="ADS_LABEL[row.ads_status]" :type="ADS_TYPE[row.ads_status]" size="small">{{ ADS_LABEL[row.ads_status] }}</el-tag>
                  <span v-else class="lg-muted">没填</span>
                </el-tooltip>
                <el-button v-if="unlocked && row.ads_status !== 'pending'" link type="primary" size="small" @click="adsSync(row)">{{ row.ads_status === 'synced' ? '重填' : '去填' }}</el-button>
              </template>
              <span v-else class="lg-muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="改密码" prop="rotated_at" width="130" />
          <el-table-column v-if="unlocked" label="" width="90">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="startEdit(row)">改</el-button>
              <el-button link type="danger" size="small" @click="remove(row)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">能填密码的工位 <small>巡航台登记这台电脑的公钥；批准前核对巡航台上显示的指纹</small></h3>
      </div>
      <div :class="isDesktop ? 'lgd-card__body--table' : ''">
        <el-table :data="stations" size="small" empty-text="还没有工位登记（工位上打开巡航台的「密码填充」）">
          <el-table-column label="电脑" prop="name" min-width="140" />
          <el-table-column label="指纹" width="190"><template #default="{ row }"><code>{{ row.fingerprint }}</code></template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }"><el-tag :type="row.status === 'trusted' ? 'success' : row.status === 'pending' ? 'warning' : 'info'" size="small">{{ row.status_label }}</el-tag></template>
          </el-table-column>
          <el-table-column label="谁登记的" prop="registered_by" width="100" />
          <el-table-column label="最近联系" prop="last_seen_at" width="140" />
          <el-table-column v-if="unlocked" label="" width="110">
            <template #default="{ row }">
              <el-button v-if="row.status !== 'trusted'" link type="primary" size="small" @click="decide(row, true)">批准</el-button>
              <el-button v-if="row.status !== 'revoked'" link type="danger" size="small" @click="decide(row, false)">停用</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </template>

  <el-dialog v-model="eOpen" :title="e.id ? '改一条' : '新建一条'" width="560px">
    <el-form label-width="110px" class="lg-form">
      <el-form-item label="分类">
        <el-select v-model="e.category"><el-option v-for="(l, k) in st.categories" :key="k" :label="l" :value="k" /></el-select>
      </el-form-item>
      <el-form-item label="名称"><el-input v-model="e.title" placeholder="比如：闲鱼 · 林一五金店 1 号" /></el-form-item>
      <el-form-item label="挂台账哪条">
        <el-select v-model="e.target" filterable remote clearable :remote-method="searchTargets" placeholder="搜支付宝 / 店铺 / 主体 / 设备" style="width: 100%">
          <el-option v-for="t in targets" :key="t.type + t.id" :label="t.label" :value="`${t.type}:${t.id}`" />
        </el-select>
      </el-form-item>
      <el-form-item label="登录名"><el-input v-model="e.login_name" /></el-form-item>
      <el-form-item label="登录密码"><el-input v-model="e.password" type="password" show-password autocomplete="new-password" :placeholder="e.id ? '不改就空着' : ''" /></el-form-item>
      <el-form-item label="二级 / 支付密码"><el-input v-model="e.secondary" type="password" show-password autocomplete="new-password" :placeholder="e.id ? '不改就空着' : ''" /></el-form-item>
      <el-form-item label="二次验证种子"><el-input v-model="e.totp" autocomplete="off" :placeholder="e.id ? '不改就空着' : 'A-Z 和 2-7 组成，有的话填'" /></el-form-item>
      <el-form-item label="给谁用">
        <el-select v-model="e.assignee_id" clearable filterable><el-option v-for="s in staff" :key="s.id" :label="s.name" :value="s.id" /></el-select>
      </el-form-item>
      <el-form-item label="员工领码"><el-switch v-model="e.employee_totp" /><span class="lg-muted vp-hint">他能领这条的 6 位码，看不到种子和密码</span></el-form-item>
      <el-form-item label="AdsPower 环境">
        <el-select v-model="e.device_id" clearable filterable placeholder="挂了就由批准过的工位填进去"><el-option v-for="d in envs" :key="d.id" :label="d.name" :value="d.id" /></el-select>
      </el-form-item>
      <el-form-item v-if="e.device_id" label="自动填的网站"><el-input v-model="e.ads_domain" placeholder="空着按挂的店铺猜，比如 goofish.com" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="e.note" type="textarea" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="eOpen = false">取消</el-button><el-button type="primary" @click="saveEdit">存</el-button></template>
  </el-dialog>
</template>

<style scoped>
.vp-lockbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; }
.vp-code { width: 150px; margin: 0 6px 6px 0; }
.vp-bind { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.vp-bind p { margin: 0 0 8px; }
.vp-sec { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.vp-tag { margin-left: 4px; }
.vp-hint { margin-left: 8px; }
</style>
