const api = require('@services/api')
const auth = require('@services/auth')

const STATE_CLASS = { NORMAL: 'sm-state--ok', CONFLICT: 'sm-state--warn', NONE: 'sm-state--bad' }
const STATE_WORD = { NORMAL: '正常', CONFLICT: '冲突 · 待核实', NONE: '无匹配' }
const DIFF_LABEL = { spu_code: '编码', spec: '配置', note: '备注' }
const WAITING = ['SUBMITTED', 'NO_MATCH']

function pickMedia(dir, existing, max) {
  return new Promise((resolve) => {
    if (existing.length >= max) return resolve([])
    wx.chooseImage({
      count: max - existing.length,
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((fp) => api.uploadMedia(dir, '', fp)))
          .then((results) => resolve(results.map((r) => ({ raw: r.public_url, url: r.access_url || r.public_url }))))
          .catch(() => {
            wx.showToast({ title: '上传失败', icon: 'none' })
            resolve([])
          })
          .finally(() => wx.hideLoading())
      },
      fail: () => resolve([]),
    })
  })
}

Page({
  data: {
    code: '',
    loaded: false,
    sku: null,
    assessment: null,
    stateClass: '',
    stateWord: '',
    candidates: [],
    match: null,
    logs: [],
    canReview: false,
    editing: true,
    selectedId: '',
    searchQ: '',
    searchResults: [],
    note: '',
    media: [],
    impact: null,
    pendingAction: '',
    reviewReason: '',
    reviewMedia: [],
    busy: false,
  },

  onLoad(options) {
    this.setData({ code: decodeURIComponent((options && options.code) || '') })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    return api.getSpuMatch(this.data.code)
      .then((res) => this.apply(res))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  apply(res) {
    const a = res.assessment
    const match = res.match
    const candidates = a.candidates.map((c) => ({
      ...c,
      diffText: c.diff.map((k) => DIFF_LABEL[k]).join('、'),
    }))
    const waiting = match && WAITING.includes(match.status)
    // 退回、待核实时把员工上次的说明和照片带出来，补正时改着方便
    const keep = match && match.status !== 'CONFIRMED'
    this.setData({
      loaded: true,
      sku: res.sku,
      assessment: a,
      stateClass: STATE_CLASS[a.state],
      stateWord: STATE_WORD[a.state],
      candidates,
      match,
      logs: res.logs,
      canReview: res.can_review,
      editing: !waiting,
      selectedId: (match && match.spu_id) || (candidates.length === 1 && a.state === 'NORMAL' ? candidates[0].spu_id : ''),
      note: keep ? (match.note || '') : '',
      media: keep ? (match.media || []) : [],
      impact: null,
      reviewReason: '',
      reviewMedia: [],
    })
  },

  previewImages(e) {
    const { list, index } = e.currentTarget.dataset
    const urls = (list || []).map((m) => (typeof m === 'string' ? m : m.url))
    if (urls.length) wx.previewImage({ urls, current: urls[index || 0] })
  },

  goEditSku() {
    wx.navigateTo({ url: `/pages/warehouse/edit/index?code=${encodeURIComponent(this.data.code)}` })
  },

  startEdit() {
    this.setData({ editing: true })
  },

  selectCandidate(e) {
    this.setData({ selectedId: e.currentTarget.dataset.id })
  },

  onSearchInput(e) {
    const q = e.detail.value
    this.setData({ searchQ: q })
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => {
      if (!q.trim()) return this.setData({ searchResults: [] })
      api.searchSpu(q.trim()).then((res) => this.setData({ searchResults: res.items })).catch(() => {})
    }, 400)
  },

  selectSearch(e) {
    const id = e.currentTarget.dataset.id
    const hit = this.data.searchResults.find((c) => c.spu_id === id)
    if (!hit) return
    const exists = this.data.candidates.some((c) => c.spu_id === id)
    this.setData({
      candidates: exists ? this.data.candidates : this.data.candidates.concat([{ ...hit, diffText: '' }]),
      selectedId: id,
      searchQ: '',
      searchResults: [],
    })
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  addMedia() {
    pickMedia('spu-match', this.data.media, 9).then((add) => add.length && this.setData({ media: this.data.media.concat(add) }))
  },

  removeMedia(e) {
    const media = this.data.media.slice()
    media.splice(e.currentTarget.dataset.index, 1)
    this.setData({ media })
  },

  onSubmit() {
    if (!this.data.selectedId) {
      wx.showToast({ title: '先在候选里选一个，或搜目录', icon: 'none' })
      return
    }
    this.send('submit', false)
  },

  onReport() {
    this.send('report', false)
  },

  confirmChange() {
    this.send(this.data.pendingAction, true)
  },

  cancelChange() {
    this.setData({ impact: null, pendingAction: '' })
  },

  send(action, confirmChange) {
    if (this.data.busy) return
    const media = this.data.media.map((m) => m.raw)
    const data = { note: this.data.note, media, confirm_change: confirmChange }
    const call = action === 'submit'
      ? api.submitSpuMatch(this.data.code, { ...data, spu_id: this.data.selectedId })
      : api.reportSpuMatch(this.data.code, data)
    this.setData({ busy: true })
    call
      .then((res) => {
        this.apply(res)
        wx.showToast({ title: action === 'submit' ? '已提交验收' : '已报告，等管理员处理', icon: 'success' })
      })
      .catch((err) => {
        if (err && err.statusCode === 409 && err.impact) {
          this.setData({ impact: err.impact, pendingAction: action })
          return
        }
        // 防呆拦下的：原话告诉员工补什么
        wx.showModal({ title: '还不能提交', content: (err && err.detail) || '提交失败', showCancel: false })
      })
      .finally(() => this.setData({ busy: false }))
  },

  onReviewReason(e) {
    this.setData({ reviewReason: e.detail.value })
  },

  addReviewMedia() {
    pickMedia('spu-match/review', this.data.reviewMedia, 9).then((add) => add.length && this.setData({ reviewMedia: this.data.reviewMedia.concat(add) }))
  },

  removeReviewMedia(e) {
    const reviewMedia = this.data.reviewMedia.slice()
    reviewMedia.splice(e.currentTarget.dataset.index, 1)
    this.setData({ reviewMedia })
  },

  onApprove() {
    this.review(true)
  },

  onReturn() {
    if (!this.data.reviewReason.trim()) {
      wx.showToast({ title: '退回要写原因：哪里不对、要补什么', icon: 'none' })
      return
    }
    this.review(false)
  },

  review(approve) {
    if (this.data.busy) return
    this.setData({ busy: true })
    api.reviewSpuMatch(this.data.code, {
      approve,
      reason: this.data.reviewReason,
      media: this.data.reviewMedia.map((m) => m.raw),
    })
      .then((res) => {
        this.apply(res)
        wx.showToast({ title: approve ? '已通过' : '已退回', icon: 'success' })
      })
      .catch((err) => wx.showModal({ title: '操作失败', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },
})
