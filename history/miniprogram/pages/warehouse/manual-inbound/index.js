const api = require('@services/api')
const appConfig = require('@services/config')
const { scanBarcode } = require('@services/scan')
const { sanitizeDecimal } = require('@utils/money')

const GRADES = ['95新', '9新', '85新', '8新']

Page({
  data: {
    submitting: false,
    grades: GRADES,
    gradeIndex: -1,
    productTypes: [],
    productTypeIndex: -1,
    locations: [],
    locationIndex: -1,
    inboundDate: '', // 留空=入库时间默认今天
    form: {
      sku_code: '',
      product_name: '',
      brand: '',
      model: '',
      spec: '',
      serial_number: '',
      barcode: '',
      location_code: '',
      condition_grade: '',
      product_type: '',
      cost_price: '',
      remark: '',
      images: [],
      location_images: [],
    },
    imageDisplay: [],
    locationImageDisplay: [],
  },

  onLoad() {
    // 商品类型（AI 生图种类）下发，入库单选必填
    api.enabledProductTypes()
      .then((types) => this.setData({ productTypes: (types || []).map((t) => t.name) }))
      .catch(() => {})
    // 老系统历史记录「转手动入库」带入的预填资料(图片仍需现场新拍)
    const intent = getApp().globalData.manualInboundIntent
    if (intent) {
      getApp().globalData.manualInboundIntent = null
      this.setData({
        'form.sku_code': intent.sku_code || '',
        'form.product_name': intent.product_name || '',
        'form.model': intent.model || '',
        'form.serial_number': intent.serial_number || '',
        'form.cost_price': intent.cost_price || '',
        'form.remark': intent.remark || '',
      })
    }
    const locations = appConfig.getLocations().map((loc) => ({
      code: loc.code,
      label: loc.label || (loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code),
    }))
    this.setData({ locations })
    if (!locations.length) {
      // 库位是后端下发的基础配置，缺了无法选库位
      appConfig.refreshConfig().then(() => {
        const locs = appConfig.getLocations().map((loc) => ({
          code: loc.code,
          label: loc.label || (loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code),
        }))
        this.setData({ locations: locs })
      }).catch(() => {})
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onCostInput(e) {
    this.setData({ 'form.cost_price': sanitizeDecimal(e.detail.value) })
  },

  scanSkuCode() {
    scanBarcode().then((text) => this.setData({ 'form.sku_code': text })).catch(() => {})
  },

  scanSerial() {
    scanBarcode().then((text) => this.setData({ 'form.serial_number': text })).catch(() => {})
  },

  scanBarcode69() {
    scanBarcode().then((text) => this.setData({ 'form.barcode': text })).catch(() => {})
  },

  pickGrade(e) {
    const idx = Number(e.detail.value)
    this.setData({ gradeIndex: idx, 'form.condition_grade': GRADES[idx] || '' })
  },

  pickProductType(e) {
    const idx = Number(e.detail.value)
    this.setData({ productTypeIndex: idx, 'form.product_type': this.data.productTypes[idx] || '' })
  },

  pickLocation(e) {
    const idx = Number(e.detail.value)
    const loc = this.data.locations[idx]
    this.setData({ locationIndex: idx, 'form.location_code': loc ? loc.code : '' })
  },

  onInboundDate(e) {
    this.setData({ inboundDate: e.detail.value })
  },

  addImage(e) {
    const type = e.currentTarget.dataset.type // product | location
    const key = type === 'location' ? 'location_images' : 'images'
    const displayKey = type === 'location' ? 'locationImageDisplay' : 'imageDisplay'
    const dir = type === 'location' ? 'sku/location/' : 'sku/product/'
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: (res) => {
        wx.showLoading({ title: '上传中…', mask: true })
        const uploads = res.tempFiles.map((f) => {
          const ext = f.fileType === 'video' ? '.mp4' : '.jpg'
          return api.uploadMedia(dir, `${Date.now()}${ext}`, f.tempFilePath)
        })
        Promise.all(uploads).then((results) => {
          wx.hideLoading()
          this.setData({
            [`form.${key}`]: [...this.data.form[key], ...results.map((r) => r.public_url)],
            [displayKey]: [...this.data[displayKey], ...results.map((r) => r.access_url || r.public_url)],
          })
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  removeImage(e) {
    const { type, index } = e.currentTarget.dataset
    const key = type === 'location' ? 'location_images' : 'images'
    const displayKey = type === 'location' ? 'locationImageDisplay' : 'imageDisplay'
    const list = [...this.data.form[key]]
    const display = [...this.data[displayKey]]
    list.splice(index, 1)
    display.splice(index, 1)
    this.setData({ [`form.${key}`]: list, [displayKey]: display })
  },

  submit() {
    if (this.data.submitting) return
    const f = this.data.form
    const name = (f.product_name || '').trim() || [f.brand, f.model].map((s) => (s || '').trim()).filter(Boolean).join(' ')
    if (!name) {
      wx.showToast({ title: '请填写商品名称或品牌型号', icon: 'none' })
      return
    }
    if (!(f.serial_number || '').trim()) {
      wx.showToast({ title: '请填写序列号', icon: 'none' })
      return
    }
    if (!(f.location_code || '').trim()) {
      wx.showToast({ title: '请选择库位', icon: 'none' })
      return
    }
    if (!(f.condition_grade || '').trim()) {
      wx.showToast({ title: '请选择成色', icon: 'none' })
      return
    }
    if (!(f.product_type || '').trim()) {
      wx.showToast({ title: '请选择商品类型', icon: 'none' })
      return
    }
    const cost = String(f.cost_price || '').trim()
    if (cost === '' || Number(cost) < 0 || !/^\d+(\.\d{1,2})?$/.test(cost)) {
      wx.showToast({ title: '请填写有效成本价（可填 0）', icon: 'none' })
      return
    }
    if (!f.images.length) {
      wx.showToast({ title: '至少 1 张商品图', icon: 'none' })
      return
    }
    const payload = {
      product_name: name,
      brand: (f.brand || '').trim() || null,
      model: (f.model || '').trim() || null,
      spec: (f.spec || '').trim() || null,
      sku_code: (f.sku_code || '').trim() || null,
      serial_number: f.serial_number.trim(),
      barcode: (f.barcode || '').trim() || null,
      location_code: f.location_code.trim(),
      condition_grade: f.condition_grade,
      product_type: f.product_type,
      cost_price: Number(cost),
      images: f.images,
      location_images: f.location_images,
      remark: (f.remark || '').trim() || null,
    }
    // 入库时间留空=后端取当前；选了日期则按当天 00:00（北京时间）回填
    if (this.data.inboundDate) {
      payload.inbound_at = `${this.data.inboundDate}T00:00:00`
    }
    this.setData({ submitting: true })
    api.manualInbound(payload).then((res) => {
      wx.showModal({
        title: '入库成功',
        content: `已生成货号 ${res.sku_code}，商品已进入在库列表。`,
        showCancel: false,
        confirmText: '完成',
        success: () => wx.navigateBack(),
      })
    }).catch((err) => {
      this.setData({ submitting: false })
      wx.showToast({ title: (err && err.detail) || '入库失败', icon: 'none' })
    })
  },
})
