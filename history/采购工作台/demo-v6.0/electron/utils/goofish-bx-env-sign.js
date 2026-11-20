/**
 * Node 补环境跑阿里 fireye / et，生成搜索用 bx-ua / bx-umidtoken / bx_et。
 * 失败返回 null，由调用方回落隐藏窗页内 fetch。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { GOOFISH_ELECTRON_BROWSE_USER_AGENT } from './xianyu-playwright-config.js'

const require = createRequire(import.meta.url)
const { JSDOM, VirtualConsole } = require('jsdom')

const __dirname = dirname(fileURLToPath(import.meta.url))

function getChromeLikeUserAgent() {
  return GOOFISH_ELECTRON_BROWSE_USER_AGENT
}

const FIREYE_CDN = 'https://g.alicdn.com/AWSC/fireyejs/1.234.24/fireyejs.js'
const ET_CDN = 'https://g.alicdn.com/AWSC/et/1.84.2/et_f.js'
const AWSC_CDN = 'https://g.alicdn.com/AWSC/AWSC/awsc.js'
const YNUF_URL = 'https://ynuf.aliapp.org/w/wu.json'

const CACHE_TTL_MS = 45_000
const INIT_TIMEOUT_MS = 20_000

/** @type {{ at: number, params: Record<string, string> } | null} */
let memCache = null
/** @type {Promise<Record<string, string> | null> | null} */
let inflight = null
/** @type {any} */
let sharedDom = null

function isPlaceholder(v) {
  const s = String(v || '').trim()
  if (!s) return true
  if (/^default_/i.test(s)) return true
  if (/^nosgn$/i.test(s)) return true
  return false
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function resolveLocalScript(name) {
  const candidates = [
    join(__dirname, '..', 'vendor', 'awsc', name),
    join(
      process.env.HOME || '',
      'Downloads',
      'new xyaa',
      '螃蟹交易平台_闲鱼_files',
      name
    )
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return ''
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': getChromeLikeUserAgent(),
      Accept: '*/*',
      Referer: 'https://www.goofish.com/'
    }
  })
  if (!res.ok) throw new Error(`fetch ${url} => ${res.status}`)
  return res.text()
}

async function loadScriptSource(localName, cdnUrl) {
  const local = resolveLocalScript(localName)
  if (local) {
    try {
      return readFileSync(local, 'utf8')
    } catch {
      /* */
    }
  }
  return fetchText(cdnUrl)
}

/** ynuf 下发 umid（与 demo.py getUmidToken 同源） */
export async function fetchYnufUmidToken() {
  const text = await fetchText(YNUF_URL)
  const m = String(text).match(/umx\.wu\('([^']+)'\);/)
  return m ? String(m[1] || '').trim() : ''
}

function installBrowserShims(window, { userAgent, href }) {
  const nav = window.navigator
  try {
    Object.defineProperty(nav, 'userAgent', { get: () => userAgent, configurable: true })
    Object.defineProperty(nav, 'platform', {
      get: () => (process.platform === 'darwin' ? 'MacIntel' : 'Win32'),
      configurable: true
    })
    Object.defineProperty(nav, 'language', { get: () => 'zh-CN', configurable: true })
    Object.defineProperty(nav, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true })
    Object.defineProperty(nav, 'webdriver', { get: () => false, configurable: true })
    Object.defineProperty(nav, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ]
        arr.length = 3
        arr.item = (i) => arr[i]
        arr.namedItem = () => null
        arr.refresh = () => {}
        return arr
      },
      configurable: true
    })
    Object.defineProperty(nav, 'mimeTypes', {
      get: () => {
        const arr = []
        arr.length = 0
        arr.item = () => null
        arr.namedItem = () => null
        return arr
      },
      configurable: true
    })
    Object.defineProperty(nav, 'hardwareConcurrency', { get: () => 8, configurable: true })
    Object.defineProperty(nav, 'deviceMemory', { get: () => 8, configurable: true })
    Object.defineProperty(nav, 'maxTouchPoints', { get: () => 0, configurable: true })
  } catch {
    /* */
  }

  // chrome runtime stub
  if (!window.chrome) {
    window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => ({}), loadTimes: () => ({}) }
  }

  // screen
  try {
    Object.defineProperty(window.screen, 'width', { get: () => 1920, configurable: true })
    Object.defineProperty(window.screen, 'height', { get: () => 1080, configurable: true })
    Object.defineProperty(window.screen, 'availWidth', { get: () => 1920, configurable: true })
    Object.defineProperty(window.screen, 'availHeight', { get: () => 1040, configurable: true })
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 24, configurable: true })
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24, configurable: true })
  } catch {
    /* */
  }

  // CSS animation / Web Animations（fireye init 常用 animationend / element.animate）
  try {
    const elProto = window.Element && window.Element.prototype
    if (elProto && typeof elProto.animate !== 'function') {
      elProto.animate = function animate() {
        return {
          finished: Promise.resolve(),
          play() {},
          pause() {},
          cancel() {},
          finish() {},
          addEventListener() {},
          removeEventListener() {}
        }
      }
    }
  } catch {
    /* */
  }

  // rAF / Idle
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)
  }
  if (typeof window.requestIdleCallback !== 'function') {
    window.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 12 }), 1)
    window.cancelIdleCallback = (id) => clearTimeout(id)
  }

  // Audio（fireye 常采）
  if (!window.AudioContext && !window.webkitAudioContext) {
    class FakeAudioContext {
      constructor() {
        this.sampleRate = 44100
        this.state = 'running'
        this.destination = {}
        this.currentTime = 0
      }
      createOscillator() {
        return {
          type: 'triangle',
          frequency: { value: 10000 },
          connect() {},
          start() {},
          stop() {}
        }
      }
      createDynamicsCompressor() {
        return {
          threshold: { value: -50 },
          knee: { value: 40 },
          ratio: { value: 12 },
          attack: { value: 0 },
          release: { value: 0.25 },
          connect() {}
        }
      }
      createAnalyser() {
        return { connect() {}, fftSize: 2048 }
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} }
      }
      close() {
        return Promise.resolve()
      }
    }
    window.AudioContext = FakeAudioContext
    window.webkitAudioContext = FakeAudioContext
  }

  // performance.memory
  try {
    if (window.performance && !window.performance.memory) {
      window.performance.memory = {
        jsHeapSizeLimit: 2172649472,
        totalJSHeapSize: 20123456,
        usedJSHeapSize: 12345678
      }
    }
  } catch {
    /* */
  }

  // crypto.getRandomValues
  try {
    if (!window.crypto) window.crypto = {}
    if (typeof window.crypto.getRandomValues !== 'function') {
      window.crypto.getRandomValues = (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
        return arr
      }
    }
  } catch {
    /* */
  }

  // canvas / webgl lightweight stubs（fireye 会探）
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype
  if (proto && !proto.__sxjkPatched) {
    proto.__sxjkPatched = true
    const origGetContext = proto.getContext
    proto.getContext = function getContext(type, attrs) {
      const t = String(type || '')
      if (t === 'webgl' || t === 'experimental-webgl' || t === 'webgl2') {
        return createWebGlStub(window)
      }
      let ctx2d = null
      try {
        ctx2d = origGetContext ? origGetContext.call(this, type, attrs) : null
      } catch {
        ctx2d = null
      }
      if (ctx2d) {
        // 补齐部分 2d API，避免 fireye 取方法时报 undefined is not a function
        const ensure = (name, fn) => {
          if (typeof ctx2d[name] !== 'function') ctx2d[name] = fn
        }
        ensure('fillRect', function () {})
        ensure('fillText', function () {})
        ensure('strokeText', function () {})
        ensure('beginPath', function () {})
        ensure('closePath', function () {})
        ensure('arc', function () {})
        ensure('fill', function () {})
        ensure('stroke', function () {})
        ensure('measureText', function (text) {
          return { width: String(text || '').length * 8 }
        })
        ensure('getImageData', function (x, y, w, h) {
          const width = Math.max(1, w | 0)
          const height = Math.max(1, h | 0)
          return {
            data: new window.Uint8ClampedArray(width * height * 4),
            width,
            height
          }
        })
        ensure('putImageData', function () {})
        ensure('createLinearGradient', function () {
          return { addColorStop() {} }
        })
        ensure('createRadialGradient', function () {
          return { addColorStop() {} }
        })
        return ctx2d
      }
      return null
    }
    const origToDataURL = proto.toDataURL
    proto.toDataURL = function toDataURL(...args) {
      try {
        return origToDataURL.apply(this, args)
      } catch {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      }
    }
  }

  // matchMedia
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (q) => ({
      matches: String(q || '').includes('prefers-color-scheme') ? false : true,
      media: String(q || ''),
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      }
    })
  }

  // Notification / Permissions stubs
  if (!window.Notification) {
    window.Notification = { permission: 'default', requestPermission: async () => 'default' }
  }

  // fireye 会调 storage quota（缺了会 TypeError 直接打崩进程）
  const storageEstimate = async () => ({ quota: 1200000000, usage: 120000, usageDetails: {} })
  const storageStub = {
    estimate: storageEstimate,
    persist: async () => true,
    persisted: async () => true,
    getDirectory: async () => {
      throw new Error('not_supported')
    }
  }
  try {
    Object.defineProperty(nav, 'storage', { get: () => storageStub, configurable: true })
  } catch {
    nav.storage = storageStub
  }
  const quotaFn = (success, _error) => {
    try {
      success && success(120000, 1200000000)
    } catch {
      /* */
    }
  }
  try {
    window.webkitStorageInfo = {
      TEMPORARY: 0,
      PERSISTENT: 1,
      queryUsageAndQuota: quotaFn
    }
    nav.webkitTemporaryStorage = { queryUsageAndQuota: quotaFn }
    nav.webkitPersistentStorage = { queryUsageAndQuota: quotaFn }
  } catch {
    /* */
  }

  // 吞掉 fireye 异步探测里的未捕获异常，避免弄崩 Node
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', (ev) => {
      try {
        ev.preventDefault?.()
      } catch {
        /* */
      }
    })
    window.addEventListener('unhandledrejection', (ev) => {
      try {
        ev.preventDefault?.()
      } catch {
        /* */
      }
    })
  }

  // sync location feel
  try {
    if (window.location && href) {
      /* JSDOM already set url */
    }
  } catch {
    /* */
  }

  // localStorage already in jsdom
  window.App = window.App || {}
}

function createWebGlStub(window) {
  const params = {
    37445: 'Google Inc. (Google)',
    37446: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0)',
    7936: 'WebKit',
    7937: 'WebKit WebGL',
    7938: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)'
  }
  const base = {
    canvas: window.document.createElement('canvas'),
    drawingBufferWidth: 300,
    drawingBufferHeight: 150,
    getParameter(p) {
      return params[p] != null ? params[p] : 0
    },
    getExtension(name) {
      if (String(name) === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 }
      }
      return {}
    },
    getSupportedExtensions() {
      return [
        'ANGLE_instanced_arrays',
        'EXT_blend_minmax',
        'EXT_color_buffer_half_float',
        'EXT_frag_depth',
        'EXT_shader_texture_lod',
        'EXT_texture_filter_anisotropic',
        'WEBKIT_EXT_texture_filter_anisotropic',
        'EXT_sRGB',
        'OES_element_index_uint',
        'OES_standard_derivatives',
        'OES_texture_float',
        'OES_texture_half_float',
        'OES_vertex_array_object',
        'WEBGL_color_buffer_float',
        'WEBGL_compressed_texture_s3tc',
        'WEBGL_debug_renderer_info',
        'WEBGL_debug_shaders',
        'WEBGL_depth_texture',
        'WEBGL_draw_buffers',
        'WEBGL_lose_context'
      ]
    },
    getContextAttributes() {
      return {
        alpha: true,
        antialias: true,
        depth: true,
        failIfMajorPerformanceCaveat: false,
        powerPreference: 'default',
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        stencil: false,
        desynchronized: false
      }
    },
    createBuffer() {
      return {}
    },
    bindBuffer() {},
    bufferData() {},
    createProgram() {
      return {}
    },
    createShader() {
      return {}
    },
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    useProgram() {},
    getAttribLocation() {
      return 0
    },
    getUniformLocation() {
      return {}
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    uniform1f() {},
    uniform2f() {},
    uniform1i() {},
    drawArrays() {},
    drawElements() {},
    viewport() {},
    clearColor() {},
    clear() {},
    enable() {},
    disable() {},
    blendFunc() {},
    depthFunc() {},
    getShaderParameter() {
      return true
    },
    getProgramParameter() {
      return true
    },
    getShaderInfoLog() {
      return ''
    },
    getProgramInfoLog() {
      return ''
    },
    getShaderPrecisionFormat() {
      return { rangeMin: 127, rangeMax: 127, precision: 23 }
    },
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    HIGH_FLOAT: 36338,
    MEDIUM_FLOAT: 36337,
    LOW_FLOAT: 36336,
    HIGH_INT: 36341,
    MEDIUM_INT: 36340,
    LOW_INT: 36339,
    readPixels() {},
    texImage2D() {},
    texParameteri() {},
    createTexture() {
      return {}
    },
    bindTexture() {},
    activeTexture() {},
    pixelStorei() {},
    clearDepth() {},
    clearStencil() {},
    colorMask() {},
    scissor() {},
    flush() {},
    finish() {}
  }
  // 未知方法一律给 noop，减少 “x is not a function”
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return function noop() {
        return null
      }
    }
  })
}

/**
 * 必须在 jsdom VM context 里跑：fireye 会取 globalThis，若在 Node eval 会绑到真 global。
 * @param {import('jsdom').JSDOM} dom
 */
function runScriptInDom(dom, code, filename = 'script.js') {
  const src = String(code || '')
  if (!src) return
  const ctx = dom.getInternalVMContext()
  try {
    // 不用 filename=真实名，避免异常堆栈把整份混淆脚本吐到 stderr
    vm.runInContext(src, ctx, { filename: `sxjk-${filename}`, timeout: 20000 })
    return true
  } catch (e) {
    const name = e?.name || 'Error'
    const msg = String(e?.message || e || '').slice(0, 200)
    console.warn(`[bx补环境] ${filename} 执行异常 ${name}: ${msg}`)
    return false
  }
}

async function ensureDomReady() {
  if (sharedDom?.window) return sharedDom

  const userAgent = getChromeLikeUserAgent()
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {})

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.goofish.com/search',
    referrer: 'https://www.goofish.com/',
    userAgent,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole
  })

  installBrowserShims(dom.window, {
    userAgent,
    href: 'https://www.goofish.com/search'
  })

  // 最小 AWSC 加载器：同步执行本地/CDN 脚本并 register
  const awscSrc = await loadScriptSource('awsc.js', AWSC_CDN).catch(() => '')
  const fireyeSrc = await loadScriptSource('fireyejs.js', FIREYE_CDN)
  const etSrc = await loadScriptSource('et_f.js', ET_CDN)

  // 先挂注册壳，再跑 fireye（fireye 会 AWSCInner.register）
  if (!dom.window.AWSCInner) {
    const modules = Object.create(null)
    dom.window.__sxjkAwscModules = modules
    dom.window.AWSCInner = {
      register(name, alias, mod) {
        const key = String(alias || name || '').trim()
        if (key) modules[key] = mod
        if (name) modules[String(name)] = mod
        if (key === 'fy' || name === 'fyModule' || name === 'fy') modules.fy = mod
        if (key === 'et' || name === 'etModule' || name === 'et') modules.et = mod
        try {
          if (mod) dom.window.__fyModule = dom.window.__fyModule || (key === 'fy' || name === 'fy' ? mod : dom.window.__fyModule)
          if (mod && (key === 'et' || name === 'et')) dom.window.__etModule = mod
        } catch {
          /* */
        }
      }
    }
    dom.window.AWSC = {
      use(name, cb) {
        const mod = modules[name]
        if (mod) {
          try {
            cb('loaded', mod)
          } catch {
            /* */
          }
        } else {
          try {
            cb('not_found', null)
          } catch {
            /* */
          }
        }
      },
      configFYEx(cb, opts) {
        this.use('fy', (st, mod) => {
          if (st !== 'loaded' || !mod) {
            try {
              cb && cb(new Error('fy_not_loaded'))
            } catch {
              /* */
            }
            return
          }
          try {
            mod.init(opts || {}, () => {
              try {
                cb && cb(null, mod)
              } catch {
                /* */
              }
            })
          } catch (e) {
            try {
              cb && cb(e)
            } catch {
              /* */
            }
          }
        })
      }
    }
  }

  if (awscSrc) {
    runScriptInDom(dom, awscSrc, 'awsc.js')
  }
  // AWSC 官方脚本可能覆盖我们的壳：保留 register 映射
  if (!dom.window.AWSCInner?.register) {
    console.warn('[bx补环境] AWSCInner.register 不可用')
  }

  const fyOk = runScriptInDom(dom, fireyeSrc, 'fireyejs.js')
  const etOk = runScriptInDom(dom, etSrc, 'et_f.js')
  const mods = dom.window.__sxjkAwscModules || {}
  console.log('[bx补环境] 脚本加载', {
    fyOk,
    etOk,
    hasAWSC: !!dom.window.AWSC,
    hasEtSign: typeof dom.window.etSign === 'function',
    moduleKeys: Object.keys(mods).slice(0, 20),
    hasFyModule: !!(mods.fy || dom.window.__fyModule)
  })

  // 给模块一点初始化时间（动画/轮询）
  await sleep(800)

  // 尝试 init fireye
  try {
    if (typeof dom.window.AWSC?.configFYEx === 'function') {
      await new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        try {
          dom.window.AWSC.configFYEx(finish, { appName: 'goofish', reqUrl: 'https://www.goofish.com/search' }, 8000)
        } catch {
          finish()
        }
        setTimeout(finish, 8000)
      })
    } else if (dom.window.AWSC?.use) {
      await new Promise((resolve) => {
        try {
          dom.window.AWSC.use('fy', (st, mod) => {
            if (st === 'loaded' && mod && typeof mod.init === 'function') {
              try {
                mod.init({ appName: 'goofish' }, () => resolve())
                setTimeout(resolve, 5000)
                return
              } catch {
                /* */
              }
            }
            resolve()
          })
        } catch {
          resolve()
        }
        setTimeout(resolve, 5000)
      })
    }
  } catch (e) {
    console.warn('[bx补环境] fy init 异常', e?.message || e)
  }

  await sleep(500)
  sharedDom = dom
  return dom
}

function pickTokensFromWindow(window, requestUrl = '') {
  const url =
    String(requestUrl || '').trim() ||
    'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/'

  let ua = ''
  let umid = ''
  let et = ''

  try {
    if (typeof window.baxiaCommon?.getUA === 'function') {
      ua = String(window.baxiaCommon.getUA() || '')
    }
  } catch {
    /* */
  }

  const fy =
    window.__fyModule ||
    window.__FYModule ||
    window.fyObj ||
    (window.__baxia__ && (window.__baxia__.postFYModule || window.__baxia__.getFYModule))

  try {
    if (!ua && fy && typeof fy.getFYToken === 'function') {
      try {
        ua = String(fy.getFYToken({ reqUrl: url }) || '')
      } catch (e1) {
        try {
          ua = String(fy.getFYToken(url) || '')
        } catch (e2) {
          try {
            ua = String(fy.getFYToken() || '')
          } catch (e3) {
            console.warn(
              '[bx补环境] getFYToken 异常',
              String(e3?.message || e2?.message || e1?.message || e3).slice(0, 160)
            )
          }
        }
      }
    }
  } catch {
    /* */
  }

  try {
    if (fy && typeof fy.getUidToken === 'function') {
      umid = String(fy.getUidToken() || '')
    }
  } catch {
    /* */
  }

  // AWSC.use 回调挂到的模块
  try {
    if (!ua && window.AWSC) {
      /* already inited */
    }
  } catch {
    /* */
  }

  try {
    if (typeof window.etSign === 'function') {
      et = String(window.etSign(url) || '')
    }
  } catch {
    /* */
  }

  try {
    const etMod = window.__etModule || window.__baxia__?.etModule
    if ((!et || isPlaceholder(et)) && etMod && typeof etMod.getETToken === 'function') {
      et = String(etMod.getETToken(url, { url, method: 'post' }) || etMod.getETToken(url) || '')
    }
  } catch {
    /* */
  }

  // 再扫一遍常见挂载点
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!/fy|fireye|etModule|__fy/i.test(key)) continue
    try {
      const mod = window[key]
      if (!ua && mod && typeof mod.getFYToken === 'function') {
        const v = String(mod.getFYToken({ reqUrl: url }) || mod.getFYToken() || '')
        if (!isPlaceholder(v)) ua = v
      }
      if (!umid && mod && typeof mod.getUidToken === 'function') {
        const v = String(mod.getUidToken() || '')
        if (!isPlaceholder(v)) umid = v
      }
      if ((!et || isPlaceholder(et)) && mod && typeof mod.getETToken === 'function') {
        const v = String(mod.getETToken(url, { url, method: 'post' }) || '')
        if (!isPlaceholder(v)) et = v
      }
    } catch {
      /* */
    }
  }

  return { ua, umid, et }
}

/**
 * @param {{ requestUrl?: string, force?: boolean }} [opts]
 * @returns {Promise<Record<string, string> | null>}
 */
export async function generateSearchBxParamsByEnv(opts = {}) {
  if (!opts.force && memCache && Date.now() - memCache.at < CACHE_TTL_MS) {
    return { ...memCache.params }
  }
  if (inflight) return inflight

  inflight = (async () => {
    const deadline = Date.now() + INIT_TIMEOUT_MS
    try {
      if (opts.force) disposeBxEnvSign()
      const dom = await ensureDomReady()
      const requestUrl = String(opts.requestUrl || '').trim()

      let ua = ''
      let umid = ''
      let et = ''
      while (Date.now() < deadline) {
        const tok = pickTokensFromWindow(dom.window, requestUrl)
        ua = tok.ua
        umid = tok.umid
        et = tok.et
        if (!isPlaceholder(ua)) break
        await sleep(300)
      }

      // umid：fy 没有则 ynuf 兜底
      if (isPlaceholder(umid)) {
        try {
          umid = await fetchYnufUmidToken()
        } catch (e) {
          console.warn('[bx补环境] ynuf umid 失败', e?.message || e)
        }
      }

      if (isPlaceholder(ua)) {
        console.warn('[bx补环境] bx-ua 未就绪（仍将回落页内）', {
          uaPrefix: String(ua || '').slice(0, 40),
          umidLen: String(umid || '').length,
          etPrefix: String(et || '').slice(0, 40)
        })
        return null
      }

      /** @type {Record<string, string>} */
      const params = {
        'bx-ua': ua
      }
      if (!isPlaceholder(umid)) params['bx-umidtoken'] = umid
      if (!isPlaceholder(et)) params.bx_et = et

      memCache = { at: Date.now(), params }
      console.log('[bx补环境] 已生成', {
        uaLen: params['bx-ua'].length,
        umidLen: params['bx-umidtoken']?.length || 0,
        etLen: params.bx_et?.length || 0
      })
      return { ...params }
    } catch (e) {
      console.warn('[bx补环境] 失败', e?.message || e)
      return null
    } finally {
      inflight = null
    }
  })()

  return inflight
}

export function disposeBxEnvSign() {
  memCache = null
  inflight = null
  try {
    sharedDom?.window?.close?.()
  } catch {
    /* */
  }
  sharedDom = null
}
