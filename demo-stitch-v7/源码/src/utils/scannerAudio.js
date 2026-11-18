// 硬件激光扫码枪（键盘楔入免聚焦）+ Web Audio 工业提示音总线
import { reactive } from 'vue'

export const scanFeedback = reactive({
  soundEnabled: true,
  lastScan: null, // { code, kind, ok, msg, ts }
  flashType: ''   // 'ok' | 'err' | 'warn' | ''
})

let audioCtx = null
let flashTimer = null

function ensureCtx() {
  if (!scanFeedback.soundEnabled || typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!audioCtx) audioCtx = new AC()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

function playTone(freq, durationMs, delayMs = 0, wave = 'sine', gainVal = 0.14) {
  try {
    const ctx = ensureCtx()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = wave
    osc.frequency.value = freq
    const start = ctx.currentTime + delayMs / 1000
    const end = start + durationMs / 1000
    gain.gain.setValueAtTime(gainVal, start)
    gain.gain.exponentialRampToValueAtTime(0.001, end)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(end)
  } catch (_) {}
}

export function beepOk() {
  playTone(920, 75, 0, 'sine', 0.14)
  playTone(1380, 105, 75, 'sine', 0.16)
}

export function beepWarn() {
  playTone(540, 110, 0, 'triangle', 0.16)
  playTone(540, 110, 145, 'triangle', 0.16)
}

export function beepErr() {
  playTone(250, 150, 0, 'sawtooth', 0.18)
  playTone(220, 150, 180, 'sawtooth', 0.18)
  playTone(190, 220, 360, 'sawtooth', 0.2)
}

export function triggerScanFeedback({ code, kind = '条码', ok = true, warn = false, msg = '' }) {
  const now = new Date().toTimeString().slice(0, 8)
  scanFeedback.lastScan = { code, kind, ok, warn, msg, ts: now }
  scanFeedback.flashType = !ok ? 'err' : warn ? 'warn' : 'ok'
  if (!ok) beepErr()
  else if (warn) beepWarn()
  else beepOk()
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    scanFeedback.flashType = ''
  }, !ok ? 2800 : 1400)
}

// 全局键盘楔入监听（激光头在 < 48ms 内连续输出字符并以 Enter 结尾，无需手点 input 框）
const listeners = new Set()
export function onGlobalBarcodeScan(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitSimulatedLaserScan(rawCode) {
  const code = String(rawCode || '').trim()
  if (!code) return
  for (const fn of listeners) {
    fn(code)
  }
}

let wedgeBuf = ''
let lastKeyTs = 0

export function installGlobalWedgeScanner() {
  if (typeof window === 'undefined' || window.__paWedgeInstalled) return
  window.__paWedgeInstalled = true
  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const now = performance.now()
    if (e.key === 'Enter') {
      if (wedgeBuf.length >= 4 && now - lastKeyTs < 120) {
        e.preventDefault()
        const scanned = wedgeBuf
        wedgeBuf = ''
        emitSimulatedLaserScan(scanned)
      } else {
        wedgeBuf = ''
      }
      return
    }
    if (e.key.length === 1) {
      if (now - lastKeyTs > 85) wedgeBuf = ''
      wedgeBuf += e.key
      lastKeyTs = now
    }
  })
}
