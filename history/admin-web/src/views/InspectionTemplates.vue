<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { errorText, uploadEvidence } from '../utils/evidenceUpload'

const list = ref([])
const settings = ref(null)
const visible = ref(false)
const form = ref(null)
const previewRow = ref(null)

async function load() {
  const [tpl, st] = await Promise.all([api.get('/inspection-ops/templates'), api.get('/inspection-ops/settings')])
  list.value = tpl.data
  settings.value = st.data
}

async function saveSettings() {
  try {
    const { full_check_required, outbound_review_required, return_recheck_required } = settings.value
    await api.put('/inspection-ops/settings', { full_check_required, outbound_review_required, return_recheck_required })
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
    await load()
  }
}

function blank() {
  return { id: null, name: '', category: '', brand: '', model: '', keywordsText: '', steps: [newStep()], enabled: true }
}

function newStep() {
  return { key: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title: '', guide: '', need_photo: false, video_url: null, video_play: null, standard: '' }
}

function edit(row) {
  form.value = row
    ? { ...row, keywordsText: (row.keywords || []).join('、'), steps: row.steps.map((s) => ({ ...s })) }
    : blank()
  visible.value = true
}

function move(i, delta) {
  const steps = form.value.steps
  const [step] = steps.splice(i, 1)
  steps.splice(i + delta, 0, step)
}

async function save() {
  const { id, keywordsText, ...rest } = form.value
  const body = { ...rest, keywords: keywordsText.split(/[、,，\s]+/).filter(Boolean) }
  try {
    if (id) await api.put(`/inspection-ops/templates/${id}`, body)
    else await api.post('/inspection-ops/templates', body)
    visible.value = false
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  }
}

async function seed() {
  try {
    const { data } = await api.post('/inspection-ops/templates/seed-demo')
    ElMessage.success(data.count ? `补上 ${data.count} 套：${data.names.join('、')}` : '示例规范都有了')
    await load()
  } catch (err) {
    ElMessage.error(errorText(err, '导入失败'))
  }
}

onMounted(load)

// 每一步的操作教程视频：传 OSS，存地址；员工在 H5 逐项验货时当前这一步能直接点开看（禅道 WH06）
const uploadingKey = ref('')
async function uploadVideo(step, e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  uploadingKey.value = step.key
  try {
    const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0].toLowerCase()
    const url = await uploadEvidence(file, 'inspection/tutorial', ext)
    step.video_url = url
    step.video_play = url
    ElMessage.success('视频已上传，记得保存规范')
  } catch (err) {
    ElMessage.error(errorText(err, '上传失败'))
  } finally {
    uploadingKey.value = ''
  }
}
</script>

<template>
  <div class="page-card">
    <div class="page-card__header">
      <h3 class="page-card__title">验货规范</h3>
      <div v-if="settings?.can_edit">
        <el-button @click="seed">补齐示例规范</el-button>
        <el-button type="primary" @click="edit(null)">新建规范</el-button>
      </div>
    </div>
    <div class="page-card__body">
      <el-form v-if="settings?.can_edit" inline>
        <el-form-item label="必须逐项验完">
          <el-switch v-model="settings.full_check_required" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="寄出前必须复核">
          <el-switch v-model="settings.outbound_review_required" @change="saveSettings" />
        </el-form-item>
        <el-form-item label="退货入库前必须复验">
          <el-switch v-model="settings.return_recheck_required" @change="saveSettings" />
        </el-form-item>
      </el-form>

      <el-table :data="list">
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="category" label="品类" width="110" />
        <el-table-column prop="brand" label="品牌" width="110" />
        <el-table-column prop="model" label="型号" width="130" />
        <el-table-column label="检查项" width="80"><template #default="{ row }">{{ row.steps.length }}</template></el-table-column>
        <el-table-column prop="version" label="版本" width="70" />
        <el-table-column label="状态" width="80">
          <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="130">
          <template #default="{ row }">
            <el-button link type="primary" @click="previewRow = row">预览</el-button>
            <el-button v-if="settings?.can_edit" link type="primary" @click="edit(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog :model-value="!!previewRow" :title="previewRow?.name" width="560px" @close="previewRow = null">
      <ol v-if="previewRow">
        <li v-for="s in previewRow.steps" :key="s.key" style="margin-bottom: 8px">
          <b>{{ s.title }}</b><span v-if="s.need_photo">（要拍照）</span>
          <a v-if="s.video_play" :href="s.video_play" target="_blank" style="margin-left: 8px">教程视频</a>
          <div>{{ s.guide }}</div>
          <div v-if="s.standard" class="std">判定：{{ s.standard }}</div>
        </li>
      </ol>
    </el-dialog>

    <el-dialog v-model="visible" :title="form?.id ? '编辑规范' : '新建规范'" width="760px">
      <el-form v-if="form" label-width="84px">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-row>
          <el-col :span="8"><el-form-item label="品类"><el-input v-model="form.category" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="品牌"><el-input v-model="form.brand" placeholder="空=整个品类" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="型号"><el-input v-model="form.model" placeholder="空=整个品牌" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="匹配词"><el-input v-model="form.keywordsText" placeholder="商品名含这些词算这个品类，用顿号隔开" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        <el-form-item label="检查项">
          <div v-for="(s, i) in form.steps" :key="s.key" class="step">
            <el-input v-model="s.title" placeholder="检查项" style="width: 150px" />
            <el-input v-model="s.guide" placeholder="怎么验" style="flex: 1" />
            <el-checkbox v-model="s.need_photo">拍照</el-checkbox>
            <el-button link :disabled="i === 0" @click="move(i, -1)">上移</el-button>
            <el-button link type="danger" @click="form.steps.splice(i, 1)">删</el-button>
            <div class="step-extra">
              <el-input v-model="s.standard" placeholder="判定标准：合格/不合格怎么判，必须交什么材料（选填）" style="flex: 1" />
              <a v-if="s.video_play" :href="s.video_play" target="_blank">看视频</a>
              <el-button v-if="s.video_url" link type="danger" @click="s.video_url = null; s.video_play = null">去掉视频</el-button>
              <label class="upload">
                <input type="file" accept="video/*" hidden @change="(e) => uploadVideo(s, e)" />
                {{ uploadingKey === s.key ? '上传中…' : s.video_url ? '换教程视频' : '+ 教程视频' }}
              </label>
            </div>
          </div>
          <el-button size="small" @click="form.steps.push(newStep())">加一项</el-button>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.step { display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 10px; flex-wrap: wrap; }
.step-extra { display: flex; align-items: center; gap: 8px; width: 100%; padding-left: 158px; }
.upload { color: var(--el-color-primary); font-size: 13px; cursor: pointer; white-space: nowrap; }
.std { color: var(--el-text-color-secondary); font-size: 13px; }
</style>
