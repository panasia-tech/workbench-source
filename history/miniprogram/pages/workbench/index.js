const auth = require('@services/auth')
const workbench = require('@services/workbench')
const { request } = require('@services/request')

// 销售工作台几个入口带红点（红的有几条，练习是还差几步）；练习门禁拦着时顶上写「真实任务先锁着」
const BADGE_ROLES = ['SALES', 'ADMIN']

Page({
  data: {
    user: null,
    entries: [],
    lockLeft: 0,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().syncTabs()
      }
      const user = getApp().globalData.user
      this.setData({
        user,
        entries: workbench.getEntriesForRole(user?.role),
      })
      if (BADGE_ROLES.includes(user?.role)) this.loadBadges()
    })
  },

  loadBadges() {
    return request({ url: '/api/sales-workbench/badges' })
      .then((b) => {
        if (!b) return
        const entries = this.data.entries.map((e) => {
          const n = e.badge ? b[e.badge] : 0
          return { ...e, badgeText: n ? (n > 99 ? '99+' : String(n)) : '' }
        })
        this.setData({ entries, lockLeft: b.practice || 0 })
      })
      .catch(() => {})
  },

  openEntry(e) {
    const { url } = e.currentTarget.dataset
    if (!url) return
    wx.navigateTo({ url })
  },

  goPractice() {
    wx.navigateTo({ url: '/pages/practice/index' })
  },
})
