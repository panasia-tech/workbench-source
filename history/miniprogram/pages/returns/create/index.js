const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const REASON_OPTIONS = [
  { key: 'CUSTOMER_CANCEL', label: '客户取消' },
  { key: 'CUSTOMER_REJECT', label: '客户拒收' },
  { key: 'CUSTOMER_RETURN', label: '客户退货' },
  { key: 'WRONG_ITEM', label: '发错商品' },
  { key: 'LOGISTICS_RETURN', label: '物流退回' },
  { key: 'INTERNAL_ERROR', label: '内部出库错误' },
  { key: 'OTHER', label: '其他' },
]

const PAGE_SIZE = 20

Page({
  data: {
    q: '',
    list: [],
    loading: false,
    noMore: false,
    listScrollTop: 0,
    selectedCode: '',
    reason: '',
    reasonOptions: REASON_OPTIONS,
    reasonIndex: -1,
    submitting: false,
  },

  onLoad(options) {
    // 出库记录「商品退回」入口带货号进来：自动搜索并选中；否则直接列最近出库
    const code = ((options && options.sku_code) || '').trim()
    if (code) {
      this.setData({ q: code })
      this.loadList(true).then(() => this.autoSelect(code))
    } else {
      this.loadList(true)
    }
  },

  // 列表限高在 scroll-view 内翻页，不用页面级 onReachBottom：
  // 列表在表单上方，页面触底翻页会让想滚到表单的人一直触发加载
  onListLower() {
    if (!this.data.loading && !this.data.noMore) this.loadList(false)
  },

  loadList(reset) {
    if (reset) this._page = 1
    this.setData({ loading: true })
    const params = { page: this._page || 1, size: PAGE_SIZE, all_operators: true }
    const q = (this.data.q || '').trim()
    if (q) params.q = q
    return api.listOutbounds(params)
      .then((res) => {
        const items = res.items || []
        const list = reset ? items : this.data.list.concat(items)
        this._page = (this._page || 1) + 1
        const patch = {
          list,
          loading: false,
          noMore: list.length >= (res.total || 0) || items.length < PAGE_SIZE,
        }
        // 重搜后把列表滚回顶部（0→0 不触发，交替一个肉眼不可见的偏移）
        if (reset) patch.listScrollTop = this.data.listScrollTop === 0 ? 0.1 : 0
        this.setData(patch)
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  autoSelect(code) {
    const hit = this.data.list.find((item) => item.sku_code === code && !item.has_return)
    if (hit) this.setData({ selectedCode: code })
  },

  onQInput(e) {
    this.setData({ q: e.detail.value })
  },

  onSearch() {
    this.setData({ selectedCode: '' })
    return this.loadList(true)
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        const cleaned = String(code || '').trim()
        if (!cleaned) return
        this.setData({ q: cleaned, selectedCode: '' })
        // 扫码即货号：命中未退货记录时直接选中
        this.loadList(true).then(() => this.autoSelect(cleaned))
      })
      .catch(() => {})
  },

  onReasonInput(e) {
    this.setData({ reason: e.detail.value })
  },

  onReasonChange(e) {
    this.setData({ reasonIndex: Number(e.detail.value) })
  },

  selectSku(e) {
    const { code, returned } = e.currentTarget.dataset
    if (!code) return
    if (returned) {
      wx.showToast({ title: '该商品已有退货记录', icon: 'none' })
      return
    }
    // 再点一次取消选中
    const next = this.data.selectedCode === code ? '' : code
    this.setData({ selectedCode: next }, () => {
      // 选中后把退货信息表单滚进视野
      if (next) wx.pageScrollTo({ selector: '.ret-submit-card', duration: 200 })
    })
  },

  onSubmit() {
    if (this.data.submitting || !this.data.selectedCode) return
    const { reasonIndex, reasonOptions } = this.data
    if (reasonIndex < 0) {
      wx.showToast({ title: '请选择退回原因', icon: 'none' })
      return
    }
    const reasonCode = reasonOptions[reasonIndex].key
    const reason = (this.data.reason || '').trim()
    if (reasonCode === 'OTHER' && !reason) {
      wx.showToast({ title: '选择「其他」时请填写说明', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.createReturn({
      sku_code: this.data.selectedCode,
      reason_code: reasonCode,
      reason: reason || null,
    })
      .then(() => {
        wx.showToast({ title: '已创建', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '创建失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
