const api = require('@services/api')
const auth = require('@services/auth')

const STATUS_LABEL = {
  IN_PROGRESS: '盘点中',
  PAUSED: '已暂停',
  COMPLETED: '有差异',
  APPROVED: '账实相符',
  PENDING_APPROVAL: '审批中',
  REJECTED: '已驳回',
}

function fmt(t) {
  if (!t) return '—'
  return String(t).replace('T', ' ').slice(0, 16)
}

Page({
  data: {
    list: [],
    loading: true,
    statusFilter: '',           // '' = 全部
    options: [
      { value: '', label: '全部' },
      { value: 'COMPLETED', label: '有差异' },
      { value: 'APPROVED', label: '账实相符' },
    ],
  },

  onLoad() {
    // 仅仓管可见
    auth.ensureLogin().then(() => {
      const role = getApp().globalData.user && getApp().globalData.user.role
      if (role !== 'WAREHOUSE' && role !== 'ADMIN') {
        wx.showToast({ title: '无权查看', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      this.load()
    })
  },

  onShow() {
    auth.ensureLogin().then(() => {
      if (this._loaded) return
      this._loaded = true
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  pickStatus(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.value }, () => this.load())
  },

  load() {
    this.setData({ loading: true })
    const params = this.data.statusFilter ? { status: this.data.statusFilter } : {}
    return api.stocktakeList(params).then((list) => {
      const rows = (list || []).map((it) => ({
        ...it,
        statusLabel: STATUS_LABEL[it.status] || it.status,
        startedText: fmt(it.started_at),
        completedText: fmt(it.completed_at),
      }))
      this.setData({ list: rows, loading: false })
    }).catch(() => this.setData({ loading: false }))
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/warehouse/stocktake-records/detail/index?id=${id}` })
  },
})
