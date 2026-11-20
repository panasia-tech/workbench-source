const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

// 手机扫码盘点(#101):挨个扫货上的条码,扫完点「完成比对」,系统拿全部在库货对一遍,
// 对上几件、少了几件(系统有没扫到)、多了几件(扫到了系统不在库)。有差异提交给管理员审批平账。
// 接口和 RFID 手持机是同一套,一个人同时只有一张没结的盘点单。

Page({
  data: {
    loading: true,
    session: null,       // 没结的盘点单;null = 可以开新的
    code: '',
    recent: [],          // 最近扫的在前
    busy: false,
    keepScanning: true,
  },

  onLoad() {
    auth.ensureLogin().then(() => {
      const role = getApp().globalData.user && getApp().globalData.user.role
      if (role !== 'WAREHOUSE' && role !== 'ADMIN') {
        wx.showToast({ title: '仓管和管理员才能盘点', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      this.load()
    })
  },

  onShow() {
    if (this._shown) this.load()
    this._shown = true
  },

  load() {
    return api.stocktakeActive().then((s) => {
      this.setSession(s)
      this.setData({ loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  setSession(s) {
    const items = (s && s.scanned_items) || []
    this.setData({ session: s || null, recent: items.slice().reverse() })
  },

  start() {
    if (this.data.busy) return
    this.setData({ busy: true })
    api.stocktakeStart()
      .then((s) => this.setSession(s))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '开始盘点失败', icon: 'none' }))
      .finally(() => this.setData({ busy: false }))
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value })
  },

  onKeepScanning(e) {
    this.setData({ keepScanning: e.detail.value })
  },

  addTyped() {
    const code = (this.data.code || '').trim()
    if (!code) return
    this.add(code, 'MANUAL').then((ok) => { if (ok) this.setData({ code: '' }) })
  },

  scan() {
    scanBarcode()
      .then((code) => this.add(code, 'SCAN'))
      .then((ok) => { if (ok && this.data.keepScanning) setTimeout(() => this.scan(), 400) })
      .catch(() => {})
  },

  // 返回是否计入;重复扫、盘点已暂停这类给提示,不算失败到要停扫
  add(code, source) {
    const s = this.data.session
    if (!s) return Promise.resolve(false)
    return api.stocktakeAddItem(s.id, { sku_code: code, source }).then((next) => {
      this.setSession(next)
      const hit = (next.scanned_items || []).slice(-1)[0] || {}
      wx.vibrateShort && wx.vibrateShort({ type: 'light' })
      wx.showToast({ title: hit.product_name ? `已盘 ${next.scanned_count} 件` : '系统里没有这个货号，已记下', icon: 'none' })
      return true
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '扫码失败', icon: 'none' })
      return false
    })
  },

  pause() {
    const s = this.data.session
    api.stocktakePause(s.id)
      .then((next) => this.setSession(next))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '暂停失败', icon: 'none' }))
  },

  resume() {
    const s = this.data.session
    api.stocktakeResume(s.id)
      .then((next) => this.setSession(next))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '继续失败', icon: 'none' }))
  },

  complete() {
    const s = this.data.session
    wx.showModal({
      title: '完成比对',
      content: `已扫 ${s.scanned_count} 件，系统在库 ${s.warehouse_count} 件。比对后就不能再扫了，确定吗？`,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ busy: true })
        api.stocktakeComplete(s.id)
          .then((next) => wx.redirectTo({ url: `/pages/warehouse/stocktake-records/detail/index?id=${next.id}` }))
          .catch((err) => wx.showToast({ title: (err && err.detail) || '完成比对失败', icon: 'none' }))
          .finally(() => this.setData({ busy: false }))
      },
    })
  },

  openResult() {
    wx.navigateTo({ url: `/pages/warehouse/stocktake-records/detail/index?id=${this.data.session.id}` })
  },
})
