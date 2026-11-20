const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { sanitizeMoneyField } = require('@utils/money')

Page({
  data: {
    form: { sku_code: '', buyer_name: '', sale_price: '', outbound_type: 'MANUAL', tracking_no: '', platform_fee: '', remark: '' },
    submitting: false,
  },

  onLoad(options) {
    this.setData({
      'form.sku_code': options.code || '',
      'form.outbound_type': options.type || 'MANUAL',
    })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`form.${key}`]: sanitizeMoneyField(key, e.detail.value) })
  },

  scanSku() {
    scanBarcode()
      .then((code) => this.setData({ 'form.sku_code': code }))
      .catch(() => {})
  },

  submit() {
    if (this.data.submitting) return
    const f = this.data.form
    if (!f.sku_code || !f.sale_price) {
      wx.showToast({ title: '货号和售价必填', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const payload = { ...f, sale_price: Number(f.sale_price), platform_fee: f.platform_fee === '' ? null : Number(f.platform_fee) }
    const req = f.outbound_type === 'ORDER_SHIP' ? api.outboundScan(payload) : api.outboundManual(payload)
    req
      .then(() => {
        wx.showToast({ title: '出库成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => {
        // 之前漏了 catch：后端报错(如「商品不在库或不可出库」)被吞掉，按钮看起来没反应
        wx.showToast({ title: (err && err.detail) || '出库失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
