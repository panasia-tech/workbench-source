const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

const STRATEGY_LABELS = {
  FACE_SCAN: '法人扫脸',
  BAD_REGISTER: '不当注册',
  NETWORK_DOWN: '断网续费',
}

Page({
  data: {
    q: '',
    status: '',          // '' 全部 / PENDING / COMPLETE
    list: [],
    page: 1,
    total: 0,
    pendingCount: 0,
    loading: false,
    noMore: false,
    syncing: false,
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

  onStatusFilter(e) {
    this.setData({ status: e.currentTarget.dataset.status })
    this.reload()
  },

  reload() {
    this.setData({ loading: true, page: 1, noMore: false })
    return this._fetch(1).then((res) => {
      this.setData({
        list: this._decorate(res.items || []),
        total: res.total || 0,
        page: 1,
        noMore: (res.items || []).length >= (res.total || 0),
        loading: false,
      })
      this._countPending()
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
      const more = this._decorate(res.items || [])
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
    if (this.data.status) params.status = this.data.status
    return api.listAccountProfiles(params)
  },

  _countPending() {
    api.listAccountProfiles({ page: 1, size: 1, status: 'PENDING' })
      .then((res) => this.setData({ pendingCount: res.total || 0 }))
      .catch(() => {})
  },

  _decorate(items) {
    return items.map((it) => ({
      ...it,
      strategyText: (it.exception_strategies || [])
        .map((s) => STRATEGY_LABELS[s] || s).join('、'),
      missingCollect: !it.device_serial || !it.phone_number,
    }))
  },

  openForm(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/account-profile/form/index?id=${id}` })
  },

  onSync() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    api.syncAccountProfiles().then((res) => {
      wx.showToast({ title: `已同步:新建${res.created}`, icon: 'none' })
      this.reload()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '同步失败', icon: 'none' })
    }).finally(() => this.setData({ syncing: false }))
  },
})
