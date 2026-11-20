<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import {
  checkResultLabels,
  checkResultTypes,
  errorText,
  evidenceKindLabels,
  exceptionTypeLabels,
  newObjectName,
  uploadEvidence,
} from '../utils/evidenceUpload'
import { appendChunk, listJobs, loadBlob, removeJob, saveJob } from '../utils/recordingStore'

// 码率压到 1.5Mbps：50MB 约能录 4 分半，走服务器上传就够
const VIDEO_BITRATE = 1500000
const MAX_RECORD_SECONDS = 30 * 60

const tasks = ref([])
const q = ref('')
const taskId = ref('')
const detail = ref(null)
const templates = ref([])
const pickedTemplate = ref('')

const videoEl = ref(null)
const cameras = ref([])
const cameraId = ref('')
const cameraError = ref('')
const cameraReady = ref(false)
let stream = null
let recorder = null
let chunks = []
let recordTimer = null
// 这段录像的本地副本和中断情况（设备断开、录制出错）
let current = null
// 上次没传完的录像（浏览器本地存着的）
const leftovers = ref([])
const recording = ref(false)
const recordSeconds = ref(0)
// 上传失败的留在这里重试，录好的视频不能因为断网就没了
const pendingUploads = ref([])
const uploading = ref(false)

const editing = ref(null)
const itemFiles = ref([])
const saving = ref(false)
const exceptionForm = ref({ exception_type: 'DAMAGED', description: '' })
const exceptionVisible = ref(false)

const items = computed(() => detail.value?.items || [])
const doneCount = computed(() => items.value.filter((i) => i.result).length)
const isPending = computed(() => detail.value?.task.status === 'PENDING')
// W11：卖家原话（下单时那版快照）对照、卖家没说过的不通过项
const compare = computed(() => detail.value?.compare || null)
const CAUSES = { unknown: '待判', seller: '卖家没说清', transport: '运输造成' }
const newProblemTitles = computed(() => (compare.value?.new_problems || []).map((k) => items.value.find((i) => i.item_key === k)?.title).filter(Boolean))
// 已提交的单子只能补测「无法测试」的项
const canEdit = (i) => isPending.value || i.result === 'UNTESTABLE'
const retesting = computed(() => !isPending.value && !!editing.value)
const retests = ref([])
const FULL_CHECK_TYPES = { NONE: 'info', IN_PROGRESS: 'warning', RETEST: 'danger', COMPLETE: 'success' }

async function loadRetests() {
  const { data } = await api.get('/inspection-ops/retests')
  retests.value = data.items
}

function openRetest(id) {
  const r = retests.value.find((x) => x.task_id === id)
  if (r && !tasks.value.some((t) => t.id === id)) tasks.value.push({ id, inspect_no: r.inspect_no, product_name: `${r.product_name}（补测）` })
  taskId.value = id
  loadDetail()
}

async function loadTasks() {
  const { data } = await api.get('/inspection/tasks', { params: { status: 'PENDING', q: q.value || undefined, size: 50 } })
  tasks.value = data.items
}

async function loadDetail() {
  if (!taskId.value) return
  const { data } = await api.get(`/inspection-ops/tasks/${taskId.value}/check`)
  detail.value = data
  pickedTemplate.value = data.matched_template?.id || ''
}

async function startCheck() {
  try {
    await api.post(`/inspection-ops/tasks/${taskId.value}/check/start`, { template_id: pickedTemplate.value || null })
    await loadDetail()
  } catch (err) {
    ElMessage.error(errorText(err, '开始失败'))
  }
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  cameras.value = devices.filter((d) => d.kind === 'videoinput')
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop())
  stream = null
  cameraReady.value = false
}

async function openCamera() {
  cameraError.value = ''
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError.value = '这个浏览器不能用摄像头，请用 Chrome 或 Edge 打开 https 地址'
    return
  }
  stopStream()
  const video = { deviceId: cameraId.value ? { exact: cameraId.value } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: true }).catch((err) => {
      // 不少 USB 摄像头没有麦克风，没声音也要能录
      if (err?.name === 'NotFoundError' || err?.name === 'NotReadableError') {
        return navigator.mediaDevices.getUserMedia({ video })
      }
      throw err
    })
  } catch (err) {
    cameraError.value = err?.name === 'NotAllowedError' ? '浏览器没给摄像头权限，点地址栏左侧的图标打开' : '打不开摄像头，检查 USB 线或换一个摄像头'
    return
  }
  videoEl.value.srcObject = stream
  cameraReady.value = true
  await listCameras()
  cameraId.value = stream.getVideoTracks()[0]?.getSettings().deviceId || cameraId.value
}

function cameraLabel() {
  return stream?.getVideoTracks()[0]?.label || null
}

function recorderType() {
  // 优先 mp4：微信和手机浏览器放不了 webm
  return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  )
}

function startRecord() {
  if (!stream) return
  chunks = []
  const mimeType = recorderType()
  const ext = mimeType.startsWith('video/mp4') ? '.mp4' : '.webm'
  // 文件名一开始就定下：之后重试上传、关页后补传都用它，服务端按地址去重
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: taskId.value,
    taskLabel: detail.value ? `${detail.value.task.inspect_no} ${detail.value.task.product_name}` : '',
    startedAt: new Date().toISOString(),
    mime: mimeType,
    ext,
    filename: newObjectName(ext),
    device: cameraLabel(),
    stopped: false,
    gapNote: '',
  }
  current = job
  saveJob(job)
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITRATE })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chunks.push(e.data)
    appendChunk(job.id, e.data) // 边录边存本地，刷新/关页也不丢
  }
  recorder.onerror = (e) => {
    job.gapNote = `录制出错：${e.error?.name || '未知'}`
    ElMessage.error('录制出错，已保存录到的部分并标记中断')
    stopRecord()
  }
  const track = stream.getVideoTracks()[0]
  if (track) {
    track.onended = () => {
      if (recorder?.state !== 'recording') return
      job.gapNote = '录制中摄像头断开'
      cameraError.value = '摄像头断开了：已录的部分会上传并标记中断，接好线后点「打开摄像头」再录一段续录'
      stopRecord()
    }
  }
  const seconds = () => recordSeconds.value
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType })
    job.stopped = true
    saveJob(job)
    queueUpload({
      taskId: job.taskId,
      blob,
      kind: 'UNBOX_VIDEO',
      ext,
      duration: seconds(),
      device: job.device,
      localJobId: job.id,
      filename: job.filename,
      startedAt: job.startedAt,
      interrupted: !!job.gapNote,
      gapNote: job.gapNote,
    })
    current = null
  }
  recorder.start(5000)
  recording.value = true
  recordSeconds.value = 0
  recordTimer = setInterval(() => {
    recordSeconds.value += 1
    if (recordSeconds.value >= MAX_RECORD_SECONDS) stopRecord()
  }, 1000)
}

function stopRecord() {
  clearInterval(recordTimer)
  if (recorder?.state === 'recording') recorder.stop()
  recording.value = false
}

function takePhoto(kind) {
  const video = videoEl.value
  if (!stream || !video?.videoWidth) return
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d').drawImage(video, 0, 0)
  canvas.toBlob(
    (blob) => queueUpload({ taskId: taskId.value, blob, kind, ext: '.jpg', device: cameraLabel(), itemKey: editing.value?.item_key }),
    'image/jpeg',
    0.92,
  )
}

function queueUpload(job) {
  pendingUploads.value.push({ ...job, failed: false })
  runUploads()
}

async function runUploads() {
  if (uploading.value) return
  uploading.value = true
  // 每轮重新找：上传途中新拍的也要接着传
  let job = pendingUploads.value.find((j) => !j.failed)
  while (job) {
    try {
      if (!job.filename) job.filename = newObjectName(job.ext) // 照片也定名，重试不换名
      const url = await uploadEvidence(job.blob, 'inspection/evidence/', job.ext, job.filename)
      await api.post(`/inspection-ops/tasks/${job.taskId}/evidence`, {
        kind: job.kind,
        url,
        item_key: job.itemKey || null,
        duration_seconds: job.duration || null,
        size_bytes: job.blob.size,
        device_label: job.device,
        started_at: job.startedAt || null,
        interrupted: !!job.interrupted,
        gap_note: job.gapNote || null,
      })
      // 服务端确认文件在、登记成功了，才删本地副本
      if (job.localJobId) await removeJob(job.localJobId)
      if (job.itemKey && editing.value?.item_key === job.itemKey) itemFiles.value.push(url)
      pendingUploads.value.splice(pendingUploads.value.indexOf(job), 1)
    } catch {
      job.failed = true
    }
    job = pendingUploads.value.find((j) => !j.failed)
  }
  uploading.value = false
  await loadDetail()
  if (pendingUploads.value.length) ElMessage.error(`${pendingUploads.value.length} 个文件没传上去，点重试`)
}

// 上次没传完的录像：页面打开时从浏览器本地找出来（禅道 WH04-13）
async function loadLeftovers() {
  const pendingIds = new Set(pendingUploads.value.map((j) => j.localJobId).filter(Boolean))
  leftovers.value = (await listJobs()).filter((j) => !pendingIds.has(j.id) && j.id !== current?.id)
}

async function resumeLeftover(job) {
  const blob = await loadBlob(job.id, job.mime)
  if (!blob) {
    ElMessage.error('本地副本是空的，传不了')
    return
  }
  queueUpload({
    taskId: job.taskId,
    blob,
    kind: 'UNBOX_VIDEO',
    ext: job.ext,
    device: job.device,
    localJobId: job.id,
    filename: job.filename,
    startedAt: job.startedAt,
    // 录制中关了页面：录到哪算哪，标中断
    interrupted: !job.stopped || !!job.gapNote,
    gapNote: job.gapNote || (job.stopped ? '' : '录制中页面被关闭，补传录到的部分'),
  })
  leftovers.value = leftovers.value.filter((j) => j.id !== job.id)
}

async function downloadLocal(job) {
  const blob = job.blob || (await loadBlob(job.localJobId || job.id, job.mime))
  if (!blob) return ElMessage.error('本地没有这段录像')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `开箱录像-${(job.taskLabel || job.taskId || '').replace(/\s+/g, '_')}-${(job.startedAt || '').slice(0, 19).replace(/[:T]/g, '')}${job.ext || '.webm'}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

async function dropLeftover(job) {
  if (!window.confirm('丢弃这段本地录像？丢了就找不回来了')) return
  await removeJob(job.id)
  leftovers.value = leftovers.value.filter((j) => j.id !== job.id)
}

function retryUploads() {
  pendingUploads.value.forEach((j) => (j.failed = false))
  runUploads()
}

function editItem(item) {
  if (!canEdit(item)) return
  // 不预先选「通过」：没验的必须自己选，补测时清空原来的「无法测试」
  editing.value = {
    ...item,
    result: isPending.value ? item.result || '' : '',
    note: isPending.value ? item.note || '' : '',
    defect_part: isPending.value ? item.defect_part || '' : '',
    seller_claim: isPending.value ? item.seller_claim || '' : '',
    disclosed: isPending.value ? !!item.disclosed : false,
    cause: isPending.value ? item.cause || 'unknown' : 'unknown',
  }
  itemFiles.value = [...(item.evidence || [])]
}

async function saveItem() {
  saving.value = true
  try {
    await api.put(`/inspection-ops/tasks/${taskId.value}/check/${editing.value.item_key}`, {
      result: editing.value.result,
      note: editing.value.note,
      evidence: itemFiles.value,
      defect_part: editing.value.defect_part,
      seller_claim: editing.value.seller_claim,
      disclosed: editing.value.result === 'FAIL' ? !!editing.value.disclosed : null,
      cause: editing.value.result === 'FAIL' ? editing.value.cause || 'unknown' : null,
    })
    await loadDetail()
    if (!isPending.value) {
      editing.value = null
      await loadRetests()
      return
    }
    const next = items.value.find((i) => !i.result)
    if (next) editItem(next)
    else editing.value = null
  } catch (err) {
    ElMessage.error(errorText(err, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function raiseFromItems() {
  const keys = compare.value?.new_problems || []
  try {
    await ElMessageBox.confirm(`把 ${keys.length} 项卖家没说过的问题建成差异工单，会通知业务员和采购处理。`, '建差异工单',
      { confirmButtonText: '建', cancelButtonText: '不建' })
  } catch {
    return
  }
  try {
    await api.post(`/inspection-ops/tasks/${taskId.value}/exceptions/from-items`, { item_keys: keys })
    ElMessage.success('已建并通知，请继续验完')
    await loadDetail()
  } catch (err) {
    ElMessage.error(errorText(err, '没建成'))
  }
}

async function submitException() {
  try {
    await api.post(`/inspection-ops/tasks/${taskId.value}/exceptions`, exceptionForm.value)
    exceptionVisible.value = false
    exceptionForm.value = { exception_type: 'DAMAGED', description: '' }
    ElMessage.success('已登记，请继续验完')
    await loadDetail()
  } catch (err) {
    ElMessage.error(errorText(err, '登记失败'))
  }
}

function clock(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function warnOnLeave(e) {
  if (recording.value || pendingUploads.value.length) e.preventDefault()
}

onMounted(async () => {
  window.addEventListener('beforeunload', warnOnLeave)
  await Promise.all([
    loadTasks(),
    loadRetests(),
    loadLeftovers(),
    api.get('/inspection-ops/templates').then(({ data }) => (templates.value = data.filter((t) => t.enabled))),
  ])
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnOnLeave)
  stopRecord()
  stopStream()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">开箱验货</h3></div>
    <div class="page-card__body">
      <el-select
        v-model="taskId"
        filterable
        remote
        reserve-keyword
        :remote-method="(v) => { q = v; loadTasks() }"
        placeholder="选待验货的单子（可搜单号、运单号、商品）"
        style="width: 480px"
        @change="loadDetail"
      >
        <el-option v-for="t in tasks" :key="t.id" :value="t.id" :label="`${t.inspect_no} ${t.piece_label ? t.piece_label + ' ' : ''}${t.product_name}`" />
      </el-select>
      <el-select
        :model-value="''"
        :placeholder="`补测待办（${retests.length}）`"
        style="width: 260px; margin-left: 8px"
        @visible-change="(v) => v && loadRetests()"
        @change="openRetest"
      >
        <el-option
          v-for="r in retests"
          :key="r.task_id"
          :value="r.task_id"
          :label="`${r.inspect_no} ${r.product_name} · ${r.items.length} 项待补测`"
        />
      </el-select>

      <el-alert v-if="leftovers.length" type="warning" :closable="false" style="margin-top: 12px" title="上次没传完的开箱录像（存在这台电脑上）">
        <div v-for="j in leftovers" :key="j.id" class="row">
          <span>{{ j.taskLabel || j.taskId }} · {{ j.startedAt ? new Date(j.startedAt).toLocaleString('zh-CN', { hour12: false }).slice(0, 16) : '' }}{{ j.stopped ? '' : '（录制中被关闭）' }}</span>
          <el-button link type="primary" size="small" @click="resumeLeftover(j)">接着上传</el-button>
          <el-button link size="small" @click="downloadLocal(j)">下载</el-button>
          <el-button link type="danger" size="small" @click="dropLeftover(j)">丢弃</el-button>
        </div>
      </el-alert>

      <el-row v-if="detail" :gutter="16" style="margin-top: 16px">
        <el-col :span="11">
          <el-card v-if="compare" shadow="never" style="margin-bottom: 12px">
            <template #header>
              卖家原来怎么说的
              <span v-if="compare.snapshot" class="muted">· {{ compare.snapshot.capture_kind_label }}{{ compare.snapshot.frozen_at ? ' · 下单时冻结' : '' }}</span>
            </template>
            <template v-if="compare.snapshot">
              <div class="claim"><span class="claim-k">标题</span>{{ compare.snapshot.title || '—' }}</div>
              <div v-if="compare.snapshot.declared_model || compare.snapshot.specs" class="claim"><span class="claim-k">型号</span>{{ compare.snapshot.declared_model }} {{ compare.snapshot.specs }}</div>
              <div v-if="compare.snapshot.condition_text" class="claim"><span class="claim-k">成色</span>{{ compare.snapshot.condition_text }}</div>
              <div v-if="compare.snapshot.accessories_text" class="claim"><span class="claim-k">配件</span>{{ compare.snapshot.accessories_text }}</div>
              <div v-if="compare.snapshot.description" class="claim claim-desc"><span class="claim-k">描述</span>{{ compare.snapshot.description }}</div>
            </template>
            <p v-else class="muted">这单没有存卖家原话（商品快照），按采购截图核对。</p>
            <el-alert v-for="r in compare.risks" :key="r" :title="r" type="warning" :closable="false" style="margin-top: 8px" />
          </el-card>
          <el-card shadow="never" header="摄像头">
            <video ref="videoEl" autoplay muted playsinline class="cam" />
            <el-alert v-if="cameraError" :title="cameraError" type="error" :closable="false" />
            <div class="row">
              <el-select v-model="cameraId" placeholder="默认摄像头" style="width: 220px" @change="openCamera">
                <el-option v-for="c in cameras" :key="c.deviceId" :value="c.deviceId" :label="c.label || '摄像头'" />
              </el-select>
              <el-button @click="openCamera">打开摄像头</el-button>
            </div>
            <div class="row">
              <el-button v-if="!recording" type="primary" :disabled="!cameraReady" @click="startRecord">开始录开箱</el-button>
              <el-button v-else type="danger" @click="stopRecord">结束录制 {{ clock(recordSeconds) }}</el-button>
              <el-button :disabled="!cameraReady" @click="takePhoto('PRODUCT_PHOTO')">拍商品照</el-button>
              <el-button :disabled="!cameraReady" @click="takePhoto('DEFECT_PHOTO')">拍瑕疵照</el-button>
            </div>
            <div v-if="recording" class="rec-state">● 正在录 {{ clock(recordSeconds) }}（边录边存在本机，刷新也不丢）</div>
            <div v-for="(j, n) in pendingUploads" :key="n" class="row">
              <el-tag size="small" :type="j.failed ? 'danger' : 'warning'">{{ j.failed ? '上传失败' : uploading ? '上传中' : '待上传' }}</el-tag>
              <span class="muted">{{ evidenceKindLabels[j.kind] }}<template v-if="j.interrupted">（中断：{{ j.gapNote }}）</template></span>
              <el-button v-if="j.kind === 'UNBOX_VIDEO'" link size="small" @click="downloadLocal(j)">下载到本机</el-button>
            </div>
            <div v-if="pendingUploads.length && !uploading" class="row">
              <el-button size="small" @click="retryUploads">重试上传</el-button>
            </div>

          </el-card>

          <el-card shadow="never" header="已留凭证" style="margin-top: 12px">
            <el-empty v-if="!detail.evidence.length" description="还没有" :image-size="48" />
            <div v-for="e in detail.evidence" :key="e.id" class="row">
              <el-tag size="small">{{ evidenceKindLabels[e.kind] }}</el-tag>
              <el-tag v-if="e.interrupted" size="small" type="danger">中断：{{ e.gap_note || '原因没写' }}</el-tag>
              <span v-if="e.started_at" class="muted">{{ e.started_at.slice(11, 16) }} 起录</span>
              <a :href="e.url" target="_blank">查看</a>
              <span class="muted">{{ e.recorded_by_name }} {{ e.duration_seconds ? clock(e.duration_seconds) : '' }}</span>
            </div>
          </el-card>
        </el-col>

        <el-col :span="13">
          <el-card shadow="never">
            <template #header>
              <div class="row between">
                <span><el-tag v-if="detail.task.piece_label" size="small" style="margin-right: 4px">{{ detail.task.piece_label }}</el-tag>{{ detail.task.product_name }} <span class="muted">{{ detail.task.order_no }}</span></span>
                <el-button v-if="isPending" type="danger" plain size="small" @click="exceptionVisible = true">发现异常</el-button>
              </div>
            </template>

            <el-alert v-if="detail.unbox_gap" type="warning" :closable="false" :title="detail.unbox_gap" style="margin-bottom: 8px" />
            <el-alert
              v-for="x in detail.exceptions"
              :key="x.id"
              :type="x.overdue ? 'error' : 'warning'"
              :closable="false"
              :title="`${exceptionTypeLabels[x.exception_type]}：${x.description}`"
              :description="[x.overdue_parts.join('、'), x.notice || '还没发通知'].filter(Boolean).join('；')"
              style="margin-bottom: 8px"
            />

            <template v-if="!items.length">
              <p v-if="!isPending" class="muted">这张单子没有逐项记录。</p>
              <div v-else class="row">
                <el-select v-model="pickedTemplate" placeholder="选验货规范" style="width: 280px">
                  <el-option v-for="t in templates" :key="t.id" :value="t.id" :label="t.name" />
                </el-select>
                <el-button type="primary" :disabled="!pickedTemplate" @click="startCheck">开始逐项验货</el-button>
              </div>
              <ol v-if="detail.matched_template" class="preview">
                <li v-for="s in detail.matched_template.steps" :key="s.key">{{ s.title }}</li>
              </ol>
            </template>

            <template v-else>
              <div class="row between" style="margin-bottom: 8px">
                <el-tag :type="FULL_CHECK_TYPES[detail.full_check.state]">{{ detail.full_check.label }}</el-tag>
                <span v-if="!isPending && detail.full_check.state === 'RETEST'" class="muted">已提交，点「无法测试」的项补测</span>
              </div>
              <el-progress :percentage="Math.round((doneCount / items.length) * 100)" :format="() => `${doneCount}/${items.length}`" />
              <div
                v-for="i in items"
                :key="i.item_key"
                class="item"
                :class="{ active: editing?.item_key === i.item_key }"
                @click="editItem(i)"
              >
                <div class="row between">
                  <span><el-tag size="small" type="info" effect="plain" style="margin-right: 6px">{{ i.dimension_label }}</el-tag>{{ i.title }}<span v-if="i.need_photo" class="muted">（要拍照）</span><span v-if="i.changed_times" class="muted">（改过 {{ i.changed_times }} 次）</span></span>
                  <el-tag v-if="i.result" :type="checkResultTypes[i.result]" size="small">{{ checkResultLabels[i.result] }}</el-tag>
                </div>
                <div v-if="i.review_hint" class="hint">{{ i.review_hint }}</div>
                <div v-if="editing?.item_key === i.item_key" @click.stop>
                  <p class="muted">{{ i.guide }}</p>
                  <p v-if="retesting" class="muted">补测：原来「无法测试」，原因：{{ i.note }}</p>
                  <el-radio-group v-model="editing.result">
                    <el-radio-button
                      v-for="(label, key) in checkResultLabels"
                      v-show="!retesting || key !== 'UNTESTABLE'"
                      :key="key"
                      :value="key"
                    >{{ label }}</el-radio-button>
                  </el-radio-group>
                  <div v-if="editing.result === 'FAIL'" class="row">
                    <el-input v-model="editing.defect_part" placeholder="瑕疵部位" style="width: 160px" />
                    <el-input v-model="editing.seller_claim" placeholder="卖家原来怎么描述的（给采购议价对比）" style="flex: 1" />
                  </div>
                  <div v-if="editing.result === 'FAIL'" class="row" style="margin-top: 6px">
                    <el-button v-if="compare?.claims?.[i.dimension] && !editing.seller_claim" link type="primary" size="small"
                      @click="editing.seller_claim = compare.claims[i.dimension].slice(0, 255)">带入卖家原话</el-button>
                    <el-checkbox v-model="editing.disclosed">卖家原来说过（不算新问题）</el-checkbox>
                    <el-radio-group v-model="editing.cause" size="small">
                      <el-radio-button v-for="(label, key) in CAUSES" :key="key" :value="key">{{ label }}</el-radio-button>
                    </el-radio-group>
                  </div>
                  <el-input
                    v-model="editing.note"
                    type="textarea"
                    :rows="2"
                    style="margin: 8px 0"
                    :placeholder="editing.result === 'UNTESTABLE' ? '为什么无法测试' : '说明'"
                  />
                  <div class="row">
                    <el-button size="small" :disabled="!cameraReady" @click="takePhoto(editing.result === 'PASS' ? 'PRODUCT_PHOTO' : 'DEFECT_PHOTO')">拍照留证</el-button>
                    <span class="muted">已留 {{ itemFiles.length }} 张</span>
                    <el-button size="small" type="primary" :loading="saving" :disabled="!editing.result" @click="saveItem">{{ retesting ? '保存补测' : '保存，下一项' }}</el-button>
                  </div>
                </div>
                <p v-else-if="i.note || i.defect_part" class="muted">
                  <template v-if="i.defect_part">【{{ i.defect_part }}】</template>{{ i.note }}<template v-if="i.seller_claim">（卖家说：{{ i.seller_claim }}）</template>
                  <template v-if="i.result === 'FAIL'"> · {{ i.disclosed ? '卖家原来说过' : '卖家没说过' }} · 原因：{{ i.cause_label || '待判' }}</template>
                </p>
              </div>
              <el-alert v-if="newProblemTitles.length" type="error" :closable="false" style="margin-top: 8px"
                :title="`卖家没说过的问题 ${newProblemTitles.length} 项：${newProblemTitles.join('、')}`">
                <el-button v-if="isPending" size="small" type="danger" plain @click="raiseFromItems">建差异工单</el-button>
              </el-alert>
              <el-alert
                v-if="doneCount === items.length && isPending"
                type="success"
                :closable="false"
                title="都验完了，回小程序验货页提交入库或拒签"
                style="margin-top: 8px"
              />
              <el-collapse v-if="detail.history?.length" style="margin-top: 12px">
                <el-collapse-item :title="`改答案和补测记录（${detail.history.length}）`">
                  <div v-for="(h, n) in detail.history" :key="n" class="muted">
                    {{ h.at }} {{ h.operator }} {{ h.action }}「{{ h.item }}」：{{ h.from }} → {{ h.to }}
                  </div>
                </el-collapse-item>
              </el-collapse>
            </template>
          </el-card>
        </el-col>
      </el-row>
    </div>

    <el-dialog v-model="exceptionVisible" title="发现异常" width="460px">
      <el-form label-width="72px">
        <el-form-item label="类型">
          <el-radio-group v-model="exceptionForm.exception_type">
            <el-radio-button v-for="(label, key) in exceptionTypeLabels" v-show="key !== 'MISSING'" :key="key" :value="key">{{ label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="情况">
          <el-input v-model="exceptionForm.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="exceptionVisible = false">取消</el-button>
        <el-button type="danger" @click="submitException">通知处理</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cam { width: 100%; aspect-ratio: 16 / 9; background: #111; border-radius: 6px; }
.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.between { justify-content: space-between; margin-top: 0; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.preview { color: var(--el-text-color-secondary); font-size: 13px; padding-left: 20px; }
.item { padding: 10px; border-bottom: 1px solid var(--el-border-color-lighter); cursor: pointer; }
.rec-state { margin-top: 8px; color: var(--el-color-danger); font-weight: 600; }
.hint { margin-top: 4px; color: var(--el-color-warning); font-size: 13px; }
.item.active { background: var(--el-fill-color-lighter); cursor: default; }
.claim { font-size: 13px; margin-top: 4px; word-break: break-all; }
.claim-k { display: inline-block; min-width: 40px; margin-right: 8px; color: var(--el-text-color-secondary); }
.claim-desc { max-height: 160px; overflow-y: auto; }
</style>
