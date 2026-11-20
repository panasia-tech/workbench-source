// H5 专有页：采购在采购单上看这件货的验货凭证——不通过/无法测试的项（部位、卖家描述 vs 实测）、
// 瑕疵照、开箱视频、异常进度。议价、退货退款拿这个对（禅道 WH05-03/04/08）。接口 /api/inspection-ops/orders/{no}/inspection。
// 一单多件时凭证按件分开，顶上切换看第几件（WH01-04）。
// 采购工作台 W12：异常单上能直接改平台售后（已提交要传回执）、记卖家的留货补差提议，不用回电脑后台（手机、电脑版共用这份）。
const api = require('@services/api')
const auth = require('@services/auth')
const { request } = require('@services/request')

const RESULT_LABEL = { FAIL: '不通过', UNTESTABLE: '无法测试' }
const KIND_LABEL = { UNBOX_VIDEO: '开箱视频', PRODUCT_PHOTO: '商品照', DEFECT_PHOTO: '瑕疵照' }
const REJECT_LABEL = { PENDING: '待拒签', REJECTED: '已拒签', RETURNING: '退回中', RETURNED: '已退回', NOT_NEEDED: '不用退' }
const REFUND_LABEL = { PENDING: '待申请', APPLIED: '已申请', ACCEPTED: '已受理', PARTIAL: '部分到账', RECEIVED: '全额到账', DENIED: '被驳回', NOT_NEEDED: '不用退款' }
const AFTERSALE = [
  { key: 'preparing', label: '准备材料' },
  { key: 'submitted', label: '已在平台提交' },
  { key: 'accepted', label: '平台已受理' },
  { key: 'withdrawn', label: '已撤销申请' },
  { key: 'disputed', label: '平台介入中' },
  { key: 'resolved', label: '平台已处理完' },
]
const EMPTY_AS = { status: '', date: '', time: '', source: 'platform', note: '' }
const EMPTY_OFFER = { by: 'seller', text: '', amount: '' }
const short = (iso) => (iso ? iso.replace('T', ' ').slice(5, 16) : '')

Page({
  data: {
    no: '', piece: 0, loaded: false, d: null, photos: [], videos: [],
    aftersaleOptions: AFTERSALE, asOpen: '', asForm: { ...EMPTY_AS }, offer: { ...EMPTY_OFFER }, asBusy: false,
  },

  onLoad(options) {
    this.setData({ no: decodeURIComponent(options.no || ''), piece: parseInt(options.piece, 10) || 0 })
  },

  onShow() {
    this.load()
  },

  switchPiece(e) {
    this.setData({ piece: e.currentTarget.dataset.no })
    this.load()
  },

  load() {
    const q = this.data.piece ? `?piece=${this.data.piece}` : ''
    auth.ensureLogin().then(() => request({ url: `/api/inspection-ops/orders/${encodeURIComponent(this.data.no)}/inspection${q}` }))
      .then((d) => {
        d.items = (d.items || []).map((i) => ({ ...i, label: RESULT_LABEL[i.result] || i.result }))
        const ev = (d.evidence || []).map((e) => ({ ...e, kindLabel: KIND_LABEL[e.kind] || e.kind }))
        d.exceptions = (d.exceptions || []).map((x) => ({
          ...x,
          rejectLabel: REJECT_LABEL[x.reject_status] || x.reject_status,
          refundLabel: REFUND_LABEL[x.refund_status] || x.refund_status,
          deadlineText: short(x.aftersale_deadline),
          offers: (x.keep_offers || []).map((o) => ({ ...o, atText: short(o.at) })),
        }))
        const old = d.task || {}
        this.setData({
          loaded: true,
          d,
          photos: ev.filter((e) => !e.is_video).map((e) => e.url).concat(old.defect_images || []),
          videos: ev.filter((e) => e.is_video).concat((old.defect_videos || []).map((url, i) => ({ url, kindLabel: `验货视频 ${i + 1}` }))),
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  previewPhoto(e) {
    wx.previewImage({ urls: this.data.photos, current: this.data.photos[e.currentTarget.dataset.index] })
  },

  previewItemPhoto(e) {
    const { list, index } = e.currentTarget.dataset
    wx.previewImage({ urls: list, current: list[index] })
  },

  playVideo(e) {
    wx.previewMedia({ sources: [{ url: this.data.videos[e.currentTarget.dataset.index].url, type: 'video' }] })
  },

  // ---------- 平台售后 ----------

  current() {
    return this.data.d.exceptions.find((x) => x.id === this.data.asOpen)
  },

  openAftersale(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ asOpen: this.data.asOpen === id ? '' : id, asForm: { ...EMPTY_AS }, offer: { ...EMPTY_OFFER } })
  },

  pickAsStatus(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ 'asForm.status': this.data.asForm.status === key ? '' : key })
  },

  pickAsSource(e) {
    this.setData({ 'asForm.source': e.currentTarget.dataset.key })
  },

  onAsDate(e) {
    this.setData({ 'asForm.date': e.detail.value })
  },

  onAsTime(e) {
    this.setData({ 'asForm.time': e.detail.value })
  },

  onAsNote(e) {
    this.setData({ 'asForm.note': e.detail.value })
  },

  postAftersale(path, data, ok) {
    this.setData({ asBusy: true })
    return request({ url: `/api/inspection-ops/exceptions/${this.data.asOpen}/${path}`, method: 'POST', data })
      .then(() => {
        wx.showToast({ title: ok, icon: 'success' })
        this.setData({ asForm: { ...EMPTY_AS }, offer: { ...EMPTY_OFFER } })
        this.load()
      })
      .catch((err) => wx.showModal({ title: '没保存上', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ asBusy: false }))
  },

  saveAftersale() {
    const f = this.data.asForm
    const data = { note: f.note.trim() || null }
    if (f.status && f.status !== this.current().aftersale_status) data.status = f.status
    if (f.date) Object.assign(data, { deadline: `${f.date}T${f.time || '23:59'}`, deadline_source: f.source })
    if (!data.status && !data.deadline) return wx.showToast({ title: '选个状态或填期限', icon: 'none' })
    this.postAftersale('aftersale', data, '已保存')
  },

  uploadReceipt() {
    wx.chooseImage({
      count: 9,
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((p) => api.uploadMedia('inspection/aftersale', '', p)))
          .then((list) => {
            wx.hideLoading()
            return this.postAftersale('aftersale', { receipt: list.map((r) => r.public_url), note: '上传平台回执' }, '回执已传')
          })
          .catch(() => { wx.hideLoading(); wx.showToast({ title: '上传失败', icon: 'none' }) })
      },
    })
  },

  previewReceipt(e) {
    const { list, index } = e.currentTarget.dataset
    wx.previewImage({ urls: list, current: list[index] })
  },

  pickOfferBy(e) {
    this.setData({ 'offer.by': e.currentTarget.dataset.key })
  },

  onOfferText(e) {
    this.setData({ 'offer.text': e.detail.value })
  },

  onOfferAmount(e) {
    this.setData({ 'offer.amount': e.detail.value })
  },

  addOffer() {
    const o = this.data.offer
    if (!o.text.trim()) return wx.showToast({ title: '把对方原话贴上', icon: 'none' })
    this.postAftersale('keep-offer', { by: o.by, text: o.text.trim(), amount: o.amount.trim() || null }, '记下了')
  },
})
