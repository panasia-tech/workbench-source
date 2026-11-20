const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const RECALL_PAGE_SIZE = 20

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function shiftDays(base, delta) {
  const d = new Date(base)
  d.setDate(d.getDate() + delta)
  return d
}

Page({
  data: {
    tab: 'pending', // 'pending' 待议价 | 'recall' 待召回快递
    list: [],
    total: 0,
    recallList: [],
    recallTotal: 0,
    recallPage: 1,
    recallNoMore: false,
    loading: false,
    q: '',
    dateFrom: '',
    dateTo: '',
    preset: '', // '' | 'today' | 'yesterday' | '7d'，仅用于高亮
  },

  onShow() {
    auth.ensureLogin().then(() => {
      this.loadCurrent()
      this.refreshRecallBadge()
    })
  },

  onPullDownRefresh() {
    this.loadCurrent().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.tab === 'recall') this.loadMoreRecall()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab }, () => this.loadCurrent())
  },

  loadCurrent() {
    return this.data.tab === 'recall' ? this.reloadRecall() : this.reload()
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
  },

  onSearch() {
    this.loadCurrent()
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => this.setData({ q: code }, () => this.loadCurrent()))
      .catch(() => {})
  },

  // 快捷日期：今天 / 昨天 / 近7天（待议价按入库时间、待召回按议价时间折算成日期区间）
  pickPreset(e) {
    const preset = e.currentTarget.dataset.preset || ''
    if (preset === this.data.preset) {
      // 再次点击同一项 → 取消筛选
      this.setData({ preset: '', dateFrom: '', dateTo: '' }, () => this.loadCurrent())
      return
    }
    const today = new Date()
    let dateFrom = ''
    let dateTo = ''
    if (preset === 'today') {
      dateFrom = fmtDate(today)
      dateTo = fmtDate(today)
    } else if (preset === 'yesterday') {
      const y = shiftDays(today, -1)
      dateFrom = fmtDate(y)
      dateTo = fmtDate(y)
    } else if (preset === '7d') {
      dateFrom = fmtDate(shiftDays(today, -6))
      dateTo = fmtDate(today)
    }
    this.setData({ preset, dateFrom, dateTo }, () => this.loadCurrent())
  },

  onDateFromChange(e) {
    this.setData({ dateFrom: e.detail.value, preset: '' }, () => this.loadCurrent())
  },

  onDateToChange(e) {
    this.setData({ dateTo: e.detail.value, preset: '' }, () => this.loadCurrent())
  },

  clearDate() {
    this.setData({ dateFrom: '', dateTo: '', preset: '' }, () => this.loadCurrent())
  },

  _filterParams() {
    const { q, dateFrom, dateTo } = this.data
    const params = {}
    if (q) params.q = q
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    return params
  },

  // ---------- 待议价 ----------
  reload() {
    this.setData({ loading: true })
    return api.listNegotiationPending(this._filterParams())
      .then((items) => {
        const list = items || []
        this.setData({ list, total: list.length, loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // ---------- 待召回快递（分页） ----------
  reloadRecall() {
    this.setData({ recallPage: 1, recallList: [], recallNoMore: false })
    return this.loadMoreRecall()
  },

  loadMoreRecall() {
    if (this.data.loading || this.data.recallNoMore) return Promise.resolve()
    this.setData({ loading: true })
    const page = this.data.recallPage
    const params = Object.assign(this._filterParams(), { page, size: RECALL_PAGE_SIZE })
    return api.listNegotiationRecallPending(params)
      .then((res) => {
        const items = res.items || []
        const merged = page === 1 ? items : this.data.recallList.concat(items)
        const noMore = merged.length >= (res.total || 0) || items.length < RECALL_PAGE_SIZE
        this.setData({
          recallList: merged,
          recallTotal: res.total || 0,
          recallPage: page + 1,
          recallNoMore: noMore,
          loading: false,
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // 在待议价 Tab 也显示待召回数量角标，提醒业务员补传改派记录
  refreshRecallBadge() {
    api.listNegotiationRecallPending({ page: 1, size: 1 })
      .then((res) => this.setData({ recallTotal: res.total || 0 }))
      .catch(() => {})
  },

  openForm(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/negotiation/form/index?code=${code}` })
  },

  openRecall(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/negotiation/recall/index?code=${code}` })
  },

  openHistory() {
    wx.navigateTo({ url: '/pages/negotiation/history/index' })
  },
})
