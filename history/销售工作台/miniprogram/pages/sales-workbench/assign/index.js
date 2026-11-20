const auth = require('@services/auth')
const { request } = require('@services/request')

// 主管加派：要求、范围、交付时间、派给谁都必填；下面是派出去的（先要主管动手的）
const STATE_TAG = {
  待接收: 'tag-warning',
  执行中: 'tag-info',
  等待外部: 'tag-warning',
  受阻待接管: 'tag-danger',
  待验收: 'tag-danger',
  退回补正: 'tag-warning',
  已验收: 'tag-success',
  已撤销: 'tag-pending',
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

Page({
  data: { staff: [], staffNames: [], tasks: [], toIdx: -1, title: '', scope: '', sku: '', day: '', time: '18:00', busy: false, loaded: false },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    // 交付时间按北京时间（后端也按北京时间读）：默认今天 18:00，过了 17 点默认明天 18:00
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    if (d.getUTCHours() >= 17) d.setUTCDate(d.getUTCDate() + 1)
    if (!this.data.day) this.setData({ day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` })
    return request({ url: '/api/sales-workbench/team' })
      .then((res) => {
        this.setData({
          staff: res.staff,
          staffNames: res.staff.map((s) => s.name),
          tasks: res.tasks.map((t) => ({ ...t, tagClass: STATE_TAG[t.state] || 'tag-pending' })),
          loaded: true,
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onPick(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.currentTarget.dataset.key === 'toIdx' ? Number(e.detail.value) : e.detail.value })
  },

  submit() {
    const d = this.data
    if (d.busy) return
    const body = {
      title: d.title,
      scope: d.scope,
      sku_code: d.sku,
      due: `${d.day} ${d.time}`,
      to: d.toIdx >= 0 ? d.staff[d.toIdx].id : '',
    }
    if (!body.to) {
      wx.showToast({ title: '选派给谁', icon: 'none' })
      return
    }
    this.setData({ busy: true })
    request({ url: '/api/sales-workbench/tasks', method: 'POST', data: body })
      .then((t) => {
        wx.showToast({ title: `已派给 ${t.assignee}`, icon: 'none' })
        this.setData({ title: '', scope: '', sku: '' })
        return this.load()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '没派出去', icon: 'none' }))
      .finally(() => this.setData({ busy: false }))
  },

  open(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },
})
