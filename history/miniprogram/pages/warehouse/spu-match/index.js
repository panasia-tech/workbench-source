const api = require('@services/api')
const auth = require('@services/auth')
const { scanBarcode } = require('@services/scan')

const PAGE_SIZE = 20
const TABS = [
  { key: 'todo', label: '待匹配' },
  { key: 'returned', label: '待补正' },
  { key: 'waiting', label: '待验收' },
  { key: 'done', label: '已确认' },
]
const HINTS = {
  todo: '在库还没确认属于哪个商品的货',
  returned: '验收没通过，按退回原因补正后重新提交',
  waiting: '已提交，等管理员验收',
  done: '验收通过，行情、图片、上架都按它算',
}
const STATE_TAG = { NORMAL: 'tag-success', CONFLICT: 'tag-warning', NONE: 'tag-danger' }

function decorate(items = []) {
  return items.map((item) => ({
    ...item,
    tagClass: item.state ? STATE_TAG[item.state] : (item.match_status === 'CONFIRMED' ? 'tag-success' : 'tag-warning'),
    tagText: item.state_title || item.match_label,
  }))
}

Page({
  data: {
    tabs: TABS,
    tab: 'todo',
    hint: HINTS.todo,
    q: '',
    list: [],
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
  },

  onLoad(options) {
    if (options && options.tab && HINTS[options.tab]) this.setData({ tab: options.tab, hint: HINTS[options.tab] })
  },

  onShow() {
    // 从匹配页回来时刷新：刚提交的那件要换到「待验收」
    auth.ensureLogin().then(() => this.reload())
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.reload(), 400)
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        this.setData({ q: code })
        this.reload()
      })
      .catch(() => {})
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab, hint: HINTS[tab] })
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.fetch(1)
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return
    this.fetch(this.data.page + 1)
  },

  fetch(page) {
    this.setData({ loading: true })
    return api.listSpuMatch({ tab: this.data.tab, q: this.data.q, page, size: PAGE_SIZE })
      .then((res) => {
        const items = decorate(res.items)
        const list = page === 1 ? items : this.data.list.concat(items)
        this.setData({ list, page, total: res.total, noMore: list.length >= res.total })
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false }))
  },

  openDetail(e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.navigateTo({ url: `/pages/warehouse/spu-match/detail/index?code=${encodeURIComponent(code)}` })
  },
})
