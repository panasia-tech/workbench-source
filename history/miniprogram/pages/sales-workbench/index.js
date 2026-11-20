const auth = require('@services/auth')
const { request } = require('@services/request')
const { startTour } = require('@utils/tour')

// 「今天」一列：后端已排好先红后黄。红 = 现在动手，黄 = 今天做完；颜色只表达这一件事
const TODO_LABEL = {
  practice: '练习',
  price_review: '清洗价',
  chat: '消息',
  fix: '整改',
  review: '审批',
  todo: '清洗',
  gaps: '缺口',
}
// 提给开发：需求只走禅道（11-09 定），直接打开禅道「销售工作台」产品（id 3）的提 Bug / 提需求页，用 ERP 账号登录
const ZENTAO = 'http://127.0.0.1:8000'
const DEV_LINKS = [`${ZENTAO}/bug-create-3.html`, `${ZENTAO}/story-create-3.html`]
// 货多的时候（真数据几百件）每种颜色只列最急的这么多条，其余去「库存商品」按颜色看
const CAP = 30

function greetOf(h) {
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    loading: false,
    loaded: false,
    ov: null,
    greet: '',
    reds: [],
    ambs: [],
    red: 0,
    yellow: 0,
    redMore: 0,
    ambMore: 0,
    locked: false,
    showHelp: false,
    accounts: [],
  },

  onShow() {
    // 从待办页回来要刷新：刚处理掉的那条该没了
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return request({ url: '/api/sales-workbench/overview' })
      .then((res) => {
        const tasks = (res.tasks || []).map((t) => ({
          ...t,
          tag: t.tag || (t.kind === 'ship' ? '发货' : (TODO_LABEL[t.key] || '待办')),
          // 标签已经写了「发货」，标题里不再重复
          title: t.kind === 'ship' ? String(t.title || '').replace(/^发货：/, '') : t.title,
          // 练习门禁拦着时，除了「去练习」都灰掉
          off: !!res.locked && t.key !== 'practice',
        }))
        const reds = tasks.filter((t) => t.level === 'red')
        const ambs = tasks.filter((t) => t.level === 'yellow')
        this.setData({
          ov: res,
          greet: greetOf(new Date().getHours()),
          reds: reds.slice(0, CAP),
          ambs: ambs.slice(0, CAP),
          red: reds.length,
          yellow: ambs.length,
          redMore: Math.max(0, reds.length - CAP),
          ambMore: Math.max(0, ambs.length - CAP),
          locked: !!res.locked,
          accounts: res.accounts || [],
          loaded: true,
        })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  toggleHelp() {
    // 打开说明时顺带走一遍本页导览（H5 里）
    if (!this.data.showHelp) startTour()
    this.setData({ showHelp: !this.data.showHelp })
  },

  openTodo(e) {
    const { url, off } = e.currentTarget.dataset
    if (off) {
      wx.showToast({ title: '先做完上手练习，真实任务才解锁', icon: 'none' })
      return
    }
    if (url) wx.navigateTo({ url })
  },

  goReport() {
    wx.navigateTo({ url: '/pages/sales-workbench/report/index' })
  },

  goDev() {
    wx.showActionSheet({
      itemList: ['软件出问题了（提 Bug）', '想要新功能（提需求）'],
      success: (r) => this._openDev(DEV_LINKS[r.tapIndex]),
    })
  },

  // 新标签页打开禅道；打不开（小程序、被拦）就复制链接
  _openDev(url) {
    let win = null
    try { win = typeof window !== 'undefined' ? window.open(url, '_blank') : null } catch (e) { win = null }
    if (win) {
      try { win.opener = null } catch (e) {}
      return
    }
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '禅道链接已复制，到浏览器里打开', icon: 'none' }) })
  },

  goAssign() {
    wx.navigateTo({ url: '/pages/sales-workbench/assign/index' })
  },

  goPractice() {
    wx.navigateTo({ url: '/pages/practice/index' })
  },

  goGoods(e) {
    const level = e.currentTarget.dataset.level
    wx.navigateTo({ url: `/pages/sales-goods/index${level ? `?level=${level}` : ''}` })
  },

  goChat() {
    wx.navigateTo({ url: '/pages/gc-chat/list/index' })
  },

  goSales() {
    wx.navigateTo({ url: '/pages/sales/index' })
  },
})
