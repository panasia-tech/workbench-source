const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

Page({
  data: {
    orderId: '',
    order: null,
    skuCode: '',
    match: null,
    matchError: '',
    trackingNo: '',
    trackingPhoneSuffix: '',
    deliveryMode: 'express',
    submitting: false,
    standalonePickup: false,
    _checkTimer: null,
  },

  onLoad(options) {
    const orderId = options.id || ''
    const skuCode = options.sku ? decodeURIComponent(options.sku) : ''
    const deliveryMode = options.pickup === '1' ? 'pickup' : 'express'
    this.setData({ orderId, skuCode, deliveryMode, standalonePickup: !orderId && !!skuCode })

    if (!orderId) return

    api.getSaleOrder(orderId).then((order) => {
      this.setData({
        order,
        trackingNo: order.tracking_no || '',
        trackingPhoneSuffix: order.tracking_phone_suffix || '',
      })
      if (skuCode) this.checkSku()
    }).catch(() => {
      wx.showToast({ title: '订单加载失败', icon: 'none' })
    })
  },

  onDeliveryMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (!mode || mode === this.data.deliveryMode) return
    this.setData({ deliveryMode: mode })
  },

  onSkuInput(e) {
    const skuCode = e.detail.value
    this.setData({ skuCode, match: null, matchError: '' })
    if (this.data._checkTimer) clearTimeout(this.data._checkTimer)
    const timer = setTimeout(() => {
      if (skuCode.trim()) this.checkSku()
    }, 400)
    this.setData({ _checkTimer: timer })
  },

  onTrackingInput(e) {
    this.setData({ trackingNo: e.detail.value })
  },

  onPhoneSuffixInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4)
    this.setData({ trackingPhoneSuffix: digits })
  },

  scanSku() {
    scanBarcode()
      .then((code) => {
        this.setData({ skuCode: code, match: null, matchError: '' })
        return this.checkSku()
      })
      .catch(() => {})
  },

  checkSku() {
    const { orderId, skuCode } = this.data
    const code = (skuCode || '').trim()
    if (!code || !orderId) return Promise.resolve()
    return api.matchSaleSku(orderId, code)
      .then((match) => {
        this.setData({ match, matchError: '' })
      })
      .catch((err) => {
        this.setData({
          match: null,
          matchError: err.detail || '未匹配到在库商品',
        })
      })
  },

  goPickupForm() {
    const code = (this.data.skuCode || '').trim()
    wx.redirectTo({
      url: `/pages/sales/outbound/index?type=PICKUP${code ? `&code=${encodeURIComponent(code)}` : ''}`,
    })
  },

  confirmShip() {
    const { order, match, trackingNo, trackingPhoneSuffix, orderId, submitting, deliveryMode } = this.data
    if (submitting || !order || !match) return

    const tracking = (trackingNo || '').trim()
    const phoneSuffix = (trackingPhoneSuffix || '').replace(/\D/g, '').slice(0, 4)
    if (deliveryMode === 'express' && !tracking) {
      wx.showToast({ title: '请填写快递运单号', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    api.outboundScan({
      sku_code: match.sku_code,
      buyer_name: order.buyer_name,
      sale_price: Number(order.amount),
      outbound_type: 'ORDER_SHIP',
      sale_order_id: orderId,
      tracking_no: deliveryMode === 'express' ? tracking : null,
      tracking_phone_suffix: deliveryMode === 'express' && phoneSuffix ? phoneSuffix : null,
    })
      .then(() => {
        wx.showToast({ title: '发货成功' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '发货失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
