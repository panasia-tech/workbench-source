const auth = require('@services/auth')
const { request } = require('@services/request')

// 步入式价格清洗：样本 → 筛选 → 价格类型 → 异常 → 有效价 → 人工确认 → 管理员生效 → 版本回看。
// 规矩全在服务端（中位数、3C 诱饵 100、已售不算成交、7 天算旧、管理员生效），这里只展示和提交。
Page({
  data: {
    loading: true,
    d: null,
    saving: false,
    showHelp: false,
    // 确认
    price: '',
    note: '',
    low: false,
    high: false,
    // 正在改的样本
    editing: '',
    reason: '',
    // 管理员退回：每个版本各写各的
    rejectNotes: {},
    // 这批样本能不能换最新的重洗（开着的那次过期了、或者有了更新的采集）
    canRestart: false,
  },

  onLoad(options) {
    this.code = decodeURIComponent((options && options.code) || '')
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    return request({ url: `/api/price-clean/skus/${encodeURIComponent(this.code)}` })
      .then((d) => this._apply(d))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  _apply(d) {
    const eff = d.task && d.task.effective
    const median = eff && eff.median ? String(eff.median) : ''
    // 同一次清洗里剔样本、改类型、切回页面，不清掉已经填的确认价和依据；换了一次清洗才重新带中位数
    const sameTask = this.data.d && this.data.d.task && d.task && this.data.d.task.id === d.task.id
    const price = sameTask && this.priceTouched ? this.data.price : median
    const note = sameTask ? this.data.note : ''
    if (!sameTask) this.priceTouched = false
    const t = d.task
    const canRestart = !!(t && t.status === 'OPEN' && (t.stale || (d.latest_crawl_date && d.latest_crawl_date > t.crawl_date)))
    this.setData({ d, loading: false, price, note, editing: '', reason: '', canRestart })
    this._flags(price)
  },

  _flags(price) {
    const d = this.data.d
    const n = Number(price) || 0
    const cost = Number(d.sku.cost_price) || 0
    this.setData({
      low: !!(n && d.floor_price && n < d.floor_price),
      high: !!(n && cost && n > cost * d.high_multiple),
    })
  },

  _call(url, method, data, okText) {
    if (this.data.saving) return Promise.resolve()
    this.setData({ saving: true })
    return request({ url, method, data })
      .then((d) => {
        this._apply(d)
        if (okText) wx.showToast({ title: okText, icon: 'success' })
      })
      .catch((err) => wx.showModal({ title: '没成', content: (err && err.detail) || '再试一次', showCancel: false }))
      .finally(() => this.setData({ saving: false }))
  },

  toggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  start() {
    const d = this.data.d
    if (!d.can_start) {
      wx.showToast({ title: d.start_blocker || '现在不能开始', icon: 'none' })
      return
    }
    if (d.latest_stale) {
      wx.showToast({ title: `行情是 ${d.latest_crawl_date || '很久以前'} 采的，超过 ${d.fresh_days} 天算旧，等重新采集`, icon: 'none', duration: 3000 })
      return
    }
    const go = () => this._call(`/api/price-clean/skus/${encodeURIComponent(this.code)}/start`, 'POST', {}, '样本已带上')
    if (d.task && d.task.status === 'OPEN') {
      wx.showModal({
        title: '换最新样本重新清洗？',
        content: '这次剔掉、改过的样本不再算，按最新一次采集重来。',
        confirmText: '重新清洗',
        success: (r) => { if (r.confirm) go() },
      })
      return
    }
    go()
  },

  // ---------------------------------------------------------- 样本
  editSample(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ editing: this.data.editing === id ? '' : id, reason: '' })
  },

  onReason(e) {
    this.setData({ reason: e.detail.value })
  },

  _patch(id, body) {
    const taskId = this.data.d && this.data.d.task ? this.data.d.task.id : null
    return this._call(`/api/price-clean/skus/${encodeURIComponent(this.code)}/samples/${id}`, 'PATCH', { ...body, task_id: taskId })
  },

  rejectSample(e) {
    const id = e.currentTarget.dataset.id
    if ((this.data.reason || '').trim().length < 2) {
      wx.showToast({ title: '剔除要写原因', icon: 'none' })
      return
    }
    this._patch(id, { kept: false, reason: this.data.reason.trim() })
  },

  keepSample(e) {
    this._patch(e.currentTarget.dataset.id, { kept: true })
  },

  pickType(e) {
    const id = e.currentTarget.dataset.id
    const t = this.data.d.price_types[Number(e.detail.value)]
    if (t) this._patch(id, { price_type: t.key })
  },

  // ---------------------------------------------------------- 确认、生效
  onPrice(e) {
    const price = String(e.detail.value || '').replace(/[^\d]/g, '')
    this.priceTouched = true
    this.setData({ price })
    this._flags(price)
    return price
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  confirm() {
    const { price, note, low, d } = this.data
    if (low && (note || '').trim().length < 4) {
      wx.showToast({ title: `低于成本线 ${d.floor_price} 元，写清依据（至少 4 个字）`, icon: 'none' })
      return
    }
    this._call(`/api/price-clean/skus/${encodeURIComponent(this.code)}/confirm`, 'POST',
      { price: Number(price) || 0, note, task_id: d.task ? d.task.id : null }, '已出待生效版本')
  },

  onRejectNote(e) {
    this.setData({ [`rejectNotes.${e.currentTarget.dataset.id}`]: e.detail.value })
  },

  activate(e) {
    this._call(`/api/price-clean/versions/${e.currentTarget.dataset.id}/review`, 'POST', { approve: true }, '已生效')
  },

  rejectVersion(e) {
    const id = e.currentTarget.dataset.id
    const text = (this.data.rejectNotes[id] || '').trim()
    if (!text) {
      wx.showToast({ title: '退回要写原因', icon: 'none' })
      return
    }
    this._call(`/api/price-clean/versions/${id}/review`, 'POST', { approve: false, note: text }, '已退回')
  },
})
