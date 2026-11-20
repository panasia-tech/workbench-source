const auth = require('@services/auth')
const { request } = require('@services/request')

// 闲鱼订单：照销售工作台交付包——上面一排分类（带数），左边订单卡，右边（手机上是卡片下面）写它为什么红、该做什么。
// 四类问题都跳红：漏抓 / 对不上货 / 卡住没走 / 状态不同步；卖出了还没到时限的是黄的「待发货」；正常走完的在「正常」里，不着色。
const TABS = [
  { key: '', label: '全部' },
  { key: 'missed', label: '漏抓', dot: 'red' },
  { key: 'mismatch', label: '对不上货', dot: 'red' },
  { key: 'stuck', label: '卡住没走', dot: 'red' },
  { key: 'unsync', label: '状态不同步', dot: 'red' },
  { key: 'pending', label: '待发货', dot: 'yellow' },
  { key: 'ok', label: '正常', dot: 'green' },
]
// 点开一单：为什么红、下一步做什么
const WHY = {
  missed: '闲鱼显示卖出了，ERP 里这件货还在库、没锁，别的号可能再卖一次。先到这件货的页面核对：真卖出了就锁货，再去发货。',
  mismatch: '同一件货在几个号都卖出了。只能发一单：选一单发货，别的跟买家协商退款，别随便找一件同款顶上。',
  stuck: '卖出了还没发，已经过了发货时限。去手动成交出库（货号已经带上），发完记得填运单号。',
  pending: '卖出了，在时限前发就行：当天 17:00 前卖出的当天 17:00 前发，17:00 后卖出的次日 17:00 前发。',
  unsync: 'ERP 已经出库了，闲鱼上这些号还挂着，买家可能还会拍。去把还挂着的号下架。',
  ok: '卖出、出库都走完了，没有别的号挂着，不用管。',
}

Page({
  data: {
    loading: false,
    loaded: false,
    tabs: [],
    tab: '',
    list: [],
    sel: null,
    recentDays: 30,
    showHelp: false,
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return request({ url: '/api/sales-workbench/orders' })
      .then((res) => {
        const problems = (res.problems || []).map((p) => {
          // 卡住没走里没过时限的（黄）单列成「待发货」
          const tab = p.kind === 'stuck' && p.level !== 'red' ? 'pending' : p.kind
          return { ...p, tab, tag: tab === 'pending' ? '待发货' : p.kind_label, _k: `${p.kind}:${p.sku_code}` }
        })
        const recent = (res.recent || []).map((r) => ({
          ...r, tab: 'ok', tag: '正常', level: 'green', _k: `ok:${r.sku_code}`,
          text: `${r.shops[r.shops.length - 1] || ''} ${r.sold_at || ''} 卖出 · ${r.state}`,
          url: r.item_url, button: '去看',
        }))
        this.all = problems.concat(recent)
        const tabs = TABS.map((t) => ({ ...t, count: t.key ? this.all.filter((o) => o.tab === t.key).length : this.all.length }))
        const keep = this.data.sel && this.all.find((o) => o._k === this.data.sel._k)
        this.setData({ tabs, recentDays: res.recent_days, loaded: true, sel: keep ? this._detail(keep) : null })
        this._render()
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  _render() {
    const tab = this.data.tab
    this.setData({ list: tab ? this.all.filter((o) => o.tab === tab) : this.all })
  },

  _detail(o) {
    return { ...o, why: WHY[o.tab] || '' }
  },

  pickTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key })
    this._render()
  },

  pick(e) {
    const k = e.currentTarget.dataset.k
    const o = this.all.find((x) => x._k === k)
    // 再点一次收起（手机上详情展开在卡片下面）
    this.setData({ sel: this.data.sel && this.data.sel._k === k ? null : this._detail(o) })
  },

  toggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },
})
