const auth = require('@services/auth')
const api = require('@services/api')

const CATEGORY_OPTIONS = [
  { key: 'REWORK', label: '我要返工', hint: '流程断点、闭环缺失、需要补责任链' },
  { key: 'FEEDBACK', label: '我要反馈', hint: 'ERP 不好用、缺功能、体验差' },
  { key: 'COMPLAINT', label: '我要投诉', hint: '向管理层反馈管理问题或协作问题' },
]

const SAMPLE_MAP = {
  REWORK: [
    {
      title: 'ROG 单物流驳回缺少闭环',
      target: '议价模块 / 物流驳回 / 仓管通知',
      content: '上次 ROG 那一票因为系统里没有做好逻辑闭环，物流驳回提交后仓管也没有收到联系提醒，导致货物灭失，最后起诉收场。建议在议价模块强制填写驳回证据（视频或照片），并在物流驳回后自动通知仓管、采购跟进，直到召回或再次签收完成。',
    },
    {
      title: '跨岗位异常无人接单',
      target: '采购 / 仓管 / 物流协作',
      content: '当异常从一个岗位流转到另一个岗位时，现在缺少明确接单和超时提醒，容易出现“都以为别人会处理”的情况。建议返工补一个责任人确认和超时催办闭环。',
    },
  ],
  FEEDBACK: [
    {
      title: 'ERP 缺少匿名反馈入口',
      target: '个人中心 / 系统建议',
      content: '建议在 ERP 个人中心保留一个匿名反馈入口，方便员工在不暴露身份的情况下反馈系统不好用、缺少功能、流程不清晰等问题，并由管理后台统一查看处理。',
    },
    {
      title: '议价模块建议补强证据规则',
      target: '议价模块',
      content: '建议议价订单在驳回、改派、召回等关键节点都要求补齐照片或视频证据，并在详情页保留完整时间线，减少后续扯皮和责任不清。',
    },
  ],
  COMPLAINT: [
    {
      title: '希望向管理层反馈流程责任不清',
      target: '管理层 / 运营流程',
      content: '当前部分异常流程没有清晰负责人和处理时限，问题出现后经常需要员工自己反复追问。建议管理层明确节点负责人、升级路径和超时处理规则。',
    },
    {
      title: '协作问题影响执行效率',
      target: '跨部门协作',
      content: '部分问题在采购、仓库、销售之间来回传递，但没有统一口径和确认机制，导致执行效率低、责任边界模糊。建议管理层统一规范并定期复盘。',
    },
  ],
}

function emptyForm(category = 'FEEDBACK') {
  return {
    category,
    title: '',
    target: '',
    content: '',
    attachments: [],
  }
}

function findHint(category) {
  const current = CATEGORY_OPTIONS.find((item) => item.key === category)
  return current ? current.hint : ''
}

Page({
  data: {
    categoryOptions: CATEGORY_OPTIONS,
    currentHint: findHint('FEEDBACK'),
    samples: SAMPLE_MAP.FEEDBACK,
    form: emptyForm(),
    attachmentDisplayUrls: [],
    submitting: false,
  },

  onLoad() {
    auth.ensureLogin().catch(() => {})
  },

  switchCategory(e) {
    const category = e.currentTarget.dataset.key
    if (!category || category === this.data.form.category) return
    this.setData({
      currentHint: findHint(category),
      samples: SAMPLE_MAP[category] || [],
      form: emptyForm(category),
      attachmentDisplayUrls: [],
    })
  },

  applySample(e) {
    const index = Number(e.currentTarget.dataset.index)
    const sample = (this.data.samples || [])[index]
    if (!sample) return
    this.setData({
      'form.title': sample.title,
      'form.target': sample.target,
      'form.content': sample.content,
    })
  },

  onTitleInput(e) {
    this.setData({ 'form.title': e.detail.value })
  },

  onTargetInput(e) {
    this.setData({ 'form.target': e.detail.value })
  },

  onContentInput(e) {
    this.setData({ 'form.content': e.detail.value })
  },

  addAttachment() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: (res) => {
        wx.showLoading({ title: '上传中…', mask: true })
        const uploads = res.tempFiles.map((file) => {
          const ext = file.fileType === 'video' ? '.mp4' : '.jpg'
          return api.uploadMedia('feedback/anonymous/', `${Date.now()}${ext}`, file.tempFilePath)
        })
        Promise.all(uploads)
          .then((results) => {
            const urls = results.map((item) => item.public_url)
            const displayUrls = results.map((item) => item.access_url || item.public_url)
            this.setData({
              'form.attachments': this.data.form.attachments.concat(urls),
              attachmentDisplayUrls: this.data.attachmentDisplayUrls.concat(displayUrls),
            })
          })
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  removeAttachment(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (Number.isNaN(index)) return
    const attachments = this.data.form.attachments.slice()
    const displayUrls = this.data.attachmentDisplayUrls.slice()
    attachments.splice(index, 1)
    displayUrls.splice(index, 1)
    this.setData({
      'form.attachments': attachments,
      attachmentDisplayUrls: displayUrls,
    })
  },

  onSubmit() {
    if (this.data.submitting) return
    const title = (this.data.form.title || '').trim()
    const target = (this.data.form.target || '').trim()
    const content = (this.data.form.content || '').trim()
    if (!title) {
      wx.showToast({ title: '请填写标题', icon: 'none' })
      return
    }
    if (!content) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    api.createAnonymousFeedback({
      category: this.data.form.category,
      title,
      target: target || null,
      content,
      attachments: this.data.form.attachments,
    })
      .then(() => {
        const nextCategory = this.data.form.category
        wx.showToast({ title: '已匿名提交', icon: 'success' })
        this.setData({
          currentHint: findHint(nextCategory),
          samples: SAMPLE_MAP[nextCategory] || [],
          form: emptyForm(nextCategory),
          attachmentDisplayUrls: [],
        })
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})
