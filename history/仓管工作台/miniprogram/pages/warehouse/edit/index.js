const api = require('@services/api')
const appConfig = require('@services/config')
const { scanBarcode } = require('@services/scan')

const GRADES = ['95新', '9新', '85新', '8新']

Page({
  data: {
    code: '',
    loading: true,
    saving: false,
    grades: GRADES,
    gradeIndex: -1,
    locations: [],
    locationIndex: -1,
    form: {
      sku_code: '',
      product_name: '',
      model: '',
      spec: '',
      serial_number: '',
      barcode: '',
      location_code: '',
      condition_grade: '',
      images: [],
      location_images: [],
    },
    imageDisplay: [],
    locationImageDisplay: [],
  },

  onLoad(options) {
    const code = options.code || ''
    if (!code) {
      wx.showToast({ title: '缺少货号', icon: 'none' })
      return
    }
    const mapLocs = () => appConfig.getLocations().map((loc) => ({
      code: loc.code,
      label: loc.label || (loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code),
    }))
    let locations = mapLocs()
    this.setData({ code, locations })
    const ensureLocations = locations.length
      ? Promise.resolve(locations)
      : appConfig.refreshConfig().then(() => {
        locations = mapLocs()
        this.setData({ locations })
        return locations
      }).catch(() => locations)
    ensureLocations.then((locs) => api.skuDetail(code).then((detail) => ({ detail, locs }))).then(({ detail, locs }) => {
      const gradeIndex = GRADES.indexOf(detail.condition_grade || '')
      const locationIndex = locs.findIndex((l) => l.code === detail.location_code)
      this.setData({
        loading: false,
        gradeIndex,
        locationIndex,
        form: {
          sku_code: detail.sku_code || '',
          product_name: detail.product_name || '',
          model: detail.model || '',
          spec: detail.spec || '',
          serial_number: detail.serial_number || '',
          barcode: detail.barcode || '',
          location_code: detail.location_code || '',
          condition_grade: detail.condition_grade || '',
          images: detail.images || [],
          location_images: detail.location_images || [],
        },
        imageDisplay: detail.images || [],
        locationImageDisplay: detail.location_images || [],
      })
    }).catch(() => {
      wx.showToast({ title: '加载商品失败', icon: 'none' })
      this.setData({ loading: false })
    })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  scanSkuCode() {
    scanBarcode().then((text) => {
      this.setData({ 'form.sku_code': text })
    }).catch(() => {})
  },

  scanSerial() {
    scanBarcode().then((text) => {
      this.setData({ 'form.serial_number': text })
    }).catch(() => {})
  },

  scanBarcode69() {
    scanBarcode().then((text) => {
      this.setData({ 'form.barcode': text })
    }).catch(() => {})
  },

  pickGrade(e) {
    const idx = Number(e.detail.value)
    this.setData({ gradeIndex: idx, 'form.condition_grade': GRADES[idx] || '' })
  },

  pickLocation(e) {
    const idx = Number(e.detail.value)
    const loc = this.data.locations[idx]
    this.setData({ locationIndex: idx, 'form.location_code': loc ? loc.code : '' })
  },

  addImage(e) {
    const type = e.currentTarget.dataset.type // product | location
    const key = type === 'location' ? 'location_images' : 'images'
    const displayKey = type === 'location' ? 'locationImageDisplay' : 'imageDisplay'
    const dir = type === 'location' ? 'sku/location/' : 'sku/product/'
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      success: (res) => {
        wx.showLoading({ title: '上传中…', mask: true })
        const uploads = res.tempFiles.map((f) =>
          api.uploadMedia(dir, `${Date.now()}.jpg`, f.tempFilePath)
        )
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
    wx.showModal({
      title: '移除图片',
      content: '确定移除这张图片？保存后生效。',
      success: (res) => {
        if (!res.confirm) return
        const list = [...this.data.form[key]]
        const display = [...this.data[displayKey]]
        list.splice(index, 1)
        display.splice(index, 1)
        this.setData({ [`form.${key}`]: list, [displayKey]: display })
      },
    })
  },

  save() {
    if (this.data.saving) return
    const f = this.data.form
    if (!(f.sku_code || '').trim()) {
      wx.showToast({ title: '货号不能为空', icon: 'none' })
      return
    }
    if (!(f.product_name || '').trim()) {
      wx.showToast({ title: '商品名称不能为空', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.updateSku(this.data.code, {
      sku_code: f.sku_code,
      product_name: f.product_name,
      model: f.model,
      spec: f.spec,
      serial_number: f.serial_number,
      barcode: f.barcode,
      location_code: f.location_code,
      condition_grade: f.condition_grade,
      images: f.images,
      location_images: f.location_images,
    }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
    })
  },
})
