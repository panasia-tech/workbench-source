const auth = require('@services/auth')
const api = require('@services/api')
const listingAutosave = require('@services/listing-autosave')

// 群控中心顶部分区:商品上架(原上架页) / 设备列表 / 任务队列(后两个为内嵌面板组件)
const SECTION_TABS = [
  { key: 'listing', label: '商品上架' },
  { key: 'device', label: '设备列表' },
  { key: 'task', label: '任务队列' },
]

const FILTER_TABS = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '待填表' },
  { key: 'list', label: '待上架' },
]

function actionForItem(item) {
  const s = item.listing_status
  if (!s || s === 'DRAFT') return { label: '填写上架', page: 'form' }
  if (s === 'READY' || s === 'CREATED' || s === 'FAILED') return { label: '店铺上架', page: 'publish' }
  return { label: '继续处理', page: 'form' }
}

function matchesFilter(item, tab) {
  const s = item.listing_status
  if (tab === 'all') return true
  if (tab === 'draft') return !s || s === 'DRAFT'
  if (tab === 'list') return s === 'READY' || s === 'CREATED' || s === 'FAILED'
  return true
}

Page({
  data: {
    sectionTabs: SECTION_TABS,
    section: 'listing',
    // 面板懒渲染:首次切到才挂载(挂载即自加载),之后用 hidden 保留状态
    visited: { listing: true, device: false, task: false },
    filterTabs: FILTER_TABS,
    listTab: 'all',
    allItems: [],
    list: [],
    q: '',
    loading: false,
    emptyText: '暂无待上架商品',
  },

  onShow() {
    auth.ensureLogin().then(() => this.refreshActive())
  },

  onPullDownRefresh() {
    this.refreshActive().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.section !== 'task') return
    const panel = this.selectComponent('#gcTaskPanel')
    if (panel) panel.loadMore()
  },

  // 刷新当前分区;面板未挂载(从未切过去)时 selectComponent 为 null,跳过即可
  refreshActive() {
    const { section } = this.data
    if (section === 'device') {
      const panel = this.selectComponent('#gcDevicePanel')
      return panel ? panel.load() : Promise.resolve()
    }
    if (section === 'task') {
      const panel = this.selectComponent('#gcTaskPanel')
      return panel ? panel.reload() : Promise.resolve()
    }
    return this.reload()
  },

  switchSection(e) {
    const section = e.currentTarget.dataset.section
    if (!section || section === this.data.section) return
    const wasVisited = this.data.visited[section]
    const visited = { ...this.data.visited, [section]: true }
    this.setData({ section, visited }, () => {
      // 首次挂载面板会自加载;已挂载过的切回来手动刷新一次
      if (wasVisited) this.refreshActive()
    })
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.listTab) return
    this.setData({ listTab: tab })
    this.applyFilter()
  },

  reload() {
    this.setData({ loading: true })
    return api.listPendingListing()
      .then((items) => {
        const enriched = (items || []).map((item) => {
          const action = actionForItem(item)
          return {
            ...item,
            _actionLabel: action.label,
            _actionPage: action.page,
          }
        })
        this.setData({ allItems: enriched, loading: false })
        this.applyFilter()
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      })
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
    this.applyFilter()
  },

  onSearch() {
    this.applyFilter()
  },

  applyFilter() {
    const { allItems, listTab, q } = this.data
    // 多关键词模糊：空格分词，每个词都要在 货号/商品名/品牌/型号/规格/库位 里命中（词间 AND）
    const terms = (q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    let list = allItems.filter((item) => matchesFilter(item, listTab))
    if (terms.length) {
      list = list.filter((item) => {
        const hay = [
          item.sku_code, item.product_name, item.brand, item.model, item.spec, item.location_code,
        ].map((s) => (s || '').toString().toLowerCase()).join(' ')
        return terms.every((t) => hay.indexOf(t) >= 0)
      })
    }
    const emptyMap = {
      all: '暂无待上架商品',
      draft: '暂无待填表商品',
      list: '暂无待上架商品',
    }
    this.setData({
      list,
      emptyText: emptyMap[listTab] || '暂无记录',
    })
  },

  openItem(e) {
    const code = e.currentTarget.dataset.code
    const page = e.currentTarget.dataset.page
    if (!code) return
    if (page === 'publish') {
      listingAutosave.gotoPublish(code)
      return
    }
    wx.navigateTo({ url: `/pages/listing/form/index?code=${code}` })
  },

  processNext() {
    const first = this.data.list[0] || this.data.allItems[0]
    if (!first) {
      wx.showToast({ title: '暂无待处理商品', icon: 'none' })
      return
    }
    const { page } = actionForItem(first)
    if (page === 'publish') {
      listingAutosave.gotoPublish(first.sku_code)
      return
    }
    wx.navigateTo({ url: `/pages/listing/form/index?code=${first.sku_code}` })
  },
})
