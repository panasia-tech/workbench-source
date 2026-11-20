const api = require('@services/api')
const auth = require('@services/auth')

// 群控中心设备列表点一个闲鱼号进来:它发过的每件货(在架/上架中/已售/已下架/失败),点开看标题、价格、描述。
const TABS = [
  { key: '', label: '全部' },
  { key: 'LISTED', label: '在架' },
  { key: 'LISTING', label: '上架中' },
  { key: 'SOLD', label: '已售' },
  { key: 'DELISTED', label: '已下架' },
  { key: 'FAILED', label: '失败' },
]

function short(t) {
  return t ? String(t).replace('T', ' ').slice(0, 16) : '—'
}

function withWhen(i) {
  const when = i.publish_status === 'SOLD' ? `卖出 ${short(i.sold_at)}`
    : i.publish_status === 'DELISTED' ? `下架 ${short(i.delisted_at)}`
      : `发布 ${short(i.created_at)}`
  return { ...i, _when: when }
}

Page({
  data: {
    accountId: '',
    nick: '',
    shopLabels: '',
    loading: true,
    all: [],
    list: [],
    tabs: TABS,
    tab: '',
    expanded: '',
  },

  onLoad(options) {
    const nick = decodeURIComponent(options.nick || '')
    this.setData({ accountId: options.account_id || '', nick })
    if (nick) wx.setNavigationBarTitle({ title: `${nick} 发的商品` })
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return api.gcOpsAccountListings(this.data.accountId).then((res) => {
      const counts = res.counts || {}
      const total = (res.items || []).length
      const tabs = TABS.map((t) => ({ ...t, count: t.key ? (counts[t.key] || 0) : total }))
        .filter((t) => !t.key || t.count)
      const nick = this.data.nick
      this.setData({
        all: (res.items || []).map(withWhen),
        tabs,
        shopLabels: (res.shop_labels || []).filter((l) => l !== nick).join('、'),
        loading: false,
      }, () => this.applyTab())
    }).catch(() => this.setData({ loading: false }))
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab }, () => this.applyTab())
  },

  applyTab() {
    const { all, tab } = this.data
    this.setData({ list: tab ? all.filter((i) => i.publish_status === tab) : all })
  },

  toggle(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ expanded: this.data.expanded === id ? '' : id })
  },

  openSku(e) {
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${e.currentTarget.dataset.code}` })
  },
})
