const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { expressSummaryFromResult } = require('../../../utils/express')

function patchListExpress(list, id, summary) {
  return list.map((item) => (item.id === id ? { ...item, express_summary: summary || '' } : item))
}

const PAGE_SIZE = 20

Page({
  data: {
    list: [],
    q: '',
    dateFrom: '',
    dateTo: '',
    status: '',
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    refreshingId: '',
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

  onDateFromChange(e) {
    this.setData({ dateFrom: e.detail.value }, () => this.reload())
  },

  onDateToChange(e) {
    this.setData({ dateTo: e.detail.value }, () => this.reload())
  },

  pickStatus(e) {
    const status = e.currentTarget.dataset.status
    this.setData({ status: status === this.data.status ? '' : status })
    this.reload()
  },

  onSearch() {
    this.reload()
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        this.setData({ q: code }, () => this.reload())
      })
      .catch(() => {})
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, dateFrom, dateTo, status } = this.data
    const params = { page, size: PAGE_SIZE }
    if (q) params.q = q
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    if (status) params.status = status
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
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  openItem(e) {
    const { id, status } = e.currentTarget.dataset
    if (status === 'PENDING') {
      wx.navigateTo({ url: `/pages/inspection/form/index?id=${id}` })
    } else {
      wx.navigateTo({ url: `/pages/inspection/detail/index?id=${id}` })
    }
  },

  onRefreshExpress(e) {
    const { id, no, cached } = e.currentTarget.dataset
    if (!no || this.data.refreshingId) return
    this.setData({ refreshingId: id })
    api.trackExpress(no, { refresh: cached === '1' })
      .then((result) => {
        this.setData({ list: patchListExpress(this.data.list, id, expressSummaryFromResult(result)) })
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '物流查询失败', icon: 'none' })
      })
      .finally(() => this.setData({ refreshingId: '' }))
  },
})
