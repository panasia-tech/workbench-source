const api = require('@services/api')
const { sanitizeDecimal } = require('@utils/money')

Page({
  data: {
    skuCode: '',
    detail: {},
    form: {
      suggest_price: '',
      remark: '',
      evidence: [],
      need_transfer: false,
    },
    evidenceDisplayUrls: [],
    // 转账功能暂未实现，先放开关但默认隐藏，待功能上线后改为 true
    showTransferSwitch: false,
    submitting: false,
  },

  onLoad(options) {
    const skuCode = options.code || ''
    this.setData({ skuCode })
    if (skuCode) this.loadDetail(skuCode)
  },

  loadDetail(code) {
    api.getNegotiation(code)
      .then((detail) => {
        this.setData({
          detail,
          'form.suggest_price': detail.cost_price != null ? String(detail.cost_price) : '',
          'form.remark': detail.negotiation_remark || '',
        })
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  addEvidence() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: (res) => {
        const uploads = res.tempFiles.map((f) => {
          const ext = f.fileType === 'video' ? '.mp4' : '.jpg'
          return api.uploadMedia('negotiation/evidence/', `${Date.now()}${ext}`, f.tempFilePath)
        })
        Promise.all(uploads).then((results) => {
          const urls = results.map((r) => r.public_url)
          const displayUrls = results.map((r) => r.access_url || r.public_url)
          this.setData({
            'form.evidence': [...this.data.form.evidence, ...urls],
            evidenceDisplayUrls: [...this.data.evidenceDisplayUrls, ...displayUrls],
          })
        }).catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
      },
    })
  },

  removeEvidence(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    const evidence = this.data.form.evidence.slice()
    const displayUrls = this.data.evidenceDisplayUrls.slice()
    evidence.splice(index, 1)
    displayUrls.splice(index, 1)
    this.setData({ 'form.evidence': evidence, evidenceDisplayUrls: displayUrls })
  },

  onTransferChange(e) {
    this.setData({ 'form.need_transfer': !!e.detail.value })
  },

  onPriceInput(e) {
    this.setData({ 'form.suggest_price': sanitizeDecimal(e.detail.value) })
  },

  onRemarkInput(e) {
    this.setData({ 'form.remark': e.detail.value })
  },

  onSubmit() {
    if (this.data.submitting) return
    const price = Number(this.data.form.suggest_price)
    if (!price || price <= 0) {
      wx.showToast({ title: '请填写有效价格', icon: 'none' })
      return
    }
    if (!this.data.form.evidence.length) {
      wx.showToast({ title: '请上传议价证据', icon: 'none' })
      return
    }
    const remark = (this.data.form.remark || '').trim()
    if (!remark) {
      wx.showToast({ title: '请填写备注', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.submitNegotiation(this.data.skuCode, {
      suggest_price: price,
      remark,
      evidence: this.data.form.evidence,
      need_transfer: !!this.data.form.need_transfer,
    })
      .then(() => {
        wx.showToast({ title: '已提交，待召回快递', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
