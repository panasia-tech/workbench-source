const api = require('./api')
const appConfig = require('./config')
const { isDev, isTest } = require('../config/env')

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) return reject(new Error('wx.login 失败'))
        api.wxLogin(res.code).then(resolve).catch(reject)
      },
      fail: reject,
    })
  })
}

function resolveApp(app) {
  return app || getApp()
}

function applySession(data, app) {
  const instance = resolveApp(app)
  if (data.token) wx.setStorageSync('token', data.token)
  instance.globalData.user = data.staff
  instance.globalData.tabs = data.tabs || []
  instance.globalData.landingPage = data.landing_page || ''
  appConfig.refreshConfig()
}

function gotoLoginPage() {
  const pages = getCurrentPages()
  const route = pages.length ? pages[pages.length - 1].route : ''
  if (route === 'pages/bind/index') return
  wx.reLaunch({ url: '/pages/bind/index' })
}

function bootstrapDev(app) {
  clearSession(app)
  gotoLoginPage()
  return Promise.resolve({ needs_login: true })
}

function leaveLoginPage() {
  const pages = getCurrentPages()
  const route = pages.length ? pages[pages.length - 1].route : ''
  // 静默登录成功时，若还停在登录/绑定页（入口页），跳去工作台
  if (!pages.length || route === 'pages/bind/index') {
    gotoLanding()
  }
}

function bootstrapTest(app) {
  return wxLogin().then((data) => {
    if (data.needs_bind) {
      gotoLoginPage()
      return data
    }
    applySession(data, app)
    leaveLoginPage()
    return data
  }).catch(() => {
    gotoLoginPage()
  })
}

function bootstrap(app) {
  if (isDev) return bootstrapDev(app)
  return bootstrapTest(app)
}

function ensureLogin() {
  const token = wx.getStorageSync('token')
  if (token && getApp().globalData.user) {
    return Promise.resolve(getApp().globalData)
  }
  return bootstrap()
}

function login(username, password) {
  return api.devLogin({ username, password }).then((data) => {
    applySession(data)
    return data
  })
}

function bind(username, password) {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        api.bind({ username, password, code: res.code }).then((data) => {
          applySession(data)
          resolve(data)
        }).catch(reject)
      },
      fail: reject,
    })
  })
}

function submitCredentials(username, password) {
  if (isDev) return login(username, password)
  return bind(username, password)
}

function clearSession(app) {
  const instance = resolveApp(app)
  wx.removeStorageSync('token')
  instance.globalData.user = null
  instance.globalData.tabs = []
  instance.globalData.landingPage = ''
}

function logout() {
  if (isDev) {
    clearSession()
    gotoLoginPage()
    return Promise.resolve()
  }
  return api.logout().catch(() => {}).finally(() => {
    clearSession()
    gotoLoginPage()
  })
}

function changePassword(oldPassword, newPassword) {
  return api.changePassword({
    old_password: oldPassword,
    new_password: newPassword,
  }).then(() => logout())
}

function gotoLanding() {
  const page = getApp().globalData.landingPage || 'pages/profile/index'
  wx.switchTab({ url: `/${page}` })
}

module.exports = {
  bootstrap,
  ensureLogin,
  login,
  bind,
  submitCredentials,
  gotoLanding,
  wxLogin,
  logout,
  changePassword,
  isDev,
  isTest,
}
