const auth = require('@services/auth')

Page({
  data: {
    username: auth.isDev ? 'admin' : '',
    password: auth.isDev ? 'admin123' : '',
    showPassword: false,
    isDev: auth.isDev,
    pageTitle: auth.isDev ? '员工登录' : '绑定员工账号',
    pageSub: auth.isDev ? '开发环境：请输入账号密码登录' : '绑定员工账号后即可使用',
    submitText: auth.isDev ? '登录' : '绑定并进入',
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: auth.isDev ? '员工登录' : '账号绑定' })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword })
  },

  onSubmit() {
    const { username, password } = this.data
    if (!username || !password) {
      wx.showToast({ title: '请输入账号密码', icon: 'none' })
      return
    }
    auth.submitCredentials(username, password).then(() => {
      auth.gotoLanding()
    }).catch((err) => {
      const fallback = auth.isDev ? '登录失败' : '绑定失败'
      wx.showToast({ title: err.detail || fallback, icon: 'none' })
    })
  },
})
