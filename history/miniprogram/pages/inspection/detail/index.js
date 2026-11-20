const auth = require('@services/auth')
const api = require('@services/api')

Page({
  data: {
    task: null,
    loading: true,
  },

  onLoad(options) {
    this.taskId = options.id
    auth.ensureLogin().then(() => this.loadTask())
  },

  loadTask() {
    if (!this.taskId) {
      this.setData({ loading: false })
      return
    }
    this.setData({ loading: true })
    api.getInspection(this.taskId)
      .then((task) => {
        this.setData({ task, loading: false })
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      })
  },

  onPullDownRefresh() {
    Promise.resolve(this.loadTask()).finally(() => wx.stopPullDownRefresh())
  },
})
