const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { expressSummaryFromResult } = require('../../utils/express')

function patchTaskExpress(tasks, id, summary) {
  return tasks.map((item) => (item.id === id ? { ...item, express_summary: summary || '' } : item))
}

Page({
  data: {
    tasks: [],
    recallPinned: [],
    trackingCount: 0,
    refreshingId: '',
    batchRefreshing: false,
    q: '',
  },

  onShow() {
    auth.ensureLogin().then(() => this.loadTasks())
  },

  loadTasks() {
    const q = (this.data.q || '').trim()
    const params = { status: 'PENDING', page: 1, size: 100 }
    if (q) params.q = q
    return api.listInspection(params).then((res) => {
      const tasks = res.items || []
      // 后端只返回议价 24h 内、仍在库的召回项；超 24h 自动移除
      const recallPinned = res.recall_items || []
      const trackingCount = tasks.filter((item) => (item.tracking_no || '').trim()).length
      this.setData({ tasks, recallPinned, trackingCount })
    })
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.loadTasks(), 400)
  },

  onSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this.loadTasks()
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        if (this._searchTimer) clearTimeout(this._searchTimer)
        this.setData({ q: code })
        this.loadTasks()
      })
      .catch(() => {})
  },

  openForm(e) {
    wx.navigateTo({ url: `/pages/inspection/form/index?id=${e.currentTarget.dataset.id}` })
  },

  // 召回商品已在库，跳转仓库详情查看库位以便取货
  openRecall(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${code}` })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/inspection/records/index' })
  },

  goRejects() {
    wx.navigateTo({ url: '/pages/inspection/rejects/index' })
  },

  goRetests() {
    wx.navigateTo({ url: '/pages/inspection/retests/index' })
  },

  onRefreshExpress(e) {
    const { id, no, phone, cached } = e.currentTarget.dataset
    if (!no || this.data.refreshingId || this.data.batchRefreshing) return
    this.setData({ refreshingId: id })
    const refresh = cached === '1'
    api.trackExpress(no, { refresh, phone })
      .then((result) => {
        const summary = expressSummaryFromResult(result)
        this.setData({ tasks: patchTaskExpress(this.data.tasks, id, summary) })
        if (result.cached && result.traces && result.traces.length) {
          wx.showToast({ title: '已显示缓存物流', icon: 'none' })
        } else if (result.msg && !(result.traces && result.traces.length)) {
          wx.showToast({ title: result.msg, icon: 'none', duration: 2500 })
        }
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '物流查询失败', icon: 'none' })
      })
      .finally(() => this.setData({ refreshingId: '' }))
  },

  refreshAllExpress() {
    if (this.data.batchRefreshing || this.data.refreshingId) return
    const pending = this.data.tasks.filter((item) => (item.tracking_no || '').trim())
    if (!pending.length) {
      wx.showToast({ title: '暂无物流单号', icon: 'none' })
      return
    }
    this.setData({ batchRefreshing: true })
    wx.showLoading({ title: '刷新物流…', mask: true })
    let done = 0
    let tasks = [...this.data.tasks]
    const runNext = (index) => {
      if (index >= pending.length) {
        wx.hideLoading()
        this.setData({ tasks, batchRefreshing: false })
        wx.showToast({ title: `已刷新 ${done}/${pending.length}`, icon: 'none' })
        return
      }
      const item = pending[index]
      api.trackExpress(item.tracking_no.trim(), { refresh: true, phone: item.tracking_phone_suffix })
        .then((result) => {
          done += 1
          tasks = patchTaskExpress(tasks, item.id, expressSummaryFromResult(result))
        })
        .catch(() => {})
        .finally(() => runNext(index + 1))
    }
    runNext(0)
  },
})
