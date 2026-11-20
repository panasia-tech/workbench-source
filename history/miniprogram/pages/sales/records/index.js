const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'PENDING', label: '待发货' },
  { key: 'SHIPPED', label: '待签收' },
  { key: 'COMPLETED', label: '已完成' },
  { key: 'RETURNING', label: '待退货' },
]

Page({
  data: {
    list: [],
    q: '',
    status: '',
    statusTabs: STATUS_TABS,
    dateFrom: '',
    dateTo: '',
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

  onDateFromChange(e) {
    this.setData({ dateFrom: e.detail.value }, () => this.reload())
  },

  onDateToChange(e) {
    this.setData({ dateTo: e.detail.value }, () => this.reload())
  },

  onSearch() {
    this.reload()
  },

  onStatusTab(e) {
    const key = e.currentTarget.dataset.key || ''
    if (key === this.data.status) return
    this.setData({ status: key }, () => this.reload())
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, status, dateFrom, dateTo } = this.data
    const params = { page, size: PAGE_SIZE }
    if (q) params.q = q
    if (status) params.status = status
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    return api.listSales(params).then((res) => {
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
    if (id) wx.navigateTo({ url: `/pages/sales/detail/index?id=${id}` })
  },
})
