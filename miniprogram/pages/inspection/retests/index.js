// 补测待办：已提交但仍有「无法测试」项的验货单，点进去补测成通过/不通过（WH03-08）
const auth = require('@services/auth')
const { request } = require('@services/request')

Page({
  data: {
    list: [],
    loading: false,
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return request({ url: '/api/inspection-ops/retests' })
      .then((res) => {
        this.setData({ list: res.items || [], loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/inspection/check/index?id=${id}` })
  },
})
