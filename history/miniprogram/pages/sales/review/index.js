// 发货前复核：看入库凭证，扫码对单，入库瑕疵逐项比对（WH10-02/03），核对无误或发现新问题。
const api = require('@services/api')
const auth = require('@services/auth')
const { request } = require('@services/request')
const { scanBarcode } = require('@services/scan')

const KIND_LABEL = { UNBOX_VIDEO: '开箱视频', PRODUCT_PHOTO: '商品照', DEFECT_PHOTO: '瑕疵照' }
const RESULT_LABEL = { PASS: '通过', FAIL: '不通过', UNTESTABLE: '无法测试' }
const CHECK_OPTS = [
  { key: 'SAME', label: '一样' },
  { key: 'FIXED', label: '已修好' },
  { key: 'WORSE', label: '更严重' },
  { key: 'NEW', label: '新问题' },
]

Page({
  data: {
    code: '',
    loaded: false,
    d: null,
    problems: [],
    checkOpts: CHECK_OPTS,
    evidence: [],
    photos: [],
    oldVideos: [],
    result: 'OK',
    identity: '',
    remark: '',
    media: [],
    busy: false,
  },

  onLoad(options) {
    this.setData({ code: decodeURIComponent(options.code || '') })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    return request({ url: `/api/inspection-ops/skus/${encodeURIComponent(this.data.code)}/dossier` })
      .then((d) => this.apply(d))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  apply(d) {
    const evidence = (d.evidence || []).map((e) => ({ ...e, kindLabel: KIND_LABEL[e.kind] || e.kind }))
    const old = d.inspection || {}
    // 扫码、拍照回来会 onShow 重新拉：已经勾过的比对别清掉
    const picked = {}
    for (const p of this.data.problems || []) if (p.check) picked[p.item_key] = p.check
    d.reviews = (d.reviews || []).map((r) => ({ ...r, created_at: (r.created_at || '').replace('T', ' ').slice(0, 16) }))
    const problems = (d.items || [])
      .filter((i) => i.result === 'FAIL' || i.result === 'UNTESTABLE')
      .map((i) => ({
        item_key: i.item_key,
        title: i.title,
        label: RESULT_LABEL[i.result],
        note: i.note,
        defect_part: i.defect_part,
        check: picked[i.item_key] || '',
      }))
    this.setData({
      loaded: true,
      d,
      evidence,
      problems,
      photos: evidence.filter((e) => !e.is_video).map((e) => e.url).concat(old.defect_images || []),
      oldVideos: old.defect_videos || [],
    })
  },

  previewPhotos(e) {
    const urls = this.data.photos
    wx.previewImage({ urls, current: urls[e.currentTarget.dataset.index || 0] })
  },

  playVideo(e) {
    const ev = this.data.evidence[e.currentTarget.dataset.index]
    if (ev) wx.previewMedia({ sources: [{ url: ev.url, type: 'video' }] })
  },

  playOldVideo(e) {
    wx.previewMedia({ sources: [{ url: this.data.oldVideos[e.currentTarget.dataset.index], type: 'video' }] })
  },

  scanIdentity() {
    scanBarcode().then((code) => this.setData({ identity: code })).catch(() => {})
  },

  onIdentity(e) {
    this.setData({ identity: e.detail.value })
  },

  pickCheck(e) {
    const { index, key } = e.currentTarget.dataset
    const problems = this.data.problems.slice()
    problems[index].check = key
    const patch = { problems }
    const anyWorse = problems.some((p) => p.check === 'WORSE' || p.check === 'NEW')
    if (anyWorse && this.data.result !== 'PROBLEM') {
      patch.result = 'PROBLEM'
      this._autoProblem = true
    } else if (!anyWorse && this._autoProblem) {
      // 是选「更严重」时自动切过去的，改回来就切回去
      patch.result = 'OK'
      this._autoProblem = false
    }
    this.setData(patch)
  },

  pickResult(e) {
    this._autoProblem = false
    this.setData({ result: e.currentTarget.dataset.key })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  addPhoto() {
    wx.chooseImage({
      count: Math.max(1, 9 - this.data.media.length),
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((p) => api.uploadMedia('outbound/review', '', p)))
          .then((list) => this.setData({ media: this.data.media.concat(list.map((r) => ({ raw: r.public_url, url: r.access_url || r.public_url }))) }))
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  removePhoto(e) {
    const media = this.data.media.slice()
    media.splice(e.currentTarget.dataset.index, 1)
    this.setData({ media })
  },

  submit() {
    if (this.data.busy) return
    if (!(this.data.identity || '').trim()) {
      wx.showToast({ title: '请先扫货号或序列号', icon: 'none' })
      return
    }
    const missing = this.data.problems.filter((p) => !p.check)
    if (missing.length) {
      wx.showToast({ title: `请比对：${missing[0].title}`, icon: 'none' })
      return
    }
    this.setData({ busy: true })
    request({
      url: `/api/inspection-ops/skus/${encodeURIComponent(this.data.code)}/review`,
      method: 'POST',
      data: {
        result: this.data.result,
        identity_code: this.data.identity,
        remark: this.data.remark,
        media: this.data.media.map((m) => m.raw),
        item_checks: this.data.problems.map((p) => ({ item_key: p.item_key, status: p.check })),
      },
    })
      .then((d) => {
        this.apply(d)
        const ok = this.data.result === 'OK'
        this.setData({ remark: '', media: [], identity: '' })
        wx.showModal({
          title: ok ? '复核完成' : '已登记问题',
          content: ok ? '回到发货页提交出库。' : '已拦住出库并通知管理员。处理好后回来再复核成「核对无误」才能发货。',
          showCancel: false,
          success: () => ok && wx.navigateBack(),
        })
      })
      .catch((err) => wx.showModal({ title: '还不能提交', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },
})
