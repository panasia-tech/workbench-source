const api = require('@services/api')

Page({
  data: {
    order: null,
    expressResult: null,
    expressLoading: false,
  },

  onLoad(options) {
    const id = options.id
    if (!id) return
    api.getSaleOrder(id).then((order) => {
      this.setData({ order })
      if (order.tracking_no) this.loadExpress(false)
    }).catch(() => {
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  loadExpress(refresh) {
    const no = this.data.order && this.data.order.tracking_no
    if (!no) return
    this.setData({ expressLoading: true })
    const phone = (this.data.order && this.data.order.tracking_phone_suffix) || ''
    api.trackExpress(no.trim(), { refresh, phone })
      .then((expressResult) => {
        this.setData({ expressResult, expressLoading: false })
      })
      .catch((err) => {
        this.setData({ expressLoading: false })
        wx.showToast({ title: (err && err.detail) || '查询失败', icon: 'none' })
      })
  },

  refreshExpress() {
    this.loadExpress(true)
  },

  goShip() {
    const { order } = this.data
    if (!order) return
    wx.navigateTo({ url: `/pages/sales/ship/index?id=${order.id}` })
  },
})
