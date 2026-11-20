const auth = require('@services/auth')
const api = require('@services/api')

const STATUS_META = {
  IDLE: { text: '在库', cls: 'tag-info' },
  IN_USE: { text: '使用中', cls: 'tag-success' },
  SCRAPPED: { text: '已报废', cls: 'tag-warning' },
  SOLD: { text: '已售出', cls: 'tag-danger' },
}

Page({
  data: {
    id: '',
    device: null,
    statusText: '',
    statusCls: '',
  },

  onLoad(options) {
    auth.ensureLogin()
    if (options.id) {
      this.setData({ id: options.id })
      this.load()
    }
  },

  load() {
    api.getAsset(this.data.id).then((res) => {
      const meta = STATUS_META[res.status] || STATUS_META.IDLE
      // 过滤云开发遗留的 cloud:// 老图（迁移到 OSS 后无法加载），只保留 http(s) 图，避免 image 组件报错
      const httpOnly = (arr) => (arr || []).filter((u) => /^https?:\/\//.test(u))
      res.image_files = httpOnly(res.image_files)
      res.product_images = httpOnly(res.product_images)
      this.setData({
        device: res,
        statusText: meta.text,
        statusCls: meta.cls,
      })
    }).catch(() => {
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  goEdit() {
    wx.navigateTo({ url: `/pages/asset/form/index?id=${this.data.id}` })
  },

  onDelete() {
    const no = this.data.device?.asset_no || ''
    wx.showModal({
      title: '删除资产',
      content: `确认删除资产 ${no}？此操作不可恢复。`,
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        api.deleteAsset(this.data.id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1000)
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '删除失败', icon: 'none' })
          })
      },
    })
  },

  previewImage(e) {
    const { url } = e.currentTarget.dataset
    const urls = (this.data.device?.image_files || []).filter(Boolean)
    if (!urls.length) return
    wx.previewImage({ current: url || urls[0], urls })
  },
})
