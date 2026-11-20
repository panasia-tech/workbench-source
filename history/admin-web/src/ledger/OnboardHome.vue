<script setup>
// 开店（第五步）：最上面是要动手的事（红 = 现在就要动手，黄 = 等谁审 / 批）；审核人和老板再往下看每个法人还差什么、
// 哪些平台还没有教程、全部开店进度，从缺口直接派单。员工只看到自己的事和自己的进度。
// 点开一份进度就在这一页换成 CaseView，返回回到列表。
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'
import CaseView from './CaseView.vue'

const props = defineProps({ isAdmin: Boolean })
const emit = defineEmits(['goto'])
const isDesktop = useDesktop()

const home = ref({ issues: [], gaps: [], coverage: [], is_reviewer: false, is_boss: false, target_keys: {}, platforms: {} })
const cases = ref([])
const showClosed = ref(false)
const openId = ref('')
const loading = ref(false)

const reviewers = ref([])
const opts = ref({ entities: [], alipays: [], shops: [], staff: [], platforms: {} })

const red = computed(() => home.value.issues.filter((x) => x.level === 'red').length)
const COVER_TYPE = { published: 'success', pending: 'warning', draft: 'info', none: 'danger' }

async function load() {
  loading.value = true
  try {
    home.value = (await api.get('/ledger/onboard/home')).data
    const params = { all: home.value.is_reviewer, closed: showClosed.value }
    cases.value = (await api.get('/ledger/onboard/cases', { params })).data.items
    if (props.isAdmin) reviewers.value = (await api.get('/ledger/onboard/reviewers')).data.items.map((x) => x.id)
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function loadOpts() {
  if (!opts.value.staff.length) opts.value = (await api.get('/ledger/onboard/dispatch-options')).data
}

function act(x) {
  const a = x.action
  if (a.type === 'case') openId.value = a.id
  else if (a.type === 'tutorial') emit('goto', 'tutorials')
  else if (a.type === 'skip') decideSkip(a.id, x.text)
  else if (a.type === 'gap') document.getElementById('gap-' + a.id)?.scrollIntoView({ behavior: 'smooth' })
}

async function decideSkip(id, text) {
  let approve
  try {
    await ElMessageBox.confirm(text, '批不批这次跳步？', { confirmButtonText: '批准跳过', cancelButtonText: '不批', distinguishCancelAndClose: true })
    approve = true
  } catch (e) {
    if (e !== 'cancel') return
    approve = false
  }
  try {
    await api.post(`/ledger/onboard/skips/${id}`, { approve })
    ElMessage.success(approve ? '批准了' : '没批')
    load()
  } catch (err) {
    ElMessage.error(errText(err, '没成功'))
  }
}

// ---------------- 目标数
const tgOpen = ref(false)
const tg = ref({ lp: null, targets: {}, note: '' })
const tgKeys = computed(() => [
  ...Object.entries(home.value.target_keys).map(([k, l]) => ({ key: k, label: l })),
  ...Object.entries(home.value.platforms).map(([k, l]) => ({ key: 'platform:' + k, label: l + '（店）' })),
])

function editTarget(g) {
  const targets = {}
  g.items.forEach((i) => { if (i.target != null) targets[i.key] = i.target })
  tg.value = { lp: g, targets, note: g.note || '' }
  tgOpen.value = true
}

async function saveTarget() {
  try {
    await api.put(`/ledger/onboard/targets/${tg.value.lp.legal_person_id}`, { targets: tg.value.targets, note: tg.value.note })
    tgOpen.value = false
    ElMessage.success('目标改好了')
    load()
  } catch (err) {
    ElMessage.error(errText(err, '没改成'))
  }
}

// ---------------- 派单
const dOpen = ref(false)
const d = ref({})
const lpFilter = ref('')
const KINDS = { alipay: '开企业支付宝', shop: '开店', tutorial: '写教程' }
const entityOpts = computed(() => opts.value.entities.filter((e) => !lpFilter.value || e.legal_person_id === lpFilter.value))
const alipayOpts = computed(() => opts.value.alipays.filter((a) => a.role === 'sales' && (!lpFilter.value || entityOpts.value.some((e) => e.id === a.entity_id))))

async function startDispatch(preset = {}, lp = '') {
  try {
    await loadOpts()
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
    return
  }
  lpFilter.value = lp
  d.value = { kind: 'shop', platform: 'xianyu', entity_id: '', alipay_id: '', assignee_id: '', due_on: '', note: '', ...preset }
  dOpen.value = true
}

function fromGap(g, item) {
  if (item.key === 'alipays') startDispatch({ kind: 'alipay' }, g.legal_person_id)
  else if (item.key.startsWith('platform:')) startDispatch({ kind: 'shop', platform: item.key.slice(9) }, g.legal_person_id)
}

async function dispatch() {
  const body = { ...d.value }
  Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k] })
  try {
    const { data } = await api.post('/ledger/onboard/cases', body)
    dOpen.value = false
    ElMessage.success('派出去了')
    await load()
    openId.value = data.id
  } catch (err) {
    ElMessage.error(errText(err, '没派成'))
  }
}

async function saveReviewers() {
  try {
    await api.put('/ledger/onboard/reviewers', { ids: reviewers.value })
    ElMessage.success('审核人改好了')
  } catch (err) {
    ElMessage.error(errText(err, '没改成'))
  }
}

async function cancelCase(c) {
  try {
    await ElMessageBox.confirm(`撤销「${c.title}」？占位的支付宝 / 店铺还留在台账里（状态「开店中」），不要了去台账删。`, '撤销开店进度', { type: 'warning' })
    await api.patch(`/ledger/onboard/cases/${c.id}`, { cancel: true })
    load()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errText(err, '没撤销'))
  }
}

onMounted(async () => {
  await load()
  if (props.isAdmin || home.value.is_reviewer) loadOpts().catch(() => {})
})
</script>

<template>
  <CaseView v-if="openId" :case-id="openId" :can-review="home.is_reviewer" :is-boss="home.is_boss"
            @back="openId = ''; load()" @open-case="(id) => (openId = id)" @changed="load" />

  <div v-else v-loading="loading">
    <!-- 要动手的事 -->
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">要动手的事 <small v-if="home.issues.length">{{ home.issues.length }} 件<template v-if="red">，红的 {{ red }}</template></small></h3>
        <el-button v-if="home.is_reviewer" type="primary" size="small" @click="startDispatch()">派开店单</el-button>
      </div>
      <div :class="isDesktop ? 'lgd-card__body' : ''">
        <div v-if="!home.issues.length" class="ob-green">● 都正常，没有要动手的事</div>
        <div v-for="(x, i) in home.issues" :key="i" class="ob-issue" @click="act(x)">
          <span :class="['ob-dot', 'ob-dot--' + x.level]" />
          <span class="ob-issue__t">{{ x.text }}</span>
          <span v-if="x.who" class="lg-muted">{{ x.who }}</span>
        </div>
      </div>
    </div>

    <!-- 缺口 -->
    <template v-if="home.is_reviewer">
      <div v-for="g in home.gaps" :id="'gap-' + g.legal_person_id" :key="g.legal_person_id" :class="isDesktop ? 'lgd-card' : 'lg-card'">
        <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
          <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">
            {{ g.name }}
            <small v-if="!g.has_target">还没填目标，看不出差多少</small>
            <small v-else-if="g.gap_total" class="lgd-danger">一共还差 {{ g.gap_total }}</small>
            <small v-else class="lgd-ok">都齐了</small>
          </h3>
          <el-button v-if="home.is_boss" size="small" @click="editTarget(g)">{{ g.has_target ? '改目标' : '填目标' }}</el-button>
        </div>
        <div :class="isDesktop ? 'lgd-card__body--table' : ''">
          <el-table :data="g.items" size="small" empty-text="台账里还什么都没有">
            <el-table-column label="项目" prop="label" min-width="110" />
            <el-table-column label="目标" width="70"><template #default="{ row }">{{ row.target ?? '—' }}</template></el-table-column>
            <el-table-column label="已就绪" prop="ready" width="70" />
            <el-table-column label="开店中" prop="building" width="70" />
            <el-table-column label="还差" width="70">
              <template #default="{ row }"><b v-if="row.gap" class="lgd-danger">{{ row.gap }}</b><span v-else-if="row.gap === 0" class="lgd-ok">0</span><span v-else>—</span></template>
            </el-table-column>
            <el-table-column label="" width="70">
              <template #default="{ row }">
                <el-button v-if="row.gap && (row.key === 'alipays' || row.key.startsWith('platform:'))" link type="primary" size="small" @click="fromGap(g, row)">派单</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>

      <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
        <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
          <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">哪些平台有开店教程 <small>没有已上线教程的平台派不了单</small></h3>
          <el-button size="small" @click="emit('goto', 'tutorials')">去写教程</el-button>
        </div>
        <div :class="isDesktop ? 'lgd-card__body' : ''" class="ob-cover">
          <el-tag v-for="x in home.coverage" :key="x.key" :type="COVER_TYPE[x.state]" size="small" effect="plain">{{ x.label }} · {{ x.state_label }}</el-tag>
        </div>
      </div>
    </template>

    <!-- 开店进度 -->
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">{{ home.is_reviewer ? '全部开店进度' : '我的开店' }} <small>{{ cases.length }} 份</small></h3>
        <el-checkbox v-model="showClosed" size="small" @change="load">含已结束</el-checkbox>
      </div>
      <div :class="isDesktop ? 'lgd-card__body--table' : ''">
        <el-table v-if="isDesktop" :data="cases" size="small" empty-text="还没有开店进度" @row-click="(r) => (openId = r.id)">
          <el-table-column label="进度" min-width="200"><template #default="{ row }">{{ row.title }}<el-tag v-if="row.status !== 'open'" size="small" type="info" class="ob-tag">{{ row.status_label }}</el-tag></template></el-table-column>
          <el-table-column label="谁做" prop="assignee_name" width="90" />
          <el-table-column label="做到" width="160"><template #default="{ row }"><el-progress :percentage="row.pct" :format="() => `${row.done}/${row.total}`" /></template></el-table-column>
          <el-table-column label="现在这一步" min-width="220">
            <template #default="{ row }">
              <template v-if="row.current_code">
                <span :class="{ 'lgd-danger': ['rejected', 'gated'].includes(row.current_state) }">{{ row.current_code }} {{ row.current_title }}</span>
                <span class="lg-muted">（{{ { active: '在做', gated: '被支付宝锁住', submitted: '等审核', rejected: '被打回' }[row.current_state] }}）</span>
              </template>
              <span v-else class="lgd-ok">全部做完</span>
            </template>
          </el-table-column>
          <el-table-column label="截止" width="100"><template #default="{ row }"><span :class="{ 'lgd-danger': row.overdue }">{{ row.due_on || '—' }}</span></template></el-table-column>
          <el-table-column v-if="home.is_reviewer" label="" width="70">
            <template #default="{ row }"><el-button v-if="row.status === 'open'" link type="danger" size="small" @click.stop="cancelCase(row)">撤销</el-button></template>
          </el-table-column>
        </el-table>
        <template v-else>
          <div v-if="!cases.length" class="lg-muted">还没有开店进度</div>
          <div v-for="row in cases" :key="row.id" class="ob-case" @click="openId = row.id">
            <div class="lg-row"><b>{{ row.title }}</b><span class="lg-muted">{{ row.done }}/{{ row.total }}</span></div>
            <div :class="['ob-case__cur', { 'lgd-danger': ['rejected', 'gated'].includes(row.current_state) }]">
              {{ row.current_code ? `${row.current_code} ${row.current_title}` : '全部做完' }}
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 审核人 -->
    <div v-if="isAdmin" :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">审核人（主管）<small>能写教程、审员工交的步骤、派单；管理员本来就能</small></h3>
      </div>
      <div :class="isDesktop ? 'lgd-card__body' : ''" class="ob-rev">
        <el-select v-model="reviewers" multiple filterable placeholder="选人" style="min-width: 280px" @visible-change="(v) => v && loadOpts()">
          <el-option v-for="s in opts.staff" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-button type="primary" size="small" @click="saveReviewers">保存</el-button>
      </div>
    </div>
  </div>

  <!-- 改目标 -->
  <el-dialog v-model="tgOpen" :title="`目标数 · ${tg.lp?.name || ''}`" width="560px">
    <p class="lg-muted">空着的不算缺口。闲鱼店不能超过执照数 × 3。</p>
    <div class="ob-tg">
      <label v-for="k in tgKeys" :key="k.key" class="ob-tg__item">
        <span>{{ k.label }}</span>
        <el-input-number v-model="tg.targets[k.key]" :min="0" :max="999" size="small" controls-position="right" />
      </label>
    </div>
    <el-input v-model="tg.note" type="textarea" placeholder="备注" class="ob-tg__note" />
    <template #footer><el-button @click="tgOpen = false">取消</el-button><el-button type="primary" @click="saveTarget">保存</el-button></template>
  </el-dialog>

  <!-- 派单 -->
  <el-dialog v-model="dOpen" title="派开店单" width="520px">
    <el-form label-width="90px" size="default" class="lg-form">
      <el-form-item label="派什么">
        <el-radio-group v-model="d.kind"><el-radio-button v-for="(l, k) in KINDS" :key="k" :value="k">{{ l }}</el-radio-button></el-radio-group>
      </el-form-item>
      <el-form-item v-if="d.kind === 'shop' || d.kind === 'tutorial'" label="平台">
        <el-select v-model="d.platform" filterable>
          <el-option v-if="d.kind === 'tutorial'" label="企业支付宝" value="alipay" />
          <el-option v-for="(l, k) in opts.platforms" :key="k" :label="l" :value="k" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="d.kind === 'shop'" label="收款支付宝">
        <el-select v-model="d.alipay_id" clearable filterable placeholder="闲鱼店要挂收款号（两道锁看它）">
          <el-option v-for="a in alipayOpts" :key="a.id" :label="`${a.account} · ${a.entity_name}`" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="d.kind === 'alipay' || (d.kind === 'shop' && !d.alipay_id)" label="主体">
        <el-select v-model="d.entity_id" filterable placeholder="开在哪张执照下">
          <el-option v-for="e in entityOpts" :key="e.id" :label="`${e.name} · ${e.legal_person_name}`" :value="e.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="派给谁">
        <el-select v-model="d.assignee_id" filterable><el-option v-for="s in opts.staff" :key="s.id" :label="s.name" :value="s.id" /></el-select>
      </el-form-item>
      <el-form-item label="截止日"><el-date-picker v-model="d.due_on" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="d.note" type="textarea" /></el-form-item>
    </el-form>
    <p v-if="d.kind !== 'tutorial'" class="lg-muted">台账里会先占一个「开店中」的{{ d.kind === 'alipay' ? '支付宝' : '店铺' }}，走完最后一步自动改成在用。</p>
    <template #footer><el-button @click="dOpen = false">取消</el-button><el-button type="primary" @click="dispatch">派出去</el-button></template>
  </el-dialog>
</template>

<style scoped>
.ob-issue { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid #f3f4f6; cursor: pointer; font-size: 14px; }
.ob-issue:hover { background: #f9fafb; }
.ob-issue__t { flex: 1; }
.ob-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.ob-dot--red { background: #dc2626; }
.ob-dot--yellow { background: #f59e0b; }
.ob-green { color: #047857; font-size: 14px; }
.ob-cover { display: flex; flex-wrap: wrap; gap: 6px; }
.ob-tag { margin-left: 6px; }
.ob-case { border-top: 1px solid #f0f0f0; padding: 10px 0; cursor: pointer; }
.ob-case__cur { font-size: 13px; margin-top: 2px; color: #6b7280; }
.ob-rev { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ob-tg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
.ob-tg__item { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.ob-tg__note { margin-top: 12px; }
.lgd-card__body--table :deep(.el-table__row) { cursor: pointer; }
</style>
