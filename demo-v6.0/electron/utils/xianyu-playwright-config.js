/**
 * Playwright 浏览器启动与上下文配置
 * - 通用账号/登录流程仍用 BASE_BROWSER_ARGS + 移动端上下文
 * - 库存监控走 MONITORING_*：更接近桌面 Chrome、注入反自动化特征弱化脚本
 */

// ---------- 通用启动参数（登录采集等场景） ----------
const BASE_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-web-security',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-features=RendererCodeIntegrity',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check'
]

/**
 * 监控任务专用：弱化自动化指纹、去掉部分「明显非日常浏览」的开关
 * （不设 disable-extensions，与常见用户「无扩展或少量扩展」更接近；仍保留沙箱等 Electron/CI 所需项）
 */
const MONITORING_BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI,RendererCodeIntegrity,PermissionsPolicy',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check'
]

const BASE_CONTEXT_DEFAULTS = {
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai'
}

const MOBILE_CONTEXT_BASE = {
  viewport: { width: 1195, height: 600 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3
}

const DESKTOP_CONTEXT_BASE = {
  viewport: { width: 1195, height: 600 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
  extraHTTPHeaders: {
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  }
}

/** 与当前 Chromium 大版本大致对齐的桌面 Chrome UA（京东 PC 站） */
const JD_MONITORING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Electron 内嵌窗口：与 IM Token / wss-goofish 同 Chrome 133 */
export const GOOFISH_ELECTRON_BROWSE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

/** 无头模式固定视口，避免过小；有头模式 viewport=null 配合最大化使用真实窗口尺寸 */
const JD_MONITORING_VIEWPORT_HEADLESS = { width: 1536, height: 864 }

const mergeContextOptions = (base, { storageState, overrides = {} } = {}) => {
  const { extraHTTPHeaders, ...restOverrides } = overrides
  const merged = {
    ...BASE_CONTEXT_DEFAULTS,
    ...base,
    ...(storageState ? { storageState } : {}),
    ...restOverrides
  }

  if (base.extraHTTPHeaders || extraHTTPHeaders) {
    merged.extraHTTPHeaders = {
      ...(base.extraHTTPHeaders || {}),
      ...(extraHTTPHeaders || {})
    }
  }

  return merged
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.devtools]
 * @param {string[]} [opts.extraArgs]
 * @param {boolean} [opts.monitoring] 为 true 时使用监控专用参数，并在有界面时最大化窗口
 * @param {boolean} [opts.useChromeChannel] 为 true 时使用系统 Chrome
 * @param {string} [opts.chromeExecutablePath] 指定 Chrome 可执行路径，优先于 channel（用于 Playwright 自检失败时）
 */
export const createBrowserLaunchOptions = ({
  headless = false,
  devtools = false,
  extraArgs = [],
  monitoring = false,
  useChromeChannel = false,
  chromeExecutablePath = ''
} = {}) => {
  const baseArgs = monitoring ? [...MONITORING_BROWSER_ARGS] : [...BASE_BROWSER_ARGS]
  if (monitoring && !headless) {
    baseArgs.push('--start-maximized')
  }
  const result = {
    headless,
    devtools,
    args: [...baseArgs, ...extraArgs]
  }
  if (monitoring && useChromeChannel) {
    if (chromeExecutablePath) {
      result.executablePath = chromeExecutablePath
    } else {
      result.channel = 'chrome'
    }
  }
  return result
}

export const getMobileContextOptions = ({ storageState, overrides } = {}) =>
  mergeContextOptions(MOBILE_CONTEXT_BASE, { storageState, overrides })

export const getDesktopContextOptions = ({ storageState, overrides } = {}) =>
  mergeContextOptions(DESKTOP_CONTEXT_BASE, { storageState, overrides })

/**
 * 京东监控：桌面环境 + 国内语言/时区/大致地理位置 + 常见请求头，贴近真实用户访问 item.jd.com
 * @param {object} [opts]
 * @param {object|null} [opts.storageState]
 * @param {boolean} [opts.headless] 无头时用固定视口；有头时 viewport=null 由窗口决定
 * @param {object} [opts.overrides] 传入 Playwright newContext 的额外字段
 */
export const getJdMonitoringContextOptions = ({ storageState, headless = false, overrides = {} } = {}) => {
  const desktopLike = {
    ...DESKTOP_CONTEXT_BASE,
    userAgent: JD_MONITORING_USER_AGENT,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    // 北京大致坐标，与 timezone 一致
    geolocation: { longitude: 116.4074, latitude: 39.9042 },
    permissions: ['geolocation'],
    viewport: headless ? JD_MONITORING_VIEWPORT_HEADLESS : null,
    screen: headless ? { width: 1920, height: 1080 } : undefined,
    // 不传 Upgrade-Insecure-Requests、Sec-Fetch-* 等，避免京东 CDN 跨域子资源请求 CORS 预检失败
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    }
  }
  // viewport 为 null 时 Playwright 禁止使用 deviceScaleFactor，需剔除
  if (!headless) {
    delete desktopLike.deviceScaleFactor
  }
  return mergeContextOptions(desktopLike, { storageState, overrides })
}

/**
 * 在每个页面脚本执行前注入：弱化 webdriver、补齐常见 Chrome 桌面端特征
 * （说明性注释写在源码中；字符串内为纯 JS，避免在页面出现乱码）
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  'use strict'
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get() { return undefined },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get() { return Object.freeze(['zh-CN', 'zh', 'en']) },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get() { return 'Win32' },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'vendor', {
      get() { return 'Google Inc.' },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get() { return 8 },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
      get() { return 0 },
      configurable: true
    })
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      get() { return 8 },
      configurable: true
    })
  } catch (e) {}

  try {
    const fakeConnection = {
      downlink: 10,
      effectiveType: '4g',
      rtt: 80,
      saveData: false,
      onchange: null,
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return false }
    }
    Object.defineProperty(Navigator.prototype, 'connection', {
      get() { return fakeConnection },
      configurable: true
    })
  } catch (e) {}

  window.chrome = window.chrome || {}
  window.chrome.runtime = window.chrome.runtime || {}
  try {
    window.chrome.csi = window.chrome.csi || function () { return { startE: Date.now() } }
    window.chrome.loadTimes = window.chrome.loadTimes || function () {
      const t = Date.now() / 1000
      return {
        commitLoadTime: t,
        connectionInfo: 'h2',
        finishDocumentLoadTime: t,
        finishLoadTime: t,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: t,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: t,
        startLoadTime: t,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      }
    }
  } catch (e) {}

  const origQuery = navigator.permissions && navigator.permissions.query
  if (typeof origQuery === 'function') {
    navigator.permissions.query = function (parameters) {
      return parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery.call(navigator.permissions, parameters)
    }
  }

  try {
    const codecMap = {
      'video/mp4': 'probably', 'video/webm': 'probably', 'video/ogg': 'maybe',
      'video/mp4; codecs="avc1.42E01E"': 'probably', 'video/webm; codecs="vp8, vorbis"': 'probably',
      'audio/mpeg': 'probably', 'audio/mp4': 'probably', 'audio/ogg': 'probably', 'audio/wav': 'maybe',
      'audio/webm': 'probably', 'audio/flac': 'probably'
    }
    const origCanPlayType = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function (type) {
      const t = (type || '').toLowerCase()
      if (codecMap[t]) return codecMap[t]
      return typeof origCanPlayType === 'function' ? origCanPlayType.call(this, type) : ''
    }
  } catch (e) {}

  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (param) {
      const UNMASKED_VENDOR_WEBGL = 37445
      const UNMASKED_RENDERER_WEBGL = 37446
      if (param === UNMASKED_VENDOR_WEBGL) return 'Google Inc. (Intel)'
      if (param === UNMASKED_RENDERER_WEBGL) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
      return origGetParameter.call(this, param)
    }
    const origGetParameter2 = WebGL2RenderingContext && WebGL2RenderingContext.prototype.getParameter
    if (origGetParameter2) {
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        const UNMASKED_VENDOR_WEBGL = 37445
        const UNMASKED_RENDERER_WEBGL = 37446
        if (param === UNMASKED_VENDOR_WEBGL) return 'Google Inc. (Intel)'
        if (param === UNMASKED_RENDERER_WEBGL) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'
        return origGetParameter2.call(this, param)
      }
    }
  } catch (e) {}
})()
`

/** 监控上下文创建后调用，确保每个页面均带伪装脚本 */
export async function applyMonitoringStealth(context) {
  await context.addInitScript(STEALTH_INIT_SCRIPT)
}

/**
 * 为闲鱼/淘宝系页面授予传感器类权限，减轻控制台 `Permissions policy violation: accelerometer`
 * 及阿里风控脚本（fireye/collina 等）在 Playwright Chromium 下滑块失败的问题。
 * 不同 Chromium 版本对 `grantPermissions` 无 `origin` 的支持程度不一，故对常见域名逐个尝试（失败忽略）。
 * @param {import('playwright').BrowserContext} context
 */
const GOOFISH_SENSOR_PERMISSIONS = /** @type {const} */ (['accelerometer', 'gyroscope', 'magnetometer'])

const GOOFISH_SENSOR_GRANT_ORIGINS = [
  'https://www.goofish.com',
  'https://goofish.com',
  'https://h5api.m.goofish.com',
  'https://m.goofish.com',
  'https://www.taobao.com',
  'https://login.taobao.com',
  'https://passport.taobao.com',
  'https://passport.alipay.com',
  'https://g.alicdn.com',
  'https://img.alicdn.com',
  'https://gm.mmstat.com',
  'https://ynuf.aliapp.org',
  'https://cf.aliyun.com',
  'https://detail.taobao.com',
  'https://item.taobao.com',
  'https://main.m.taobao.com',
  'https://h5.m.taobao.com',
  'https://ditu.amap.com',
  'https://www.amap.com',
  'https://amap.com',
  'https://m.amap.com'
]

export async function grantGoofishPlaywrightSensorPermissions(context) {
  if (!context || typeof context.grantPermissions !== 'function') return
  try {
    await context.grantPermissions([...GOOFISH_SENSOR_PERMISSIONS])
  } catch (e) {
    console.warn('[浏览器自动化] grantPermissions(sensors) 全站', e?.message || e)
  }
  for (const origin of GOOFISH_SENSOR_GRANT_ORIGINS) {
    try {
      await context.grantPermissions([...GOOFISH_SENSOR_PERMISSIONS], { origin })
    } catch {
      /* 部分版本或 origin 组合不支持时忽略 */
    }
  }
}

/** 放宽 document/iframe 的 Permissions-Policy，避免 fireye/collina 报 accelerometer violation */
const PERMISSIVE_SENSOR_PERMISSIONS_POLICY =
  'accelerometer=*, gyroscope=*, magnetometer=*'

const PERMISSIVE_SENSOR_META_TAG =
  '<meta http-equiv="Permissions-Policy" content="accelerometer=*, gyroscope=*, magnetometer=*">'

/** 向 HTML 注入 Permissions-Policy meta，并为 iframe 补 allow 属性 */
function injectSensorPolicyIntoHtml(html) {
  let body = String(html || '')
  if (/<head[\s>]/i.test(body)) {
    body = body.replace(/<head([^>]*)>/i, `<head$1>${PERMISSIVE_SENSOR_META_TAG}`)
  } else if (/<html[\s>]/i.test(body)) {
    body = body.replace(/<html([^>]*)>/i, `<html$1><head>${PERMISSIVE_SENSOR_META_TAG}</head>`)
  }
  body = body.replace(/<iframe(?![^>]*\sallow=)([^>]*)>/gi, (_match, attrs) => {
    return `<iframe allow="accelerometer *; gyroscope *; magnetometer *"${attrs}>`
  })
  return body
}

/**
 * 在页面脚本执行前：强制覆盖原生传感器 API + 拦截 deviceorientation/devicemotion 监听。
 * Chromium 自带 Accelerometer，仅 typeof === 'undefined' 时 mock 无效，必须 defineProperty 覆盖。
 */
export const SENSOR_POLICY_INIT_SCRIPT = `
(() => {
  'use strict'
  const granted = { state: 'granted', onchange: null }
  const origQuery = navigator.permissions && navigator.permissions.query
  if (typeof origQuery === 'function') {
    navigator.permissions.query = function (params) {
      const name = String(params && params.name ? params.name : '').toLowerCase()
      if (name === 'accelerometer' || name === 'gyroscope' || name === 'magnetometer') {
        return Promise.resolve(granted)
      }
      return origQuery.call(navigator.permissions, params)
    }
  }

  class MockSensor extends EventTarget {
    constructor() {
      super()
      this.x = 0
      this.y = 0
      this.z = 9.8
      this.timestamp = Date.now()
    }
    start() {
      queueMicrotask(() => this.dispatchEvent(new Event('reading')))
    }
    stop() {}
  }

  for (const sensorName of [
    'Accelerometer',
    'Gyroscope',
    'Magnetometer',
    'LinearAccelerationSensor',
    'GravitySensor',
    'AbsoluteOrientationSensor',
    'RelativeOrientationSensor'
  ]) {
    try {
      Object.defineProperty(window, sensorName, {
        configurable: true,
        writable: true,
        value: class extends MockSensor {}
      })
    } catch (e) {}
  }

  const SENSOR_EVENTS = new Set(['deviceorientation', 'devicemotion', 'deviceorientationabsolute'])
  const origAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const eventName = String(type).toLowerCase()
    if (SENSOR_EVENTS.has(eventName)) {
      const handler = typeof listener === 'function' ? listener : listener && listener.handleEvent
      if (!handler) return
      const fakeEvent = {
        type: eventName,
        alpha: 0,
        beta: 0,
        gamma: 0,
        absolute: false,
        acceleration: { x: 0, y: 0, z: 9.8 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        rotationRate: { alpha: 0, beta: 0, gamma: 0 },
        interval: 16
      }
      queueMicrotask(() => {
        try {
          handler.call(this, fakeEvent)
        } catch (e) {}
      })
      return
    }
    return origAdd.call(this, type, listener, options)
  }

  const origRemove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (SENSOR_EVENTS.has(String(type).toLowerCase())) return
    return origRemove.call(this, type, listener, options)
  }
})()
`

const sensorPolicyRouteContexts = new WeakSet()

/**
 * 改写 document/iframe 响应头的 Permissions-Policy，解决 punish 页 fireyejs accelerometer violation。
 * 须在 context 上、首次 page.goto 之前调用；每个 context 只装一次 route。
 * @param {import('playwright').BrowserContext} context
 */
export async function setupGoofishSensorPermissionsPolicyBypass(context) {
  if (!context || typeof context.route !== 'function') return
  if (sensorPolicyRouteContexts.has(context)) return
  sensorPolicyRouteContexts.add(context)

  await context.route('**/*', async (route) => {
    const resourceType = route.request().resourceType()
    if (resourceType !== 'document' && resourceType !== 'iframe') {
      await route.continue()
      return
    }
    try {
      const response = await route.fetch()
      const headers = { ...response.headers() }
      headers['permissions-policy'] = PERMISSIVE_SENSOR_PERMISSIONS_POLICY
      delete headers['feature-policy']
      const contentType = headers['content-type'] || ''
      if (/text\/html/i.test(contentType)) {
        const html = injectSensorPolicyIntoHtml(await response.text())
        await route.fulfill({
          status: response.status(),
          headers,
          body: html,
          contentType
        })
        return
      }
      await route.fulfill({ response, headers })
    } catch {
      await route.continue()
    }
  })
}

/** 传感器反检测：grant + init script + Permissions-Policy route（阿里 punish / 滑块页） */
export async function applyGoofishSensorAntiBot(context) {
  await grantGoofishPlaywrightSensorPermissions(context)
  await context.addInitScript(SENSOR_POLICY_INIT_SCRIPT)
  await setupGoofishSensorPermissionsPolicyBypass(context)
}

/**
 * 阿里 punish / 滑块：系统 Chrome + 持久化 Profile + 最小注入。
 * 不用 mock 传感器、不改写 HTML（会破坏 fireye 指纹，导致手动拖也失败）。
 * 对齐闲鱼 Electron 内嵌窗：Chrome 133 + Sec-CH-UA。
 * @param {import('playwright').Chromium} chromium
 * @param {{ userDataDir?: string }} [opts]
 */
export async function openCaptchaBrowserSession(chromium, { userDataDir } = {}) {
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const profileDir = userDataDir || join(tmpdir(), 'sxjk-captcha-chrome-profile')
  mkdirSync(profileDir, { recursive: true })

  const userAgent = GOOFISH_ELECTRON_BROWSE_USER_AGENT
  const secChUa = '"Google Chrome";v="133", "Chromium";v="133", "Not-A.Brand";v="24"'
  const launchBase = {
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check'
    ],
    userAgent,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Sec-CH-UA': secChUa,
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"'
    }
  }

  let context
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      ...launchBase,
      channel: 'chrome'
    })
  } catch (launchErr) {
    console.warn('[浏览器自动化] 系统 Chrome 启动失败，回退内置 Chromium:', launchErr?.message || launchErr)
    context = await chromium.launchPersistentContext(profileDir, launchBase)
  }

  await grantGoofishPlaywrightSensorPermissions(context)
  await applyMonitoringStealth(context)

  return { browser: context.browser(), context, userDataDir: profileDir }
}

/** 阿里 punish / 滑块 H5 常用 Android Chrome 移动 UA */
export const GOOFISH_PUNISH_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

/**
 * 与 c7d1df4 / xianyu-goofish-playwright 一致：内置 Chromium + 监控上下文 + 传感器 + stealth。
 * 默认 useChromeChannel=false（Playwright 内置 Chromium 对 grantPermissions(sensors) 更稳）。
 * @param {import('playwright').Chromium} chromium
 * @param {{ headless?: boolean, useChromeChannel?: boolean, mobile?: boolean, viewport?: { width: number, height: number } }} [opts]
 */
export async function openGoofishPlaywrightBrowserSession(chromium, {
  headless = false,
  useChromeChannel = false,
  mobile = false,
  viewport
} = {}) {
  const launchOptions = createBrowserLaunchOptions({
    headless,
    monitoring: true,
    useChromeChannel
  })

  let browser
  try {
    browser = await chromium.launch(launchOptions)
  } catch (launchErr) {
    console.warn('[浏览器自动化] launch 失败，回退内置 Chromium:', launchErr?.message || launchErr)
    browser = await chromium.launch({ headless, args: launchOptions.args || [] })
  }

  const contextOptionsFn = mobile ? getMobileContextOptions : getGoofishPlaywrightContextOptions
  const defaultViewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }
  const context = await browser.newContext(
    contextOptionsFn({
      headless,
      overrides: {
        viewport: viewport || defaultViewport,
        permissions: ['geolocation', ...GOOFISH_SENSOR_PERMISSIONS],
        ...(mobile ? { userAgent: GOOFISH_PUNISH_MOBILE_USER_AGENT } : {})
      }
    })
  )

  await applyGoofishSensorAntiBot(context)
  await applyMonitoringStealth(context)
  return { browser, context }
}

/** 闲鱼 www.goofish.com：与京东监控相同的桌面 Chromium 上下文（启动参数 + stealth） */
export const getGoofishPlaywrightContextOptions = getJdMonitoringContextOptions
