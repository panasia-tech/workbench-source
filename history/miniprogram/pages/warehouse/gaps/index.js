const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

const PAGE_SIZE = 20
const KIND_TAG = {
  unresolved: 'tag-warning',
  no_price: 'tag-info',
  no_image: 'tag-warning',
  below_cost: 'tag-danger',
  unlisted: 'tag-success',
  other: 'tag-pending',
}

Page({
  data: {
    kinds: [],
    kind: '',
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    isAdmin: false,
    settingOpen: false,
    allKinds: [],
  },

  onLoad(options) {
    if (options && options.kind) this.setData({ kind: options.kind })
  },

  onShow() {
    // 从「去补拍 / 去上架」回来要刷新：刚补好的那件该挪走了
    auth.ensureLogin().then(() => {
      this.setData({ isAdmin: getApp().globalData.user?.role === 'ADMIN' })
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

  switchKind(e) {
    const kind = e.currentTarget.dataset.kind || ''
    if (kind === this.data.kind) return
    this.setData({ kind })
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.fetch(1)
  },

  fetch(page) {
    this.setData({ loading: true })
    const params = { page, size: PAGE_SIZE }
    if (this.data.kind) params.kind = this.data.kind
    if (this.data.q.trim()) params.q = this.data.q.trim()
    return api.listStockGaps(params)
      .then((res) => {
        const items = (res.items || []).map((x) => ({ ...x, tagClass: KIND_TAG[x.kind] || 'tag-pending' }))
        const list = page === 1 ? items : this.data.list.concat(items)
        const all = (res.kinds || []).reduce((n, k) => n + k.total, 0)
        this.setData({
          kinds: [{ key: '', label: '全部', total: all }].concat(res.kinds || []),
          list,
          page,
          total: res.total,
          noMore: list.length >= res.total,
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  goFix(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },

  openSetting() {
    api.getStockGapSettings()
      .then((res) => this.setData({
        settingOpen: true,
        allKinds: res.all.map((k) => ({ ...k, checked: res.kinds.indexOf(k.key) >= 0 })),
      }))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  closeSetting() {
    this.setData({ settingOpen: false })
  },

  toggleKind(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ allKinds: this.data.allKinds.map((k) => (k.key === key ? { ...k, checked: !k.checked } : k)) })
  },

  saveSetting() {
    const kinds = this.data.allKinds.filter((k) => k.checked).map((k) => k.key)
    api.saveStockGapSettings({ kinds })
      .then(() => {
        this.setData({ settingOpen: false, kind: '' })
        wx.showToast({ title: '已保存', icon: 'success' })
        this.reload()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' }))
  },
})
