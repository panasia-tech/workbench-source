const api = require('@services/api')
const auth = require('@services/auth')
const { request } = require('@services/request')

// 一张虚拟产品卡：照销售工作台交付包——首屏问题箱和四个数，下面横排 8 步，点哪步看哪步；
// 当前这步就在本页交证据（缺的写「待核」，不能空、不能填 0，服务端同样拦）。
// 在售以后：订单（从聊天认出来的付款）在本页发码、放行、看码、作废换码；卡券在本页补。
const BADGE = { red: '✕ 现在动手', yellow: '! 注意', green: '✓ 正常' }
const DECISIONS = ['继续', '扩大', '调整', '暂停', '退出']
const LEVELS = ['A', 'B', 'C']
const LAWYER = [
  { key: 'unsubmitted', label: '没送审' },
  { key: 'pending', label: '审核中' },
  { key: 'passed', label: '通过' },
  { key: 'rejected', label: '没通过' },
]

Page({
  data: {
    loading: true,
    d: null,
    sel: 1,
    step: null,
    ev: [],
    form: {},
    images: [],
    peers: '',
    decisions: DECISIONS,
    decisionIdx: 0,
    levels: LEVELS,
    lawyerLabels: LAWYER.map((x) => x.label),
    rs: { codes: '', supplier: '', cost: '', expire_on: '' },
    set: {},
    shared: '',
    revealed: {},
    showHelp: false,
    busy: false,
  },

  onLoad(options) {
    this.id = (options && options.id) || ''
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load(keepSel) {
    return request({ url: `/api/virtual/products/${this.id}` })
      .then((d) => this._show(d, keepSel))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  _show(d, keepSel) {
    d.badge = BADGE[d.level]
    d.pathText = (d.path || []).join(' › ')
    d.lawyerIdx = Math.max(0, LAWYER.findIndex((x) => x.key === d.compliance.lawyer))
    d.levelIdx = Math.max(0, LEVELS.indexOf(d.compliance.level))
    d.refundPct = (d.refund_rate * 100).toFixed(1)
    d.fee = d.price ? (d.price * d.platform_fee_rate).toFixed(2) : null
    d.feePct = Number((d.platform_fee_rate * 100).toFixed(2))
    d.orders = d.orders.map((o) => ({ ...o, code: this.data.revealed[o.id] || '' }))
    const sel = keepSel ? this.data.sel : (d.state === 'pending' ? 7 : d.step)
    this.setData({
      d,
      loading: false,
      set: {
        item_ids: (d.item_urls || []).join('\n'),
        warn_at: String(d.warn_at),
        stop_at: String(d.stop_at),
        refund_limit: String(d.checks.refund_limit),
        note: d.compliance.note || '',
      },
    })
    this._pick(sel)
    wx.setNavigationBarTitle({ title: d.name || '产品卡' })
  },

  _pick(n) {
    const d = this.data.d
    const step = d.steps.find((s) => s.n === n) || d.steps[0]
    const ev = d.evidence.filter((e) => e.step === step.n)
    const form = {}
    step.fields.forEach((f) => { form[f.key] = '' })
    // 第 4 步把上一步的进价带过来，少填一次
    if (step.n === 4 && d.cost) form.cost = String(d.cost)
    this.setData({ sel: step.n, step, ev, form, images: [], peers: '', decisionIdx: 0 })
  },

  pickStep(e) {
    this._pick(Number(e.currentTarget.dataset.n))
  },

  toggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  jump(e) {
    const go = e.currentTarget.dataset.go
    if (go === 'steps') this._pick(this.data.d.state === 'pending' ? 7 : this.data.d.step)
    wx.pageScrollTo({ selector: `#vi-${go}`, duration: 200 })
  },

  onField(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  onPeers(e) {
    this.setData({ peers: e.detail.value })
  },

  onDecision(e) {
    const i = Number(e.detail.value)
    this.setData({ decisionIdx: i, 'form.decision': DECISIONS[i] })
  },

  addImage() {
    wx.chooseImage({
      count: Math.max(1, 9 - this.data.images.length),
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((p) => api.uploadMedia('virtual/evidence', '', p)))
          .then((list) => this.setData({ images: this.data.images.concat(list.map((r) => r.access_url || r.public_url)) }))
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  removeImage(e) {
    const images = this.data.images.slice()
    images.splice(e.currentTarget.dataset.i, 1)
    this.setData({ images })
  },

  preview(e) {
    wx.previewImage({ urls: e.currentTarget.dataset.urls, current: e.currentTarget.dataset.url })
  },

  _post(url, data, ok, keepSel = true) {
    if (this.data.busy) return Promise.resolve()
    this.setData({ busy: true })
    return request({ url, method: 'POST', data })
      .then((res) => {
        if (ok) wx.showToast({ title: ok, icon: 'success' })
        return res && res.steps ? this._show(res, keepSel) : this.load(keepSel)
      })
      .catch((err) => wx.showModal({ title: '没成功', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  submitStep() {
    const { step, form, images, peers } = this.data
    const missing = step.fields.filter((f) => !String(form[f.key] || '').trim()).map((f) => f.label)
    if (missing.length) {
      wx.showToast({ title: `还缺：${missing.join('、')}。不知道的写「待核」`, icon: 'none' })
      return
    }
    const title = step.n === 7 ? '申请上架？' : step.n === 8 ? '交这周复盘？' : `交第 ${step.n} 步？`
    wx.showModal({
      title,
      content: step.n === 7 ? '交上去等主管批，批了才算在售。' : '交了就记下，下一步接着做。',
      success: (r) => {
        if (r.confirm) this._post(`/api/virtual/products/${this.id}/advance`, { evidence: form, images, peers }, '交上了', false)
      },
    })
  },

  approve() {
    wx.showModal({
      title: '批准上架？',
      content: '批了这张卡就算在售：填上闲鱼链接后，买家付款会出现在这里等发码。',
      confirmText: '批准',
      success: (r) => { if (r.confirm) this._post(`/api/virtual/products/${this.id}/review`, { ok: true }, '已批准', false) },
    })
  },

  reject() {
    wx.showModal({
      title: '退回上架申请',
      editable: true,
      placeholderText: '缺哪项证据、怎么改',
      confirmText: '退回',
      success: (r) => {
        if (!r.confirm) return
        const note = (r.content || '').trim()
        if (note.length < 4) {
          wx.showToast({ title: '退回要写清楚缺哪项（至少 4 个字）', icon: 'none' })
          return
        }
        this._post(`/api/virtual/products/${this.id}/review`, { ok: false, note }, '已退回', false)
      },
    })
  },

  // ---------------- 订单
  syncNow() {
    this._post('/api/virtual/sync', {}, '已同步')
  },

  sendCode(e) {
    const o = this.data.d.orders.find((x) => x.id === e.currentTarget.dataset.id)
    wx.showModal({
      title: `给 ${o.buyer} 发码？`,
      content: this.data.d.delivery === 'card'
        ? '从库存里拿一张码，连同交付话术和使用指引发进这个买家的聊天。'
        : '把产品卡上的内容连同话术发进这个买家的聊天。',
      confirmText: '发送',
      success: (r) => { if (r.confirm) this._post(`/api/virtual/orders/${o.id}/send`, {}, '已交给群控发送') },
    })
  },

  release(e) {
    const o = this.data.d.orders.find((x) => x.id === e.currentTarget.dataset.id)
    wx.showModal({
      title: '放行这一单？',
      content: `拦住的原因：${(o.hits || []).join('；')}\n确认没问题再放行，放行会记下是你放的。`,
      confirmText: '放行',
      success: (r) => { if (r.confirm) this._post(`/api/virtual/orders/${o.id}/release`, {}, '已放行') },
    })
  },

  delivered(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '已经交付了？',
      editable: true,
      placeholderText: '怎么交付的，如：已代充到 138****0000',
      confirmText: '记下',
      success: (r) => { if (r.confirm) this._post(`/api/virtual/orders/${id}/delivered`, { note: (r.content || '').trim() }, '已记下') },
    })
  },

  reveal(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '看这单的码？',
      content: '每看一次都会记下：谁、什么时候、哪一单。',
      confirmText: '看',
      success: (r) => {
        if (!r.confirm) return
        request({ url: `/api/virtual/orders/${id}/reveal`, method: 'POST' })
          .then((res) => {
            const revealed = { ...this.data.revealed, [id]: res.code }
            const orders = this.data.d.orders.map((o) => (o.id === id ? { ...o, code: res.code } : o))
            this.setData({ revealed, 'd.orders': orders })
          })
          .catch((err) => wx.showToast({ title: (err && err.detail) || '没看成', icon: 'none' }))
      },
    })
  },

  copyCode(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.code })
  },

  voidCode(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '这张码作废？',
      editable: true,
      placeholderText: '为什么作废，如：买家说已被使用',
      confirmText: '作废',
      success: (r) => {
        if (r.confirm) this._post(`/api/virtual/orders/${id}/void`, { note: (r.content || '').trim() }, '已作废，再点发码换一张')
      },
    })
  },

  flagBuyer(e) {
    const o = this.data.d.orders.find((x) => x.id === e.currentTarget.dataset.id)
    const on = !(o.buyer_flag && o.buyer_flag.blacklisted)
    wx.showModal({
      title: on ? `把 ${o.buyer} 拉进退款名单？` : `把 ${o.buyer} 移出退款名单？`,
      editable: on,
      placeholderText: '为什么，如：要了码说没收到',
      confirmText: on ? '拉进' : '移出',
      success: (r) => {
        if (r.confirm) {
          this._post('/api/virtual/buyers', { buyer_key: o.buyer_key, buyer_name: o.buyer, blacklisted: on, note: (r.content || '').trim() },
            on ? '已拉进名单' : '已移出')
        }
      },
    })
  },

  // ---------------- 库存
  onRs(e) {
    this.setData({ [`rs.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  restock() {
    const rs = this.data.rs
    const n = rs.codes.split('\n').filter((x) => x.trim()).length
    if (!n) {
      wx.showToast({ title: '把码贴进来，一行一张', icon: 'none' })
      return
    }
    if (this.data.busy) return
    this.setData({ busy: true })
    request({ url: `/api/virtual/products/${this.id}/restock`, method: 'POST', data: rs })
      .then((res) => {
        wx.showModal({
          title: `入库 ${res.added} 张`,
          content: res.dup ? `${res.dup} 张重复（这次贴了两遍或库里已有），没再入。` : '没有重复的。',
          showCancel: false,
        })
        this.setData({ rs: { codes: '', supplier: '', cost: '', expire_on: '' } })
        this._show(res.product, true)
      })
      .catch((err) => wx.showModal({ title: '没入库', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  onShared(e) {
    this.setData({ shared: e.detail.value })
  },

  saveShared() {
    this._patch({ shared_content: this.data.shared }, '已保存').then(() => this.setData({ shared: '' }))
  },

  // ---------------- 设置
  onSet(e) {
    this.setData({ [`set.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  _patch(data, ok) {
    if (this.data.busy) return Promise.resolve()
    this.setData({ busy: true })
    return request({ url: `/api/virtual/products/${this.id}/settings`, method: 'POST', data })
      .then((d) => {
        if (ok) wx.showToast({ title: ok, icon: 'success' })
        this._show(d, true)
      })
      .catch((err) => wx.showModal({ title: '没改成', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  saveSet() {
    const s = this.data.set
    this._patch({
      item_ids: s.item_ids,
      warn_at: s.warn_at,
      stop_at: s.stop_at,
      checks: { refund_limit: s.refund_limit },
    }, '已保存')
  },

  _editable() {
    if (this.data.d.can_edit) return true
    wx.showToast({ title: '这张产品卡不是你负责的，找负责人或主管', icon: 'none' })
    return false
  },

  toggleCheck(e) {
    if (!this._editable()) return
    const k = e.currentTarget.dataset.k
    this._patch({ checks: { [k]: !this.data.d.checks[k] } })
  },

  toggleAuto() {
    if (!this._editable()) return
    const on = !this.data.d.auto_delivery
    this._patch({ auto_delivery: on }, on ? '已打开' : '已关掉')
  },

  onLevel(e) {
    this._patch({ compliance: { level: LEVELS[Number(e.detail.value)] } })
  },

  onLawyer(e) {
    this._patch({ compliance: { lawyer: LAWYER[Number(e.detail.value)].key } })
  },

  saveLawNote() {
    this._patch({ compliance: { note: this.data.set.note } }, '已保存')
  },

  onAdminDecision(e) {
    const decision = DECISIONS[Number(e.detail.value)]
    wx.showModal({
      title: `改成「${decision}」？`,
      content: decision === '暂停' || decision === '退出' ? '暂停、退出会关掉这张卡的自动发货，记得去闲鱼下架。' : '',
      success: (r) => { if (r.confirm) this._patch({ decision }, '已改') },
    })
  },
})
