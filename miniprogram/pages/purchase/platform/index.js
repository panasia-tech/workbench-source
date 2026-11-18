// 采购工作台 W10：执行端只读「我买到的」抓回来的订单。待建单的一键带到采购表单；要人看的写一句处理结果。
const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20
const TABS = [
  { key: 'unbound', label: '待建单' },
  { key: 'review', label: '要人看' },
  { key: 'all', label: '全部' },
]

Page({
  data: {
    tabs: TABS,
    view: 'unbound',
    q: '',
    list: [],
    counts: {},
    total: 0,
    page: 1,
    loading: false,
    noMore: false,
    lastSynced: '',
    openId: '',
    detail: null,
  },

  onShow() {
    auth.ensureLogin().then(() => this.reload())
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  switchTab(e) {
    this.setData({ view: e.currentTarget.dataset.key }, () => this.reload())
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false, openId: '', detail: null })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, view, q } = this.data
    const params = { page, size: PAGE_SIZE, view }
    if (q) params.q = q
    return api.listPlatformOrders(params).then((res) => {
      const items = res.items || []
      const merged = page === 1 ? items : this.data.list.concat(items)
      this.setData({
        list: merged,
        total: res.total || 0,
        counts: res.counts || {},
        lastSynced: (res.last_synced_at || '').replace('T', ' ').slice(0, 16),
        page: page + 1,
        noMore: merged.length >= (res.total || 0) || items.length < PAGE_SIZE,
        loading: false,
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.openId === id) {
      this.setData({ openId: '', detail: null })
      return
    }
    this.setData({ openId: id, detail: null })
    api.getPlatformOrder(id).then((d) => {
      d.events = (d.events || []).map((x) => ({ ...x, at: (x.at || '').replace('T', ' ').slice(5, 16) }))
      this.setData({ detail: d })
    }).catch(() => wx.showToast({ title: '打不开', icon: 'none' }))
  },

  makeOrder(e) {
    wx.navigateTo({ url: `/pages/purchase/index?platform_order_id=${encodeURIComponent(e.currentTarget.dataset.id)}` })
  },

  markReviewed(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '看过了',
      editable: true,
      placeholderText: '写一句怎么处理的',
      success: (r) => {
        if (!r.confirm) return
        const note = (r.content || '').trim()
        if (!note) {
          wx.showToast({ title: '要写一句怎么处理的', icon: 'none' })
          return
        }
        api.reviewPlatformOrder(id, note).then(() => {
          wx.showToast({ title: '已记下', icon: 'success' })
          this.reload()
        }).catch(() => wx.showToast({ title: '没记上', icon: 'none' }))
      },
    })
  },

  openPurchase(e) {
    wx.navigateTo({ url: `/pages/purchase/detail/index?id=${e.currentTarget.dataset.id}` })
  },
})
