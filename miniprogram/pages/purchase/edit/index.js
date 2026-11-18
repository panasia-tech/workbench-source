const api = require('@services/api')
const { sanitizeMoneyField } = require('../../../utils/money')
const auth = require('@services/auth')
const appConfig = require('@services/config')
const media = require('../../../utils/media')

const MAX_SCREENSHOTS = 2
const MAX_PRODUCT_IMAGES = 9

function splitDatetime(value) {
  if (!value) return { date: '', time: '' }
  const normalized = String(value).replace('T', ' ').trim()
  const [date = '', time = ''] = normalized.split(/\s+/)
  return { date, time: (time || '00:00').slice(0, 5) }
}

function joinDatetime(date, time) {
  if (!date || !time) return ''
  const t = time.length === 5 ? `${time}:00` : time
  return `${date} ${t}`
}

function composeProductName(brand, model) {
  return [brand, model].map((s) => (s || '').trim()).filter(Boolean).join(' ')
}

Page({
  data: {
    orderId: '',
    form: {
      brand: '',
      model: '',
      spec: '',
      external_order_no: '',
      transaction_no: '',
      tracking_no: '',
      tracking_phone_suffix: '',
      seller_name: '',
      unit_price: '',
      purchase_account: '',
      remark: '',
      is_overdue: false,
    },
    canEditOverdue: false,
    orderDate: '',
    orderTime: '',
    paidDate: '',
    paidTime: '',
    screenshotUrls: [],
    screenshotDisplayUrls: [],
    productImageUrls: [],
    productImageDisplayUrls: [],
    maxProductImages: MAX_PRODUCT_IMAGES,
    maxScreenshots: MAX_SCREENSHOTS,
    purchaseAccounts: [],
    purchaseAccountIndex: 0,
    purchaseAccountLabel: '',
    submitting: false,
    loaded: false,
  },

  onLoad(options) {
    this.orderId = options.id
    auth.ensureLogin().then(() => {
      if (!appConfig.getPurchaseAccounts().length) {
        return appConfig.refreshConfig()
      }
      return null
    }).then(() => this.loadOrder()).catch(() => this.loadOrder())
  },

  loadOrder() {
    api.getPurchase(this.orderId).then((order) => {
      const orderTime = splitDatetime(order.order_time)
      const paidAt = splitDatetime(order.paid_at)
      const productImageUrls = order.product_images || []
      const screenshotUrls = [order.screenshot_url, order.screenshot_url_2].filter(Boolean)
      this.setData({
        orderId: order.id,
        loaded: true,
        form: {
          brand: order.brand || '',
          model: order.model || '',
          spec: order.spec || '',
          external_order_no: order.external_order_no || '',
          transaction_no: order.transaction_no || '',
          tracking_no: order.tracking_no || '',
          tracking_phone_suffix: order.tracking_phone_suffix || '',
          seller_name: order.seller_name || '',
          unit_price: order.unit_price != null ? String(order.unit_price) : '',
          purchase_account: order.purchase_account || '',
          remark: order.remark || '',
          is_overdue: !!order.is_overdue,
        },
        canEditOverdue: (getApp().globalData.user || {}).role === 'ADMIN',
        orderDate: orderTime.date,
        orderTime: orderTime.time,
        paidDate: paidAt.date,
        paidTime: paidAt.time,
        productImageUrls,
        productImageDisplayUrls: productImageUrls,
        screenshotUrls,
        screenshotDisplayUrls: screenshotUrls,
      }, () => this.syncPurchaseAccounts())
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  syncPurchaseAccounts() {
    const accounts = appConfig.getPurchaseAccounts()
    const code = (this.data.form.purchase_account || '').trim()
    let purchaseAccountIndex = 0
    let purchaseAccountLabel = ''
    if (code && accounts.length) {
      const idx = accounts.findIndex((row) => row.code === code)
      if (idx >= 0) {
        purchaseAccountIndex = idx
        purchaseAccountLabel = accounts[idx].label
      }
    }
    if (!purchaseAccountLabel && code) {
      purchaseAccountLabel = appConfig.findPurchaseAccountLabel(code) || code
    }
    this.setData({ purchaseAccounts: accounts, purchaseAccountIndex, purchaseAccountLabel })
  },

  onPurchaseAccountChange(e) {
    const index = Number(e.detail.value)
    const account = this.data.purchaseAccounts[index]
    if (!account) return
    this.setData({
      purchaseAccountIndex: index,
      purchaseAccountLabel: account.label,
      'form.purchase_account': account.code,
    })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const value = sanitizeMoneyField(key, e.detail.value)
    this.setData({ [`form.${key}`]: value })
  },

  onPhoneSuffixInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4)
    this.setData({ 'form.tracking_phone_suffix': digits })
  },

  onOverdueToggle(e) {
    this.setData({ 'form.is_overdue': !!e.detail.value })
  },

  onOrderDateChange(e) { this.setData({ orderDate: e.detail.value }) },
  onOrderTimeChange(e) { this.setData({ orderTime: e.detail.value }) },
  onPaidDateChange(e) { this.setData({ paidDate: e.detail.value }) },
  onPaidTimeChange(e) { this.setData({ paidTime: e.detail.value }) },

  chooseProductImage() {
    const remaining = MAX_PRODUCT_IMAGES - this.data.productImageUrls.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_PRODUCT_IMAGES} 张商品图`, icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      success: (res) => {
        const uploads = res.tempFiles.map((file, i) =>
          api.uploadMedia('purchase/products/', `${Date.now()}_${i}.jpg`, file.tempFilePath)
        )
        Promise.all(uploads).then((results) => {
          this.setData({
            productImageUrls: [
              ...this.data.productImageUrls,
              ...results.map((result) => result.public_url),
            ],
            productImageDisplayUrls: [
              ...this.data.productImageDisplayUrls,
              ...results.map((result) => media.uploadAccessUrl(result)),
            ],
          })
        }).catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
      },
    })
  },

  removeProductImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({
      productImageUrls: this.data.productImageUrls.filter((_, i) => i !== index),
      productImageDisplayUrls: this.data.productImageDisplayUrls.filter((_, i) => i !== index),
    })
  },

  chooseScreenshot() {
    const remaining = MAX_SCREENSHOTS - this.data.screenshotUrls.length
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传 2 张截图', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      success: (res) => {
        const uploads = res.tempFiles.map((file, i) =>
          api.uploadMedia('purchase/screenshots/', `${Date.now()}_${i}.jpg`, file.tempFilePath)
        )
        Promise.all(uploads).then((results) => {
          this.setData({
            screenshotUrls: [
              ...this.data.screenshotUrls,
              ...results.map((result) => result.public_url),
            ],
            screenshotDisplayUrls: [
              ...this.data.screenshotDisplayUrls,
              ...results.map((result) => media.uploadAccessUrl(result)),
            ],
          })
        }).catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
      },
    })
  },

  removeScreenshot(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({
      screenshotUrls: this.data.screenshotUrls.filter((_, i) => i !== index),
      screenshotDisplayUrls: this.data.screenshotDisplayUrls.filter((_, i) => i !== index),
    })
  },

  validate() {
    const f = this.data.form
    if (!this.data.productImageUrls.length) return '请至少保留 1 张商品图'
    if (!f.brand.trim()) return '请填写品牌'
    if (!f.model.trim()) return '请填写型号'
    if (!f.unit_price) return '请填写成交金额'
    if (!f.external_order_no.trim()) return '请填写订单号'
    if (!f.transaction_no.trim()) return '请填写交易流水号'
    if (!f.tracking_no.trim()) return '请填写物流单号'
    if (!f.seller_name.trim()) return '请填写卖家昵称'
    if (!f.purchase_account.trim()) return '请选择采购账号'
    if (!joinDatetime(this.data.orderDate, this.data.orderTime)) return '请选择下单时间'
    if (!joinDatetime(this.data.paidDate, this.data.paidTime)) return '请选择付款时间'
    return ''
  },

  submit() {
    if (this.data.submitting) return
    const err = this.validate()
    if (err) {
      wx.showToast({ title: err, icon: 'none' })
      return
    }
    const f = this.data.form
    const urls = this.data.screenshotUrls
    const payload = {
      brand: f.brand.trim(),
      model: f.model.trim(),
      product_name: composeProductName(f.brand, f.model),
      spec: f.spec.trim() || null,
      unit_price: Number(f.unit_price),
      external_order_no: f.external_order_no.trim(),
      transaction_no: f.transaction_no.trim(),
      tracking_no: f.tracking_no.trim(),
      tracking_phone_suffix: (f.tracking_phone_suffix || '').replace(/\D/g, '').slice(0, 4) || null,
      seller_name: f.seller_name.trim(),
      order_time: joinDatetime(this.data.orderDate, this.data.orderTime),
      paid_at: joinDatetime(this.data.paidDate, this.data.paidTime),
      purchase_account: f.purchase_account.trim(),
      remark: f.remark.trim() || null,
      screenshot_url: urls[0] || null,
      screenshot_url_2: urls[1] || null,
      product_images: [...this.data.productImageUrls],
    }
    // 逾期采购仅管理员可改，非管理员不下发该字段
    if (this.data.canEditOverdue) {
      payload.is_overdue = !!f.is_overdue
    }
    this.setData({ submitting: true })
    api.updatePurchase(this.data.orderId, payload).then(() => {
      wx.showToast({ title: '已保存' })
      const pages = getCurrentPages()
      const prev = pages[pages.length - 2]
      if (prev && typeof prev.onLoad === 'function' && prev.route && prev.route.indexOf('purchase/detail') >= 0) {
        // 让详情页重新拉取最新数据
        prev.onLoad({ id: this.data.orderId })
      }
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((error) => {
      this.setData({ submitting: false })
      wx.showToast({ title: (error && error.detail) || '保存失败', icon: 'none' })
    })
  },
})
