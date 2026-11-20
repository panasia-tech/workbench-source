const api = require('@services/api')
const appConfig = require('@services/config')
const { scanBarcode } = require('@services/scan')

const GRADES = ['95新', '9新', '85新', '8新']

Page({
  data: {
    taskId: '',
    task: null,
    locations: [],
    locationIndex: 0,
    locationLabel: '',
    locationPickerVisible: false,
    tempLocationIndex: [0],
    actionType: 'INBOUND',
    grades: GRADES,
    gradeIndex: -1,
    form: {
      listing_images: [],
      defect_images: [],
      defect_videos: [],
      reject_images: [],
      location_images: [],
      inspection_result: 'PASSED',
      sku_code: '',
      serial_number: '',
      barcode: '',
      location_code: '',
      condition_grade: '',
      mismatch_remark: '',
      remark: '',
      tags: [],
      product_type: '',
    },
    tagOptions: [],
    productTypes: [],
    productTypeIndex: -1,
    listingDisplayUrls: [],
    defectDisplayUrls: [],
    rejectDisplayUrls: [],
    locationDisplayUrls: [],
    submitting: false,
  },

  toggleTag(e) {
    const { name } = e.currentTarget.dataset
    if (!name) return
    const tags = (this.data.form.tags || []).slice()
    const idx = tags.indexOf(name)
    if (idx >= 0) tags.splice(idx, 1)
    else tags.push(name)
    this.setData({ 'form.tags': tags })
  },

  pickProductType(e) {
    const idx = Number(e.detail.value)
    this.setData({ productTypeIndex: idx, 'form.product_type': this.data.productTypes[idx] || '' })
  },

  pickGrade(e) {
    const idx = Number(e.detail.value)
    this.setData({ gradeIndex: idx, 'form.condition_grade': GRADES[idx] || '' })
  },

  syncLocations() {
    const locations = appConfig.getLocations().map((loc) => ({
      ...loc,
      label: loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code,
    }))
    let locationIndex = 0
    let locationLabel = ''
    const code = (this.data.form.location_code || '').trim()
    if (code && locations.length) {
      const idx = locations.findIndex((loc) => loc.code === code)
      if (idx >= 0) {
        locationIndex = idx
        locationLabel = locations[idx].label
      }
    }
    this.setData({ locations, locationIndex, locationLabel })
  },

  onLoad(options) {
    this.setData({ taskId: options.id })
    const loadTask = api.getInspection(options.id)
    const loadConfig = appConfig.getLocations().length
      ? Promise.resolve()
      : appConfig.refreshConfig()
    const loadTags = api.enabledWarehouseTags().catch(() => [])
    const loadTypes = api.enabledProductTypes().catch(() => [])
    Promise.all([loadTask, loadConfig, loadTags, loadTypes])
      .then(([task, _, tags, types]) => {
        this.setData({ task, tagOptions: tags || [], productTypes: (types || []).map((t) => t.name) })
        this.syncLocations()
      })
      .catch(() => {
        wx.showToast({ title: '加载失败', icon: 'none' })
      })
  },

  pickAction(e) {
    this.setData({ actionType: e.currentTarget.dataset.type })
  },

  pickResult(e) {
    this.setData({ 'form.inspection_result': e.currentTarget.dataset.result })
  },

  openLocationPicker() {
    if (!this.data.locations.length) return
    this.setData({
      locationPickerVisible: true,
      tempLocationIndex: [this.data.locationIndex],
    })
  },

  closeLocationPicker() {
    this.setData({ locationPickerVisible: false })
  },

  onLocationPickerChange(e) {
    this.setData({ tempLocationIndex: e.detail.value })
  },

  confirmLocationPicker() {
    const index = this.data.tempLocationIndex[0] || 0
    const loc = this.data.locations[index]
    if (!loc) {
      this.closeLocationPicker()
      return
    }
    this.setData({
      locationPickerVisible: false,
      locationIndex: index,
      locationLabel: loc.label,
      'form.location_code': loc.code,
    })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (key) this.setData({ [`form.${key}`]: e.detail.value })
  },

  scanSkuCode() {
    scanBarcode()
      .then((code) => this.setData({ 'form.sku_code': code }))
      .catch(() => {})
  },

  scanSerialNumber() {
    scanBarcode()
      .then((code) => this.setData({ 'form.serial_number': code }))
      .catch(() => {})
  },

  scanBarcode69() {
    scanBarcode()
      .then((code) => this.setData({ 'form.barcode': code }))
      .catch(() => {})
  },

  ocrSkuCode() {
    this._ocrCode('sku_code', '货号')
  },

  ocrSerialNumber() {
    this._ocrCode('serial_number', '序列号')
  },

  // 货号与序列号同在标签上，合并识别常取错；分两个按钮各拍各的字段更准
  _ocrCode(field, label) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const file = res.tempFiles[0]
        wx.showLoading({ title: `识别${label}…`, mask: true })
        api.uploadMedia('inspection/ocr/', `${Date.now()}.jpg`, file.tempFilePath)
          .then((result) => api.ocrSkuLabel(result.public_url))
          .then((ocr) => {
            const parsed = (ocr && ocr.parsed) || ocr || {}
            // 序列号用独立字段；绝不能把货号 M########-### 写进 serial_number
            const code = field === 'serial_number'
              ? (parsed.serial_number || '')
              : (parsed.primary_sku_code || (parsed.sku_codes && parsed.sku_codes[0]) || '')
            wx.hideLoading()
            if (code) {
              this.setData({ [`form.${field}`]: code })
              wx.showToast({ title: `已识别${label}`, icon: 'success' })
            } else {
              wx.showToast({ title: `未识别到${label}`, icon: 'none' })
            }
          })
          .catch(() => {
            wx.hideLoading()
            wx.showToast({ title: '识别失败', icon: 'none' })
          })
      },
    })
  },

  addImage(e) {
    const type = e.currentTarget.dataset.type
    const isVideoOnly = type === 'defect_video'
    // 入库图/拒签证据图/定位图：图片视频均可上传；瑕疵照片仍仅图片（视频走单独按钮）
    const allowVideo = ['listing', 'reject', 'location'].indexOf(type) >= 0
    const mediaType = isVideoOnly ? ['video'] : allowVideo ? ['image', 'video'] : ['image']
    wx.chooseMedia({
      count: isVideoOnly ? 2 : 9,
      mediaType,
      success: (res) => {
        const dirMap = {
          listing: 'inspection/listing/',
          defect: 'inspection/defect/',
          defect_video: 'inspection/defect-video/',
          reject: 'inspection/reject/',
          location: 'sku/location/',
        }
        const keyMap = {
          listing: 'listing_images',
          defect: 'defect_images',
          defect_video: 'defect_videos',
          reject: 'reject_images',
          location: 'location_images',
        }
        const displayMap = {
          listing: 'listingDisplayUrls',
          defect: 'defectDisplayUrls',
          reject: 'rejectDisplayUrls',
          location: 'locationDisplayUrls',
        }
        const dir = dirMap[type]
        const key = keyMap[type]
        const displayKey = displayMap[type]
        const uploads = res.tempFiles.map((f) => {
          // 按单个文件类型定扩展名，视频与图片可在同一次选择里混传
          const ext = (isVideoOnly || f.fileType === 'video') ? '.mp4' : '.jpg'
          return api.uploadMedia(dir, `${Date.now()}${ext}`, f.tempFilePath)
        })
        Promise.all(uploads).then((results) => {
          const urls = results.map((r) => r.public_url)
          const displayUrls = results.map((r) => r.access_url || r.public_url)
          const patch = {
            [`form.${key}`]: [...this.data.form[key], ...urls],
          }
          if (displayKey) {
            patch[displayKey] = [...this.data[displayKey], ...displayUrls]
          }
          this.setData(patch)
        }).catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
      },
    })
  },

  submit() {
    if (this.data.submitting) return
    const { actionType, form: f } = this.data
    if (!this.data.task || this.data.task.status !== 'PENDING') return this._submitInboundForm(f)
    const { request } = require('@services/request')
    request({ url: `/api/inspection-ops/tasks/${this.data.taskId}/check` })
        .then((check) => {
          // 与后端 assert_ready_to_submit 一致：已开始逐项验货时，入库/拒签都要验完；
          // 「无法测试」可先提交，不能因 items.length>0 永久拦住已验完的单。
          const left = (check.items || []).filter((i) => !i.result)
          if (left.length) {
            wx.showModal({
              title: '先完成逐项验货',
              content: `还有 ${left.length} 项没验，请按规范完成后再提交。`,
              showCancel: false,
              success: () => wx.navigateTo({ url: `/pages/inspection/check/index?id=${this.data.taskId}` }),
            })
            return
          }
          const { request: req } = require('@services/request')
          return req({ url: '/api/inspection-ops/settings' }).then((settings) => {
            if (!(check.items && check.items.length) && settings.full_check_required && check.matched_template) {
              wx.showModal({ title: '需要逐项验货', content: '管理端已要求该商品先完成验货规范逐项检查。', showCancel: false,
                success: () => wx.navigateTo({ url: `/pages/inspection/check/index?id=${this.data.taskId}` }) })
              return
            }
            this._submitInboundForm(f)
          })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '无法确认全检状态，请重试', icon: 'none' }))
  },

  _submitInboundForm(f) {
    const { actionType } = this.data
    if (actionType === 'REJECT') {
      if (!(f.remark || '').trim()) {
        wx.showToast({ title: '请填写拒签原因', icon: 'none' })
        return
      }
      this._post({
        action_type: 'REJECT',
        remark: f.remark.trim(),
        reject_images: f.reject_images,
      })
      return
    }

    if (!f.listing_images.length) {
      wx.showToast({ title: '至少 1 张入库图', icon: 'none' })
      return
    }
    if (!(f.sku_code || '').trim()) {
      wx.showToast({ title: '请填写货号', icon: 'none' })
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
    if (!(f.product_type || '').trim()) {
      wx.showToast({ title: '请选择商品类型', icon: 'none' })
      return
    }
    if (!(f.condition_grade || '').trim()) {
      wx.showToast({ title: '请选择成色', icon: 'none' })
      return
    }

    const payload = {
      action_type: 'INBOUND',
      listing_images: f.listing_images,
      defect_images: f.defect_images,
      defect_videos: f.defect_videos,
      location_images: f.location_images,
      inspection_result: f.inspection_result,
      sku_code: f.sku_code.trim(),
      serial_number: f.serial_number.trim(),
      barcode: f.barcode.trim() || null,
      location_code: f.location_code.trim(),
      condition_grade: f.condition_grade,
      mismatch_remark: f.mismatch_remark.trim() || null,
      remark: f.remark.trim() || null,
      tags: f.tags || [],
      product_type: f.product_type,
    }

    this._post(payload)
  },

  _post(payload) {
    this.setData({ submitting: true })
    api.submitInspection(this.data.taskId, payload)
      .then(() => {
        wx.showToast({
          title: payload.action_type === 'REJECT' ? '已拒签' : '验货完成',
        })
        wx.navigateBack()
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
