const auth = require('@services/auth')
const { request } = require('@services/request')

// 遇到没见过的情况：写一句话报给主管；主管回该怎么办，可以记成规则，大家都看得到
Page({
  data: { d: null, text: '', sku: '', busy: false, answers: {}, ruleOf: {} },

  onLoad(options) {
    if (options && options.code) this.setData({ sku: decodeURIComponent(options.code) })
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    return request({ url: '/api/sales-workbench/reports' })
      .then((d) => {
        this.setData({ d })
        if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('mp:sales-badges'))
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  send() {
    if (this.data.busy) return
    this.setData({ busy: true })
    request({ url: '/api/sales-workbench/reports', method: 'POST', data: { text: this.data.text, sku_code: this.data.sku } })
      .then(() => {
        wx.showToast({ title: '已报给主管', icon: 'none' })
        this.setData({ text: '' })
        return this.load()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '没报上', icon: 'none' }))
      .finally(() => this.setData({ busy: false }))
  },

  // 主管：回该怎么办
  onAnswer(e) {
    this.setData({ [`answers.${e.currentTarget.dataset.id}`]: e.detail.value })
  },

  toggleRule(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ [`ruleOf.${id}`]: !this.data.ruleOf[id] })
  },

  answer(e) {
    const id = e.currentTarget.dataset.id
    request({
      url: `/api/sales-workbench/reports/${id}/answer`,
      method: 'POST',
      data: { answer: this.data.answers[id] || '', is_rule: !!this.data.ruleOf[id] },
    })
      .then(() => {
        wx.showToast({ title: this.data.ruleOf[id] ? '已回复，记成规则了' : '已回复', icon: 'none' })
        return this.load()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '没回上', icon: 'none' }))
  },
})
