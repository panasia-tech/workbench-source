import { nextTick as vueNextTick } from 'vue'
import * as router from '../router.js'
import * as ui from '../ui.js'
import { promisify, warnOnce } from '../util.js'
import * as storage from './storage.js'
import * as network from './network.js'
import * as media from './media.js'
import { scanCode } from './scan.js'

// wx 对象。清单见 names.js；没实现的接口走最底下的 Proxy：打一次警告、按失败回调。

function withCallbacks(name, options, promise) {
  const o = options || {}
  const hasCb = typeof o.success === 'function' || typeof o.fail === 'function' || typeof o.complete === 'function'
  promise.then(
    (res) => {
      if (o.success) o.success(res)
      if (o.complete) o.complete(res)
    },
    (err) => {
      if (o.fail) o.fail(err)
      else if (hasCb) console.warn(`[H5] wx.${name}`, err && err.errMsg)
      if (o.complete) o.complete(err)
    },
  )
  if (hasCb) {
    promise.catch(() => {})
    return undefined
  }
  return promise
}

const route = (name, fn) => (o = {}) => withCallbacks(name, o, fn(o))

function topHost() {
  return router.hostOf(router.topEntry())
}

const impl = {
  // ---- 界面
  showToast: promisify('showToast', (o) => { ui.showToast(o) }),
  hideToast: promisify('hideToast', () => { ui.hideToast() }),
  showLoading: promisify('showLoading', (o) => { ui.showLoading(o) }),
  hideLoading: promisify('hideLoading', () => { ui.hideToast() }),
  showModal(o = {}) {
    const p = ui.showModal(o)
    const hasCb = o.success || o.fail || o.complete
    return hasCb ? undefined : p
  },
  showActionSheet(o = {}) {
    const p = ui.showActionSheet(o)
    const hasCb = o.success || o.fail || o.complete
    if (hasCb) {
      p.catch(() => {})
      return undefined
    }
    return p
  },
  setNavigationBarTitle: promisify('setNavigationBarTitle', ({ title }) => {
    const entry = router.topEntry()
    if (entry) entry.title = title == null ? '' : String(title)
    router.refreshTitle()
  }),
  setNavigationBarColor: promisify('setNavigationBarColor', () => {}),
  showNavigationBarLoading: promisify('showNavigationBarLoading', () => {}),
  hideNavigationBarLoading: promisify('hideNavigationBarLoading', () => {}),
  hideHomeButton: promisify('hideHomeButton', () => {}),
  startPullDownRefresh: promisify('startPullDownRefresh', () => {
    const h = topHost()
    if (h) h.startPullDownRefresh()
  }),
  stopPullDownRefresh: promisify('stopPullDownRefresh', () => {
    const h = topHost()
    if (h) h.stopPullDownRefresh()
  }),
  pageScrollTo: promisify('pageScrollTo', ({ scrollTop = 0, duration = 300, selector, offsetTop = 0 }) => {
    const h = topHost()
    const sc = h && h.scroller()
    if (!sc) return
    let top = Number(scrollTop) || 0
    if (selector) {
      const root = h.pageEl() || sc
      const el = root.querySelector(selector)
      if (!el) throw new Error(`selector ${selector} not found`)
      top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop + (Number(offsetTop) || 0)
    }
    sc.scrollTo({ top, behavior: Number(duration) > 0 ? 'smooth' : 'auto' })
  }),
  nextTick(fn) {
    vueNextTick(fn)
  },

  // ---- 路由
  navigateTo: route('navigateTo', (o) => router.navigateTo(o.url)),
  navigateBack: route('navigateBack', (o) => router.navigateBack(o.delta)),
  redirectTo: route('redirectTo', (o) => router.redirectTo(o.url)),
  reLaunch: route('reLaunch', (o) => router.reLaunch(o.url)),
  switchTab: route('switchTab', (o) => router.switchTab(o.url)),

  // ---- 存储
  ...storage,

  // ---- 网络
  request: network.request,
  uploadFile: network.uploadFile,
  downloadFile: network.downloadFile,
  connectSocket: network.connectSocket,

  // ---- 媒体
  chooseMedia: media.chooseMedia,
  chooseImage: media.chooseImage,
  chooseVideo: media.chooseVideo,
  previewImage: media.previewImage,
  previewMedia: media.previewMedia,
  getImageInfo: media.getImageInfo,
  saveImageToPhotosAlbum: media.saveImageToPhotosAlbum,

  // ---- 设备 / 系统
  scanCode,
  setClipboardData: promisify('setClipboardData', async ({ data }) => {
    const text = data == null ? '' : String(data)
    let ok = false
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch { /* 走下面的兜底 */ }
    if (!ok) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      ta.remove()
    }
    if (!ok) throw new Error('复制失败')
    // 小程序复制成功会自己弹「内容已复制」，页面代码依赖这个提示
    ui.showToast({ title: '内容已复制', icon: 'none' })
  }),
  getClipboardData: promisify('getClipboardData', async () => ({ data: await navigator.clipboard.readText() })),
  makePhoneCall: promisify('makePhoneCall', ({ phoneNumber }) => { location.href = `tel:${phoneNumber}` }),
  vibrateShort: promisify('vibrateShort', () => { if (navigator.vibrate) navigator.vibrate(15) }),
  vibrateLong: promisify('vibrateLong', () => { if (navigator.vibrate) navigator.vibrate(400) }),
  getNetworkType: promisify('getNetworkType', () => {
    const c = navigator.connection
    return { networkType: navigator.onLine ? (c && c.effectiveType) || 'unknown' : 'none' }
  }),
  onNetworkStatusChange(cb) {
    const fire = () => cb({ isConnected: navigator.onLine, networkType: navigator.onLine ? 'unknown' : 'none' })
    cb.__mpNet = fire
    window.addEventListener('online', fire)
    window.addEventListener('offline', fire)
  },
  offNetworkStatusChange(cb) {
    if (!cb || !cb.__mpNet) return
    window.removeEventListener('online', cb.__mpNet)
    window.removeEventListener('offline', cb.__mpNet)
  },
  getSystemInfoSync: () => systemInfo(),
  getSystemInfo: promisify('getSystemInfo', () => systemInfo()),
  getWindowInfo: () => systemInfo(),
  getDeviceInfo: () => systemInfo(),
  getAppBaseInfo: () => ({ SDKVersion: 'h5', language: navigator.language, version: '', theme: 'light' }),
  // 网页没有右上角胶囊：给一个贴在最右边、宽度为 0 的框，自己画导航栏的页面据此算出
  // 「不用让位」，高度和外壳导航栏一样是 44
  getMenuButtonBoundingClientRect: () => {
    const w = window.innerWidth
    return { width: 0, height: 32, top: 6, bottom: 38, left: w, right: w }
  },
  getAccountInfoSync: () => ({ miniProgram: { appId: 'h5', envVersion: 'release', version: '' }, plugin: {} }),
  getLaunchOptionsSync: () => ({ path: router.topEntry() ? router.topEntry().route : '', query: {}, scene: 1001 }),
  getEnterOptionsSync: () => ({ path: router.topEntry() ? router.topEntry().route : '', query: {}, scene: 1001 }),
  canIUse: (name) => {
    const key = String(name || '').split('.')[0]
    return Object.prototype.hasOwnProperty.call(impl, key)
  },
  getUpdateManager: () => ({
    onCheckForUpdate() {},
    onUpdateReady() {},
    onUpdateFailed() {},
    applyUpdate() { location.reload() },
  }),
  onAppShow(cb) { appListeners.show.add(cb) },
  onAppHide(cb) { appListeners.hide.add(cb) },
  offAppShow(cb) { appListeners.show.delete(cb) },
  offAppHide(cb) { appListeners.hide.delete(cb) },
  reportAnalytics() {},
  reportMonitor() {},
  createSelectorQuery: () => createSelectorQuery(),
}

const appListeners = { show: new Set(), hide: new Set() }
document.addEventListener('visibilitychange', () => {
  const set = document.visibilityState === 'hidden' ? appListeners.hide : appListeners.show
  for (const cb of set) {
    try { cb({}) } catch (e) { console.error(e) }
  }
})

function systemInfo() {
  const w = window.innerWidth
  const h = window.innerHeight
  const ua = navigator.userAgent
  return {
    brand: '',
    model: '',
    pixelRatio: window.devicePixelRatio || 1,
    screenWidth: window.screen ? window.screen.width : w,
    screenHeight: window.screen ? window.screen.height : h,
    windowWidth: w,
    windowHeight: h,
    statusBarHeight: 0,
    safeArea: { left: 0, right: w, top: 0, bottom: h, width: w, height: h },
    language: navigator.language,
    version: '',
    system: ua,
    platform: /iphone|ipad|ipod/i.test(ua) ? 'ios' : /android/i.test(ua) ? 'android' : 'devtools',
    SDKVersion: 'h5',
    theme: 'light',
  }
}

/** 最小可用的 SelectorQuery：select/selectAll + boundingClientRect/scrollOffset + exec */
function createSelectorQuery() {
  const tasks = []
  const root = () => {
    const h = topHost()
    return (h && h.pageEl()) || document
  }
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { id: el.id, dataset: { ...el.dataset }, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const node = (selector, all) => ({
    boundingClientRect(cb) {
      tasks.push({ cb, run: () => (all ? Array.from(root().querySelectorAll(selector)).map(rectOf) : rectOf(root().querySelector(selector))) })
      return query
    },
    scrollOffset(cb) {
      tasks.push({
        cb,
        run: () => {
          const el = selector === '__viewport__' ? (topHost() && topHost().scroller()) : root().querySelector(selector)
          return el ? { scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, scrollHeight: el.scrollHeight, scrollWidth: el.scrollWidth } : null
        },
      })
      return query
    },
    fields(_, cb) {
      return this.boundingClientRect(cb)
    },
  })
  const query = {
    in() { return query },
    select: (s) => node(s, false),
    selectAll: (s) => node(s, true),
    selectViewport: () => node('__viewport__', false),
    exec(cb) {
      requestAnimationFrame(() => {
        const results = tasks.map((t) => {
          const r = t.run()
          if (t.cb) t.cb(r)
          return r
        })
        if (cb) cb(results)
      })
    },
  }
  return query
}

const unsupported = new Set(['login', 'getUserProfile', 'getUserInfo', 'requestPayment', 'requestSubscribeMessage', 'getPhoneNumber'])

export const wx = new Proxy(impl, {
  get(target, key) {
    if (typeof key !== 'string') return target[key]
    if (key in target) return target[key]
    return (o = {}) => {
      warnOnce(`wx.${key} 在 H5 里没有实现`)
      if (!unsupported.has(key)) ui.showToast({ title: `H5 暂不支持 ${key}`, icon: 'none' })
      const err = { errMsg: `${key}:fail H5 暂不支持` }
      if (o && typeof o.fail === 'function') o.fail(err)
      if (o && typeof o.complete === 'function') o.complete(err)
      if (!o || (!o.success && !o.fail && !o.complete)) return Promise.reject(err)
      return undefined
    }
  },
})
