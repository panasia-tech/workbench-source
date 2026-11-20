const auth = require('@services/auth')

const MIN_LEN = 6

Page({
  data: {
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    showOld: false,
    showNew: false,
    showConfirm: false,
    submitting: false,
  },

  onShow() {
    auth.ensureLogin()
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  togglePassword(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: !this.data[field] })
  },

  onSubmit() {
    const { oldPassword, newPassword, confirmPassword } = this.data
    if (!oldPassword || !newPassword || !confirmPassword) {
      wx.showToast({ title: '请填写完整', icon: 'none' })
      return
    }
    if (newPassword.length < MIN_LEN) {
      wx.showToast({ title: `新密码至少 ${MIN_LEN} 位`, icon: 'none' })
      return
    }
    if (newPassword !== confirmPassword) {
      wx.showToast({ title: '两次新密码不一致', icon: 'none' })
      return
    }
    if (oldPassword === newPassword) {
      wx.showToast({ title: '新密码不能与原密码相同', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    auth.changePassword(oldPassword, newPassword)
      .then(() => {
        wx.showToast({ title: '密码已修改', icon: 'success' })
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '修改失败', icon: 'none' })
      })
      .finally(() => {
        this.setData({ submitting: false })
      })
  },
})
