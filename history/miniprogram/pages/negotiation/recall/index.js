const api = require('@services/api')

Page({
  data: {
    skuCode: '',
    detail: {},
    // 顺丰改派/再次派件凭证（图片/视频混存）
    media: [],
    mediaDisplayUrls: [],
    submitting: false,
  },

  onLoad(options) {
    const skuCode = options.code || ''
    this.setData({ skuCode })
    if (skuCode) this.loadDetail(skuCode)
  },

  loadDetail(code) {
    api.getNegotiationRecall(code)
      .then((detail) => {
        this.setData({ detail })
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
      })
  },

  addMedia() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: (res) => {
        const uploads = res.tempFiles.map((f) => {
          const ext = f.fileType === 'video' ? '.mp4' : '.jpg'
          return api.uploadMedia('negotiation/redispatch/', `${Date.now()}${ext}`, f.tempFilePath)
        })
        Promise.all(uploads).then((results) => {
          const urls = results.map((r) => r.public_url)
          const displayUrls = results.map((r) => r.access_url || r.public_url)
          this.setData({
            media: [...this.data.media, ...urls],
            mediaDisplayUrls: [...this.data.mediaDisplayUrls, ...displayUrls],
          })
        }).catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
      },
    })
  },

  removeMedia(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    const media = this.data.media.slice()
    const displayUrls = this.data.mediaDisplayUrls.slice()
    media.splice(index, 1)
    displayUrls.splice(index, 1)
    this.setData({ media, mediaDisplayUrls: displayUrls })
  },

  onSubmit() {
    if (this.data.submitting) return
    if (!this.data.media.length) {
      wx.showToast({ title: '请上传顺丰改派/再次派件截图', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.submitNegotiationRecall(this.data.skuCode, { redispatch_media: this.data.media })
      .then(() => {
        wx.showToast({ title: '已召回快递', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
