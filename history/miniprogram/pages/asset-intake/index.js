const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

// 状态 → 标签色（文案由后端给）
const STATUS_TAG = {
  pending: 'tag-warning',
  listing: 'tag-info',
  on_sale: 'tag-success',
  to_ship: 'tag-warning',
  sold: 'tag-pending',
  locked: 'tag-pending',
  loss: 'tag-danger',
  split: 'tag-pending',
}

function decorate(item) {
  return { ...item, statusCls: STATUS_TAG[item.status] || 'tag-pending' }
}

Page({
  data: {
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    isAdmin: false,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      const user = getApp().globalData.user || {}
      this.setData({ isAdmin: user.role === 'ADMIN' })
      // 从录入页回来要看到刚录的、改过的，每次进来都刷
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
      const list = this.data.list.concat((res.items || []).map(decorate))
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
    const q = this.data.q.trim()
    if (q) params.q = q
    return api.listAssetIntakes(params)
  },

  openItem(e) {
    const { code } = e.currentTarget.dataset
    if (!code) return
    wx.navigateTo({ url: `/pages/asset-intake/form/index?code=${code}` })
  },

  onCreate() {
    wx.navigateTo({ url: '/pages/asset-intake/form/index' })
  },
})
