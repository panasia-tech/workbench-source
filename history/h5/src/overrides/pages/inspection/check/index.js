// H5 专用页（小程序没有这一页，见 h5/src/overrides/patches.json 往 app.json 加的那行）。
// 接口与后台「开箱验货」同一套：/api/inspection-ops/tasks/{id}/check（server/app/routers/inspection_ops.py）。
// 规则在服务端：坏货/拒签也要验完；无法测试要原因+凭证，提交后进补测；改答案留痕，后面已填项提示复核。
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
const STATE_CLASS = { NONE: '', IN_PROGRESS: 'ck-state--warn', RETEST: 'ck-state--bad', COMPLETE: 'ck-state--ok' }
const EXCEPTION_TYPES = [
  { key: 'DAMAGED', label: '坏货' },
  { key: 'MISMATCH', label: '货不对版' },
  { key: 'OTHER', label: '其他' },
]
const KIND_LABEL = { UNBOX_VIDEO: '开箱视频', PRODUCT_PHOTO: '商品照', DEFECT_PHOTO: '瑕疵照' }

function upload(path, dir) {
  return api.uploadMedia(dir, '', path).then((r) => ({ raw: r.public_url, url: r.access_url || r.public_url }))
}

Page({
  data: {
    compare: null,
    newProblems: '',
    causes: [{ key: 'unknown', label: '待判' }, { key: 'seller', label: '卖家没说清' }, { key: 'transport', label: '运输造成' }],
    id: '',
    loaded: false,
    task: null,
    items: [],
    fullCheck: null,
    stateClass: '',
    pending: true,
    templates: [],
    templateIndex: -1,
    preview: [],
    evidence: [],
    exceptions: [],
    history: [],
    doneCount: 0,
    editingKey: '',
    editing: null,
    results: RESULTS,
    retesting: false,
    busy: false,
    exceptionOpen: false,
    exceptionTypes: EXCEPTION_TYPES,
    exceptionType: 'DAMAGED',
    exceptionText: '',
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    const id = this.data.id
    return Promise.all([
      request({ url: `/api/inspection-ops/tasks/${id}/check` }),
      this.data.templates.length ? Promise.resolve(null) : request({ url: '/api/inspection-ops/templates' }).catch(() => []),
    ])
      .then(([d, tpls]) => {
        const items = (d.items || []).map((i) => ({
          ...i,
          resultLabel: RESULT_LABEL[i.result] || '',
          resultClass: RESULT_CLASS[i.result] || '',
          editable: d.task.status === 'PENDING' || i.result === 'UNTESTABLE',
        }))
        const patch = {
          loaded: true,
          task: d.task,
          items,
          fullCheck: d.full_check,
          stateClass: STATE_CLASS[d.full_check.state],
          pending: d.task.status === 'PENDING',
          preview: d.matched_template ? d.matched_template.steps.map((s) => s.title) : [],
          evidence: (d.evidence || []).map((e) => ({ ...e, kindLabel: KIND_LABEL[e.kind] || e.kind })),
          // 超时项是数组，页面上直接插值会印成 JSON，先拼成一句
          exceptions: (d.exceptions || []).map((x) => ({ ...x, overdue_parts: (x.overdue_parts || []).join('、') })),
          history: d.history || [],
          doneCount: items.filter((i) => i.result).length,
          // W11：卖家原话（下单时那版快照）对照、风险提醒、卖家没说过的不通过项
          compare: d.compare || null,
          newProblems: ((d.compare && d.compare.new_problems) || []).map((k) => (items.find((i) => i.item_key === k) || {}).title).filter(Boolean).join('、'),
        }
        if (tpls) {
          const enabled = tpls.filter((t) => t.enabled)
          patch.templates = enabled
          const matched = d.matched_template && enabled.findIndex((t) => t.id === d.matched_template.id)
          patch.templateIndex = matched >= 0 ? matched : -1
        }
        this.setData(patch)
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  onTemplateChange(e) {
    this.setData({ templateIndex: Number(e.detail.value) })
  },

  startCheck() {
    const t = this.data.templates[this.data.templateIndex]
    if (!t) return wx.showToast({ title: '先选验货规范', icon: 'none' })
    this.setData({ busy: true })
    request({ url: `/api/inspection-ops/tasks/${this.data.id}/check/start`, method: 'POST', data: { template_id: t.id } })
      .then(() => this.load())
      .then(() => {
        const first = this.data.items.find((i) => !i.result)
        if (first) this.openItem({ currentTarget: { dataset: { key: first.item_key } } })
      })
      .catch((err) => wx.showModal({ title: '开始不了', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  openItem(e) {
    const key = e.currentTarget.dataset.key
    const item = this.data.items.find((i) => i.item_key === key)
    if (!item || !item.editable) return
    if (this.data.editingKey === key) return
    const retesting = !this.data.pending
    // 不预先选「通过」：没验的必须自己选；补测从空开始
    this.setData({
      editingKey: key,
      retesting,
      editing: {
        result: retesting ? '' : item.result || '',
        note: retesting ? '' : item.note || '',
        defect_part: retesting ? '' : item.defect_part || '',
        seller_claim: retesting ? '' : item.seller_claim || '',
        disclosed: retesting ? false : !!item.disclosed,
        cause: retesting ? '' : item.cause || 'unknown',
        claim: (this.data.compare && this.data.compare.claims && this.data.compare.claims[item.dimension]) || '',
        files: retesting ? [] : (item.evidence || []).map((u) => ({ raw: u, url: u })),
      },
    })
  },

  toggleDisclosed() {
    this.setData({ 'editing.disclosed': !this.data.editing.disclosed })
  },

  pickCause(e) {
    this.setData({ 'editing.cause': e.currentTarget.dataset.key })
  },

  useClaim() {
    this.setData({ 'editing.seller_claim': (this.data.editing.claim || '').slice(0, 255) })
  },

  // 把卖家没说过的不通过项建成差异工单（会通知业务员和采购）
  raiseFromItems() {
    const keys = (this.data.compare && this.data.compare.new_problems) || []
    if (!keys.length) return
    wx.showModal({
      title: '建差异工单',
      content: `把 ${keys.length} 项卖家没说过的问题建成工单，会通知业务员和采购处理。`,
      success: (r) => {
        if (!r.confirm) return
        this.setData({ busy: true })
        request({ url: `/api/inspection-ops/tasks/${this.data.id}/exceptions/from-items`, method: 'POST', data: { item_keys: keys } })
          .then(() => { wx.showToast({ title: '已建并通知', icon: 'success' }); return this.load() })
          .catch((err) => wx.showModal({ title: '没建成', content: (err && err.detail) || '请重试', showCancel: false }))
          .finally(() => this.setData({ busy: false }))
      },
    })
  },

  closeItem() {
    this.setData({ editingKey: '', editing: null })
  },

  pickResult(e) {
    this.setData({ 'editing.result': e.currentTarget.dataset.key })
  },

  onField(e) {
    this.setData({ [`editing.${e.currentTarget.dataset.key}`]: e.detail.value })
  },

  onNote(e) {
    this.setData({ 'editing.note': e.detail.value })
  },

  addPhoto() {
    const files = this.data.editing.files
    wx.chooseImage({
      count: Math.max(1, 9 - files.length),
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        Promise.all(res.tempFilePaths.map((p) => upload(p, 'inspection/check')))
          .then((list) => this.setData({ 'editing.files': this.data.editing.files.concat(list) }))
          .catch(() => wx.showToast({ title: '上传失败，再试一次', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  removePhoto(e) {
    const files = this.data.editing.files.slice()
    files.splice(e.currentTarget.dataset.index, 1)
    this.setData({ 'editing.files': files })
  },

  saveItem() {
    const ed = this.data.editing
    if (!ed || !ed.result) return wx.showToast({ title: '先选结果', icon: 'none' })
    this.setData({ busy: true })
    request({
      url: `/api/inspection-ops/tasks/${this.data.id}/check/${this.data.editingKey}`,
      method: 'PUT',
      data: {
        result: ed.result, note: ed.note, evidence: ed.files.map((f) => f.raw), defect_part: ed.defect_part, seller_claim: ed.seller_claim,
        disclosed: ed.result === 'FAIL' ? !!ed.disclosed : null, cause: ed.result === 'FAIL' ? ed.cause || 'unknown' : null,
      },
    })
      .then(() => this.load())
      .then(() => {
        this.closeItem()
        if (!this.data.pending) return wx.showToast({ title: '补测已保存', icon: 'success' })
        const next = this.data.items.find((i) => !i.result)
        if (next) this.openItem({ currentTarget: { dataset: { key: next.item_key } } })
      })
      .catch((err) => wx.showModal({ title: '还不能保存', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  // 开箱视频：用手机录（拆封前开始录），传完登记成本单凭证
  recordVideo() {
    wx.chooseVideo({
      sourceType: ['camera', 'album'],
      success: (res) => {
        wx.showLoading({ title: '视频上传中' })
        upload(res.tempFilePath, 'inspection/unbox')
          .then((f) => request({
            url: `/api/inspection-ops/tasks/${this.data.id}/evidence`,
            method: 'POST',
            data: { kind: 'UNBOX_VIDEO', url: f.raw, duration_seconds: Math.round(res.duration || 0) || null, size_bytes: res.size || null, device_label: '手机' },
          }))
          .then(() => this.load())
          .then(() => wx.showToast({ title: '开箱视频已保存', icon: 'success' }))
          .catch((err) => wx.showModal({ title: '视频没传上去', content: ((err && err.detail) || '网络或文件太大') + '。视频还在手机相册里，可以稍后从相册再传。', showCancel: false }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  openEvidence(e) {
    const ev = this.data.evidence[e.currentTarget.dataset.index]
    if (!ev) return
    if (ev.is_video) wx.previewMedia({ sources: [{ url: ev.url, type: 'video' }] })
    else wx.previewImage({ urls: [ev.url] })
  },

  openException() {
    this.setData({ exceptionOpen: true, exceptionText: '', exceptionType: 'DAMAGED' })
  },

  closeException() {
    this.setData({ exceptionOpen: false })
  },

  pickExceptionType(e) {
    this.setData({ exceptionType: e.currentTarget.dataset.key })
  },

  onExceptionText(e) {
    this.setData({ exceptionText: e.detail.value })
  },

  submitException() {
    if (!this.data.exceptionText.trim()) return wx.showToast({ title: '写一下什么情况', icon: 'none' })
    this.setData({ busy: true })
    request({
      url: `/api/inspection-ops/tasks/${this.data.id}/exceptions`,
      method: 'POST',
      data: { exception_type: this.data.exceptionType, description: this.data.exceptionText },
    })
      .then(() => {
        this.setData({ exceptionOpen: false })
        wx.showModal({ title: '已登记异常', content: '业务员和采购已收到通知（以页面上显示的送达情况为准）。请继续把其余项目验完。', showCancel: false })
        return this.load()
      })
      .catch((err) => wx.showModal({ title: '登记失败', content: (err && err.detail) || '请重试', showCancel: false }))
      .finally(() => this.setData({ busy: false }))
  },

  noop() {},

  playTutorial(e) {
    wx.previewMedia({ sources: [{ url: e.currentTarget.dataset.url, type: 'video' }] })
  },

  backToForm() {
    wx.navigateBack()
  },
})
