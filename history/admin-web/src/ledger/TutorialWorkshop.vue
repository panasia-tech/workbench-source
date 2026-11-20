<script setup>
// 开店教程（第五步）：审核人写、提交，老板发布或退回。阶段 → 步骤 → 要交的材料三层；每步可配红字、防错清单、
// 要不要审核 / 勾确认、跨轨锁（店铺教程才有，格式 alipay:C10）、要不要交新设密码进库。没录视频就空着，页面上写「待录」。
// 已发布的不能直接改：改了保存是另存一个新版本草稿，发布新版本时旧的自动归档，已经在走的进度还按旧版本走。
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api, { errText } from './api'
import { useDesktop } from './useDesktop'

const props = defineProps({ isBoss: Boolean })
const isDesktop = useDesktop()

const list = ref([])
const meta = ref({ kinds: {}, platforms: {}, material_kinds: {}, lockin_categories: {} })
const loading = ref(false)
const edit = ref(null) // 正在改的那份（整棵树）
const saving = ref(false)

const STATUS_TYPE = { draft: 'info', pending: 'warning', published: 'success', archived: '' }
const GUARD_COLS = [['pre', '什么时候'], ['mistake', '容易错成'], ['block', '系统怎么拦'], ['tip', '提示'], ['recover', '错了怎么补'], ['owner', '谁负责'], ['evidence', '留什么证据']]

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/ledger/onboard/tutorials')
    list.value = data.items
    meta.value = data
  } catch (err) {
    ElMessage.error(errText(err, '加载失败'))
  } finally {
    loading.value = false
  }
}

async function open(row) {
  try {
    edit.value = (await api.get(`/ledger/onboard/tutorials/${row.id}`)).data
  } catch (err) {
    ElMessage.error(errText(err, '打不开'))
  }
}

const newStep = (code = 'A01') => ({ code, title: '', who: '开店员工', when: '', guide: '', warn: '', deliver: '', stop: '', video_url: '',
  require_review: false, require_confirm: false, gate: '', vault_lockin: '', guards: [], materials: [{ key: 'shot', label: '做完的截图说明', kind: 'text', required: true, placeholder: '' }] })

const nOpen = ref(false)
const n = ref({ kind: 'shop', platform: '', title: '' })
async function create() {
  try {
    const body = [{ title: '阶段 1', desc: '', duration: '', steps: [{ ...newStep('A01'), title: '第一步（改成真的）' }] }]
    const { data } = await api.post('/ledger/onboard/tutorials', { ...n.value, body })
    nOpen.value = false
    await load()
    open({ id: data.id })
  } catch (err) {
    ElMessage.error(errText(err, '没建成'))
  }
}

function nextCode(stage) {
  const all = edit.value.body.flatMap((s) => s.steps.map((x) => x.code))
  const prefix = (stage.steps[0]?.code || 'A01').replace(/\d+$/, '')
  let i = 1
  while (all.includes(prefix + String(i).padStart(2, '0'))) i++
  return prefix + String(i).padStart(2, '0')
}

function move(arr, i, d) {
  const j = i + d
  if (j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

const readonlyNote = computed(() => (['published', 'archived'].includes(edit.value?.status) ? '这一版已发布，保存会另存成新版本草稿，发布前员工还用旧版。' : ''))

async function save() {
  saving.value = true
  try {
    const { data } = await api.put(`/ledger/onboard/tutorials/${edit.value.id}`, { title: edit.value.title, summary: edit.value.summary, body: edit.value.body })
    ElMessage.success(data.id !== edit.value.id ? `另存成 v${data.version} 草稿了` : '保存了')
    await load()
    await open({ id: data.id })
  } catch (err) {
    ElMessage.error(errText(err, '没保存'))
  } finally {
    saving.value = false
  }
}

async function submit(row) {
  try {
    await api.post(`/ledger/onboard/tutorials/${row.id}/submit`)
    ElMessage.success('交给老板发布了')
    load()
    if (edit.value?.id === row.id) open(row)
  } catch (err) {
    ElMessage.error(errText(err, '没提交'))
  }
}

async function verdict(row, approve) {
  try {
    let note = ''
    if (!approve) {
      note = (await ElMessageBox.prompt('哪里要改？', `退回 ${row.title}`, { inputType: 'textarea', inputValidator: (v) => (v || '').trim().length >= 4 || '至少写 4 个字' })).value
    } else {
      await ElMessageBox.confirm(`发布「${row.title}」v${row.version}？发布后就能按它派单，同编号的旧版本归档。`, '发布教程')
    }
    await api.post(`/ledger/onboard/tutorials/${row.id}/verdict`, { approve, note })
    ElMessage.success(approve ? '发布了' : '退回了')
    load()
    if (edit.value?.id === row.id) open(row)
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(errText(err, '没成功'))
  }
}

onMounted(load)
</script>

<template>
  <div v-if="!edit" v-loading="loading">
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <h3 :class="isDesktop ? 'lgd-card__title' : 'lg-section'">开店教程 <small>审核人写、老板发布；先照「写教程的教程」亲手走一遍再写</small></h3>
        <el-button type="primary" size="small" @click="n = { kind: 'shop', platform: '', title: '' }; nOpen = true">新写一份</el-button>
      </div>
      <div :class="isDesktop ? 'lgd-card__body--table' : ''">
        <el-table :data="list" size="small" @row-click="open">
          <el-table-column label="教程" min-width="240"><template #default="{ row }">{{ row.title }} <span class="lg-muted">v{{ row.version }}</span></template></el-table-column>
          <el-table-column label="开什么" width="110"><template #default="{ row }">{{ row.platform_label || row.kind_label }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="STATUS_TYPE[row.status]" size="small">{{ row.status_label }}</el-tag></template></el-table-column>
          <el-table-column label="步数" width="120"><template #default="{ row }">{{ row.stage_count }} 段 {{ row.step_count }} 步 · 审 {{ row.review_count }}</template></el-table-column>
          <el-table-column label="视频待录" prop="video_missing" width="80" />
          <el-table-column label="" width="150">
            <template #default="{ row }">
              <el-button v-if="row.status === 'draft'" link type="primary" size="small" @click.stop="submit(row)">提交发布</el-button>
              <template v-if="row.status === 'pending' && isBoss">
                <el-button link type="success" size="small" @click.stop="verdict(row, true)">发布</el-button>
                <el-button link type="danger" size="small" @click.stop="verdict(row, false)">退回</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <el-dialog v-model="nOpen" title="新写一份教程" width="440px">
      <el-form label-width="70px" class="lg-form">
        <el-form-item label="开什么">
          <el-radio-group v-model="n.kind"><el-radio-button v-for="(l, k) in meta.kinds" :key="k" :value="k">{{ l }}</el-radio-button></el-radio-group>
        </el-form-item>
        <el-form-item v-if="n.kind === 'shop'" label="平台">
          <el-select v-model="n.platform" filterable><el-option v-for="(l, k) in meta.platforms" :key="k" :label="l" :value="k" /></el-select>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="n.title" placeholder="比如：小红书小店开店" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="nOpen = false">取消</el-button><el-button type="primary" @click="create">建草稿</el-button></template>
    </el-dialog>
  </div>

  <!-- 编辑 -->
  <div v-else>
    <div class="tw-top">
      <span class="lgd-back" @click="edit = null; load()">← 返回清单</span>
      <el-tag :type="STATUS_TYPE[edit.status]" size="small">{{ edit.status_label }}</el-tag>
      <span class="lg-muted">{{ edit.code }} v{{ edit.version }}<template v-if="edit.review_note"> · 老板意见：{{ edit.review_note }}</template></span>
      <span class="tw-sp" />
      <el-button v-if="edit.status === 'draft'" size="small" @click="submit(edit)">提交发布</el-button>
      <template v-if="edit.status === 'pending' && isBoss">
        <el-button size="small" type="success" @click="verdict(edit, true)">发布</el-button>
        <el-button size="small" type="danger" plain @click="verdict(edit, false)">退回</el-button>
      </template>
      <el-button type="primary" size="small" :loading="saving" @click="save">保存</el-button>
    </div>
    <p v-if="readonlyNote" class="lg-warn">{{ readonlyNote }}</p>
    <div :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__body' : ''">
        <el-input v-model="edit.title" placeholder="标题" class="tw-mb" />
        <el-input v-model="edit.summary" type="textarea" :autosize="{ minRows: 2 }" placeholder="一句话说清这份教程开什么、要准备什么" />
      </div>
    </div>

    <div v-for="(st, si) in edit.body" :key="si" :class="isDesktop ? 'lgd-card' : 'lg-card'">
      <div :class="isDesktop ? 'lgd-card__head' : 'lg-row'">
        <el-input v-model="st.title" class="tw-stage" placeholder="阶段标题" />
        <div class="lgd-toolbar">
          <el-input v-model="st.duration" size="small" placeholder="多久，比如 第 1 天" style="width: 140px" />
          <el-button link size="small" @click="move(edit.body, si, -1)">上移</el-button>
          <el-button link size="small" @click="move(edit.body, si, 1)">下移</el-button>
          <el-button link type="danger" size="small" @click="edit.body.splice(si, 1)">删阶段</el-button>
        </div>
      </div>
      <div :class="isDesktop ? 'lgd-card__body' : ''">
        <el-input v-model="st.desc" type="textarea" :autosize="{ minRows: 1 }" placeholder="这一阶段要干什么" class="tw-mb" />
        <el-collapse>
          <el-collapse-item v-for="(sp, pi) in st.steps" :key="pi" :name="si + '-' + pi">
            <template #title>
              <b class="tw-code">{{ sp.code }}</b>{{ sp.title || '（没写标题）' }}
              <el-tag v-if="sp.require_review" size="small" type="warning" class="tw-tag">审</el-tag>
              <el-tag v-if="sp.gate" size="small" type="danger" class="tw-tag">锁 {{ sp.gate }}</el-tag>
              <el-tag v-if="sp.vault_lockin" size="small" class="tw-tag">交密码</el-tag>
              <el-tag v-if="!sp.video_url" size="small" type="info" class="tw-tag">视频待录</el-tag>
            </template>
            <el-form label-width="100px" size="small" class="lg-form">
              <el-form-item label="编号 / 标题">
                <div class="tw-row"><el-input v-model="sp.code" style="width: 80px" /><el-input v-model="sp.title" /></div>
              </el-form-item>
              <el-form-item label="谁做 / 何时"><div class="tw-row"><el-input v-model="sp.who" style="width: 160px" /><el-input v-model="sp.when" /></div></el-form-item>
              <el-form-item label="怎么做"><el-input v-model="sp.guide" type="textarea" :autosize="{ minRows: 3 }" /></el-form-item>
              <el-form-item label="红字"><el-input v-model="sp.warn" type="textarea" :autosize="{ minRows: 1 }" placeholder="不看会废号 / 出错的地方，页面上红色平铺" /></el-form-item>
              <el-form-item label="做到什么算完"><el-input v-model="sp.deliver" /></el-form-item>
              <el-form-item label="先停手"><el-input v-model="sp.stop" placeholder="遇到什么情况先停下找人" /></el-form-item>
              <el-form-item label="视频"><el-input v-model="sp.video_url" placeholder="https://…（没录就空着，别填假的）" /></el-form-item>
              <el-form-item label="闸口">
                <el-checkbox v-model="sp.require_review">要审核</el-checkbox>
                <el-checkbox v-model="sp.require_confirm">要勾确认</el-checkbox>
                <el-input v-if="edit.kind === 'shop'" v-model="sp.gate" placeholder="跨轨锁 alipay:C10" style="width: 160px; margin-left: 12px" />
                <el-select v-model="sp.vault_lockin" clearable placeholder="交密码进库" style="width: 150px; margin-left: 12px">
                  <el-option v-for="(l, k) in meta.lockin_categories" :key="k" :label="'交密码（' + l + '）'" :value="k" />
                </el-select>
              </el-form-item>
              <el-form-item label="要交的材料">
                <div class="tw-list">
                  <div v-for="(m, mi) in sp.materials" :key="mi" class="tw-row">
                    <el-input v-model="m.key" placeholder="键 shot" style="width: 110px" />
                    <el-input v-model="m.label" placeholder="叫什么" />
                    <el-select v-model="m.kind" style="width: 90px"><el-option v-for="(l, k) in meta.material_kinds" :key="k" :label="l" :value="k" /></el-select>
                    <el-checkbox v-model="m.required">必填</el-checkbox>
                    <el-input v-model="m.placeholder" placeholder="提示" />
                    <el-button link type="danger" @click="sp.materials.splice(mi, 1)">删</el-button>
                  </div>
                  <el-button link type="primary" @click="sp.materials.push({ key: '', label: '', kind: 'text', required: true, placeholder: '' })">+ 材料</el-button>
                </div>
              </el-form-item>
              <el-form-item label="防错清单">
                <div class="tw-list">
                  <div v-for="(g, gi) in sp.guards" :key="gi" class="tw-guard">
                    <el-input v-for="[k, l] in GUARD_COLS" :key="k" v-model="g[k]" :placeholder="l" />
                    <el-button link type="danger" @click="sp.guards.splice(gi, 1)">删</el-button>
                  </div>
                  <el-button link type="primary" @click="sp.guards.push(Object.fromEntries(GUARD_COLS.map(([k]) => [k, ''])))">+ 一条</el-button>
                </div>
              </el-form-item>
              <div class="tw-row">
                <el-button size="small" @click="move(st.steps, pi, -1)">上移</el-button>
                <el-button size="small" @click="move(st.steps, pi, 1)">下移</el-button>
                <el-button size="small" type="danger" plain @click="st.steps.splice(pi, 1)">删这一步</el-button>
              </div>
            </el-form>
          </el-collapse-item>
        </el-collapse>
        <el-button link type="primary" class="tw-add" @click="st.steps.push(newStep(nextCode(st)))">+ 加一步</el-button>
      </div>
    </div>
    <el-button @click="edit.body.push({ title: '新阶段', desc: '', duration: '', steps: [newStep(nextCode({ steps: [] }))] })">+ 加阶段</el-button>
  </div>
</template>

<style scoped>
.tw-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.tw-sp { flex: 1; }
.tw-mb { margin-bottom: 8px; }
.tw-stage { max-width: 460px; font-weight: 600; }
.tw-code { width: 40px; display: inline-block; }
.tw-tag { margin-left: 6px; }
.tw-row { display: flex; gap: 6px; align-items: center; width: 100%; flex-wrap: wrap; }
.tw-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.tw-guard { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; border: 1px dashed #e5e7eb; padding: 6px; border-radius: 6px; }
.tw-add { margin-top: 8px; }
</style>
