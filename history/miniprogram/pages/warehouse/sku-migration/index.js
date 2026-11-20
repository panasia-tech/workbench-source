const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

const PAGE_SIZE = 20
const TABS = [
  { key: 'pending', label: '待更换' },
  { key: 'done', label: '已更换' },
]

function decorateItems(items = []) {
  return items.map((item) => ({
    ...item,
    migrationLabel: item.migration_status === 'DONE' ? '已更换' : '待更换',
  }))
}

Page({
  data: {
    tabs: TABS,
    tab: 'pending',
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    editorVisible: false,
    editorOldCode: '',
    editorNewCode: '',
    saving: false,
  },

  onShow() {
    auth.ensureLogin().then(() => {
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
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.reload(), 400)
  },

  onSearch() {
    this.reload()
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        if (this._searchTimer) clearTimeout(this._searchTimer)
        this.setData({ q: code })
        this.reload()
      })
      .catch(() => {})
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab })
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], total: 0, noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { tab, q, page } = this.data
    return api.listSkuMigration({
      tab,
      q: q.trim(),
      page,
      size: PAGE_SIZE,
    }).then((res) => {
      const nextItems = decorateItems(res.items || [])
      const merged = page === 1 ? nextItems : this.data.list.concat(nextItems)
      const noMore = merged.length >= (res.total || 0) || nextItems.length < PAGE_SIZE
      this.setData({
        list: merged,
        total: res.total || 0,
        page: page + 1,
        noMore,
        loading: false,
      })
    }).catch((err) => {
      this.setData({ loading: false })
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  openDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${code}` })
  },

  openEditor(e) {
    const oldCode = e.currentTarget.dataset.code
    if (!oldCode) return
    this.setData({
      editorVisible: true,
      editorOldCode: oldCode,
      editorNewCode: '',
    })
  },

  closeEditor() {
    if (this.data.saving) return
    this.setData({
      editorVisible: false,
      editorOldCode: '',
      editorNewCode: '',
    })
  },

  onEditorInput(e) {
    this.setData({ editorNewCode: (e.detail.value || '').toUpperCase().trim() })
  },

  scanNewCode() {
    scanBarcode()
      .then((code) => {
        this.setData({ editorNewCode: code.toUpperCase() })
      })
      .catch(() => {})
  },

  submitRecode() {
    const oldCode = this.data.editorOldCode
    const newCode = (this.data.editorNewCode || '').trim().toUpperCase()
    if (!oldCode || !newCode) {
      wx.showToast({ title: '请先输入新货号', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.recodeSkuMigration({
      old_sku_code: oldCode,
      new_sku_code: newCode,
    }).then(() => {
      wx.showToast({ title: '更换成功', icon: 'success' })
      this.setData({
        saving: false,
        editorVisible: false,
        editorOldCode: '',
        editorNewCode: '',
      })
      this.reload()
    }).catch((err) => {
      this.setData({ saving: false })
      wx.showToast({ title: (err && err.detail) || '更换失败', icon: 'none' })
    })
  },
})
