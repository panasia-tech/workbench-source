const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const PAGE_SIZE = 20

Page({
  data: {
    list: [],
    q: '',
    dateFrom: '',
    dateTo: '',
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
  },

  onShow() {
    // 点进详情再返回不重拉：原来回到第 1 页、翻到的位置没了（8cd994b 的守卫，4318de7 合入时被带掉）；要新数据下拉刷新
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

  onScanSearch() {
    scanBarcode()
      .then((code) => this.setData({ q: code }, () => this.reload()))
      .catch(() => {})
  },

  onDateFromChange(e) {
    this.setData({ dateFrom: e.detail.value }, () => this.reload())
  },

  onDateToChange(e) {
    this.setData({ dateTo: e.detail.value }, () => this.reload())
  },

  clearDate() {
    this.setData({ dateFrom: '', dateTo: '' }, () => this.reload())
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, dateFrom, dateTo } = this.data
    // 已完成且 action_type=REJECT，即拒签退回的历史订单
    const params = { page, size: PAGE_SIZE, status: 'DONE', action_type: 'REJECT' }
    if (q) params.q = q
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    return api.listInspection(params).then((res) => {
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
    }).catch((err) => {
      this.setData({ loading: false })
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/inspection/reject-detail/index?id=${id}` })
  },
})
