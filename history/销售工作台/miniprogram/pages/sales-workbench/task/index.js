const auth = require('@services/auth')
const { request } = require('@services/request')

// 一条主管加派的任务：要求、范围、交付时间、转交上下文、记录；按钮只给现在能点的（后端 can 说了算）
const STATE_TAG = {
  待接收: 'tag-warning',
  执行中: 'tag-info',
  等待外部: 'tag-warning',
  受阻待接管: 'tag-danger',
  待验收: 'tag-info',
  退回补正: 'tag-danger',
  已验收: 'tag-success',
  已撤销: 'tag-pending',
}
// 要先写一句话的动作：写什么
const FORM = {
  wait: '等谁、等什么、哪天复查',
  block: '卡在哪（主管会来接管）',
  submit: '做了什么、结果在哪',
  reject: '退回意见：还缺什么',
  takeover: '给接手人的办法（可不写）',
  reassign: '转交上下文：已做 / 未完成 / 下一步',
}

Page({
  data: { t: null, tagClass: '', form: '', formHint: '', note: '', waitWho: '', waitWhy: '', waitUntil: '', toIdx: -1, staffNames: [], busy: false },

  onLoad(options) {
    this.id = (options && options.id) || ''
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  load() {
    return request({ url: `/api/sales-workbench/tasks/${this.id}` })
      .then((t) => this.show(t))
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  show(t) {
    const staff = (t.staff || []).filter((s) => s.id !== t.assignee_id)
    this.staff = staff
    this.setData({
      t,
      tagClass: STATE_TAG[t.state] || 'tag-pending',
      can: (t.can || []).reduce((m, a) => ({ ...m, [a]: true }), {}),
      staffNames: staff.map((s) => s.name),
      form: '',
      note: '',
    })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onPickTo(e) {
    this.setData({ toIdx: Number(e.detail.value) })
  },

  // 要写一句话的先展开输入框，不用写的直接做
  tapAct(e) {
    const a = e.currentTarget.dataset.a
    if (FORM[a] && this.data.form !== a) {
      this.setData({ form: a, formHint: FORM[a], note: '' })
      return
    }
    if (a === 'cancel') {
      wx.showModal({
        title: '撤销这条任务？',
        content: '撤销后接手人那边就没了，记录留着。',
        success: (r) => r.confirm && this.send(a),
      })
      return
    }
    this.send(a)
  },

  cancelForm() {
    this.setData({ form: '' })
  },

  send(a) {
    if (this.data.busy) return
    const d = this.data
    const body = { note: d.note, wait_who: d.waitWho, wait_why: d.waitWhy, wait_until: d.waitUntil, handoff: d.note }
    if (a === 'reassign') body.to = d.toIdx >= 0 ? this.staff[d.toIdx].id : ''
    this.setData({ busy: true })
    request({ url: `/api/sales-workbench/tasks/${this.id}/${a}`, method: 'POST', data: body })
      .then((t) => {
        wx.showToast({ title: `已${t.log.length ? t.log[t.log.length - 1].action : '保存'}`, icon: 'none' })
        this.show(t)
        return a === 'reassign' || a === 'cancel' ? this.load() : null
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '没成功', icon: 'none' }))
      .finally(() => this.setData({ busy: false }))
  },
})
