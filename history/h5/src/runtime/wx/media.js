import { openPreview } from '../ui.js'
import { promisify } from '../util.js'

// 选图 / 选视频 / 预览。
// 小程序的临时文件路径（tempFilePath）在这里是 blob: 地址，背后的 File 记在 tempFiles 里，
// uploadFile 拿路径换回 File 上传；<image src> 直接用 blob 地址显示。

const tempFiles = new Map()

export function registerTempFile(file) {
  const url = URL.createObjectURL(file)
  tempFiles.set(url, file)
  return url
}

export async function resolveTempFile(path) {
  if (!path) return null
  if (tempFiles.has(path)) return tempFiles.get(path)
  if (/^(blob:|data:|https?:)/.test(path)) {
    const resp = await fetch(path)
    const blob = await resp.blob()
    return new File([blob], 'upload', { type: blob.type })
  }
  return null
}

// ---------------------------------------------------------------- 压缩
// 对应小程序 sizeType: compressed。照片长边压到 2560、JPEG 0.85；
// 截图（PNG）转 JPEG 但不缩，OCR 要看清字。压完反而更大就用原图。

const MAX_EDGE = 2560

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ img, url })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

async function compressImage(file) {
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif|bmp)$/i.test(file.type || '')) return { file }
  let loaded
  try {
    loaded = await loadImage(file)
  } catch {
    return { file }
  }
  const { img, url } = loaded
  const w = img.naturalWidth
  const h = img.naturalHeight
  try {
    const isPng = /png/i.test(file.type)
    const scale = isPng ? 1 : Math.min(1, MAX_EDGE / Math.max(w, h))
    if (scale === 1 && /jpe?g/i.test(file.type) && file.size < 1.5 * 1024 * 1024) return { file, width: w, height: h }
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, cw, ch)
    ctx.drawImage(img, 0, 0, cw, ch)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', isPng ? 0.9 : 0.85))
    if (!blob || blob.size >= file.size) return { file, width: w, height: h }
    const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '.jpg'
    return { file: new File([blob], name, { type: 'image/jpeg' }), width: cw, height: ch }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function videoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    let done = false
    const finish = (meta) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      resolve(meta)
    }
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => finish({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight })
    v.onerror = () => finish({ duration: 0, width: 0, height: 0 })
    setTimeout(() => finish({ duration: 0, width: 0, height: 0 }), 3000)
    v.src = url
  })
}

// ---------------------------------------------------------------- 选文件

/**
 * 弹出系统的文件选择。必须在点击事件里同步调用（iOS 只认用户手势里的 input.click()），
 * 小程序页面里 bindtap → wx.chooseMedia 正好是同步的。
 */
let lastInput = null

function pickFiles({ accept, multiple, capture }) {
  return new Promise((resolve, reject) => {
    if (lastInput) lastInput.remove()
    const input = document.createElement('input')
    lastInput = input
    input.type = 'file'
    input.accept = accept
    if (multiple) input.multiple = true
    if (capture) input.setAttribute('capture', capture)
    input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;'
    document.body.appendChild(input)
    let settled = false
    const done = (files) => {
      if (settled) return
      settled = true
      setTimeout(() => input.remove(), 0)
      if (lastInput === input) lastInput = null
      if (files && files.length) resolve(files)
      else reject(new Error('cancel'))
    }
    // 取消只认 cancel 事件（Safari 16.4+ / Chrome 113+）。不拿「窗口重新获得焦点」猜：
    // iOS 选完照片要先转码才派发 change，猜早了会把用户刚选的图丢掉。
    input.addEventListener('change', () => done(Array.from(input.files || [])))
    input.addEventListener('cancel', () => done(null))
    input.click()
  })
}

function acceptFor(mediaType) {
  const types = new Set(mediaType && mediaType.length ? mediaType : ['image', 'video'])
  if (types.has('mix')) return 'image/*,video/*'
  const parts = []
  if (types.has('image')) parts.push('image/*')
  if (types.has('video')) parts.push('video/*')
  return parts.join(',') || 'image/*'
}

function captureFor(sourceType, camera) {
  const src = sourceType && sourceType.length ? sourceType : ['album', 'camera']
  if (src.length === 1 && src[0] === 'camera') return camera === 'front' ? 'user' : 'environment'
  return ''
}

async function toTempFiles(files, { compress }) {
  const out = []
  for (const f of files) {
    const isVideo = /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name || '')
    if (isVideo) {
      const meta = await videoMeta(f)
      out.push({
        tempFilePath: registerTempFile(f),
        size: f.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        thumbTempFilePath: '',
        fileType: 'video',
      })
    } else {
      const { file, width, height } = compress ? await compressImage(f) : { file: f }
      out.push({ tempFilePath: registerTempFile(file), size: file.size, width: width || 0, height: height || 0, fileType: 'image' })
    }
  }
  return out
}

function wantsCompress(sizeType) {
  const t = sizeType && sizeType.length ? sizeType : ['original', 'compressed']
  return t.includes('compressed')
}

export function chooseMedia(options = {}) {
  const count = Math.max(1, Number(options.count) || 9)
  const picking = pickFiles({
    accept: acceptFor(options.mediaType),
    multiple: count > 1,
    capture: captureFor(options.sourceType, options.camera),
  })
  return promisify('chooseMedia', async () => {
    let files
    try {
      files = await picking
    } catch {
      throw { errMsg: 'chooseMedia:fail cancel' }
    }
    const tempFiles = await toTempFiles(files.slice(0, count), { compress: wantsCompress(options.sizeType) })
    const types = new Set(tempFiles.map((t) => t.fileType))
    return { tempFiles, type: types.size > 1 ? 'mix' : [...types][0] || 'image' }
  })(options)
}

export function chooseImage(options = {}) {
  const count = Math.max(1, Number(options.count) || 9)
  const picking = pickFiles({ accept: 'image/*', multiple: count > 1, capture: captureFor(options.sourceType) })
  return promisify('chooseImage', async () => {
    let files
    try {
      files = await picking
    } catch {
      throw { errMsg: 'chooseImage:fail cancel' }
    }
    const list = await toTempFiles(files.slice(0, count), { compress: wantsCompress(options.sizeType) })
    return { tempFilePaths: list.map((t) => t.tempFilePath), tempFiles: list.map((t) => ({ path: t.tempFilePath, size: t.size })) }
  })(options)
}

export function chooseVideo(options = {}) {
  const picking = pickFiles({ accept: 'video/*', multiple: false, capture: captureFor(options.sourceType, options.camera) })
  return promisify('chooseVideo', async () => {
    let files
    try {
      files = await picking
    } catch {
      throw { errMsg: 'chooseVideo:fail cancel' }
    }
    const [t] = await toTempFiles(files.slice(0, 1), { compress: false })
    return { tempFilePath: t.tempFilePath, duration: t.duration, size: t.size, width: t.width, height: t.height }
  })(options)
}

// ---------------------------------------------------------------- 预览

export const previewImage = promisify('previewImage', ({ urls = [], current }) => {
  const list = urls.filter(Boolean)
  let index = 0
  if (typeof current === 'number') index = current
  else if (current) index = Math.max(0, list.indexOf(current))
  openPreview(list.map((url) => ({ url, type: 'image' })), index)
})

export const previewMedia = promisify('previewMedia', ({ sources = [], current = 0 }) => {
  openPreview(
    sources.filter((s) => s && s.url).map((s) => ({ url: s.url, type: s.type === 'video' ? 'video' : 'image', poster: s.poster || '' })),
    Number(current) || 0,
  )
})

export const getImageInfo = promisify('getImageInfo', ({ src }) => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, path: src, orientation: 'up', type: '' })
  img.onerror = () => reject(new Error('图片加载失败'))
  img.src = src
}))

/** 浏览器存不进相册：下载到本地，手机上会进「文件」/下载目录 */
export const saveImageToPhotosAlbum = promisify('saveImageToPhotosAlbum', async ({ filePath }) => {
  const a = document.createElement('a')
  a.href = filePath
  a.download = `image_${Date.now()}.jpg`
  document.body.appendChild(a)
  a.click()
  a.remove()
})
