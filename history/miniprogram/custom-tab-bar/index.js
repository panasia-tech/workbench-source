Component({
  data: {
    tabs: [],
    selected: 0,
  },

  lifetimes: {
    attached() {
      this.syncTabs()
    },
  },

  pageLifetimes: {
    show() {
      this.syncTabs()
    },
  },

  methods: {
    syncTabs() {
      const app = getApp()
      const tabs = app.globalData.tabs || []
      const pages = getCurrentPages()
      const route = pages.length ? pages[pages.length - 1].route : ''
      let selected = 0
      tabs.forEach((t, i) => {
        if (t.pagePath === route) selected = i
      })
      this.setData({ tabs, selected })
    },

    onSwitch(e) {
      const { path, index } = e.currentTarget.dataset
      if (index === this.data.selected) return
      wx.switchTab({
        url: `/${path}`,
        fail: (err) => {
          console.error('switchTab failed', path, err)
          wx.showToast({ title: '页面跳转失败', icon: 'none' })
        },
      })
    },
  },
})
