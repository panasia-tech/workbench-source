const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

const STATUS_META = {
  IDLE: { text: '在库', cls: 'tag-info' },
  IN_USE: { text: '使用中', cls: 'tag-success' },
  SCRAPPED: { text: '已报废', cls: 'tag-warning' },
  SOLD: { text: '已售出', cls: 'tag-danger' },
}

function decorate(item) {
  const meta = STATUS_META[item.status] || STATUS_META.IDLE
  // 缩略图：优先实拍图 image_files，其次采购回填图 product_images；只取 http(s) 图（cloud:// 老图无法加载）
  const firstHttp = (arr) => (arr || []).find((u) => /^https?:\/\//.test(u)) || ''
  const thumb = firstHttp(item.image_files) || firstHttp(item.product_images)
  return { ...item, statusText: meta.text, statusCls: meta.cls, thumb }
}

Page({
  data: {
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      if (this._loaded) return
      this._loaded = true
      this.reload()
    })
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
  },

  onSearch() {
    this.reload()
  },

  reload() {
    this.setData({ loading: true, page: 1, noMore: false })
    return this._fetch(1).then((res) => {
      const items = (res.items || []).map(decorate)
      this.setData({
        list: items,
        total: res.total || 0,
        page: 1,
        noMore: items.length >= (res.total || 0),
        loading: false,
      })
    }).catch((err) => {
      this.setData({ loading: false })
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return
    const next = this.data.page + 1
    this.setData({ loading: true })
    this._fetch(next).then((res) => {
      const more = (res.items || []).map(decorate)
      const list = this.data.list.concat(more)
      this.setData({
        list,
        page: next,
        total: res.total || 0,
        noMore: list.length >= (res.total || 0),
        loading: false,
      })
    }).catch(() => this.setData({ loading: false }))
  },

  _fetch(page) {
    const params = { page, size: PAGE_SIZE }
    if (this.data.q.trim()) params.q = this.data.q.trim()
    return api.listAssets(params)
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/asset/detail/index?id=${id}` })
  },

  onDeleteItem(e) {
    const { id, no } = e.currentTarget.dataset
    if (!id) return
    wx.showModal({
      title: '删除资产',
      content: `确认删除资产 ${no || ''}？此操作不可恢复。`,
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        api.deleteAsset(id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.reload()
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '删除失败', icon: 'none' })
          })
      },
    })
  },

  onCreate() {
    wx.navigateTo({ url: '/pages/asset/form/index' })
  },
})
