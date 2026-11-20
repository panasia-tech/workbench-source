const auth = require('@services/auth')
const api = require('@services/api')

Page({
  data: {
    task: null,
    loading: true,
  },

  onLoad(query) {
    this.taskId = query.id || ''
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    if (!this.taskId) {
      this.setData({ loading: false })
      return Promise.resolve()
    }
    this.setData({ loading: true })
    return api.getInspection(this.taskId)
      .then((task) => this.setData({ task, loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },
})
