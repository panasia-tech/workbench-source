const auth = require('@services/auth')
const api = require('@services/api')

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
]

Page({
  data: {
    periods: PERIODS,
    period: 'today',
    stats: {},
    loading: false,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      const user = getApp().globalData.user
      if (!user || user.role !== 'ADMIN') {
        wx.showToast({ title: '无权限', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 400)
        return
      }
      return this.loadStats()
    })
  },

  pickPeriod(e) {
    const period = e.currentTarget.dataset.period
    if (period === this.data.period) return
    this.setData({ period })
    this.loadStats()
  },

  loadStats() {
    this.setData({ loading: true })
    return api.dashboardAdminStats({ period: this.data.period }).then((stats) => {
      this.setData({ stats, loading: false })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },
})
