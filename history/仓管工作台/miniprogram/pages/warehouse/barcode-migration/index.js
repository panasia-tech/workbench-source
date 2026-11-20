const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

const PAGE_SIZE = 20
const TABS = [
  { key: 'pending', label: '待更换' },
  { key: 'done', label: '已更换' },
  { key: 'missing', label: '未查到' },
]
// 与后端 normalize_barcode 保持一致：EAN-8 / UPC-A / EAN-13(69码) / ITF-14
const VALID_LENGTHS = [8, 12, 13, 14]

function decorateItems(items = []) {
  return items.map((item) => ({
    ...item,
    migrationLabel: item.migration_status === 'DONE' ? '已更换' : '待更换',
    actionLabel: item.barcode ? '更换 69码' : '录入 69码',
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
    editorSkuCode: '',
    editorOldBarcode: '',
    editorNewBarcode: '',
    saving: false,
    relookupCode: '',
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
    return api.listBarcodeMigration({
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
    const { code, barcode } = e.currentTarget.dataset
    if (!code) return
    this.setData({
      editorVisible: true,
      editorSkuCode: code,
      editorOldBarcode: barcode || '',
      editorNewBarcode: '',
    })
  },

  closeEditor() {
    if (this.data.saving) return
    this.setData({
      editorVisible: false,
      editorSkuCode: '',
      editorOldBarcode: '',
      editorNewBarcode: '',
    })
  },

  onEditorInput(e) {
    // 69码只可能是数字，扫码枪/输入法带进来的空格、连字符直接滤掉
    this.setData({ editorNewBarcode: (e.detail.value || '').replace(/\D/g, '') })
  },

  scanNewBarcode() {
    scanBarcode()
      .then((code) => {
        this.setData({ editorNewBarcode: (code || '').replace(/\D/g, '') })
      })
      .catch(() => {})
  },

  // 「未查到」多半是录码时条码库没查成（早期没配 AppCode / 接口抖动），
  // 码本身是对的，重查一次即可补上 SPU，不必让仓管重录
  relookup(e) {
    const code = e.currentTarget.dataset.code
    if (!code || this.data.relookupCode) return
    this.setData({ relookupCode: code })
    wx.showLoading({ title: '查询中…', mask: true })
    api.lookupSkuBarcode(code).then(() => {
      wx.showToast({ title: '已查到，已补全 SPU', icon: 'success' })
      this.reload()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '仍未查到', icon: 'none' })
    }).finally(() => {
      wx.hideLoading()
      this.setData({ relookupCode: '' })
    })
  },

  submitBarcode() {
    const skuCode = this.data.editorSkuCode
    const barcode = (this.data.editorNewBarcode || '').replace(/\D/g, '')
    if (!skuCode || !barcode) {
      wx.showToast({ title: '请先输入新 69码', icon: 'none' })
      return
    }
    if (VALID_LENGTHS.indexOf(barcode.length) < 0) {
      wx.showToast({ title: '69码应为 8/12/13/14 位数字', icon: 'none' })
      return
    }
    if (barcode === this.data.editorOldBarcode) {
      wx.showToast({ title: '与原 69码相同', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.recodeBarcodeMigration({
      sku_code: skuCode,
      barcode,
    }).then((res) => {
      // 写码成功但条码库没查到 SPU 时明确提示，避免仓管以为是失败
      const ok = res && res.spu_text
      wx.showToast({
        title: ok ? '更换成功' : '已保存，条码库未查到',
        icon: ok ? 'success' : 'none',
      })
      this.setData({
        saving: false,
        editorVisible: false,
        editorSkuCode: '',
        editorOldBarcode: '',
        editorNewBarcode: '',
      })
      this.reload()
    }).catch((err) => {
      this.setData({ saving: false })
      wx.showToast({ title: (err && err.detail) || '更换失败', icon: 'none' })
    })
  },
})
