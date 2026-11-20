const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

Page({
  data: {
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

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page } = this.data
    return api.listSwitch({ page, size: PAGE_SIZE }).then((res) => {
      const items = res.items || []
      const merged = page === 1 ? items : this.data.list.concat(items)
      const noMore = merged.length >= (res.total || 0) || items.length < PAGE_SIZE
      this.setData({
        list: merged,
        total: res.total || 0,
        page: page + 1,
        noMore,
        loading: false,
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (id) wx.navigateTo({ url: `/pages/switch/detail/index?id=${id}` })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/switch/create/index' })
  },

  goSwitchShip() {
    wx.navigateTo({ url: '/pages/sales/outbound/index?type=SWITCH' })
  },
})
