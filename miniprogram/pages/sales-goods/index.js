const auth = require('@services/auth')
const { request } = require('@services/request')
const { startTour } = require('@utils/tour')

const LEVELS = [
  { key: 'red', label: '要处理，先做这些' },
  { key: 'yellow', label: '注意，有空看看' },
  { key: 'green', label: '正常，不用管' },
]
// 角标前的记号：颜色之外再给一个形状，色弱也分得清
const BADGE = { red: '✕', yellow: '!', green: '✓' }

// 库存商品：每件在库的货一张卡。红 = 现在动手，黄 = 注意，绿 = 不用管；颜色只表达这一件事。
// 筛选、分组、搜索留在页面里，进详情再回来还是原样（页面没销毁）。
Page({
  data: {
    loading: false,
    loaded: false,
    counts: { red: 0, yellow: 0, green: 0 },
    pool: [],
    isAdmin: false,
    total: 0,
    level: '',
    group: 'level',
    q: '',
    groups: [],
    showHelp: false,
  },

  onLoad(options) {
    this.items = []
    // 「今天」里「去库存商品看全部」带着颜色进来
    const level = (options && options.level) || ''
    if (LEVELS.some((l) => l.key === level)) this.setData({ level })
  },

  onShow() {
    // 从详情回来要刷新：刚处理掉的那条该变色了
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    const q = (this.data.q || '').trim()
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return request({ url: `/api/sales-workbench/goods${qs}` })
      .then((res) => {
        this.items = (res.items || []).map((c) => ({
          ...c,
          top: c.issues[0] || null,
          more: Math.max(0, c.issues.length - 1),
          badge: `${BADGE[c.level]} ${c.level_label}`,
          cost: c.cost_price === null || c.cost_price === undefined ? '' : `¥${Number(c.cost_price).toFixed(0)}`,
          // 行情：最近两次抓价的涨跌（±10% 黄、±20% 红；日期是最近一次）
          trendText: c.trend && c.trend.pct ? `行情 ${c.trend.pct > 0 ? '↑' : '↓'}${Math.abs(c.trend.pct)}% · ${c.trend.date}` : '',
          trendLevel: c.trend ? c.trend.level || '' : '',
          cycleText: c.age_stage === 'stale' ? `满 ${c.cycle} 周期 · ${c.age_days} 天` : `第 ${c.cycle} 周期 · ${c.age_days} 天`,
          // 各号审批小结（上架审批开着才有）：通过 / 待办（没清洗 + 等审批）/ 要整改
          shopSum: c.approval
            ? [
              { k: 'green', n: c.approval.approved, t: '通过' },
              { k: 'yellow', n: c.approval.todo + c.approval.review, t: '待办' },
              { k: 'red', n: c.approval.fix, t: '要整改' },
            ].filter((x) => x.n)
            : [],
        }))
        const user = getApp().globalData.user || {}
        this.setData({
          counts: res.counts,
          total: res.total,
          pool: res.pool || [],
          isAdmin: user.role === 'ADMIN',
          loaded: true,
        })
        this._render()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  _render() {
    const { level, group } = this.data
    const list = level ? this.items.filter((c) => c.level === level) : this.items
    let groups
    if (group === 'type' || group === 'source') {
      const field = group === 'type' ? 'product_type' : 'source'
      const by = {}
      list.forEach((c) => { (by[c[field]] = by[c[field]] || []).push(c) })
      groups = Object.keys(by).sort((a, b) => by[b].length - by[a].length).map((k) => ({ key: k, title: k, items: by[k] }))
    } else {
      groups = LEVELS.map((l) => ({ key: l.key, dot: l.key, title: l.label, items: list.filter((c) => c.level === l.key) }))
        .filter((g) => g.items.length)
    }
    this.setData({ groups })
  },

  pickLevel(e) {
    const key = e.currentTarget.dataset.key
    // 「全部」传空；点已选中的那个再点一次也回到全部
    this.setData({ level: !key || this.data.level === key ? '' : key })
    this._render()
  },

  pickGroup(e) {
    this.setData({ group: e.currentTarget.dataset.key })
    this._render()
  },

  onSearch(e) {
    this.setData({ q: e.detail.value })
  },

  doSearch() {
    this.load()
  },

  // 管理员：同款图池在后台「图片爬虫」页审核
  goPool() {
    const url = '/console/master/product-images'
    let win = null
    try { win = typeof window !== 'undefined' ? window.open(url, '_blank') : null } catch (e) { win = null }
    if (!win) wx.showToast({ title: '到电脑后台「图片爬虫」里看', icon: 'none' })
  },

  toggleHelp() {
    // 打开说明时顺带走一遍本页导览（H5 里）
    if (!this.data.showHelp) startTour()
    this.setData({ showHelp: !this.data.showHelp })
  },

  openCard(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },

  // 不等行情提醒，随时挑一件去清洗价格
  goClean(e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.navigateTo({ url: `/pages/price-clean/index?code=${encodeURIComponent(code)}` })
  },

  openIssue(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },
})
