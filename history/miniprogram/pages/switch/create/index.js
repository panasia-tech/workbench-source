const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { sanitizeMoneyField } = require('@utils/money')

Page({
  data: {
    form: { sku_code: '', unit_price: '', remark: '', evidence_urls: [] },
    evidenceDisplayUrls: [],
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

  addEvidence() {
    wx.chooseMedia({
      count: 3,
      mediaType: ['image'],
      success: (res) => {
        const urls = [...this.data.form.evidence_urls]
        const displayUrls = [...this.data.evidenceDisplayUrls]
        res.tempFiles.forEach((file) => {
          api.uploadMedia('sales/evidence/', `${Date.now()}.jpg`, file.tempFilePath).then((result) => {
            urls.push(result.public_url)
            displayUrls.push(result.access_url || result.public_url)
            this.setData({ 'form.evidence_urls': urls, evidenceDisplayUrls: displayUrls })
          }).catch(() => {
            wx.showToast({ title: '上传失败', icon: 'none' })
          })
        })
      },
    })
  },

  submit() {
    const f = this.data.form
    if (!f.sku_code || !f.unit_price) {
      wx.showToast({ title: '货号和单价必填', icon: 'none' })
      return
    }
    api.createSwitch({
      sku_code: f.sku_code,
      unit_price: Number(f.unit_price),
      remark: f.remark || null,
      evidence_urls: f.evidence_urls,
    }).then(() => {
      wx.showToast({ title: '已创建' })
      wx.navigateBack()
    })
  },
})
