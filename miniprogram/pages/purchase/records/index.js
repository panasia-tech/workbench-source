const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

// 北京当日 YYYY-MM-DD（设备时区可能非北京，统一换算）
function cnToday() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const cn = new Date(utc + 8 * 3600000)
  const m = String(cn.getMonth() + 1).padStart(2, '0')
  const d = String(cn.getDate()).padStart(2, '0')
  return `${cn.getFullYear()}-${m}-${d}`
}

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

  onLoad(query) {
    // 从「我的-今日采购」卡片进入时默认只看今日，与卡片数字口径一致
    if (query && query.today === '1') {
      const today = cnToday()
      this.setData({ dateFrom: today, dateTo: today })
    }
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

  onSearch() {
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, dateFrom, dateTo } = this.data
    const params = { page, size: PAGE_SIZE }
    if (q) params.q = q
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    return api.listPurchase(params).then((res) => {
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
    wx.navigateTo({ url: `/pages/purchase/detail/index?id=${e.currentTarget.dataset.id}` })
  },
})
