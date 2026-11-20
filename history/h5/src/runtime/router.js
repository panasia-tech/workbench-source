import { markRaw, reactive } from 'vue'
import { parseQuery } from './util.js'

// 页面栈：小程序的 navigateTo / navigateBack / redirectTo / switchTab / reLaunch 语义。
//   base   最底下那页：当前 tab 页，或 reLaunch / 直接打开地址得到的非 tab 页
//   stack  base 之上 navigateTo 进来的页
//   tabs   活着的 tab 页（切 tab 不销毁，和小程序一样）
// 浏览器历史只是它的影子：每层页面（以及能用返回键关掉的弹层）占一条历史，
// 安卓返回键 / 浏览器后退 = navigateBack，刷新后再后退会按历史里的地址重建页面。

let cfg = null
let tabRoutes = new Set()
let seq = 0
const vms = new Map()
const SID = Math.random().toString(36).slice(2)

export const nav = reactive({ tabs: [], base: null, stack: [], tabBar: null })

export function initRouter(config) {
  cfg = config
  const list = (config.appJson.tabBar && config.appJson.tabBar.list) || []
  tabRoutes = new Set(list.map((t) => t.pagePath))
  if (config.tabBarLoader) {
    config.tabBarLoader().then((m) => { nav.tabBar = markRaw(m.default) }, (e) => console.error('[H5] tabBar 加载失败', e))
  }
}

export const isTabRoute = (route) => tabRoutes.has(route)
export const windowConfig = () => (cfg && cfg.appJson.window) || {}
export const entryRoute = () => (cfg && cfg.appJson.pages[0]) || ''
export const topEntry = () => (nav.stack.length ? nav.stack[nav.stack.length - 1] : nav.base)
export const pageJsonOf = (route) => (cfg && cfg.pageJsons[route]) || {}

export function titleOf(entry) {
  if (!entry) return ''
  if (entry.title != null) return entry.title
  const j = pageJsonOf(entry.route)
  return j.navigationBarTitleText || (cfg && cfg.appJson.window.navigationBarTitleText) || ''
}

// ---------------------------------------------------------------- 页面实例登记

const hosts = new Map()

/** PageHost 登记自己（滚动容器、下拉刷新），wx.pageScrollTo / stopPullDownRefresh 找它 */
export function bindHost(entry, host) {
  hosts.set(entry.id, host)
}

export function unbindHost(entry) {
  hosts.delete(entry.id)
}

export function hostOf(entry) {
  return entry ? hosts.get(entry.id) || null : null
}

export function bindVm(entry, vm) {
  vms.set(entry.id, vm)
}

export function vmOf(entry) {
  return entry ? vms.get(entry.id) || null : null
}

export function getCurrentPages() {
  return [nav.base, ...nav.stack].filter(Boolean).map((e) => vms.get(e.id)).filter(Boolean)
}

export const isTop = (entry) => topEntry() === entry

// ---------------------------------------------------------------- 地址

function normalize(p) {
  const out = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

export function parseUrl(url) {
  const u = String(url || '').trim()
  const qi = u.indexOf('?')
  let path = qi < 0 ? u : u.slice(0, qi)
  const queryString = qi < 0 ? '' : u.slice(qi + 1)
  if (path.startsWith('/')) path = normalize(path)
  else {
    const from = topEntry()
    const dir = from ? from.route.split('/').slice(0, -1).join('/') : ''
    path = normalize(`${dir}/${path}`)
  }
  return { route: path.replace(/\.html$/, ''), queryString }
}

export function parseHash(hash) {
  const h = String(hash || '').replace(/^#/, '')
  if (!h.startsWith('/')) return null
  const parsed = parseUrl(h)
  return cfg.pageLoaders[parsed.route] ? parsed : null
}

const hashOf = (e) => `#/${e.route}${e.queryString ? `?${e.queryString}` : ''}`

// ---------------------------------------------------------------- 页面条目

function createEntry(route, queryString) {
  const entry = reactive({
    id: ++seq,
    route,
    queryString: queryString || '',
    query: parseQuery(queryString),
    isTab: tabRoutes.has(route),
    title: null,
    component: null,
    loadError: '',
    dead: false,
  })
  loadEntry(entry)
  return entry
}

export function loadEntry(entry) {
  entry.loadError = ''
  cfg.pageLoaders[entry.route]().then(
    (m) => { entry.component = markRaw(m.default) },
    (err) => {
      console.error(`[H5] 页面 ${entry.route} 加载失败`, err)
      entry.loadError = (err && err.message) || String(err)
    },
  )
}

function unload(entry) {
  if (!entry || entry.dead) return
  entry.dead = true
  const vm = vms.get(entry.id)
  if (vm && vm.__mpUnload) vm.__mpUnload()
  vms.delete(entry.id)
}

let lastTop = null

function settle() {
  const t = topEntry()
  if (t !== lastTop) {
    const prev = lastTop
    lastTop = t
    if (prev && !prev.dead) {
      const vm = vms.get(prev.id)
      if (vm && vm.__mpHide) vm.__mpHide()
    }
    if (t) {
      const vm = vms.get(t.id)
      if (vm && vm.__mpShow) vm.__mpShow()
    }
  }
  if (typeof document !== 'undefined') document.title = titleOf(t) || cfg.appJson.window.navigationBarTitleText || ''
  syncHistory()
}

export function refreshTitle() {
  document.title = titleOf(topEntry()) || ''
}

function fail(name, msg) {
  return Promise.reject({ errMsg: `${name}:fail ${msg}` })
}

function checkRoute(name, route) {
  if (!cfg.pageLoaders[route]) return `page "${route}" is not found`
  return ''
}

// ---------------------------------------------------------------- 路由接口

export function navigateTo(url) {
  const { route, queryString } = parseUrl(url)
  const bad = checkRoute('navigateTo', route)
  if (bad) return fail('navigateTo', bad)
  if (isTabRoute(route)) return fail('navigateTo', 'can not navigateTo a tabbar page')
  nav.stack.push(createEntry(route, queryString))
  settle()
  return Promise.resolve({ errMsg: 'navigateTo:ok' })
}

function popPages(n) {
  const removed = nav.stack.splice(nav.stack.length - n, n)
  for (let i = removed.length - 1; i >= 0; i--) unload(removed[i])
}

export function navigateBack(delta = 1) {
  const n = Math.max(1, Number(delta) || 1)
  if (!nav.stack.length) {
    // 直接打开的非 tab 页没有上一页：小程序会给个「回首页」按钮，这里直接回首页
    if (nav.base && !nav.base.isTab) {
      goHome()
      return Promise.resolve({ errMsg: 'navigateBack:ok' })
    }
    return fail('navigateBack', 'cannot navigate back at first page.')
  }
  popPages(Math.min(n, nav.stack.length))
  settle()
  return Promise.resolve({ errMsg: 'navigateBack:ok' })
}

export function redirectTo(url) {
  const { route, queryString } = parseUrl(url)
  const bad = checkRoute('redirectTo', route)
  if (bad) return fail('redirectTo', bad)
  if (isTabRoute(route)) return fail('redirectTo', 'can not redirectTo a tabbar page')
  const entry = createEntry(route, queryString)
  if (nav.stack.length) {
    unload(nav.stack.pop())
    nav.stack.push(entry)
  } else {
    if (nav.base && !nav.base.isTab) unload(nav.base)
    nav.base = entry
  }
  settle()
  return Promise.resolve({ errMsg: 'redirectTo:ok' })
}

function closeLayers() {
  while (layers.length) {
    const l = layers.pop()
    try { l.close() } catch (e) { console.error(e) }
  }
}

export function switchTab(url) {
  const { route } = parseUrl(url)
  const bad = checkRoute('switchTab', route)
  if (bad) return fail('switchTab', bad)
  if (!isTabRoute(route)) return fail('switchTab', 'can not switch to no-tabBar page')
  closeLayers()
  popPages(nav.stack.length)
  if (nav.base && !nav.base.isTab) unload(nav.base)
  let tab = nav.tabs.find((t) => t.route === route && !t.dead)
  if (!tab) {
    tab = createEntry(route, '')
    nav.tabs.push(tab)
  }
  nav.base = tab
  settle()
  return Promise.resolve({ errMsg: 'switchTab:ok' })
}

export function reLaunch(url) {
  const { route, queryString } = parseUrl(url)
  const bad = checkRoute('reLaunch', route)
  if (bad) return fail('reLaunch', bad)
  closeLayers()
  popPages(nav.stack.length)
  if (nav.base && !nav.base.isTab) unload(nav.base)
  for (const t of nav.tabs) unload(t)
  nav.tabs = []
  const entry = createEntry(route, queryString)
  if (entry.isTab) nav.tabs.push(entry)
  nav.base = entry
  settle()
  return Promise.resolve({ errMsg: 'reLaunch:ok' })
}

export function goHome() {
  const landing = cfg.landing ? cfg.landing() : ''
  const target = landing || [...tabRoutes][0] || cfg.appJson.pages[0]
  return isTabRoute(target) ? switchTab(`/${target}`) : reLaunch(`/${target}`)
}

// ---------------------------------------------------------------- 浏览器历史

const layers = []
let layerSeq = 0
let histDepth = 0
let queue = Promise.resolve()
let pendingPop = null

/** 弹层登记一条历史，返回键先关它；close 是返回键触发时的关闭动作 */
export function pushLayer(close) {
  const layer = { id: ++layerSeq, close }
  layers.push(layer)
  syncHistory()
  return layer
}

export function popLayer(layer) {
  // 按 id 找：弹层状态是响应式对象，从里面取回来的 layer 是 Proxy，indexOf 认不出原对象
  const i = layer ? layers.findIndex((l) => l.id === layer.id) : -1
  log('popLayer', layer && layer.id, 'found', i)
  if (i < 0) return
  layers.splice(i, 1)
  syncHistory()
}

/** 关掉最上面一层弹层（电脑上按 Esc，等于手机的返回键）；没有弹层返回 false */
export function closeTopLayer() {
  const layer = layers[layers.length - 1]
  if (!layer) return false
  try { layer.close() } catch (err) { console.error(err) }
  return true
}

function urlAt(depth) {
  const pages = [nav.base, ...nav.stack].filter(Boolean)
  if (!pages.length) return location.href
  return hashOf(pages[Math.min(depth, pages.length - 1)])
}

function historyGo(delta) {
  return new Promise((resolve) => {
    pendingPop = resolve
    history.go(delta)
    setTimeout(() => {
      if (pendingPop === resolve) {
        pendingPop = null
        resolve()
      }
    }, 600)
  })
}

// 开发时把历史同步过程记在 window.__mpHistLog，排查「返回键没反应」这类问题用
const trace = import.meta.env.DEV ? (window.__mpHistLog = []) : null
const log = (...a) => {
  if (!trace) return
  trace.push(a.join(' '))
  if (trace.length > 200) trace.splice(0, trace.length - 200)
}

function syncHistory() {
  log('sync queued', nav.stack.length, layers.length, histDepth)
  queue = queue.then(async () => {
    const target = nav.stack.length + layers.length
    log('sync run target', target, 'histDepth', histDepth)
    if (target < histDepth) {
      await historyGo(target - histDepth)
      histDepth = target
    }
    while (histDepth < target) {
      histDepth++
      history.pushState({ mp: histDepth, sid: SID }, '', urlAt(histDepth))
    }
    history.replaceState({ mp: histDepth, sid: SID }, '', urlAt(histDepth))
  }).catch((e) => console.error('[H5] 历史同步失败', e))
}

function onPopState(e) {
  log('popstate', JSON.stringify(e.state), 'pending', !!pendingPop)
  if (pendingPop) {
    const r = pendingPop
    pendingPop = null
    r()
    return
  }
  const st = e.state
  queue = queue.then(async () => {
    if (!st || st.sid !== SID) {
      // 刷新之前留下的历史：按这条历史的地址重建底页
      histDepth = 0
      const parsed = parseHash(location.hash)
      const url = cfg.resolveBootUrl(parsed ? `/${parsed.route}${parsed.queryString ? `?${parsed.queryString}` : ''}` : '')
      history.replaceState({ mp: 0, sid: SID }, '', location.href)
      const { route } = parseUrl(url)
      if (isTabRoute(route)) switchTab(url)
      else reLaunch(url)
      return
    }
    const d = st.mp
    if (d > histDepth) {
      // 小程序没有「前进」
      await historyGo(histDepth - d)
      return
    }
    let n = histDepth - d
    histDepth = d
    while (n > 0 && layers.length) {
      const layer = layers.pop()
      n--
      try { layer.close() } catch (err) { console.error(err) }
    }
    if (n > 0 && nav.stack.length) {
      popPages(Math.min(n, nav.stack.length))
    }
    settle()
  })
}

export function startRouter(url) {
  window.addEventListener('popstate', onPopState)
  document.addEventListener('visibilitychange', () => {
    const vm = vmOf(topEntry())
    if (!vm) return
    if (document.visibilityState === 'hidden') vm.__mpHide && vm.__mpHide()
    else vm.__mpShow && vm.__mpShow()
  })
  const { route, queryString } = parseUrl(url)
  const entry = createEntry(route, queryString)
  if (entry.isTab) nav.tabs.push(entry)
  nav.base = entry
  histDepth = 0
  history.replaceState({ mp: 0, sid: SID }, '', hashOf(entry))
  settle()
}
