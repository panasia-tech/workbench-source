<script setup>
// 一份开店进度：左边是全部步骤（按阶段），右边一屏一步。默认停在现在要做的那一步；后面还没到的点进去只能看，
// 有「回到现在这一步」。红字平铺不折叠；被支付宝锁住的步骤显示为什么锁、不做会怎样，能一键跳去支付宝那份进度。
// 打回重交是新的一版，历次材料和审核意见都列在下面。
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const props = defineProps({ caseId: { type: String, required: true }, canReview: Boolean, isBoss: Boolean })
const emit = defineEmits(['back', 'open-case', 'changed'])
const isDesktop = useDesktop()

const c = ref(null)
const loading = ref(false)
const pick = ref('')
const form = ref({})
const confirmed = ref(false)
const busy = ref(false)
const reviewNote = ref('')
const lock = ref({ login_name: '', password: '', secondary: '', totp: '' })

const STATE_TYPE = { approved: 'success', skipped: 'info', submitted: 'warning', rejected: 'danger', active: 'primary', gated: 'danger', locked: 'info' }
const GUARD_COLS = [['pre', '什么时候'], ['mistake', '容易错成'], ['block', '系统怎么拦'], ['tip', '提示'], ['recover', '错了怎么补'], ['owner', '谁负责'], ['evidence', '留什么证据']]
const HIST = { submitted: '等审核', approved: '通过', rejected: '打回', skipped: '老板批准跳过' }

const step = computed(() => c.value?.steps.find((s) => s.code === pick.value))
const sp = computed(() => step.value?.step || {})
const canSubmit = computed(() => c.value?.status === 'open' && ['active', 'rejected'].includes(step.value?.state))
const canLockIn = computed(() => c.value?.status === 'open' && sp.value.vault_lockin && ['active', 'rejected', 'submitted'].includes(step.value?.state))
const canSkip = computed(() => c.value?.status === 'open' && ['active', 'gated', 'rejected'].includes(step.value?.state) && step.value?.skip?.status !== 'pending')
const stages = computed(() => (c.value?.stages || []).map((st) => ({ ...st, steps: st.codes.map((k) => c.value.steps.find((s) => s.code === k)) })))

async function load(keepPick = false) {
  loading.value = true
  try {
    c.value = (await api.get(`/ledger/onboard/cases/${props.caseId}`)).data
    if (!keepPick || !step.value) pick.value = c.value.current_code || c.value.steps[c.value.steps.length - 1]?.code
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

// 换一步就把表单换成这一步的：被打回的带上上一版填的，改了再交
watch(step, (s) => {
  const last = s?.history?.[0]
  form.value = Object.fromEntries((s?.step?.materials || []).map((m) => [m.key, s.state === 'rejected' ? last?.materials?.[m.key] || '' : '']))
  confirmed.value = false
  reviewNote.value = ''
  lock.value = { login_name: '', password: '', secondary: '', totp: '' }
})

watch(() => props.caseId, () => load(), { immediate: true })

async function submit() {
  busy.value = true
  try {
    const { data } = await api.post(`/ledger/onboard/cases/${props.caseId}/steps/${pick.value}/submit`, { materials: form.value, confirmed: confirmed.value })
    ElMessage.success(data.status === 'approved' ? '交上了，这一步算过' : '交上了，等审核')
    await load()
    emit('changed')
  } catch (err) {
    ElMessage.error(errText(err, '没交上'))
  } finally {
    busy.value = false
  }
}

async function review(approve) {
  busy.value = true
  try {
    await api.post(`/ledger/onboard/cases/${props.caseId}/steps/${pick.value}/review`, { approve, note: reviewNote.value })
    ElMessage.success(approve ? '通过了' : '打回了')
    await load()
    emit('changed')
  } catch (err) {
    ElMessage.error(errText(err, '没审成'))
  } finally {
    busy.value = false
  }
}

async function lockIn() {
  busy.value = true
  try {
    await api.post(`/ledger/onboard/cases/${props.caseId}/steps/${pick.value}/lock-in`, lock.value)
    lock.value = { login_name: '', password: '', secondary: '', totp: '' }
    ElMessage.success('已锁进密码库，你自己也看不到了')
  } catch (err) {
    ElMessage.error(errText(err, '没交上'))
  } finally {
    busy.value = false
  }
}

async function askSkip() {
  try {
    const { value } = await ElMessageBox.prompt('为什么要跳过这一步？老板批了才算。', `申请跳过 ${pick.value}`, {
      inputType: 'textarea', inputValidator: (v) => (v || '').trim().length >= 4 || '至少写 4 个字', confirmButtonText: '提交',
    })
    await api.post(`/ledger/onboard/cases/${props.caseId}/steps/${pick.value}/skip`, { reason: value })
    ElMessage.success('已提交，等老板批')
    await load(true)
    emit('changed')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errText(err, '没提交上'))
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="cv-top">
      <span class="lgd-back" @click="emit('back')">← 返回</span>
      <template v-if="c">
        <h2 class="cv-title">{{ c.title }}</h2>
        <el-tag :type="c.status === 'done' ? 'success' : c.status === 'cancelled' ? 'info' : 'primary'" size="small">{{ c.status_label }}</el-tag>
        <span class="lg-muted">{{ c.assignee_name }} · {{ c.tutorial_title }} v{{ c.tutorial_version }}<template v-if="c.due_on"> · 截止 {{ c.due_on }}</template></span>
        <span v-if="c.overdue" class="lgd-danger">已过截止日</span>
      </template>
    </div>
    <el-progress v-if="c" :percentage="c.pct" :format="() => `${c.done}/${c.total}`" class="cv-progress" />

    <div v-if="c" :class="isDesktop ? 'cv-wrap' : ''">
      <!-- 全部步骤 -->
      <aside :class="isDesktop ? 'cv-rail lgd-card' : 'cv-rail-m'">
        <div v-for="st in stages" :key="st.code" class="cv-stage">
          <div class="cv-stage__title">{{ st.title }}<small v-if="st.duration"> · {{ st.duration }}</small></div>
          <button v-for="s in st.steps" :key="s.code" :class="['cv-step', 'cv-step--' + s.state, { 'cv-step--on': s.code === pick }]" @click="pick = s.code">
            <b>{{ s.code }}</b><span class="cv-step__t">{{ s.title }}</span><em>{{ s.state_label }}</em>
          </button>
        </div>
      </aside>

      <!-- 这一步 -->
      <section v-if="step" :class="isDesktop ? 'lgd-card cv-main' : 'lg-card'">
        <div :class="isDesktop ? 'lgd-card__body' : ''">
          <div v-if="step.state === 'locked'" class="cv-banner">
            还没到这一步，只能先看看。
            <el-button link type="primary" @click="pick = c.current_code">回到现在这一步 {{ c.current_code }}</el-button>
          </div>
          <div v-if="step.state === 'gated' && step.lock" class="cv-lock">
            <div class="cv-lock__t">🔒 {{ step.lock.reason }}</div>
            <div>不先做会怎样：{{ step.lock.consequence }}</div>
            <div>怎么办：{{ step.lock.hint }}</div>
            <el-button v-if="step.lock.case_id" size="small" type="danger" plain @click="emit('open-case', step.lock.case_id)">去看支付宝那份进度</el-button>
          </div>

          <div class="cv-head">
            <el-tag :type="STATE_TYPE[step.state]" size="small">{{ step.state_label }}</el-tag>
            <h3>{{ step.code }} · {{ sp.title }}</h3>
          </div>
          <p class="lg-muted">谁做：{{ sp.who }}<template v-if="sp.when"> ｜ 什么时候：{{ sp.when }}</template><template v-if="sp.require_review"> ｜ 要审核</template></p>

          <div v-if="sp.warn" class="cv-warn">⚠ {{ sp.warn }}</div>
          <div class="cv-guide">{{ sp.guide }}</div>
          <p class="cv-meta">
            视频：<a v-if="sp.video_url" :href="sp.video_url" target="_blank" rel="noopener">看操作视频</a><span v-else class="lg-muted">待录</span>
            <template v-if="sp.deliver"> ｜ 做到什么算完：{{ sp.deliver }}</template>
          </p>
          <p v-if="sp.stop" class="cv-meta">遇到这些先停手：{{ sp.stop }}</p>

          <el-collapse v-if="sp.guards?.length" class="cv-guards">
            <el-collapse-item :title="`防错清单（${sp.guards.length} 条）`">
              <div v-for="(g, i) in sp.guards" :key="i" class="cv-guard">
                <div v-for="[k, l] in GUARD_COLS" :key="k" v-show="g[k]"><span class="lg-muted">{{ l }}：</span>{{ g[k] }}</div>
              </div>
            </el-collapse-item>
          </el-collapse>

          <!-- D15：账单里对没对上 -->
          <div v-if="step.bill_check" class="cv-bill">
            <template v-if="!step.bill_check.amount">D14 还没登记测试金额。</template>
            <template v-else>
              D14 登记的测试金额 <b>¥{{ step.bill_check.amount }}</b>：
              <span v-if="!step.bill_check.authorized" class="lgd-danger">这个支付宝还没授权对账，系统拉不到账单（台账「对账」页发授权链接）</span>
              <span v-else-if="step.bill_check.found.length" class="lgd-ok">账单里找到 {{ step.bill_check.found.length }} 笔（{{ step.bill_check.found.map((f) => f.bill_date).join('、') }}）</span>
              <span v-else class="lgd-danger">账单里还没找到这笔</span>
              <div v-if="step.bill_check.same_amount?.length" class="lgd-danger">和「{{ step.bill_check.same_amount.join('、') }}」用了同一个金额</div>
            </template>
          </div>

          <!-- 交新设的密码 -->
          <div v-if="canLockIn" class="cv-box">
            <div class="cv-box__t">交新设的密码 <small class="lg-muted">交上去就锁进密码库，交完你自己也看不到</small></div>
            <el-form label-width="110px" size="small" class="lg-form">
              <el-form-item label="登录名"><el-input v-model="lock.login_name" placeholder="登录邮箱 / 手机号 / 会员名" /></el-form-item>
              <el-form-item label="登录密码"><el-input v-model="lock.password" type="password" show-password autocomplete="new-password" /></el-form-item>
              <el-form-item label="二级 / 支付密码"><el-input v-model="lock.secondary" type="password" show-password autocomplete="new-password" /></el-form-item>
              <el-form-item label="二次验证种子"><el-input v-model="lock.totp" placeholder="有的话填，A-Z 和 2-7 组成" autocomplete="off" /></el-form-item>
              <el-button type="primary" :loading="busy" @click="lockIn">锁进密码库</el-button>
            </el-form>
          </div>

          <!-- 交材料 -->
          <div v-if="canSubmit" class="cv-box">
            <div class="cv-box__t">{{ step.state === 'rejected' ? '改好重交' : '交这一步' }}</div>
            <el-form label-position="top" size="small" class="lg-form">
              <el-form-item v-for="m in sp.materials" :key="m.key" :label="m.label + (m.required ? '' : '（选填）')">
                <el-input v-model="form[m.key]" :type="m.kind === 'textarea' ? 'textarea' : 'text'" :autosize="{ minRows: 2 }" :placeholder="m.placeholder || '没有就写「待核」并说明为什么'" />
              </el-form-item>
              <el-checkbox v-if="sp.require_confirm" v-model="confirmed">我已经照着做完、红字都检查过了</el-checkbox>
              <div class="cv-actions">
                <el-button type="primary" :loading="busy" @click="submit">{{ sp.require_review ? '交给审核' : '交上（不用审核）' }}</el-button>
                <el-button v-if="canSkip" @click="askSkip">申请跳过</el-button>
              </div>
            </el-form>
          </div>
          <div v-else-if="canSkip" class="cv-actions"><el-button @click="askSkip">申请跳过这一步</el-button></div>
          <div v-if="step.skip" class="cv-meta">
            跳步申请（{{ step.skip.requested_by }}，{{ step.skip.created_at }}）：{{ step.skip.reason }} ——
            <b>{{ { pending: '等老板批', approved: '老板批准了', rejected: '老板没批' }[step.skip.status] }}</b>
            <template v-if="step.skip.decide_note">：{{ step.skip.decide_note }}</template>
          </div>

          <!-- 审核 -->
          <div v-if="canReview && step.state === 'submitted'" class="cv-box cv-box--review">
            <div class="cv-box__t">审核第 {{ step.history[0].version_no }} 版（{{ step.history[0].submitted_by }} 交的）</div>
            <el-input v-model="reviewNote" type="textarea" :autosize="{ minRows: 2 }" placeholder="打回要写清楚哪里不对、怎么改（至少 4 个字）；通过可不写" />
            <div class="cv-actions">
              <el-button type="success" :loading="busy" @click="review(true)">通过</el-button>
              <el-button type="danger" plain :loading="busy" @click="review(false)">打回</el-button>
            </div>
          </div>

          <!-- 历次 -->
          <div v-if="step.history?.length" class="cv-hist">
            <div class="cv-box__t">交过 {{ step.history.length }} 次</div>
            <div v-for="h in step.history" :key="h.version_no" class="cv-hist__row">
              <div><b>第 {{ h.version_no }} 版</b> · {{ HIST[h.status] }} · {{ h.submitted_by }} {{ h.submitted_at }}<template v-if="h.reviewed_by"> · {{ h.reviewed_by }} {{ h.reviewed_at }}</template></div>
              <div v-for="m in sp.materials" :key="m.key" v-show="h.materials?.[m.key]" class="lg-muted">{{ m.label }}：{{ h.materials[m.key] }}</div>
              <div v-if="h.review_note" :class="h.status === 'rejected' ? 'lgd-danger' : 'lg-muted'">意见：{{ h.review_note }}</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cv-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.cv-title { margin: 0; font-size: 17px; }
.cv-progress { margin-bottom: 14px; max-width: 520px; }
.cv-wrap { display: flex; gap: 16px; align-items: flex-start; }
.cv-rail { width: 300px; flex-shrink: 0; padding: 10px; max-height: calc(100vh - 210px); overflow-y: auto; position: sticky; top: 0; }
.cv-rail-m { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.cv-main { flex: 1; min-width: 0; }
.cv-stage { margin-bottom: 10px; }
.cv-stage__title { font-size: 12px; font-weight: 600; color: #6b7280; margin: 4px 2px 6px; }
.cv-step { display: flex; align-items: baseline; gap: 6px; width: 100%; text-align: left; border: 1px solid transparent; background: none; border-radius: 6px; padding: 5px 6px; cursor: pointer; font-size: 13px; color: #1f2937; }
.cv-step b { flex-shrink: 0; width: 30px; }
.cv-step__t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-step em { font-style: normal; font-size: 11px; color: #6b7280; flex-shrink: 0; }
.cv-step:hover { background: #f5f7fa; }
.cv-step--on { border-color: #1677ff; background: #eff6ff; }
.cv-step--approved b, .cv-step--skipped b { color: #047857; }
.cv-step--rejected b, .cv-step--gated b, .cv-step--rejected em, .cv-step--gated em { color: #dc2626; }
.cv-step--submitted b, .cv-step--submitted em { color: #b45309; }
.cv-step--active b, .cv-step--active em { color: #1677ff; }
.cv-step--locked { color: #9ca3af; }
.cv-head { display: flex; align-items: center; gap: 8px; }
.cv-head h3 { margin: 0; font-size: 16px; }
.cv-banner { background: #f5f7fa; border: 1px dashed #d1d5db; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }
.cv-lock { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-size: 13px; line-height: 1.8; }
.cv-lock__t { font-weight: 600; }
.cv-warn { background: #fef2f2; border-left: 3px solid #dc2626; color: #991b1b; padding: 8px 12px; margin: 10px 0; font-size: 13px; line-height: 1.7; }
.cv-guide { white-space: pre-wrap; line-height: 1.8; font-size: 14px; margin: 10px 0; }
.cv-meta { font-size: 13px; margin: 6px 0; }
.cv-guards { margin: 10px 0; }
.cv-guard { border-bottom: 1px dashed #e5e7eb; padding: 6px 0; font-size: 13px; line-height: 1.7; }
.cv-bill { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px; padding: 8px 12px; margin: 10px 0; font-size: 13px; }
.cv-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin: 12px 0; }
.cv-box--review { border-color: #fde68a; background: #fffbeb; }
.cv-box__t { font-weight: 600; font-size: 14px; margin-bottom: 8px; }
.cv-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.cv-hist { margin-top: 14px; }
.cv-hist__row { border-top: 1px solid #f0f0f0; padding: 8px 0; font-size: 13px; line-height: 1.7; }
</style>
