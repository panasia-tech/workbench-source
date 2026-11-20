const api = require('@services/api')
const appConfig = require('@services/config')
const { scanBarcode } = require('@services/scan')

const CONDITION_OPTIONS = [
  { key: 'NORMAL', label: '正常' },
  { key: 'OPENED', label: '已拆封' },
  { key: 'USED', label: '轻微使用' },
  { key: 'ABNORMAL', label: '异常（损坏/缺配件等）' },
]

Page({
  data: {
    id: '',
    returnNo: '',
    skuCode: '',
    productName: '',
    serialNumber: '',
    conditionOptions: CONDITION_OPTIONS,
    conditionIndex: -1,
    locations: [],
    locationIndex: -1,
    media: [],
    mediaDisplays: [],
    abnormalReason: '',
    remark: '',
    // 序列号不符时由后端提示转为异常挂起
    markAbnormal: false,
    submitting: false,
  },

  onLoad(options) {
    this.setData({
      id: options.id || '',
      returnNo: options.return_no || '',
      skuCode: options.sku_code || '',
      productName: decodeURIComponent(options.product_name || ''),
    })
    const ready = appConfig.getLocations().length
      ? Promise.resolve()
      : appConfig.refreshConfig()
    ready.then(() => {
      const locations = appConfig.getLocations().map((loc) => ({
        ...loc,
        label: loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code,
      }))
      this.setData({ locations })
    })
  },

  onSerialInput(e) {
    this.setData({ serialNumber: e.detail.value })
  },

  onScanSerial() {
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((code) => {
        const cleaned = String(code || '').replace(/\s+/g, '').slice(0, 128)
        if (!cleaned) {
          wx.showToast({ title: '未识别到有效条形码，请重新扫描', icon: 'none' })
          return
        }
        this.setData({ serialNumber: cleaned })
      })
      .catch(() => {})
  },

  onConditionChange(e) {
    this.setData({ conditionIndex: Number(e.detail.value) })
  },

  onLocationChange(e) {
    this.setData({ locationIndex: Number(e.detail.value) })
  },

  onAbnormalInput(e) {
    this.setData({ abnormalReason: e.detail.value })
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value })
  },

  onAddImages() {
    const existing = this.data.media
    if (existing.length >= 9) return
    wx.chooseImage({
      count: 9 - existing.length,
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        const tasks = res.tempFilePaths.map((fp) => api.uploadMedia('returns/receive', '', fp))
        Promise.all(tasks).then((results) => {
          const urls = results.map((r) => r.public_url)
          const displays = results.map((r) => r.access_url || r.public_url)
          this.setData({
            media: existing.concat(urls),
            mediaDisplays: this.data.mediaDisplays.concat(displays),
          })
        }).catch(() => {
          wx.showToast({ title: '上传失败', icon: 'none' })
        }).finally(() => wx.hideLoading())
      },
    })
  },

  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.index
    const media = this.data.media.slice()
    const displays = this.data.mediaDisplays.slice()
    media.splice(idx, 1)
    displays.splice(idx, 1)
    this.setData({ media, mediaDisplays: displays })
  },

  onSubmit() {
    if (this.data.submitting) return
    const { conditionIndex, locationIndex, locations, markAbnormal } = this.data
    const serial = (this.data.serialNumber || '').trim()
    if (!serial) {
      wx.showToast({ title: '请扫码或输入商品序列号', icon: 'none' })
      return
    }
    if (conditionIndex < 0) {
      wx.showToast({ title: '请选择商品状态', icon: 'none' })
      return
    }
    if (locationIndex < 0 || !locations[locationIndex]) {
      wx.showToast({ title: '请选择当前库位', icon: 'none' })
      return
    }
    if (!this.data.media.length) {
      wx.showToast({ title: '请上传退回照片', icon: 'none' })
      return
    }
    const condition = this.data.conditionOptions[conditionIndex].key
    const abnormalReason = (this.data.abnormalReason || '').trim()
    if ((condition === 'ABNORMAL' || markAbnormal) && !abnormalReason) {
      wx.showToast({ title: '请填写异常说明', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.receiveReturn(this.data.id, {
      serial_number: serial,
      condition,
      location_code: locations[locationIndex].code,
      media: this.data.media,
      remark: (this.data.remark || '').trim() || null,
      mark_abnormal: markAbnormal,
      abnormal_reason: abnormalReason || null,
    })
      .then((res) => {
        const abnormal = res && res.status === 'ABNORMAL'
        wx.showToast({ title: abnormal ? '已挂起待裁决' : '入库成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 800)
      })
      .catch((err) => {
        const detail = (err && err.detail) || ''
        if (detail.indexOf('序列号不符') === 0) {
          wx.showModal({
            title: '序列号不符',
            content: `${detail}\n\n是否标记为「退回异常」挂起，交管理员裁决？`,
            confirmText: '标记异常',
            cancelText: '重新核对',
            success: (res) => {
              if (res.confirm) {
                this.setData({ markAbnormal: true })
                wx.showToast({ title: '请填写异常说明后再次提交', icon: 'none' })
              }
            },
          })
          return
        }
        wx.showToast({ title: detail || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
