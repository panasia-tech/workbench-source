const auth = require('@services/auth')
const api = require('@services/api')

const ACTIVITY_PAGE_SIZE = 20
const LEDGER_URL = 'http://127.0.0.1:8000'

Page({
  data: {
    user: null,
    summary: {},
    activities: [],
    activitiesHasMore: true,
    activitiesLoading: false,
    workload: {},
    commission: null,
    financeStats: null,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().syncTabs()
      this.setData({ user: getApp().globalData.user })
      const isAdmin = getApp().globalData.user?.role === 'ADMIN'
      return Promise.all([
        api.dashboardSummary(),
        // 最近动态仅管理员展示，非管理员不请求
        isAdmin ? api.dashboardActivities({ offset: 0, limit: ACTIVITY_PAGE_SIZE }) : Promise.resolve([]),
        api.dashboardWorkload(),
        api.dashboardCommission({ period: 'today' }),
        isAdmin ? api.financeStats({}).catch(() => null) : Promise.resolve(null),
      ])
    }).then(([summary, activities, workload, commission, financeStats]) => {
      const role = getApp().globalData.user?.role
      const showPurchaseCommission = role === 'PURCHASER' || role === 'ADMIN'
      const showWarehouseCommission = role === 'WAREHOUSE' || role === 'ADMIN'
      const showSalesCommission = role === 'SALES' || role === 'ADMIN'
      const showFinanceMenu = role === 'FINANCE' || role === 'ADMIN'
      // 顶部统计卡按"跳转页的可见角色"逐张控制，避免无权角色点了报错或看空数据
      const showInspectStat = role === 'WAREHOUSE' || role === 'ADMIN'            // 待验货→验货任务(仓管/管理员)
      const showInStockStat = role === 'WAREHOUSE' || role === 'SALES' || role === 'ADMIN'  // 在库→库存(仓管/销售/管理员)
      const showPurchaseStat = role === 'PURCHASER' || role === 'ADMIN'           // 今日采购→采购记录(采购/管理员)
      const showOutboundStat = role === 'WAREHOUSE' || role === 'SALES' || role === 'ADMIN'  // 今日出库→出库记录(仓管/销售/管理员)
      const showStatsGrid = showInspectStat || showInStockStat || showPurchaseStat || showOutboundStat
      const isAdmin = role === 'ADMIN'
      this.setData({
        summary,
        activities,
        activitiesHasMore: activities.length >= ACTIVITY_PAGE_SIZE,
        activitiesLoading: false,
        workload,
        commission,
        financeStats,
        showPurchaseCommission,
        showWarehouseCommission,
        showSalesCommission,
        showCommissionRows: showPurchaseCommission || showWarehouseCommission || showSalesCommission,
        showFinanceMenu,
        showInspectStat,
        showInStockStat,
        showPurchaseStat,
        showOutboundStat,
        showStatsGrid,
        isAdmin,
      })
    })
  },

  loadMoreActivities() {
    if (this.data.activitiesLoading || !this.data.activitiesHasMore) return
    this.setData({ activitiesLoading: true })
    api.dashboardActivities({ offset: this.data.activities.length, limit: ACTIVITY_PAGE_SIZE })
      .then((more) => {
        this.setData({
          activities: this.data.activities.concat(more || []),
          activitiesHasMore: (more || []).length >= ACTIVITY_PAGE_SIZE,
          activitiesLoading: false,
        })
      })
      .catch(() => this.setData({ activitiesLoading: false }))
  },

  goPendingInspect() {
    wx.navigateTo({ url: '/pages/inspection/index' })
  },

  goInStock() {
    wx.navigateTo({ url: '/pages/warehouse/index' })
  },

  goPurchaseRecords() {
    wx.navigateTo({ url: '/pages/purchase/records/index?today=1' })
  },

  goOutboundRecords() {
    wx.navigateTo({ url: '/pages/sales/outbound-records/index' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号吗？',
      success: (res) => {
        if (res.confirm) auth.logout()
      },
    })
  },

  goStats() {
    wx.navigateTo({ url: '/pages/profile/stats/index' })
  },

  goChangePassword() {
    wx.navigateTo({ url: '/pages/profile/change-password/index' })
  },

  goMyInfo() {
    wx.navigateTo({ url: '/pages/profile/my-info/index' })
  },

  goMcp() {
    wx.navigateTo({ url: '/pages/profile/mcp/index' })
  },

  goBill() {
    wx.navigateTo({ url: '/pages/finance/bill/index' })
  },

  goPayslip() {
    wx.navigateTo({ url: '/pages/profile/payslip/index' })
  },

  goAnonymousFeedback() {
    wx.navigateTo({ url: '/pages/feedback/anonymous/index' })
  },

  goAsset() {
    wx.navigateTo({ url: '/pages/asset/index' })
  },

  goPhone() {
    wx.navigateTo({ url: '/pages/phone/index' })
  },

  goAccountProfile() {
    wx.navigateTo({ url: '/pages/account-profile/index' })
  },

  // 大台账是后台打包出来的单独页面：新标签页打开（同域，借 H5 的登录）；小程序里打不开就复制链接
  goLedger() {
    let win = null
    try { win = typeof window !== 'undefined' ? window.open(LEDGER_URL, '_blank') : null } catch (e) { win = null }
    if (win) return
    wx.setClipboardData({ data: LEDGER_URL, success: () => wx.showToast({ title: '台账链接已复制，到浏览器里打开', icon: 'none' }) })
  },

  goGcBind() {
    wx.navigateTo({ url: '/pages/gc-bind/index' })
  },
})
