import { pwa, promptInstall } from '../../../pwa/state.js'

const auth = require('@services/auth')

const LAST_USERNAME_KEY = 'h5_last_username'
// 「记住密码」勾没勾：记的是这台设备上的人上一次的选择，第一次默认勾上
const REMEMBER_PREF_KEY = 'h5_remember_pref'

function errorText(err) {
  if (err && typeof err.detail === 'string' && err.detail) return err.detail
  return '登录失败'
}

Page({
  data: {
    username: '',
    password: '',
    showPassword: false,
    submitting: false,
    canInstall: false,
    remember: true,
    // 这台设备记住了这个账号：密码框留空、显示「已记住密码」，直接点登录
    remembered: false,
    // 从员工工作台第一次进来：账号是工作台绑定的那个，只输密码确认本人
    confirm: false,
    // 在钉钉里打开：「用钉钉登录」；ddPending 正在自动免登，ddError 没登上的原因
    ddAvailable: false,
    ddPending: false,
    ddError: '',
  },

  onLoad() {
    const dd = auth.dingtalkState()
    this.setData({ ddAvailable: dd.available, ddPending: dd.pending, ddError: dd.error })
    const pending = auth.pendingWorkbenchConfirm()
    if (pending) {
      this.setData({ confirm: true, username: pending.username, remembered: false })
      return
    }
    const acc = auth.rememberedAccount()
    const pref = wx.getStorageSync(REMEMBER_PREF_KEY)
    this.setData({
      username: (acc && acc.username) || wx.getStorageSync(LAST_USERNAME_KEY) || '',
      remembered: !!acc,
      remember: pref === '' ? true : !!pref,
    })
  },

  onShow() {
    // 已经从桌面图标打开的不再提示安装
    this.setData({ canInstall: !pwa.standalone })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const patch = { [key]: e.detail.value }
    if (this.data.remembered) {
      const acc = auth.rememberedAccount()
      // 改成了别的账号、或者开始自己输密码：不再用记住的那份
      if (key === 'password' || !acc || e.detail.value.trim().toLowerCase() !== acc.username.toLowerCase()) {
        patch.remembered = false
      }
    }
    this.setData(patch)
  },

  onPasswordFocus() {
    if (this.data.remembered) this.setData({ remembered: false, password: '' })
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword })
  },

  toggleRemember() {
    const remember = !this.data.remember
    wx.setStorageSync(REMEMBER_PREF_KEY, remember)
    const patch = { remember }
    if (!remember && this.data.remembered) {
      auth.forgetDevice()
      patch.remembered = false
    }
    this.setData(patch)
  },

  onSubmit() {
    if (this.data.submitting) return
    if (this.data.confirm) {
      this.confirmWorkbench()
      return
    }
    const username = (this.data.username || '').trim()
    const password = this.data.password || ''
    const useRemembered = this.data.remembered
    if (!username) {
      wx.showToast({ title: '请输入账号', icon: 'none' })
      return
    }
    if (!useRemembered && !password) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const login = useRemembered ? auth.loginWithRemembered() : auth.submitCredentials(username, password)
    login.then((data) => {
      const name = (data && data.staff && data.staff.username) || username
      wx.setStorageSync(LAST_USERNAME_KEY, name)
      // 一台设备只记一个账号：勾着就换一张新凭证（顺带续期），没勾就清掉
      if (this.data.remember) return auth.rememberDevice(name)
      auth.forgetDevice()
      return null
    }).then(() => {
      this.setData({ submitting: false, password: '' })
      auth.gotoLanding()
    }).catch((err) => {
      this.setData({ submitting: false })
      if (useRemembered && err && (err.statusCode === 401 || err.statusCode === 403)) {
        auth.forgetDevice()
        this.setData({ remembered: false, password: '' })
      }
      wx.showToast({ title: errorText(err), icon: 'none' })
    })
  },

  confirmWorkbench() {
    if (!this.data.password) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    auth.confirmWorkbench(this.data.password).then(() => {
      this.setData({ submitting: false, password: '' })
      auth.gotoLanding()
    }).catch((err) => {
      this.setData({ submitting: false })
      wx.showToast({ title: errorText(err), icon: 'none' })
    })
  },

  onDingtalk() {
    if (this.data.submitting) return
    this.setData({ submitting: true, ddError: '' })
    auth.loginWithDingtalk().then(() => {
      this.setData({ submitting: false })
      auth.gotoLanding()
    }).catch(() => {
      this.setData({ submitting: false, ddError: auth.dingtalkState().error })
    })
  },

  onInstall() {
    if (pwa.canInstall) {
      promptInstall()
      return
    }
    wx.showModal({
      title: '添加到桌面',
      content: pwa.ios
        ? '用 Safari 打开本页，点底部的分享按钮，选「添加到主屏幕」。'
        : '点浏览器右上角的菜单，选「添加到主屏幕」或「安装应用」。',
      showCancel: false,
      confirmText: '知道了',
    })
  },
})
