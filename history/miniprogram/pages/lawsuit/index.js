const auth = require('@services/auth')
const api = require('@services/api')

const PAGE_SIZE = 20

// 全部 + 四个业务状态（DRAFT 仅在「全部」里出现）
const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'EVIDENCE_SUBMITTED', label: '已提交证据' },
  { key: 'SUBMITTED_LAWYER', label: '已提交律师回复' },
  { key: 'PENDING_HEARING', label: '待开庭' },
  { key: 'JUDGED', label: '已判决' },
]

const STATUS_META = {
  DRAFT: { text: '待提交证据', cls: 'tag-muted' },
  EVIDENCE_SUBMITTED: { text: '已提交证据', cls: 'tag-warning' },
  SUBMITTED_LAWYER: { text: '已提交律师回复', cls: 'tag-info' },
  PENDING_HEARING: { text: '待开庭', cls: 'tag-warning' },
  JUDGED: { text: '已判决', cls: 'tag-success' },
}

function decorate(item) {
  const meta = STATUS_META[item.status] || STATUS_META.DRAFT
  return { ...item, statusText: meta.text, statusCls: meta.cls }
}

Page({
  data: {
    statusTabs: STATUS_TABS,
    status: '',
    q: '',
    list: [],
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

  onSearch() {
    this.reload()
  },

  switchStatus(e) {
    const status = e.currentTarget.dataset.key || ''
    if (status === this.data.status) return
    this.setData({ status }, () => this.reload())
  },

  reload() {
    this.setData({ loading: true, page: 1, noMore: false })
    return this._fetch(1).then((res) => {
      const items = (res.items || []).map(decorate)
      this.setData({
        list: items,
        total: res.total || 0,
        page: 1,
        noMore: items.length >= (res.total || 0),
        loading: false,
      })
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
      const more = (res.items || []).map(decorate)
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
    const { q, status } = this.data
    const params = { page, size: PAGE_SIZE }
    if (q.trim()) params.q = q.trim()
    if (status) params.status = status
    return api.listLawsuits(params)
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/lawsuit/detail/index?id=${id}` })
  },

  // 删除起诉单（列表删除按钮 / 长按均触发）
  onDeleteItem(e) {
    const { id, no } = e.currentTarget.dataset
    if (!id) return
    wx.showModal({
      title: '删除起诉单',
      content: `确认删除起诉单 ${no || ''}？此操作不可恢复。`,
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        api.deleteLawsuit(id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            this.reload()
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '删除失败', icon: 'none' })
          })
      },
    })
  },

  onCreate() {
    wx.navigateTo({ url: '/pages/lawsuit/detail/index' })
  },
})
