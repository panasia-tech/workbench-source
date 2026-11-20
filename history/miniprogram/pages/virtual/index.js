const auth = require('@services/auth')
const { request } = require('@services/request')

// 虚拟商品（卡券、数字权益）：照销售工作台交付包的「虚拟选品」——分类一层层点下去，每张产品卡标红黄绿。
// 红 = 现在动手（付款没发码、卡券用完），黄 = 注意，绿 = 没事。点卡进产品卡走 8 步、补码、发码。
const BADGE = { red: '✕ 现在动手', yellow: '! 注意', green: '✓ 正常' }
const DELIVERY = [
  { key: 'card', label: '有卡券（每单发不同的码）' },
  { key: 'nocard', label: '无卡券（人人发同一份内容）' },
  { key: 'topup', label: '代充（来一单去充一单）' },
  { key: 'manual', label: '人工交付' },
]

Page({
  data: {
    loading: true,
    items: [],
    shown: [],
    tree: [],
    counts: { red: 0, yellow: 0, green: 0 },
    l1: '',
    l2: '',
    l2s: [],
    level: '',
    mine: false,
    q: '',
    isAdmin: false,
    auto: false,
    showNew: false,
    showHelp: false,
    form: { name: '', brand: '', face: '', path: '', delivery: 0 },
    deliveryLabels: DELIVERY.map((x) => x.label),
    pathHints: [],
    busy: false,
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    const qs = this.data.mine ? '?mine=true' : ''
    return request({ url: `/api/virtual/products${qs}` })
      .then((d) => {
        const items = d.items.map((c) => ({
          ...c,
          badge: BADGE[c.level],
          pathText: (c.path || []).join(' › '),
          stepText: c.state === 'on_sale' || c.state === 'paused' || c.state === 'exited'
            ? c.state_label
            : `第 ${c.step}/8 步 · ${(d.sop.find((s) => s.n === c.step) || {}).title || ''}${c.state === 'pending' ? '（等批）' : ''}`,
        }))
        const hints = []
        const walk = (nodes, pre) => nodes.forEach((n) => {
          const p = pre.concat(n.name)
          if (p.length >= 2) hints.push(p.join(' › '))
          walk(n.kids || [], p)
        })
        walk(d.tree, [])
        this.setData({
          loading: false, items, tree: d.tree, counts: d.counts, isAdmin: d.is_admin, auto: d.auto_delivery,
          pathHints: hints.slice(0, 30),
        })
        this._filter()
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  _filter() {
    const { items, l1, l2, level, q, tree } = this.data
    const k = (q || '').trim().toLowerCase()
    const shown = items.filter((c) => {
      if (l1 && c.path[0] !== l1) return false
      if (l2 && c.path[1] !== l2) return false
      if (level && c.level !== level) return false
      if (k && `${c.code} ${c.name} ${c.brand || ''} ${c.pathText}`.toLowerCase().indexOf(k) < 0) return false
      return true
    })
    const node = tree.find((n) => n.name === l1)
    this.setData({ shown, l2s: node ? node.kids : [] })
  },

  pickL1(e) {
    const name = e.currentTarget.dataset.name
    this.setData({ l1: this.data.l1 === name ? '' : name, l2: '' })
    this._filter()
  },

  pickL2(e) {
    const name = e.currentTarget.dataset.name
    this.setData({ l2: this.data.l2 === name ? '' : name })
    this._filter()
  },

  pickLevel(e) {
    const lv = e.currentTarget.dataset.lv
    this.setData({ level: this.data.level === lv ? '' : lv })
    this._filter()
  },

  toggleMine() {
    this.setData({ mine: !this.data.mine })
    this.load()
  },

  onSearch(e) {
    this.setData({ q: e.detail.value })
    this._filter()
  },

  open(e) {
    wx.navigateTo({ url: `/pages/virtual/item/index?id=${e.currentTarget.dataset.id}` })
  },

  toggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  toggleNew() {
    const form = { ...this.data.form }
    // 新建时分类默认带上现在点着的那层
    if (!this.data.showNew && !form.path && this.data.l1) form.path = [this.data.l1, this.data.l2].filter(Boolean).join(' › ')
    this.setData({ showNew: !this.data.showNew, form })
  },

  onForm(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  pickHint(e) {
    this.setData({ 'form.path': e.currentTarget.dataset.p })
  },

  create() {
    const f = this.data.form
    if (!f.name.trim()) {
      wx.showToast({ title: '写一下这是什么商品', icon: 'none' })
      return
    }
    if (!f.path.trim()) {
      wx.showToast({ title: '选一个分类，或者照「A 码券类 › A1 餐饮券」写', icon: 'none' })
      return
    }
    if (this.data.busy) return
    this.setData({ busy: true })
    request({
      url: '/api/virtual/products',
      method: 'POST',
      data: { name: f.name, brand: f.brand, face: f.face, path: f.path, delivery: DELIVERY[Number(f.delivery)].key },
    })
      .then((p) => {
        this.setData({ showNew: false, form: { name: '', brand: '', face: '', path: '', delivery: 0 } })
        wx.navigateTo({ url: `/pages/virtual/item/index?id=${p.id}` })
      })
      .catch((err) => wx.showModal({ title: '没建上', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  toggleAuto() {
    const on = !this.data.auto
    wx.showModal({
      title: on ? '打开自动发货？' : '关掉自动发货？',
      content: on
        ? '打开后，产品卡上也开了自动发货的，买家一付款系统就把码发进聊天，不等人点。被检查拦住的单照样等人放行。'
        : '关掉后所有虚拟单都要人点「发码」。',
      confirmText: on ? '打开' : '关掉',
      success: (r) => {
        if (!r.confirm) return
        request({ url: `/api/virtual/settings/auto-delivery?on=${on}`, method: 'POST' })
          .then(() => this.setData({ auto: on }))
          .catch((err) => wx.showToast({ title: (err && err.detail) || '没改成', icon: 'none' }))
      },
    })
  },
})
