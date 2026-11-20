// H5 专有页：一张采购单买了同一件商品好几件、分几次到（禅道 WH01-04）。
// 设件数（一件都还没验时）、看每件到没到验没验、没到的件标「没到货」走退款跟踪。
// 接口 /api/purchase/orders/{id}/pieces、/quantity、/pieces/{n}/missing。
const auth = require('@services/auth')
const { request } = require('@services/request')

const STATE_CLASS = { 已入库: 'ok', 已拒签: 'bad', 没到货: 'bad' }
const REFUND_LABEL = { PENDING: '待申请', APPLIED: '已申请', ACCEPTED: '已受理', PARTIAL: '部分到账', RECEIVED: '已到账', DENIED: '被驳回', NOT_NEEDED: '不用退' }

Page({
  data: { id: '', loaded: false, d: null, qty: '', missingNo: 0, reason: '' },

  onLoad(options) {
    this.setData({ id: options.id || '' })
  },

  onShow() {
    this.load()
  },

  load() {
    return auth.ensureLogin()
      .then(() => request({ url: `/api/purchase/orders/${this.data.id}/pieces` }))
      .then((d) => this.show(d))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  show(d) {
    d.pieces = (d.pieces || []).map((p) => ({
      ...p,
      cls: STATE_CLASS[p.state] || 'wait',
      at: (p.inspected_at || '').replace('T', ' ').slice(0, 16),
      refundLabel: p.refund_status ? REFUND_LABEL[p.refund_status] || p.refund_status : '',
    }))
    this.setData({ loaded: true, d, qty: String(d.quantity), missingNo: 0, reason: '' })
  },

  onQty(e) {
    this.setData({ qty: e.detail.value })
  },

  saveQty() {
    const n = parseInt(this.data.qty, 10)
    if (!n || n < 1) {
      wx.showToast({ title: '请填件数', icon: 'none' })
      return
    }
    request({ url: `/api/purchase/orders/${this.data.id}/quantity`, method: 'PUT', data: { quantity: n } })
      .then((d) => {
        this.show(d)
        wx.showToast({ title: `已改为 ${n} 件` })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' }))
  },

  openMissing(e) {
    this.setData({ missingNo: e.currentTarget.dataset.no, reason: '' })
  },

  closeMissing() {
    this.setData({ missingNo: 0 })
  },

  onReason(e) {
    this.setData({ reason: e.detail.value })
  },

  submitMissing() {
    const reason = this.data.reason.trim()
    if (!reason) {
      wx.showToast({ title: '写明情况，比如卖家说只剩 2 件', icon: 'none' })
      return
    }
    const no = this.data.missingNo
    request({ url: `/api/purchase/orders/${this.data.id}/pieces/${no}/missing`, method: 'POST', data: { reason } })
      .then((d) => {
        this.show(d)
        wx.showModal({
          title: `第 ${no} 件已标没到货`,
          content: '已按这件的金额开了退款跟踪，业务员和采购员会收到通知。退款进度在「验货异常」里跟。',
          showCancel: false,
          confirmText: '知道了',
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' }))
  },

  goEvidence(e) {
    wx.navigateTo({ url: `/pages/purchase/evidence/index?no=${encodeURIComponent(this.data.d.order_no)}&piece=${e.currentTarget.dataset.no}` })
  },
})
