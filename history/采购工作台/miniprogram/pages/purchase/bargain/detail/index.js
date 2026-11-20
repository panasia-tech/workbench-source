const api = require('@services/api')
const auth = require('@services/auth')

const STATE_LABEL = {
  IDENTIFY: '识别', QUOTE: '报价', COUNTER: '还价', DEAL: '谈妥',
  PAUSING: '待确认暂停', PAUSED: '已暂停', CLOSED: '结束',
}

const CHECK_LABEL = {
  PENDING: '待核', DECLARED: '卖家已声明', VERIFIED: '已核对', SKIPPED: '跳过',
}

function decorate(d) {
  const checks = (d.checks || []).map((c) => ({
    ...c,
    statusLabel: CHECK_LABEL[c.status] || c.status,
    pending: c.status === 'PENDING',
  }))
  return {
    ...d,
    stateLabel: STATE_LABEL[d.state] || d.state,
    // 服务端记的是 UTC（带 Z），原样显示比北京时间慢 8 小时
    events: (d.events || []).slice().reverse().map((e) => ({ ...e, at: cnTime(e.at) })),
    canAct: d.state !== 'DEAL' && d.state !== 'CLOSED',
    checks,
    pendingRequired: d.pending_required || 0,
  }
}

function cnTime(iso) {
  const t = Date.parse(iso || '')
  if (Number.isNaN(t)) return iso || ''
  const d = new Date(t + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

Page({
  data: {
    id: '',
    d: null,
    price: '',
    note: '',
    busy: false,
    STATE_LABEL,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    if (!this.data.id) return
    return api.getBargainSession(this.data.id)
      .then((d) => this.setData({ d: decorate(d) }))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  onPrice(e) { this.setData({ price: e.detail.value }) },
  onNote(e) { this.setData({ note: e.detail.value }) },

  act(e) {
    const action = e.currentTarget.dataset.action
    if (this.data.busy) return
    if (['quote', 'counter', 'deal'].includes(action) && !(Number(this.data.price) > 0)) {
      wx.showToast({ title: '请填写价格', icon: 'none' })
      return
    }
    if (action === 'deal' && (this.data.d.pendingRequired || 0) > 0) {
      wx.showModal({
        title: '还有必要问题待核',
        content: `还有 ${this.data.d.pendingRequired} 项必核未完成，请先在下方核对。`,
        showCancel: false,
      })
      return
    }
    this.setData({ busy: true })
    api.bargainTransition(this.data.id, {
      action,
      price: this.data.price ? Number(this.data.price) : null,
      note: this.data.note || null,
    })
      .then((d) => {
        this.setData({ price: '', note: '', d: decorate(d) })
        wx.showToast({ title: STATE_LABEL[d.state] || '已更新', icon: 'success' })
      })
      .catch((err) => wx.showModal({ title: '还不能操作', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  setCheck(e) {
    const { key, status } = e.currentTarget.dataset
    if (!key || !status || this.data.busy) return
    const run = (note) => {
      this.setData({ busy: true })
      api.bargainUpdateCheck(this.data.id, { key, status, note: note || null })
        .then((d) => {
          this.setData({ d: decorate(d) })
          wx.showToast({ title: CHECK_LABEL[status] || '已更新', icon: 'success' })
        })
        .catch((err) => wx.showToast({ title: (err && err.detail) || '更新失败', icon: 'none' }))
        .finally(() => this.setData({ busy: false }))
    }
    if (status === 'DECLARED' || status === 'VERIFIED') {
      wx.showModal({
        title: status === 'DECLARED' ? '卖家已声明' : '已核对',
        editable: true,
        placeholderText: status === 'DECLARED' ? '卖家原话（可选）' : '核对说明（可选）',
        success: (res) => {
          if (res.confirm) run(res.content || '')
        },
      })
      return
    }
    run()
  },

  goCreatePurchase() {
    const d = this.data.d
    if (!d || d.state !== 'DEAL') {
      wx.showToast({ title: '谈妥后才能建采购单', icon: 'none' })
      return
    }
    const q = [
      `bargain_session_id=${encodeURIComponent(d.id)}`,
      d.platform_item_id ? `platform_item_id=${encodeURIComponent(d.platform_item_id)}` : '',
      d.source_url ? `source_url=${encodeURIComponent(d.source_url)}` : '',
      d.seller_name ? `seller_name=${encodeURIComponent(d.seller_name)}` : '',
      d.purchase_account ? `purchase_account=${encodeURIComponent(d.purchase_account)}` : '',
      d.deal_price != null ? `unit_price=${encodeURIComponent(String(d.deal_price))}` : '',
      d.title ? `title=${encodeURIComponent(d.title)}` : '',
    ].filter(Boolean).join('&')
    wx.navigateTo({ url: `/pages/purchase/index?${q}` })
  },

  goPurchaseDetail() {
    if (!this.data.d || !this.data.d.purchase_order_id) return
    wx.navigateTo({ url: `/pages/purchase/detail/index?id=${this.data.d.purchase_order_id}` })
  },

  goGcChat() {
    const id = this.data.d && this.data.d.gc_conversation_id
    if (!id) return
    const d = this.data.d
    const q = [
      `id=${encodeURIComponent(id)}`,
      d.seller_name ? `title=${encodeURIComponent(d.seller_name)}` : '',
      d.purchase_account ? `acc=${encodeURIComponent(d.purchase_account)}` : '',
      d.title ? `item=${encodeURIComponent(d.title)}` : '',
      d.listed_price != null ? `price=${encodeURIComponent(String(d.listed_price))}` : '',
    ].filter(Boolean).join('&')
    wx.navigateTo({ url: `/pages/gc-chat/detail/index?${q}` })
  },
})
