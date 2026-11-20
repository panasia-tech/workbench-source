<template>
  <Transition name="mp-fade">
    <div v-if="scanner.visible" class="mp-scan">
      <video ref="video" class="mp-scan__video" playsinline webkit-playsinline muted autoplay />
      <div class="mp-scan__frame" :class="{ 'mp-scan__frame--square': squareFrame }"><i class="mp-scan__line" /></div>
      <div class="mp-scan__top">
        <button type="button" class="mp-scan__btn" @click="cancel">取消</button>
        <button v-if="torchSupported" type="button" class="mp-scan__btn" @click="toggleTorch">{{ torch ? '关闭照明' : '打开照明' }}</button>
      </div>
      <div class="mp-scan__bottom">
        <p class="mp-scan__tip" :class="{ 'mp-scan__tip--err': !!error }">{{ error || tip }}</p>
        <form v-if="manual" class="mp-scan__manual" @submit.prevent="submitManual">
          <input ref="manualInput" v-model="manualText" class="mp-scan__input" placeholder="输入条码内容" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button type="submit" class="mp-scan__ok" :disabled="!manualText.trim()">确定</button>
        </form>
        <div class="mp-scan__actions">
          <button type="button" class="mp-scan__link" @click="pickImage">从相册识别</button>
          <button type="button" class="mp-scan__link" @click="openManual">手动输入</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { closeScanner, scanner } from '../runtime/ui.js'
import { createDetector } from './barcode.js'

const video = ref(null)
const manualInput = ref(null)
const error = ref('')
const tip = ref('')
const manual = ref(false)
const manualText = ref('')
const torch = ref(false)
const torchSupported = ref(false)

const squareFrame = computed(() => scanner.formats.every((f) => f === 'qr_code' || f === 'data_matrix'))

let stream = null
let loopTimer = null
let session = 0
let canvas = null

watch(() => scanner.visible, (v) => {
  if (v) start()
  else stop()
})

function reset() {
  error.value = ''
  manual.value = false
  manualText.value = ''
  torch.value = false
  torchSupported.value = false
  tip.value = squareFrame.value ? '把二维码放进框里' : '把条码放进框里'
}

// 鼠标键盘设备（电脑）：手动输入框一打开就出来并拿到焦点——USB 扫码枪就是键盘输入 + 回车，
// 不用先点「手动输入」。摄像头照样开，有的话也能对着扫
const desktopLike = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches)

async function start() {
  const my = ++session
  reset()
  if (desktopLike()) openManual()
  let det
  try {
    det = await createDetector(scanner.formats)
  } catch (e) {
    console.error(e)
    error.value = '识别组件没加载出来，可以先手动输入'
    openManual()
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    error.value = window.isSecureContext ? '这个浏览器不支持调用相机，请手动输入' : '要用 https 打开才能调用相机，请手动输入'
    openManual()
    return
  }
  // 没有摄像头（大多是电脑）就别等权限弹窗了，直接给手动输入
  try {
    const devices = navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : null
    if (devices && devices.length && !devices.some((d) => d.kind === 'videoinput')) {
      if (my !== session) return
      error.value = '没找到摄像头，请手动输入'
      openManual()
      return
    }
  } catch {
    /* 拿不到设备列表就照常申请相机 */
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    })
  } catch (e) {
    if (my !== session) return
    error.value = e && e.name === 'NotAllowedError'
      ? '没有相机权限，请在浏览器设置里打开，或手动输入'
      : e && e.name === 'NotFoundError' ? '没找到摄像头，请手动输入' : '相机打不开，请手动输入'
    openManual()
    return
  }
  if (my !== session) {
    stopTracks()
    return
  }
  await nextTick()
  const el = video.value
  if (!el) return
  el.srcObject = stream
  try { await el.play() } catch { /* iOS 需要用户手势时会在点击后自动播放 */ }
  const track = stream.getVideoTracks()[0]
  const caps = track && track.getCapabilities ? track.getCapabilities() : {}
  torchSupported.value = !!(caps && caps.torch)
  if (caps && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {})
  }
  loop(det, my)
}

function frameSource(det) {
  const el = video.value
  if (det.native) return el
  // wasm 版吃 canvas；分辨率太高会慢，长边压到 1280
  const w = el.videoWidth
  const h = el.videoHeight
  if (!w || !h) return null
  const s = Math.min(1, 1280 / Math.max(w, h))
  canvas = canvas || document.createElement('canvas')
  canvas.width = Math.round(w * s)
  canvas.height = Math.round(h * s)
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(el, 0, 0, canvas.width, canvas.height)
  return canvas
}

function loop(det, my) {
  clearTimeout(loopTimer)
  const tick = async () => {
    if (my !== session || !scanner.visible) return
    const el = video.value
    if (el && el.readyState >= 2) {
      try {
        const src = frameSource(det)
        const found = src ? await det.detector.detect(src) : []
        if (my !== session) return
        const hit = found.find((b) => b.rawValue && b.rawValue.trim())
        if (hit) {
          done(hit.rawValue.trim(), hit.format)
          return
        }
      } catch (e) {
        console.warn('[H5] 识别出错', e)
      }
    }
    loopTimer = setTimeout(tick, det.native ? 120 : 180)
  }
  tick()
}

function done(text, format) {
  if (navigator.vibrate) navigator.vibrate(60)
  closeScanner({ text, format })
}

function stopTracks() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
}

function stop() {
  session++
  clearTimeout(loopTimer)
  stopTracks()
}

function cancel() {
  closeScanner(null)
}

async function toggleTorch() {
  const track = stream && stream.getVideoTracks()[0]
  if (!track) return
  try {
    await track.applyConstraints({ advanced: [{ torch: !torch.value }] })
    torch.value = !torch.value
  } catch {
    torchSupported.value = false
  }
}

function openManual() {
  manual.value = true
  nextTick(() => manualInput.value && manualInput.value.focus())
}

function submitManual() {
  const text = manualText.value.trim()
  if (text) done(text, scanner.formats[0] || 'code_128')
}

function pickImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const file = input.files && input.files[0]
    if (!file) return
    try {
      const det = await createDetector(scanner.formats)
      const bitmap = await createImageBitmap(file)
      const found = await det.detector.detect(bitmap)
      const hit = found.find((b) => b.rawValue && b.rawValue.trim())
      if (hit) done(hit.rawValue.trim(), hit.format)
      else error.value = '这张图里没认出条码，换一张或者手动输入'
    } catch (e) {
      console.error(e)
      error.value = '这张图识别失败，换一张或者手动输入'
    }
  }
  input.click()
}
</script>
