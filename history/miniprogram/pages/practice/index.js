const auth = require('@services/auth')
const { request } = require('@services/request')
const { scanBarcode } = require('@services/scan')
const { resetTours } = require('@utils/tour')

// 上手练习（练习门禁，11-13）：演练商品走一遍实物三步。对错由服务端判，这里只管填和展示。
Page({
  data: {
    loading: true,
    p: null,
    cur: 1,
    showGuard: false,
    err: '',
    saving: false,
    // 第 1 步
    price: '',
    reason: '',
    images: [],
    imageOpts: [],
    low: false,
    high: false,
    // 再练一遍（三步都做过了，从第 1 步再走）
    redo: false,
    // 第 2 步
    choice: -1,
    // 第 3 步
    code: '',
    trackingNo: '',
    // 管理员
    isAdmin: false,
    admin: null,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      const isAdmin = (getApp().globalData.user || {}).role === 'ADMIN'
      this.setData({ isAdmin })
      this.load()
      if (isAdmin) this.loadAdmin()
    })
  },

  load() {
    return request({ url: '/api/practice' })
      .then((p) => this._apply(p))
      .catch((err) => this.setData({ loading: false, err: (err && err.detail) || '加载失败' }))
  },

  _apply(p, justDid) {
    // 再练一遍：三步都做过了，按顺序从第 1 步再走，服务端照样判对错、记录覆盖，做完的不会变回没做完
    let cur
    let redo = this.data.redo
    if (redo) {
      cur = justDid && justDid < p.steps.length ? justDid + 1 : justDid ? 0 : this.data.cur
      if (!cur) redo = false
    } else {
      const next = p.steps.find((s) => !s.done)
      cur = next ? next.no : 0
    }
    this.setData({ loading: false, p, cur, redo, err: '', showGuard: false })
    this._imageOpts(this.data.images)
  },

  toggleGuard() {
    this.setData({ showGuard: !this.data.showGuard })
  },

  // ---------------------------------------------------------- 第 1 步：定价、选图
  onPrice(e) {
    const price = String(e.detail.value || '').replace(/[^\d]/g, '')
    const item = this.data.p.item
    const n = Number(price) || 0
    this.setData({
      price,
      low: n > 0 && n < item.floor,
      high: n > item.cost * item.high_multiple,
      err: '',
    })
    return price
  },

  onReason(e) {
    this.setData({ reason: e.detail.value, err: '' })
  },

  toggleImage(e) {
    const name = e.currentTarget.dataset.name
    const images = this.data.images.slice()
    const i = images.indexOf(name)
    if (i >= 0) images.splice(i, 1)
    else images.push(name)
    this.setData({ images, err: '' })
    this._imageOpts(images)
  },

  _imageOpts(images) {
    const all = (this.data.p && this.data.p.item.images) || []
    this.setData({ imageOpts: all.map((name) => ({ name, on: images.indexOf(name) >= 0 })) })
  },

  // ---------------------------------------------------------- 第 2 步：选答案
  pickChoice(e) {
    this.setData({ choice: Number(e.currentTarget.dataset.i), err: '' })
  },

  // ---------------------------------------------------------- 第 3 步：扫码、运单
  onCode(e) {
    this.setData({ code: e.detail.value, err: '' })
  },

  onTracking(e) {
    this.setData({ trackingNo: e.detail.value, err: '' })
  },

  scan() {
    scanBarcode().then((code) => this.setData({ code, err: '' })).catch(() => {})
  },

  // ---------------------------------------------------------- 交这一步
  submit() {
    const { cur, saving } = this.data
    if (!cur || saving) return
    const body = cur === 1
      ? { price: Number(this.data.price) || 0, images: this.data.images, reason: this.data.reason }
      : cur === 2
        ? { choice: this.data.choice }
        : { code: this.data.code, tracking_no: this.data.trackingNo }
    this.setData({ saving: true, err: '' })
    request({ url: `/api/practice/steps/${cur}`, method: 'POST', data: body })
      .then((p) => {
        this._apply(p, cur)
        wx.showToast({ title: this.data.cur ? '这一步做对了' : '练习做完了', icon: 'success' })
        // H5 电脑版：让菜单红点和顶栏「真实任务先锁着」马上跟着变（小程序里没有 window，跳过）
        if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('mp:sales-badges'))
      })
      .catch((err) => this.setData({ err: (err && err.detail) || '没交上，再试一次' }))
      .finally(() => this.setData({ saving: false }))
  },

  // ---------------------------------------------------------- 管理员：开关、谁做完了
  loadAdmin() {
    request({ url: '/api/practice/progress' })
      .then((admin) => this.setData({ admin }))
      .catch(() => {})
  },

  toggleRequired() {
    const on = !(this.data.admin && this.data.admin.required)
    wx.showModal({
      title: on ? '打开练习门禁？' : '关掉练习门禁？',
      content: on
        ? '打开后，没做完练习的销售不能上架、审批、发货——已经卖出等着发的单也会被拦，要仓管或管理员发（管理员不受影响）。'
        : '关掉后谁都不拦，做过的进度留着。',
      confirmText: on ? '打开' : '关掉',
      success: (r) => {
        if (!r.confirm) return
        request({ url: '/api/practice/setting', method: 'PUT', data: { required: on } })
          .then((admin) => {
            this.setData({ admin })
            this.load()
          })
          .catch((err) => wx.showToast({ title: (err && err.detail) || '没改成', icon: 'none' }))
      },
    })
  },

  again() {
    this.setData({ cur: 1, redo: true, price: '', reason: '', images: [], low: false, high: false, choice: -1, code: '', trackingNo: '', err: '' })
    this._imageOpts([])
  },

  retour() {
    resetTours()
    wx.showToast({ title: '再进今天、库存商品、商品详情会重走一遍', icon: 'none' })
  },

  goToday() {
    wx.redirectTo({ url: '/pages/sales-workbench/index' })
  },
})
