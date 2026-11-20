const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { sanitizeMoneyField } = require('@utils/money')

Page({
  data: {
    form: {
      sku_code: '',
      sale_price: '',
      transaction_type: 'PLATFORM', // PLATFORM 平台交易 | PICKUP 自提
      worry_free: false, // 平台交易：是否无忧卖（off=普通1.6% / on=无忧2.6%）
      shop_name: '',
      buyer_name: '',
      buyer_phone: '',
      tracking_no: '',
      express_fee: '',
      platform_fee: '',
      remark: '',
      evidence_urls: [],
    },
    evidenceDisplayUrls: [],
    sku: null,
    skuLoading: false,
    skuError: '',
    submitting: false,
    shops: [],
    shopLabels: [],
    shopIndex: -1,
  },

  onLoad(options) {
    this.loadShops()
    if (options.code) {
      this.setData({ 'form.sku_code': options.code })
      this.lookupSku(options.code, { fillPrice: true })
    }
  },

  loadShops() {
    api.saleShops()
      .then((list) => {
        const shops = list || []
        this.setData({ shops, shopLabels: shops.map((s) => s.label || s.code) })
      })
      .catch(() => {
        wx.showToast({ title: '店铺列表加载失败', icon: 'none' })
      })
  },

  onShopChange(e) {
    const idx = Number(e.detail.value)
    const shop = this.data.shops[idx]
    this.setData({ shopIndex: idx, 'form.shop_name': shop ? (shop.label || shop.code) : '' })
  },

  pickTransactionType(e) {
    const t = e.currentTarget.dataset.type
    if (!t || t === this.data.form.transaction_type) return
    this.setData({ 'form.transaction_type': t })
  },

  onWorryFreeChange(e) {
    this.setData({ 'form.worry_free': !!e.detail.value })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const value = sanitizeMoneyField(key, e.detail.value)
    this.setData({ [`form.${key}`]: value })
    if (key === 'sku_code' && this.data.sku && this.data.sku.sku_code !== value.trim()) {
      this.setData({ sku: null, skuError: '' })
    }
  },

  onCodeBlur(e) {
    const code = (e.detail.value || '').trim()
    if (code) this.lookupSku(code, { fillPrice: !this.data.form.sale_price })
  },

  onPhoneInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 11)
    this.setData({ 'form.buyer_phone': digits })
  },

  lookupSku(code, { fillPrice = false } = {}) {
    const sku_code = (code || '').trim()
    if (!sku_code) return
    if (this.data.sku && this.data.sku.sku_code === sku_code) return
    this.setData({ skuLoading: true, skuError: '' })
    api.skuDetail(sku_code)
      .then((sku) => {
        const patch = { sku, skuLoading: false }
        if (fillPrice && sku.suggest_price) {
          patch['form.sale_price'] = String(sku.suggest_price)
        }
        this.setData(patch)
      })
      .catch((err) => {
        this.setData({ sku: null, skuLoading: false, skuError: err.detail || '未找到该货号对应的商品' })
      })
  },

  goSkuDetail() {
    const sku = this.data.sku
    if (!sku) return
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${sku.sku_code}` })
  },

  scanSku() {
    scanBarcode()
      .then((code) => {
        this.setData({ 'form.sku_code': code })
        this.lookupSku(code, { fillPrice: !this.data.form.sale_price })
      })
      .catch(() => {})
  },

  uploadEvidence() {
    const remain = 3 - this.data.form.evidence_urls.length
    if (remain <= 0) {
      wx.showToast({ title: '最多 3 个凭证', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image', 'video'],
      success: (res) => {
        const urls = [...this.data.form.evidence_urls]
        const displayUrls = [...this.data.evidenceDisplayUrls]
        res.tempFiles.forEach((file, i) => {
          const ext = file.fileType === 'video' ? '.mp4' : '.jpg'
          api.uploadMedia('sales/evidence/', `${Date.now()}_${i}${ext}`, file.tempFilePath).then((result) => {
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
    if (!f.sku_code.trim()) {
      wx.showToast({ title: '请扫码或填写货号', icon: 'none' })
      return
    }
    if (!this.data.sku) {
      wx.showToast({ title: '请先查到对应商品再提交', icon: 'none' })
      return
    }
    if (!f.sale_price || Number(f.sale_price) <= 0) {
      wx.showToast({ title: '请填写正确成交价', icon: 'none' })
      return
    }
    // 自提无平台店铺，成交店铺仅平台交易必填
    if (f.transaction_type === 'PLATFORM' && !(f.shop_name || '').trim()) {
      wx.showToast({ title: '请选择成交店铺', icon: 'none' })
      return
    }
    if (!f.evidence_urls.length) {
      wx.showToast({ title: '请上传至少 1 个成交凭证', icon: 'none' })
      return
    }

    const isPickup = f.transaction_type === 'PICKUP'
    this.setData({ submitting: true })
    api.manualDeal({
      sku_code: f.sku_code.trim(),
      sale_price: Number(f.sale_price),
      transaction_type: f.transaction_type,
      worry_free: isPickup ? false : !!f.worry_free,
      shop_name: isPickup ? null : ((f.shop_name || '').trim() || null),
      buyer_name: (f.buyer_name || '').trim() || null,
      buyer_phone: (f.buyer_phone || '').replace(/\D/g, '') || null,
      tracking_no: (f.tracking_no || '').trim() || null,
      express_fee: f.express_fee ? Number(f.express_fee) : null,
      platform_fee: isPickup || f.platform_fee === '' ? null : Number(f.platform_fee),
      remark: (f.remark || '').trim() || null,
      evidence_urls: f.evidence_urls,
    })
      .then(() => {
        wx.showToast({ title: '已成交出库' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '成交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
