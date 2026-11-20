import { createApp } from 'vue'
import './styles/base.css'
import './styles/shell.css'
import './styles/desktop.css'
import { appDef, appJson, pageJsons, pageLoaders, tabBarLoader } from 'virtual:mp-app'
import AppShell from './shell/AppShell.vue'
import { installRuntime } from './runtime/install.js'
import { getApp, initApp, launchApp } from './runtime/app.js'
import { getCurrentPages, initRouter, nav, parseHash, startRouter } from './runtime/router.js'
import { wx } from './runtime/wx/index.js'
import { getStorageSync } from './runtime/wx/storage.js'
import { registerPwa } from './pwa/register.js'

// 入口页是 app.json 的第一页（登录 / 绑定页）。H5 启动时直接决定落到哪页，
// 不像小程序那样先停在登录页再静默跳走——有登录态就直接开首页或地址栏里的页面。
const LOGIN_ROUTE = appJson.pages[0]
const FIRST_TAB = appJson.tabBar && appJson.tabBar.list && appJson.tabBar.list[0] && appJson.tabBar.list[0].pagePath

function landing() {
  const g = getApp().globalData || {}
  const cached = getStorageSync('h5_session') || {}
  return g.landingPage || cached.landing_page || FIRST_TAB || LOGIN_ROUTE
}

function resolveBootUrl(url) {
  const route = url ? url.replace(/^\//, '').split('?')[0] : ''
  if (!getStorageSync('token')) return `/${LOGIN_ROUTE}`
  if (!route || route === LOGIN_ROUTE || !pageLoaders[route]) return `/${landing()}`
  return url
}

initRouter({ appJson, pageJsons, pageLoaders, tabBarLoader, landing, resolveBootUrl })
initApp(appDef)

const app = createApp(AppShell)
installRuntime(app)
app.mount('#app')

const fromHash = parseHash(location.hash)
const bootUrl = resolveBootUrl(fromHash ? `/${fromHash.route}${fromHash.queryString ? `?${fromHash.queryString}` : ''}` : '')
startRouter(bootUrl)
launchApp({ path: bootUrl.slice(1).split('?')[0], query: {}, scene: 1001 })

const splash = document.getElementById('boot-splash')
if (splash) splash.remove()

registerPwa()

// 开发时在控制台里摸运行时：__mp.wx.navigateTo({ url }) / __mp.pages()
if (import.meta.env.DEV) window.__mp = { wx, nav, pages: getCurrentPages, app: getApp }
