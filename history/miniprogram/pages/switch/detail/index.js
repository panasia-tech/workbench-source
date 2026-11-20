const api = require('@services/api')
const { sanitizeDecimal } = require('@utils/money')

Page({
  data: { order: null, depositAmount: '', finalAmount: '' },

  onLoad(options) {
    this.orderId = options.id
    this.load()
  },

  load() {
    api.getSwitch(this.orderId).then((order) => {
      this.setData({ order, depositAmount: order.deposit_amount ? String(order.deposit_amount) : '', finalAmount: order.final_amount ? String(order.final_amount) : '' })
    })
  },

  onDepositInput(e) { this.setData({ depositAmount: sanitizeDecimal(e.detail.value) }) },
  onFinalInput(e) { this.setData({ finalAmount: sanitizeDecimal(e.detail.value) }) },

  payDeposit() {
    if (!this.data.depositAmount) {
      wx.showToast({ title: '填写定金', icon: 'none' })
      return
    }
    api.switchDeposit(this.orderId, { deposit_amount: Number(this.data.depositAmount), evidence_urls: [] }).then(() => {
      wx.showToast({ title: '已登记定金' })
      this.load()
    })
  },

  payFinal() {
    if (!this.data.finalAmount) {
      wx.showToast({ title: '填写尾款', icon: 'none' })
      return
    }
    api.switchFinal(this.orderId, { final_amount: Number(this.data.finalAmount), evidence_urls: [] }).then(() => {
      wx.showToast({ title: '已登记尾款' })
      this.load()
    })
  },

  applyCutoff() {
    api.switchApplyCutoff(this.orderId, {}).then(() => {
      wx.showToast({ title: '已申请截单' })
      this.load()
    })
  },

  cancelOrder() {
    wx.showModal({
      title: '取消切单',
      content: '确定取消并释放库存？',
      success: (res) => {
        if (res.confirm) {
          api.switchCancel(this.orderId).then(() => {
            wx.showToast({ title: '已取消' })
            wx.navigateBack()
          })
        }
      },
    })
  },
})
