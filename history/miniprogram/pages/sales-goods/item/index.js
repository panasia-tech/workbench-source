const auth = require('@services/auth')
const { request } = require('@services/request')
const { startTour } = require('@utils/tour')

// 一件货（实物详情）：照销售工作台交付包——首屏是图、问题箱和四个价，下面横排五步。
// 点哪一步看哪一步：各号走到哪了直接列在本页，等审批的号在本页就能通过 / 退回；
// 填价选图、发布、发货还是去现成页面做（那几页的规矩多，不另写一份）。没轮到的步骤说明先做哪步。
const BADGE = { red: '✕', yellow: '!', green: '✓' }

Page({
  data: {
    loading: true,
    d: null,
    cur: 0,
    sel: 0,
    step: null,
    rows: [],
    hint: '',
    showMore: false,
    showHelp: false,
    busy: false,
  },

  onLoad(options) {
    this.code = decodeURIComponent((options && options.code) || '')
  },

  onShow() {
    // 从处理页回来要刷新：刚做完的那步该打勾了
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    return request({ url: `/api/sales-workbench/goods/${encodeURIComponent(this.code)}` })
      .then((d) => {
        const keepSel = this.data.d && this.data.sel
        d.badge = `${BADGE[d.card.level]} ${d.card.level_label}`
        d.cycleText = d.card.age_days === null || d.card.age_days === undefined
          ? ''
          : (d.card.age_stage === 'stale' ? `满 ${d.card.cycle} 周期 · ${d.card.age_days} 天` : `第 ${d.card.cycle} 周期 · ${d.card.age_days} 天`)
        this.setData({ d, loading: false, cur: Math.min(this.data.cur, Math.max(0, (d.photos || []).length - 1)) })
        this._pick(keepSel || d.current || 5)
        wx.setNavigationBarTitle({ title: d.card.product_name || '商品' })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // 选中第几步：面板里列这一步要看的那几个号
  _pick(no) {
    const d = this.data.d
    const step = d.steps.find((s) => s.no === no) || d.steps[0]
    const shops = d.shops || []
    let rows = []
    if (step.no === 2) rows = shops
    else if (step.no === 3) rows = shops.filter((s) => s.state === 'SUBMITTED' || s.state === 'APPROVED')
    else if (step.no === 4) rows = shops.filter((s) => s.state === 'APPROVED' || s.listed)
    rows = rows.map((s) => ({
      ...s,
      tone: s.needs_fix || s.state === 'REJECTED' || s.state === 'STALE' ? 'red'
        : s.state === 'APPROVED' ? 'green' : 'yellow',
      // 本页能不能直接批；不能就写原因（灰按钮要说明）
      reviewLock: s.state !== 'SUBMITTED' ? ''
        : s.submitted_by_me ? '自己提交的要别人批'
          : s.below_floor && !d.can_review_low_price ? '低于最低价，只有管理员能批' : '',
    }))
    // 别的号还没清洗时第 3 步整体算没轮到，但已经提交的号可以先批
    const waiting = step.no === 3 ? rows.filter((s) => s.state === 'SUBMITTED').length : 0
    const hint = waiting ? `${waiting} 个号等审批，在这里直接通过或退回` : ''
    this.setData({ sel: step.no, step, rows, hint })
  },

  pickStep(e) {
    this._pick(Number(e.currentTarget.dataset.no))
  },

  pickPhoto(e) {
    this.setData({ cur: Number(e.currentTarget.dataset.i) })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },

  tapLocked(e) {
    wx.showToast({ title: e.currentTarget.dataset.lock || '还没轮到这一步', icon: 'none' })
  },

  approve(e) {
    const { id, label, lock } = e.currentTarget.dataset
    if (lock) {
      wx.showToast({ title: lock, icon: 'none' })
      return
    }
    const shop = ((this.data.d && this.data.d.shops) || []).find((x) => x.id === id)
    wx.showModal({
      title: `通过「${label}」？`,
      content: shop && shop.below_floor
        ? `低于最低价。理由：${shop.note || '没写'}\n通过后这个号按这个价和图发布。`
        : '通过后这个号按批过的价和图发布。',
      confirmText: '通过',
      success: (r) => { if (r.confirm) this._review(id, true, '') },
    })
  },

  reject(e) {
    const { id, label } = e.currentTarget.dataset
    wx.showModal({
      title: `退回「${label}」`,
      editable: true,
      placeholderText: '写清哪里不对，提交的人照着改',
      confirmText: '退回',
      success: (r) => {
        if (!r.confirm) return
        const note = (r.content || '').trim()
        if (!note) {
          wx.showToast({ title: '退回要写原因', icon: 'none' })
          return
        }
        this._review(id, false, note)
      },
    })
  },

  buyerCancelled() {
    wx.showModal({
      title: '买家取消了，货放回在库？',
      editable: true,
      placeholderText: '怎么取消的，如：买家拍错了已退款',
      confirmText: '放回在库',
      success: (r) => {
        if (!r.confirm) return
        const reason = (r.content || '').trim()
        if (reason.length < 2) {
          wx.showToast({ title: '写一句怎么取消的', icon: 'none' })
          return
        }
        if (this.data.busy) return
        this.setData({ busy: true })
        request({
          url: `/api/sales-workbench/goods/${encodeURIComponent(this.code)}/buyer-cancelled`,
          method: 'POST',
          data: { reason },
        })
          .then(() => {
            wx.showToast({ title: '已放回在库', icon: 'success' })
            return this.load()
          })
          .catch((err) => wx.showModal({ title: '没放回', content: (err && err.detail) || '操作失败', showCancel: false }))
          .finally(() => this.setData({ busy: false }))
      },
    })
  },

  _review(shopId, approve, note) {
    if (this.data.busy) return
    this.setData({ busy: true })
    request({
      url: `/api/listing-approvals/skus/${encodeURIComponent(this.code)}/review`,
      method: 'POST',
      data: { shop_ids: [shopId], approve, note: note || null },
    })
      .then(() => {
        wx.showToast({ title: approve ? '已通过' : '已退回', icon: 'success' })
        return this.load()
      })
      .catch((err) => wx.showModal({ title: approve ? '没批上' : '没退回', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  toggleMore() {
    this.setData({ showMore: !this.data.showMore })
  },

  toggleHelp() {
    // 打开说明时顺带走一遍本页导览（H5 里）
    if (!this.data.showHelp) startTour()
    this.setData({ showHelp: !this.data.showHelp })
  },

  goDetail() {
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${encodeURIComponent(this.code)}` })
  },
})
