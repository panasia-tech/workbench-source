// H5 专有页：客户退回的货重新验一遍（禅道 WH10-07/08/10）。检查项照搬原验货单，每项旁边显示入库时的结果；
// 下面按时间列出这件货历次的照片视频（入库、发货前复核、出库、退回收货、复验）。
// 结论「和入库时一致」才能正常入库；「发现问题」只能在收货核对里标异常挂起，等管理员裁决。
// 接口：/api/inspection-ops/returns/{id}/recheck（server/app/routers/inspection_ops.py）。
const api = require('@services/api')
const auth = require('@services/auth')
const { request } = require('@services/request')

const RESULTS = [
  { key: 'PASS', label: '通过' },
  { key: 'FAIL', label: '不通过' },
  { key: 'UNTESTABLE', label: '无法测试' },
]
const RESULT_LABEL = { PASS: '通过', FAIL: '不通过', UNTESTABLE: '无法测试' }
const RESULT_CLASS = { PASS: 'tag-success', FAIL: 'tag-danger', UNTESTABLE: 'tag-warning' }

function shortTime(s) {
  return (s || '').replace('T', ' ').slice(5, 16)
}

Page({
  data: {
    id: '',
    loaded: false,
    d: null,
    items: [],
    history: [],
    results: RESULTS,
    editingKey: '',
    editing: { result: '', note: '', evidence: [] },
    conclusion: 'OK',
    note: '',
    media: [],
    busy: false,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  url(suffix) {
    return `/api/inspection-ops/returns/${this.data.id}/recheck${suffix || ''}`
  },

  load() {
    return request({ url: this.url() })
      .then((d) => this.apply(d))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  apply(d) {
    const items = (d.items || []).map((i) => ({
      ...i,
      resultLabel: RESULT_LABEL[i.result] || '',
      resultClass: RESULT_CLASS[i.result] || '',
      beforeLabel: RESULT_LABEL[i.before_result] || '',
      beforeClass: RESULT_CLASS[i.before_result] || '',
      // 入库时通过、这次不通过 = 新问题
      changed: i.before_result === 'PASS' && i.result === 'FAIL',
    }))
    const history = (d.history || []).map((h) => ({ ...h, time: shortTime(h.at) }))
    this.setData({
      loaded: true,
      d: { ...d, finished_at: shortTime(d.finished_at) },
      items,
      history,
      left: items.filter((i) => !i.result).length,
    })
  },

  start() {
    if (this.data.busy) return
    this.setData({ busy: true })
    request({ url: this.url(), method: 'POST' })
      .then((d) => this.apply(d))
      .catch((err) => wx.showModal({ title: '开始不了', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  openItem(e) {
    if (!this.data.d.started || this.data.d.finished_at) return
    const key = e.currentTarget.dataset.key
    if (key === this.data.editingKey) return
    const item = this.data.items.find((i) => i.key === key) || {}
    this.setData({
      editingKey: key,
      editing: {
        result: item.result || '',
        note: item.note || '',
        evidence: (item.evidence || []).map((url) => ({ raw: url, url })),
      },
    })
  },

  noop() {},

  pickItemResult(e) {
    this.setData({ 'editing.result': e.currentTarget.dataset.key })
  },

  onItemNote(e) {
    this.setData({ 'editing.note': e.detail.value })
  },

  upload(dir, onDone) {
    wx.chooseImage({
      count: 9,
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((p) => api.uploadMedia(dir, '', p)))
          .then((list) => onDone(list.map((r) => ({ raw: r.public_url, url: r.access_url || r.public_url }))))
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  addItemPhoto() {
    this.upload('returns/recheck', (list) => this.setData({ 'editing.evidence': this.data.editing.evidence.concat(list).slice(0, 9) }))
  },

  removeItemPhoto(e) {
    const evidence = this.data.editing.evidence.slice()
    evidence.splice(e.currentTarget.dataset.index, 1)
    this.setData({ 'editing.evidence': evidence })
  },

  saveItem() {
    const { editing, editingKey } = this.data
    if (!editing.result) {
      wx.showToast({ title: '先选结果', icon: 'none' })
      return
    }
    if (this.data.busy) return
    this.setData({ busy: true })
    request({
      url: this.url(`/items/${encodeURIComponent(editingKey)}`),
      method: 'PUT',
      data: { result: editing.result, note: editing.note, evidence: editing.evidence.map((m) => m.raw) },
    })
      .then((d) => {
        this.apply(d)
        // 自动跳到下一项没验的
        const next = this.data.items.find((i) => !i.result)
        this.setData({ editingKey: '' })
        if (next) this.openItem({ currentTarget: { dataset: { key: next.key } } })
      })
      .catch((err) => wx.showModal({ title: '还不能保存', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  pickConclusion(e) {
    this.setData({ conclusion: e.currentTarget.dataset.key })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  addPhoto() {
    this.upload('returns/recheck', (list) => this.setData({ media: this.data.media.concat(list).slice(0, 9) }))
  },

  removePhoto(e) {
    const media = this.data.media.slice()
    media.splice(e.currentTarget.dataset.index, 1)
    this.setData({ media })
  },

  finish() {
    if (this.data.busy) return
    this.setData({ busy: true })
    request({
      url: this.url('/finish'),
      method: 'POST',
      data: { result: this.data.conclusion, note: this.data.note, media: this.data.media.map((m) => m.raw) },
    })
      .then((d) => {
        this.apply(d)
        const ok = this.data.conclusion === 'OK'
        wx.showModal({
          title: ok ? '复验完成' : '已记下问题',
          content: ok
            ? '回到退货列表点「收货核对」入库。'
            : '这件货不能直接入库：回到退货列表点「收货核对」，勾选「标记异常」挂起，管理员会裁决恢复在库还是报损。',
          showCancel: false,
          success: () => wx.navigateBack(),
        })
      })
      .catch((err) => wx.showModal({ title: '还不能提交', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  preview(e) {
    const h = this.data.history[e.currentTarget.dataset.index]
    if (!h) return
    if (h.is_video) {
      wx.previewMedia({ sources: [{ url: h.url, type: 'video' }] })
      return
    }
    const urls = this.data.history.filter((x) => !x.is_video).map((x) => x.url)
    wx.previewImage({ urls, current: h.url })
  },
})
