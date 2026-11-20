// H5 版登录：员工账号密码直接登录（POST /api/auth/h5-login），不经微信。
// 和小程序版（miniprogram/services/auth.js）导出同一组函数，页面代码不用改。差别：
//   - 没有静默登录：token 失效（401）就回登录页
//   - 退出只清本地。不调 /api/auth/logout——那个接口会清掉 openid，等于顺手把小程序那边的微信绑定也解了
//   - 有 token 时先请求 /api/auth/me 校验；网络不通就用上次的会话先把页面开起来
//   - 每次启动顺手续期 token（/api/auth/refresh），天天用的人不会隔几天被踢回登录页
const api = require('./api')
const appConfig = require('./config')
const { request } = require('./request')

const SESSION_KEY = 'h5_session'
const REMEMBER_KEY = 'h5_remember'
const LOGIN_ROUTE = 'pages/bind/index'

let bootPromise = null
let redirecting = false

function resolveApp(app) {
  return app || getApp()
}

function currentRoute() {
  const pages = getCurrentPages()
  return pages.length ? pages[pages.length - 1].route : ''
}

function setGlobals(data, app) {
  const instance = resolveApp(app)
  instance.globalData.user = data.staff || null
  instance.globalData.tabs = data.tabs || []
  instance.globalData.landingPage = data.landing_page || ''
  // 电脑端左侧菜单按角色出入口，globalData 不是响应式的，换了人通知它一声
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mp:session'))
}

function applySession(data, app) {
  if (data.token) wx.setStorageSync('token', data.token)
  setGlobals(data, app)
  wx.setStorageSync(SESSION_KEY, {
    staff: data.staff || null,
    tabs: data.tabs || [],
    landing_page: data.landing_page || '',
  })
  appConfig.refreshConfig()
}

function clearSession(app) {
  wx.removeStorageSync('token')
  wx.removeStorageSync(SESSION_KEY)
  setGlobals({}, app)
}

function gotoLoginPage() {
  if (currentRoute() === LOGIN_ROUTE) return
  wx.reLaunch({ url: `/${LOGIN_ROUTE}` })
}

function gotoLanding() {
  const page = getApp().globalData.landingPage || 'pages/profile/index'
  wx.switchTab({ url: `/${page}` })
}

function leaveLoginPage() {
  if (currentRoute() === LOGIN_ROUTE) gotoLanding()
}

function tokenExp(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(part)).exp * 1000
  } catch (e) {
    return 0
  }
}

// 剩不到 6 天就换一枚新的（令牌 7 天有效）
function renewToken() {
  const token = wx.getStorageSync('token')
  if (!token || tokenExp(token) - Date.now() > 6 * 86400000) return
  request({ url: '/api/auth/refresh', method: 'POST', _noAuthRedirect: true })
    .then((data) => {
      if (data && data.token && wx.getStorageSync('token') === token) wx.setStorageSync('token', data.token)
    })
    .catch(() => {})
}

// ---------------------------------------------------------------- 从员工工作台进入
// 员工工作台（妙搭）用 iframe 打开 /h5/?entry_token=…（一次性、60 秒）。先把 token 从地址栏拿掉，
// 再交给服务端换登录（/api/auth/miaoda-entry，换身份用的 key 只在服务端）。同一个工作台账号第一次
// 进来要在登录页输一次 ERP 密码确认本人，之后免登录。token 作废（iframe 二次加载、超时）就当没带：
// 有会话照用，没有去登录页。

const ENTRY_PARAM = 'entry_token'
let miaodaConfirm = null // { ticket, username }：等本人在登录页输密码确认

function takeEntryTokenPeek() {
  try { return !!new URL(window.location.href).searchParams.get(ENTRY_PARAM) } catch (e) { return false }
}

function takeEntryToken() {
  const url = new URL(window.location.href)
  const token = url.searchParams.get(ENTRY_PARAM)
  if (!token) return ''
  url.searchParams.delete(ENTRY_PARAM)
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  return token
}

function enterFromWorkbench(entryToken, app) {
  return request({
    url: '/api/auth/miaoda-entry',
    method: 'POST',
    data: { entry_token: entryToken },
    _noAuthRedirect: true,
  }).then((data) => {
    if (data && data.token) {
      redirecting = false
      applySession(data, app)
      return 'in'
    }
    if (data && data.needs_confirm) {
      miaodaConfirm = { ticket: data.ticket, username: data.username }
      return 'confirm'
    }
    return 'skip'
  }).catch(() => 'skip')
}

/** 登录页用：这次是从工作台第一次进来、等本人确认吗 */
function pendingWorkbenchConfirm() {
  return miaodaConfirm ? { username: miaodaConfirm.username } : null
}

function confirmWorkbench(password) {
  if (!miaodaConfirm) return Promise.reject({ statusCode: 401, detail: '确认超时，请回工作台重新进入' })
  return request({
    url: '/api/auth/miaoda-confirm',
    method: 'POST',
    data: { ticket: miaodaConfirm.ticket, password },
    _noAuthRedirect: true,
  }).then((data) => {
    miaodaConfirm = null
    redirecting = false
    applySession(data)
    return data
  })
}

// ---------------------------------------------------------------- 钉钉工作台免登
// 在钉钉里打开、本地没有登录：用钉钉 JSAPI 拿一次性授权码，交给服务端换令牌（/api/auth/dingtalk-login，
// 按 staff.dingtalk_userid 认人）。JSAPI 只在钉钉里才按需从钉钉官方 CDN 加载，普通浏览器不加载。
// 先用新接口 dd.requestAuthCode（客户端 6.0+），不行退回老的 runtime.permission.requestAuthCode。
// 没关联钉钉 / 失败：落到账号密码页、写明原因，页上有「用钉钉登录」能再点。本次打开里点过退出就不再自动登。

const DD_JS = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.2.9/dingtalk.open.js'
const DD_OFF_KEY = 'h5_dd_sso_off'
let ddError = ''
let ddPending = false

function inDingTalk() {
  return typeof navigator !== 'undefined' && /DingTalk/i.test(navigator.userAgent || '')
}

function ddAutoOff() {
  try { return sessionStorage.getItem(DD_OFF_KEY) === '1' } catch (e) { return false }
}

function setDdAutoOff(off) {
  try {
    if (off) sessionStorage.setItem(DD_OFF_KEY, '1')
    else sessionStorage.removeItem(DD_OFF_KEY)
  } catch (e) { /* 存不了就算了 */ }
}

function loadDd() {
  if (window.dd && window.dd.runtime) return Promise.resolve(window.dd)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = DD_JS
    s.onload = () => (window.dd ? resolve(window.dd) : reject(new Error('钉钉组件没加载上')))
    s.onerror = () => reject(new Error('钉钉组件没加载上，检查网络'))
    document.head.appendChild(s)
  })
}

function codeOf(res) {
  return (res && (res.code || res.authCode)) || ''
}

function ddAuthCode(cfg) {
  return loadDd().then((dd) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('钉钉没有响应')), 10000)
    const ok = (code) => { clearTimeout(timer); resolve(code) }
    const fail = (err) => {
      clearTimeout(timer)
      reject(new Error((err && (err.errorMessage || err.message)) || '钉钉没给授权码'))
    }
    const legacy = () => Promise.resolve(dd.runtime.permission.requestAuthCode({ corpId: cfg.corp_id }))
      .then((res) => (codeOf(res) ? ok(codeOf(res)) : fail()))
      .catch(fail)
    dd.ready(() => {
      if (typeof dd.requestAuthCode === 'function' && cfg.client_id) {
        Promise.resolve(dd.requestAuthCode({ clientId: cfg.client_id, corpId: cfg.corp_id }))
          .then((res) => (codeOf(res) ? ok(codeOf(res)) : legacy()))
          .catch(legacy)
      } else {
        legacy()
      }
    })
    if (typeof dd.error === 'function') dd.error(fail)
  }))
}

/** 登录页用：在钉钉里打开的，给「用钉钉登录」按钮；上次免登失败的原因 */
function dingtalkState() {
  // 登录页可能比 onLaunch 里的自动免登先打开：没令牌、这次还没试过也算「正在登」
  const auto = inDingTalk() && !wx.getStorageSync('token') && !ddAutoOff() && !ddError
  return { available: inDingTalk(), error: ddError, pending: ddPending || auto }
}

function loginWithDingtalk(app) {
  ddError = ''
  ddPending = true
  return request({ url: '/api/auth/dingtalk-config', _noAuthRedirect: true })
    .then((cfg) => {
      if (!cfg || !cfg.enabled) throw new Error('钉钉免登还没开通，请用账号密码登录')
      return ddAuthCode(cfg)
    })
    .then((code) => request({
      url: '/api/auth/dingtalk-login',
      method: 'POST',
      data: { code },
      _noAuthRedirect: true,
    }))
    .then((data) => {
      redirecting = false
      setDdAutoOff(false)
      applySession(data, app)
      return data
    })
    .catch((err) => {
      ddError = (err && (err.detail || err.message)) || '钉钉登录没成功'
      throw err
    })
    .finally(() => { ddPending = false })
}

function bootstrap(app) {
  if (bootPromise) return bootPromise
  if (!wx.getStorageSync('token') && inDingTalk() && !ddAutoOff() && !takeEntryTokenPeek()) {
    bootPromise = loginWithDingtalk(app)
      .then(() => {
        bootPromise = null
        leaveLoginPage()
        return { dingtalk: true }
      })
      .catch(() => {
        bootPromise = null
        setDdAutoOff(true) // 这次打开里不再自动试，登录页上能手动点
        clearSession(app)
        wx.reLaunch({ url: `/${LOGIN_ROUTE}` })
        return { needs_login: true }
      })
    return bootPromise
  }
  const entryToken = takeEntryToken()
  if (entryToken) {
    bootPromise = enterFromWorkbench(entryToken, app).then((how) => {
      bootPromise = null
      if (how === 'in') {
        leaveLoginPage()
        return { workbench: true }
      }
      if (how === 'confirm') {
        // 登录页这时多半已经开着（它是首页），重开一次它才会进「确认本人」
        wx.reLaunch({ url: `/${LOGIN_ROUTE}` })
        return { needs_login: true }
      }
      return bootstrap(app)
    })
    return bootPromise
  }
  const token = wx.getStorageSync('token')
  if (!token) {
    clearSession(app)
    gotoLoginPage()
    return Promise.resolve({ needs_login: true })
  }
  bootPromise = api.me()
    .then((data) => {
      applySession({ token, staff: data.staff, tabs: data.tabs, landing_page: data.landing_page }, app)
      leaveLoginPage()
      renewToken()
      renewRemember(data.staff)
      return data
    })
    .catch((err) => {
      if (err && err.statusCode === 403) {
        clearSession(app)
        wx.showToast({ title: err.detail || '账号已停用', icon: 'none' })
        gotoLoginPage()
        return { needs_login: true }
      }
      if (err && err.statusCode === 401) return { needs_login: true } // request.js 已经送回登录页
      // 断网 / 服务器不通：用上次的会话先进，接口会各自报错
      const cached = wx.getStorageSync(SESSION_KEY)
      if (cached && cached.staff) {
        setGlobals(cached, app)
        return { cached: true }
      }
      throw err
    })
    .finally(() => {
      bootPromise = null
    })
  return bootPromise
}

function ensureLogin() {
  const token = wx.getStorageSync('token')
  if (token && getApp().globalData.user) return Promise.resolve(getApp().globalData)
  return bootstrap()
}

function login(username, password) {
  return request({
    url: '/api/auth/h5-login',
    method: 'POST',
    data: { username, password },
    _noAuthRedirect: true,
  }).then((data) => {
    redirecting = false
    applySession(data)
    return data
  })
}

function logout() {
  clearSession()
  setDdAutoOff(true) // 在钉钉里点了退出：这次打开里别马上又自动登回去
  gotoLoginPage()
  return Promise.resolve()
}

function changePassword(oldPassword, newPassword) {
  return api.changePassword({
    old_password: oldPassword,
    new_password: newPassword,
  }).then(() => {
    // 改了密码，服务端那张记住的凭证已经作废，本地也别留着
    forgetDevice()
    return logout()
  })
}

// ---------------------------------------------------------------- 记住密码
// 本地存的不是密码，是服务端发的一张「记住登录」凭证（30 天，改密码即作废，见
// server/app/services/remember_login.py）。一台设备只记一个账号。退出登录不清它——
// 记住密码的意义就是退出之后下次点一下就能进；改密码、登录时取消勾选才清。

function rememberedAccount() {
  const r = wx.getStorageSync(REMEMBER_KEY)
  return r && r.token && r.username ? { username: r.username } : null
}

function forgetDevice() {
  wx.removeStorageSync(REMEMBER_KEY)
}

/** 登录成功后、勾着「记住密码」时调。要不到凭证（断网之类）就算了，不挡登录。 */
function rememberDevice(username) {
  return request({ url: '/api/auth/h5-remember', method: 'POST', _noAuthRedirect: true })
    .then((data) => {
      if (data && data.remember_token) {
        wx.setStorageSync(REMEMBER_KEY, { username, token: data.remember_token, at: Date.now() })
      }
    })
    .catch(() => {})
}

/** 每天续一次，常用的人记住的凭证不会过期 */
function renewRemember(staff) {
  const r = wx.getStorageSync(REMEMBER_KEY)
  if (!r || !r.token || !staff) return
  if (String(r.username).toLowerCase() !== String(staff.username || '').toLowerCase()) return
  if (Date.now() - (r.at || 0) < 86400000) return
  rememberDevice(r.username)
}

/** 登录页「已记住密码」直接点登录 */
function loginWithRemembered() {
  const r = wx.getStorageSync(REMEMBER_KEY)
  if (!r || !r.token) return Promise.reject({ statusCode: 401, detail: '记住的密码已失效，请重新输入' })
  return request({
    url: '/api/auth/h5-remember-login',
    method: 'POST',
    data: { remember_token: r.token },
    _noAuthRedirect: true,
  }).then((data) => {
    redirecting = false
    applySession(data)
    return data
  })
}

function logoutExpired() {
  if (redirecting) return
  redirecting = true
  const hadToken = !!wx.getStorageSync('token')
  clearSession()
  if (hadToken) wx.showToast({ title: '登录过期了，请重新登录', icon: 'none' })
  gotoLoginPage()
  setTimeout(() => { redirecting = false }, 1500)
}

let verifying = null

/**
 * request.js 收到 401 时调。某个接口回 401 不一定是登录失效（小程序那边 401 会静默重登，
 * 掩盖了这类情况），所以先拿 /api/auth/me 再问一次，确实失效才回登录页；并发的 401 只问一次。
 */
function handleUnauthorized(url) {
  if (redirecting) return
  const token = wx.getStorageSync('token')
  if (!token) {
    gotoLoginPage()
    return
  }
  if (url === '/api/auth/me') {
    logoutExpired()
    return
  }
  if (verifying) return
  verifying = request({ url: '/api/auth/me', _noAuthRedirect: true })
    .catch((err) => {
      if (err && err.statusCode === 401 && wx.getStorageSync('token') === token) logoutExpired()
    })
    .finally(() => { verifying = null })
}

function wxLogin() {
  return Promise.reject(new Error('H5 不支持微信登录'))
}

module.exports = {
  bootstrap,
  ensureLogin,
  pendingWorkbenchConfirm,
  confirmWorkbench,
  login,
  bind: login,
  submitCredentials: login,
  gotoLanding,
  wxLogin,
  logout,
  changePassword,
  handleUnauthorized,
  rememberedAccount,
  rememberDevice,
  forgetDevice,
  loginWithRemembered,
  dingtalkState,
  loginWithDingtalk,
  isDev: false,
  isTest: false,
}
