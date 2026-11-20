const auth = require('@services/auth')
const api = require('@services/api')

Page({
  data: {
    erpOrders: [],
    ordersLoading: false,
  },

  onShow() {
    auth.ensureLogin().then(() => this.reload())
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  reload() {
    return this.loadErpOrders()
  },

  loadErpOrders() {
    this.setData({ ordersLoading: true })
    return api
      .listSales({ status: 'PENDING', page: 1, size: 50 })
      .then((res) => {
        this.setData({
          erpOrders: res.items || [],
          ordersLoading: false,
        })
      })
      .catch(() => {
        this.setData({ ordersLoading: false })
        wx.showToast({ title: '订单加载失败', icon: 'none' })
      })
  },

  openShip(e) {
    const { id, sku } = e.currentTarget.dataset
    if (!id) return
    const q = [`id=${id}`, sku ? `sku=${encodeURIComponent(sku)}` : ''].filter(Boolean).join('&')
    wx.navigateTo({ url: `/pages/sales/ship/index?${q}` })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/sales/records/index' })
  },

  goPickupRecords() {
    wx.navigateTo({ url: '/pages/sales/pickup-records/index' })
  },

  goPickup() {
    wx.navigateTo({ url: '/pages/sales/outbound/index?type=PICKUP' })
  },

  goManualSale() {
    wx.navigateTo({ url: '/pages/sales/manual-sale/index' })
  },

  goSwitchList() {
    wx.navigateTo({ url: '/pages/switch/list/index' })
  },
})
