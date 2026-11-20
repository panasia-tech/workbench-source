const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

// 上架审批（手机版）：每件在库货、每个号的价和图，员工清洗提交、管理员批过才发。和电脑后台同一套接口。
const PAGE_SIZE = 20
const TABS = [
  { key: 'todo', label: '待清洗' },
  { key: 'review', label: '待审批' },
  { key: 'fix', label: '在架待整改' },
  { key: 'done', label: '已通过' },
  { key: 'all', label: '全部' },
]
const STATE_CLASS = {
  NONE: 'lap-st--none',
  DRAFT: 'lap-st--draft',
  SUBMITTED: 'lap-st--wait',
  APPROVED: 'lap-st--ok',
  REJECTED: 'lap-st--bad',
  STALE: 'lap-st--bad',
}

function itemView(item, shops) {
  const cells = shops.map((s) => {
    const c = item.cells[s.id] || {}
    return { id: s.id, label: s.label, state: c.label, cls: STATE_CLASS[c.state] || '', fix: !!c.needs_fix }
  })
  return { ...item, shopCells: cells }
}

Page({
  data: {
    tabs: TABS,
    tab: 'todo',
    counts: {},
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    costHidden: true,
    isAdmin: false,
    settings: null,
    settingOpen: false,
    ratioInput: '',
  },

  onLoad(options) {
    if (options && options.tab) this.setData({ tab: options.tab })
  },

  onShow() {
    // 从一件货回来要刷新：刚提交 / 批过的那件该换页签了
    auth.ensureLogin().then(() => {
      this.setData({ isAdmin: getApp().globalData.user?.role === 'ADMIN' })
      this.loadSettings()
      return this.reload()
    })
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.loading || this.data.noMore) return
    this.fetch(this.data.page + 1)
  },

  loadSettings() {
    return api.listingApprovalSettings()
      .then((settings) => this.setData({ settings }))
      .catch(() => {})
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.reload(), 400)
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        this.setData({ q: code })
        this.reload()
      })
      .catch(() => {})
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.key
    if (!tab || tab === this.data.tab) return
    this.setData({ tab })
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.fetch(1)
  },

  fetch(page) {
    this.setData({ loading: true })
    const params = { state: this.data.tab, page, size: PAGE_SIZE }
    if (this.data.q.trim()) params.keyword = this.data.q.trim()
    return api.listingApprovalTasks(params)
      .then((res) => {
        const items = (res.items || []).map((x) => itemView(x, res.shops || []))
        const list = page === 1 ? items : this.data.list.concat(items)
        this.setData({
          counts: res.counts || {},
          costHidden: !!res.cost_hidden,
          list,
          page,
          total: res.total,
          noMore: list.length >= res.total,
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  openSku(e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.navigateTo({ url: `/pages/listing/approvals/detail/index?code=${encodeURIComponent(code)}` })
  },

  // ------------------------------------------------------------ 管理员：开关和成本比例
  openSetting() {
    if (!this.data.isAdmin || !this.data.settings) return
    this.setData({ settingOpen: true, ratioInput: this.data.settings.min_cost_ratio })
  },

  closeSetting() {
    this.setData({ settingOpen: false })
  },

  noop() {},

  onRatioInput(e) {
    this.setData({ ratioInput: e.detail.value })
  },

  toggleRequired() {
    const on = !this.data.settings.required
    const save = () => this._saveSettings({ required: on })
    if (!on) {
      save()
      return
    }
    wx.showModal({
      title: '打开上架审批',
      content: '打开后，手动上架、自动上架都只发批过的价和图，没批的号一律不发。',
      confirmText: '打开',
      success: (r) => { if (r.confirm) save() },
    })
  },

  toggleAutoPublish() {
    if (!this.data.isAdmin || !this.data.settings) return
    this._saveSettings({ auto_publish: !this.data.settings.auto_publish })
  },

  saveRatio() {
    const ratio = Number(this.data.ratioInput)
    if (!(ratio > 0 && ratio <= 10)) {
      wx.showToast({ title: '比例填 0 到 10 之间的数', icon: 'none' })
      return
    }
    this._saveSettings({ min_cost_ratio: ratio })
  },

  _saveSettings(patch) {
    api.saveListingApprovalSettings(patch)
      .then((settings) => {
        this.setData({ settings, ratioInput: settings.min_cost_ratio })
        wx.showToast({ title: '已保存', icon: 'success' })
        this.reload()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' }))
  },
})
