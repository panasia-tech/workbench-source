<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { zipSync } from 'fflate'
import api from '../api'

const FRAME_COUNT = 100

// ---------- 壁纸轮播 ----------
const wallpapers = ref([])
const intervalMs = ref(100)
const stage = ref(null)
const playingIndex = ref(-1)
const paused = ref(false)
let raf = 0
let startAt = 0
let pausedAt = 0

function pickWallpapers(e) {
  wallpapers.value.forEach((u) => URL.revokeObjectURL(u))
  wallpapers.value = [...e.target.files].filter((f) => f.type.startsWith('image/')).map((f) => URL.createObjectURL(f))
}

async function play() {
  if (!wallpapers.value.length) return
  await stage.value.requestFullscreen()
  startAt = performance.now()
  paused.value = false
  // 按经过时间算第几张，不用 setInterval：浏览器卡一下不会把节奏带快
  const step = () => {
    if (!paused.value) {
      playingIndex.value = Math.floor((performance.now() - startAt) / intervalMs.value) % wallpapers.value.length
    }
    raf = requestAnimationFrame(step)
  }
  step()
}

// 暂停停在当前这张（拍某张壁纸的特写），再按接着从这张往下放（禅道 WH09-02）
function togglePause() {
  if (playingIndex.value < 0) return
  if (paused.value) {
    startAt += performance.now() - pausedAt
  } else {
    pausedAt = performance.now()
  }
  paused.value = !paused.value
}

function onKey(e) {
  if (e.code === 'Space' && document.fullscreenElement) {
    e.preventDefault()
    togglePause()
  }
}

function stopPlay() {
  cancelAnimationFrame(raf)
  playingIndex.value = -1
  paused.value = false
}

function onFullscreenChange() {
  if (!document.fullscreenElement) stopPlay()
}

// ---------- 视频切片 ----------
const frames = ref([])
const slicing = ref(false)
const skuCode = ref('')
const sourceName = ref('')
const perShop = ref(10)
const progress = ref(0)
const shops = ref([])
const pickedShops = ref([])

const selected = computed(() => frames.value.filter((f) => f.selected))
const usable = computed(() => frames.value.filter((f) => !f.issue))
// 能用的图不够每个账号分 perShop 张：提示补拍（禅道 WH09-12）
const shortage = computed(() => {
  const need = Math.max(1, pickedShops.value.length) * perShop.value
  return usable.value.length < need ? need - usable.value.length : 0
})
// 选中的图轮流分给各账号，一张图只进一个账号
const assignment = computed(() => {
  const map = new Map(pickedShops.value.map((s) => [s, []]))
  if (!pickedShops.value.length) return map
  selected.value.forEach((f, i) => map.get(pickedShops.value[i % pickedShops.value.length]).push(f))
  return map
})

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    video.onseeked = resolve
    video.onerror = () => reject(new Error('decode'))
    video.currentTime = time
  })
}

function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
}

// 缩到 64 宽的灰度图上看清晰度（拉普拉斯方差）、亮度，再算 dHash 找近重复（禅道 WH09-09/10）
const probe = document.createElement('canvas')
function measure(source) {
  const w = 64
  const h = Math.max(8, Math.round((source.height / source.width) * w))
  probe.width = w
  probe.height = h
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  let sum = 0
  for (let i = 0; i < w * h; i += 1) {
    g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
    sum += g[i]
  }
  let lapSum = 0
  let lapSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]
      lapSum += v
      lapSq += v * v
      n += 1
    }
  }
  const sharp = lapSq / n - (lapSum / n) ** 2
  // dHash：9x8 灰度，左右相邻比大小
  ctx.drawImage(source, 0, 0, 9, 8)
  const d = ctx.getImageData(0, 0, 9, 8).data
  let hash = ''
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const a = d[(y * 9 + x) * 4] + d[(y * 9 + x) * 4 + 1] + d[(y * 9 + x) * 4 + 2]
      const b = d[(y * 9 + x + 1) * 4] + d[(y * 9 + x + 1) * 4 + 1] + d[(y * 9 + x + 1) * 4 + 2]
      hash += a > b ? '1' : '0'
    }
  }
  return { sharp, bright: sum / (w * h), hash }
}

function hamming(a, b) {
  let n = 0
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) n += 1
  return n
}

// 阈值按这批视频自己的清晰度中位数算：不同手机、不同显示器差得多，写死一个数不准
function markIssues() {
  const sharps = frames.value.map((f) => f.sharp).sort((a, b) => a - b)
  const median = sharps[Math.floor(sharps.length / 2)] || 0
  let lastKept = null
  for (const f of frames.value) {
    f.issue = ''
    if (f.bright < 25) f.issue = '过暗'
    else if (f.bright > 235) f.issue = '过曝'
    else if (f.sharp < median * 0.35) f.issue = '糊/切换中'
    else if (lastKept && hamming(f.hash, lastKept.hash) <= 3) f.issue = '近重复'
    if (!f.issue) lastKept = f
  }
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  return `${m}m${(sec - m * 60).toFixed(2).padStart(5, '0')}s`
}

async function sliceVideo(e) {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  clearFrames()
  sourceName.value = file.name
  slicing.value = true
  progress.value = 0
  const src = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = src
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error('decode'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    const gap = video.duration / FRAME_COUNT
    for (let i = 0; i < FRAME_COUNT; i += 1) {
      const at = Math.min(i * gap + gap / 2, video.duration - 0.01)
      await seekTo(video, at)
      ctx.drawImage(video, 0, 0)
      const blob = await toBlob(canvas)
      const m = measure(canvas)
      frames.value.push({ no: i + 1, at, blob, url: URL.createObjectURL(blob), selected: false, issue: '', ...m })
      progress.value = i + 1
    }
    markIssues()
    // 默认选上能用的，糊的/重复的留给人看一眼再决定（禅道 WH09-11）
    frames.value.forEach((f) => (f.selected = !f.issue))
  } catch {
    ElMessage.error('这个视频浏览器解不开，手机拍的 HEVC 视频请导出成 H.264 再试')
  } finally {
    URL.revokeObjectURL(src)
    slicing.value = false
  }
}

function clearFrames() {
  frames.value.forEach((f) => URL.revokeObjectURL(f.url))
  frames.value = []
}

function setAll(value) {
  frames.value.forEach((f) => (f.selected = value))
}

function selectUsable() {
  frames.value.forEach((f) => (f.selected = !f.issue))
}

// 文件名带货号、第几帧、视频里的时间点，拿到图能找回是哪段视频哪一秒（禅道 WH09-07/16）
function frameName(f) {
  const code = (skuCode.value || '').trim().replace(/[\\/:*?"<>|\s]+/g, '') || '未填货号'
  return `${code}-${String(f.no).padStart(3, '0')}-${fmtTime(f.at)}.jpg`
}

async function download() {
  if (!selected.value.length) return
  if (!skuCode.value.trim()) {
    ElMessage.warning('先填货号：文件名和清单里要带上，才知道是哪件货的图')
    return
  }
  const files = {}
  const rows = [['账号', '文件名', '第几帧', '视频时间点(秒)', '画面提示', '原视频', '货号']]
  const add = async (path, f) => {
    // jpg 已经压过，zip 里不再压
    files[path] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }]
  }
  if (pickedShops.value.length) {
    for (const [shop, list] of assignment.value) {
      for (const f of list) {
        await add(`${shop}/${frameName(f)}`, f)
        rows.push([shop, frameName(f), f.no, f.at.toFixed(2), f.issue, sourceName.value, skuCode.value.trim()])
      }
    }
  } else {
    for (const f of selected.value) {
      await add(frameName(f), f)
      rows.push(['', frameName(f), f.no, f.at.toFixed(2), f.issue, sourceName.value, skuCode.value.trim()])
    }
  }
  // 分配清单：哪张给了哪个账号、出自原视频哪一秒（禅道 WH09-14）；说明这是展示素材不是验货证据（WH09-18）
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  files['分配清单.csv'] = [new TextEncoder().encode('\ufeff' + csv), {}]
  files['说明.txt'] = [new TextEncoder().encode(
    `这是商品展示素材（壁纸轮播实拍切片），不是验货证据。\r\n货号：${skuCode.value.trim()}\r\n原视频：${sourceName.value}\r\n导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\r\n`,
  ), {}]
  const url = URL.createObjectURL(new Blob([zipSync(files)], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `展示素材-${skuCode.value.trim()}-${selected.value.length}张.zip`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('keydown', onKey)
  const { data } = await api.get('/master/sale-shops/enabled')
  shops.value = data
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('keydown', onKey)
  stopPlay()
  wallpapers.value.forEach((u) => URL.revokeObjectURL(u))
  clearFrames()
})
</script>

<template>
  <div class="page-card">
    <div class="page-card__header"><h3 class="page-card__title">壁纸轮播</h3></div>
    <div class="page-card__body row">
      <input type="file" accept="image/*" multiple @change="pickWallpapers" />
      <span>每张</span>
      <el-input-number v-model="intervalMs" :min="50" :max="10000" :step="50" size="small" />
      <span>毫秒</span>
      <el-button type="primary" :disabled="!wallpapers.length" @click="play">全屏播放（{{ wallpapers.length }} 张）</el-button>
      <span class="muted">播放中按空格或点画面暂停，再按接着放；Esc 退出</span>
      <div ref="stage" class="stage" @click="togglePause">
        <img v-if="playingIndex >= 0" :src="wallpapers[playingIndex]" alt="" />
        <div v-if="paused" class="paused">已暂停 · 第 {{ playingIndex + 1 }} 张</div>
      </div>
    </div>
  </div>

  <div class="page-card" style="margin-top: 16px">
    <div class="page-card__header"><h3 class="page-card__title">视频切片</h3></div>
    <div class="page-card__body">
      <div class="row">
        <el-input v-model="skuCode" placeholder="货号（文件名和清单里带上）" style="width: 220px" />
        <input type="file" accept="video/*" :disabled="slicing" @change="sliceVideo" />
        <el-progress v-if="slicing" :percentage="progress" style="width: 240px" />
      </div>
      <template v-if="frames.length && !slicing">
        <div class="row">
          <el-button size="small" @click="setAll(true)">全选</el-button>
          <el-button size="small" @click="setAll(false)">全不选</el-button>
          <el-button size="small" @click="selectUsable">只选能用的（{{ usable.length }}）</el-button>
          <el-select v-model="pickedShops" multiple collapse-tags placeholder="分给哪些账号" style="width: 280px">
            <el-option v-for="s in shops" :key="s.id" :value="s.label || s.code" :label="s.label || s.code" />
          </el-select>
          <el-button type="primary" :disabled="!selected.length" @click="download">下载选中的 {{ selected.length }} 张</el-button>
        </div>
        <div class="row muted">
          <span>每个账号要</span>
          <el-input-number v-model="perShop" :min="1" :max="50" size="small" />
          <span>张</span>
          <span v-for="[shop, list] in assignment" :key="shop">· {{ shop }} {{ list.length }} 张</span>
        </div>
        <el-alert
          v-if="shortage"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 8px"
          :title="`能用的只有 ${usable.length} 张，按 ${Math.max(1, pickedShops.length)} 个账号每个 ${perShop} 张还差 ${shortage} 张，建议补拍一段（拍久一点、手稳一点、对准屏幕）`"
        />
        <div class="grid">
          <div v-for="f in frames" :key="f.no" class="frame" :class="{ on: f.selected, bad: f.issue }" @click="f.selected = !f.selected">
            <img :src="f.url" :alt="frameName(f)" loading="lazy" />
            <span class="frame-meta">{{ f.at.toFixed(1) }}s<b v-if="f.issue"> · {{ f.issue }}</b></span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.muted { color: var(--el-text-color-secondary); font-size: 13px; }
.stage { width: 0; height: 0; overflow: hidden; }
.stage:fullscreen { width: 100vw; height: 100vh; background: #000; }
.stage img { width: 100%; height: 100%; object-fit: cover; display: block; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
.frame { position: relative; border: 3px solid transparent; border-radius: 4px; cursor: pointer; }
.frame.bad img { opacity: 0.45; }
.frame-meta { position: absolute; left: 4px; bottom: 4px; padding: 0 4px; border-radius: 3px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 11px; }
.frame-meta b { color: #fbbf24; font-weight: 600; }
.stage { position: relative; }
.paused { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); padding: 6px 14px; border-radius: 6px; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 16px; }
.frame.on { border-color: var(--el-color-primary); }
.frame img { width: 100%; display: block; }
</style>
