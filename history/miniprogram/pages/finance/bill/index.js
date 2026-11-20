const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'custom', label: '自定义' },
]

function cnNow() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  return new Date(utc + 8 * 3600000)
}

function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 返回某个预设周期对应的 [date_from, date_to]（中国日历，含首尾）
function rangeForPeriod(key, customFrom, customTo) {
  const today = cnNow()
  const todayStr = fmtDate(today)
  if (key === 'today') return [todayStr, todayStr]
  if (key === 'yesterday') {
    const y = cnNow()
    y.setDate(y.getDate() - 1)
    const s = fmtDate(y)
    return [s, s]
  }
  if (key === 'week') {
    const d = cnNow()
    // 周一为一周起点（getDay: 0=周日）
    const dow = d.getDay() === 0 ? 7 : d.getDay()
    d.setDate(d.getDate() - (dow - 1))
    return [fmtDate(d), todayStr]
  }
  if (key === 'month') {
    const d = cnNow()
    d.setDate(1)
    return [fmtDate(d), todayStr]
  }
  // custom
  return [customFrom || todayStr, customTo || todayStr]
}

Page({
  data: {
    periods: PERIODS,
    period: 'today',
    customFrom: '',
    customTo: '',
    dateFrom: '',
    dateTo: '',
    stats: {},
    loading: false,

    detailTab: 'purchase', // purchase | sales
    list: [],
    page: 1,
    listLoading: false,
    noMore: false,
  },

  onLoad() {
    const today = fmtDate(cnNow())
    this.setData({ customFrom: today, customTo: today })
  },

  onShow() {
    auth.ensureLogin().then(() => {
      const role = getApp().globalData.user && getApp().globalData.user.role
      if (role !== 'FINANCE' && role !== 'ADMIN') {
        wx.showToast({ title: '无权限', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 400)
        return
      }
      this.applyPeriod(this.data.period)
    })
  },

  onPullDownRefresh() {
    this.refreshAll().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMoreDetails()
  },

  pickPeriod(e) {
    const period = e.currentTarget.dataset.period
    if (period === this.data.period) return
    this.setData({ period })
    if (period !== 'custom') this.applyPeriod(period)
  },

  onCustomFromChange(e) {
    this.setData({ customFrom: e.detail.value }, () => {
      if (this.data.period === 'custom') this.applyPeriod('custom')
    })
  },

  onCustomToChange(e) {
    this.setData({ customTo: e.detail.value }, () => {
      if (this.data.period === 'custom') this.applyPeriod('custom')
    })
  },

  applyPeriod(period) {
    const [dateFrom, dateTo] = rangeForPeriod(period, this.data.customFrom, this.data.customTo)
    if (dateTo < dateFrom) {
      wx.showToast({ title: '结束日期早于开始', icon: 'none' })
      return
    }
    this.setData({ dateFrom, dateTo })
    this.refreshAll()
  },

  refreshAll() {
    return Promise.all([this.loadStats(), this.reloadDetails()])
  },

  loadStats() {
    const { dateFrom, dateTo } = this.data
    this.setData({ loading: true })
    return api.financeStats({ date_from: dateFrom, date_to: dateTo })
      .then((stats) => this.setData({ stats: stats || {}, loading: false }))
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '统计加载失败', icon: 'none' })
      })
  },

  switchDetailTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.detailTab) return
    this.setData({ detailTab: tab })
    this.reloadDetails()
  },

  reloadDetails() {
    this.setData({ list: [], page: 1, noMore: false })
    return this.loadMoreDetails()
  },

  loadMoreDetails() {
    if (this.data.listLoading || this.data.noMore) return Promise.resolve()
    const { detailTab, dateFrom, dateTo, page } = this.data
    this.setData({ listLoading: true })
    const fn = detailTab === 'purchase' ? api.financePurchaseDetails : api.financeSalesDetails
    return fn({ date_from: dateFrom, date_to: dateTo, page, size: PAGE_SIZE }).then((res) => {
      const items = (res && res.items) || []
      const total = (res && res.total) || 0
      const merged = page === 1 ? items : this.data.list.concat(items)
      const noMore = merged.length >= total || items.length < PAGE_SIZE
      this.setData({ list: merged, page: page + 1, noMore, listLoading: false })
    }).catch(() => {
      this.setData({ listLoading: false })
      wx.showToast({ title: '明细加载失败', icon: 'none' })
    })
  },
})
