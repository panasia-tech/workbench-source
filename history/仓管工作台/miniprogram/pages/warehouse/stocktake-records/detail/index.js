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
    id: '',
    loading: true,
    session: null,
    statusLabel: '',
    startedText: '—',
    completedText: '—',
    tabs: [],          // [{key,label,items}]
    activeKey: '',
    list: [],          // 当前 Tab 的商品列表
    canSubmit: false,
    submitting: false,
  },

  onLoad(query) {
    this.setData({ id: query.id || '' })
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    this.setData({ loading: true })
    return api.stocktakeDetail(this.data.id).then((s) => {
      const diff = s.diff_result
      let tabs
      if (diff) {
        tabs = [
          { key: 'matched', label: '账实相符', items: diff.matched || [] },
          { key: 'missing', label: '盘亏', items: diff.missing || [] },
          { key: 'surplus', label: '盘盈', items: diff.surplus || [] },
        ]
      } else {
        // 无差异结果(如盘点中)：退化为已盘读列表
        tabs = [{ key: 'scanned', label: '已盘读', items: s.scanned_items || [] }]
      }
      const active = tabs[0]
      const user = getApp().globalData.user || {}
      const open = s.status === 'COMPLETED' || s.status === 'REJECTED'
      this.setData({
        canSubmit: open && (user.role === 'ADMIN' || user.name === s.operator_name),
        session: s,
        loading: false,
        statusLabel: STATUS_LABEL[s.status] || s.status,
        startedText: fmt(s.started_at),
        completedText: fmt(s.completed_at),
        tabs,
        activeKey: active.key,
        list: active.items,
      })
    }).catch(() => {
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    })
  },

  pickTab(e) {
    const key = e.currentTarget.dataset.key
    const tab = this.data.tabs.find((t) => t.key === key)
    this.setData({ activeKey: key, list: tab ? tab.items : [] })
  },

  // 有差异的单提交审批:少的按报损、多的按盘盈入库(系统里没有的货号不处理),管理员在后台批了才平账
  submit() {
    const s = this.data.session
    const diff = s.diff_result || {}
    const m = (diff.missing || []).length
    const surplus = diff.surplus || []
    const p = surplus.filter((i) => i.product_name).length
    const unknown = surplus.length - p
    wx.showModal({
      title: '提交审批',
      content: `少了 ${m} 件按报损、多了 ${p} 件按盘盈入库${unknown ? `，系统里没有的 ${unknown} 个货号不处理` : ''}，提交给管理员审批。确定吗？`,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submitting: true })
        api.stocktakeAutoPropose(s.id)
          .then(() => api.stocktakeSubmit(s.id))
          .then(() => {
            wx.showToast({ title: '已提交', icon: 'success' })
            return this.load()
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
          })
          .finally(() => this.setData({ submitting: false }))
      },
    })
  },

  openSku(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${code}` })
  },
})
