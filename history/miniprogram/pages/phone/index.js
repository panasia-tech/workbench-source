const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

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
      this.setData({
        list: res.items || [],
        total: res.total || 0,
        page: 1,
        noMore: (res.items || []).length >= (res.total || 0),
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
      const more = res.items || []
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
    return api.listPhones(params)
  },

  openForm(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/phone/form/index${id ? '?id=' + id : ''}` })
  },

  onDeleteItem(e) {
    const { id, no } = e.currentTarget.dataset
    if (!id) return
    wx.showModal({
      title: '删除手机号',
      content: `确认删除号码 ${no || ''}？此操作不可恢复。`,
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        api.deletePhone(id)
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
    wx.navigateTo({ url: '/pages/phone/form/index' })
  },
})
