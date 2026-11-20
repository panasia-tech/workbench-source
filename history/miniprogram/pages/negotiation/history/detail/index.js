const auth = require('@services/auth')
const api = require('@services/api')

Page({
  data: {
    skuCode: '',
    detail: {},
    // 议价幅度：dir 用于上色（down=降价/up=涨价），absText 为不含符号的金额
    priceDiff: null,
    loading: false,
  },

  onLoad(options) {
    const skuCode = options.code || ''
    this.setData({ skuCode })
    if (skuCode) {
      auth.ensureLogin().then(() => this.loadDetail(skuCode))
    }
  },

  loadDetail(code) {
    this.setData({ loading: true })
    api.getNegotiationHistory(code)
      .then((detail) => {
        let priceDiff = null
        if (detail.old_cost != null && detail.final_price != null) {
          const raw = Number(detail.final_price) - Number(detail.old_cost)
          priceDiff = {
            dir: raw < 0 ? 'down' : (raw > 0 ? 'up' : 'flat'),
            sign: raw > 0 ? '+' : (raw < 0 ? '-' : ''),
            abs: Math.abs(raw),
          }
        }
        this.setData({ detail, priceDiff, loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },
})
