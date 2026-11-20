// 原生小程序逐项验货；与后台开箱验货共用 inspection-ops API 和规范快照。
const api = require('@services/api')
const auth = require('@services/auth')
const { request } = require('@services/request')

const RESULTS = [{ key: 'PASS', label: '通过' }, { key: 'FAIL', label: '不通过' }, { key: 'UNTESTABLE', label: '无法测试' }]
const RESULT_LABEL = { PASS: '通过', FAIL: '不通过', UNTESTABLE: '无法测试' }
const RESULT_CLASS = { PASS: 'tag-success', FAIL: 'tag-danger', UNTESTABLE: 'tag-warning' }
const STATE_CLASS = { NONE: '', IN_PROGRESS: 'ck-state--warn', RETEST: 'ck-state--bad', COMPLETE: 'ck-state--ok' }
const EXCEPTION_TYPES = [{ key: 'DAMAGED', label: '坏货' }, { key: 'MISMATCH', label: '货不对版' }, { key: 'OTHER', label: '其他' }]
const KIND_LABEL = { UNBOX_VIDEO: '开箱视频', PRODUCT_PHOTO: '商品照', DEFECT_PHOTO: '瑕疵照' }

function upload(path, dir) {
  return api.uploadMedia(dir, '', path).then((r) => ({ raw: r.public_url, url: r.access_url || r.public_url }))
}

Page({
  data: {
    id: '', loaded: false, task: null, items: [], fullCheck: null, stateClass: '', pending: true,
    templates: [], templateIndex: -1, preview: [], evidence: [], exceptions: [], history: [], doneCount: 0,
    editingKey: '', editing: null, results: RESULTS, retesting: false, busy: false,
    exceptionOpen: false, exceptionTypes: EXCEPTION_TYPES, exceptionType: 'DAMAGED', exceptionText: '',
  },
  onLoad(options) { this.setData({ id: options.id || '' }) },
  onShow() { auth.ensureLogin().then(() => this.load()) },
  load() {
    const id = this.data.id
    return Promise.all([
      request({ url: `/api/inspection-ops/tasks/${id}/check` }),
      this.data.templates.length ? Promise.resolve(null) : request({ url: '/api/inspection-ops/templates' }).catch(() => []),
    ]).then(([d, templates]) => {
      const items = (d.items || []).map((i) => ({ ...i, resultLabel: RESULT_LABEL[i.result] || '', resultClass: RESULT_CLASS[i.result] || '', editable: d.task.status === 'PENDING' || i.result === 'UNTESTABLE' }))
      const patch = {
        loaded: true, task: d.task, items, fullCheck: d.full_check || { state: 'NONE', label: '未开始' }, stateClass: STATE_CLASS[(d.full_check || {}).state] || '',
        pending: d.task.status === 'PENDING', preview: d.matched_template ? d.matched_template.steps.map((s) => s.title) : [],
        evidence: (d.evidence || []).map((e) => ({ ...e, kindLabel: KIND_LABEL[e.kind] || e.kind })),
        exceptions: d.exceptions || [], history: d.history || [], doneCount: items.filter((i) => i.result).length,
      }
      if (templates) {
        const enabled = (Array.isArray(templates) ? templates : (templates.items || templates.records || [])).filter((t) => t.enabled)
        patch.templates = enabled
        const matched = d.matched_template && enabled.findIndex((t) => t.id === d.matched_template.id)
        patch.templateIndex = matched >= 0 ? matched : -1
        // 不覆盖员工已手动选择的规范
        if (this._templatePicked) patch.templateIndex = this.data.templateIndex
      }
      this.setData(patch)
    }).catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },
  onTemplateChange(e) { this._templatePicked = true; this.setData({ templateIndex: Number(e.detail.value) }) },
  startCheck() {
    const t = this.data.templates[this.data.templateIndex]
    if (!t) return wx.showToast({ title: '先选验货规范', icon: 'none' })
    this.setData({ busy: true })
    request({ url: `/api/inspection-ops/tasks/${this.data.id}/check/start`, method: 'POST', data: { template_id: t.id } })
      .then(() => this.load()).then(() => { const first = this.data.items.find((i) => !i.result); if (first) this.openItem({ currentTarget: { dataset: { key: first.item_key } } }) })
      .catch((err) => wx.showModal({ title: '开始不了', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },
  openItem(e) {
    const key = e.currentTarget.dataset.key
    const item = this.data.items.find((i) => i.item_key === key)
    if (!item || !item.editable || this.data.editingKey === key) return
    const retesting = !this.data.pending
    this.setData({ editingKey: key, retesting, editing: {
      result: retesting ? '' : item.result || '', note: retesting ? '' : item.note || '',
      defect_part: retesting ? '' : item.defect_part || '', seller_claim: retesting ? '' : item.seller_claim || '',
      files: retesting ? [] : (item.evidence || []).map((u) => ({ raw: u, url: u })),
    } })
  },
  closeItem() { this.setData({ editingKey: '', editing: null }) },
  pickResult(e) { this.setData({ 'editing.result': e.currentTarget.dataset.key }) },
  onField(e) { this.setData({ [`editing.${e.currentTarget.dataset.key}`]: e.detail.value }) },
  onNote(e) { this.setData({ 'editing.note': e.detail.value }) },
  addPhoto() {
    const files = this.data.editing.files
    wx.chooseImage({ count: Math.max(1, 9 - files.length), sizeType: ['compressed'], success: (res) => {
      wx.showLoading({ title: '上传中' })
      Promise.all(res.tempFilePaths.map((p) => upload(p, 'inspection/check')))
        .then((list) => this.setData({ 'editing.files': this.data.editing.files.concat(list) }))
        .catch(() => wx.showToast({ title: '上传失败，再试一次', icon: 'none' })).finally(() => wx.hideLoading())
    } })
  },
  removePhoto(e) { const files = this.data.editing.files.slice(); files.splice(e.currentTarget.dataset.index, 1); this.setData({ 'editing.files': files }) },
  saveItem() {
    const ed = this.data.editing
    if (!ed || !ed.result) return wx.showToast({ title: '先选结果', icon: 'none' })
    if (ed.result === 'UNTESTABLE' && !String(ed.note || '').trim()) return wx.showToast({ title: '无法测试请填写原因', icon: 'none' })
    if (this.data.items.find((i) => i.item_key === this.data.editingKey)?.need_photo && !ed.files.length) return wx.showToast({ title: '此项需要拍照留证', icon: 'none' })
    this.setData({ busy: true })
    request({ url: `/api/inspection-ops/tasks/${this.data.id}/check/${this.data.editingKey}`, method: 'PUT', data: {
      result: ed.result, note: ed.note, evidence: ed.files.map((f) => f.raw), defect_part: ed.defect_part, seller_claim: ed.seller_claim,
    } }).then(() => this.load()).then(() => {
      this.closeItem()
      if (!this.data.pending) return wx.showToast({ title: '补测已保存', icon: 'success' })
      const next = this.data.items.find((i) => !i.result)
      if (next) this.openItem({ currentTarget: { dataset: { key: next.item_key } } })
    }).catch((err) => wx.showModal({ title: '还不能保存', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },
  recordVideo() {
    wx.chooseVideo({ sourceType: ['camera', 'album'], success: (res) => {
      wx.showLoading({ title: '视频上传中' })
      upload(res.tempFilePath, 'inspection/unbox').then((f) => request({
        url: `/api/inspection-ops/tasks/${this.data.id}/evidence`, method: 'POST',
        data: { kind: 'UNBOX_VIDEO', url: f.raw, duration_seconds: Math.round(res.duration || 0) || null, size_bytes: res.size || null, device_label: '手机' },
      })).then(() => this.load()).then(() => wx.showToast({ title: '开箱视频已保存', icon: 'success' }))
        .catch((err) => wx.showModal({ title: '视频没传上去', content: ((err && err.detail) || '网络或文件太大') + '。视频还在手机相册里，可以稍后从相册再传。', showCancel: false }))
        .finally(() => wx.hideLoading())
    } })
  },
  openEvidence(e) { const ev = this.data.evidence[e.currentTarget.dataset.index]; if (!ev) return; if (ev.is_video) wx.previewMedia({ sources: [{ url: ev.url, type: 'video' }] }); else wx.previewImage({ urls: [ev.url] }) },
  openException() { this.setData({ exceptionOpen: true, exceptionText: '', exceptionType: 'DAMAGED' }) },
  closeException() { this.setData({ exceptionOpen: false }) },
  pickExceptionType(e) { this.setData({ exceptionType: e.currentTarget.dataset.key }) },
  onExceptionText(e) { this.setData({ exceptionText: e.detail.value }) },
  submitException() {
    if (!this.data.exceptionText.trim()) return wx.showToast({ title: '写一下什么情况', icon: 'none' })
    this.setData({ busy: true })
    request({ url: `/api/inspection-ops/tasks/${this.data.id}/exceptions`, method: 'POST', data: { exception_type: this.data.exceptionType, description: this.data.exceptionText } })
      .then(() => { this.setData({ exceptionOpen: false }); wx.showModal({ title: '已登记异常', content: '请按页面显示的送达情况确认通知状态，并继续验完其余项目。', showCancel: false }); return this.load() })
      .catch((err) => wx.showModal({ title: '登记失败', content: (err && err.detail) || '请重试', showCancel: false })).finally(() => this.setData({ busy: false }))
  },
  noop() {},
  playTutorial(e) { wx.previewMedia({ sources: [{ url: e.currentTarget.dataset.url, type: 'video' }] }) },
  backToForm() { wx.navigateBack() },
})
