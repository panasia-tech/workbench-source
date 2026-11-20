const auth = require('@services/auth')

const api = require('@services/api')

const { scanBarcode } = require('@services/scan')

const listingAutosave = require('@services/listing-autosave')

const PAGE_SIZE = 20

/** 默认展示全部在库实物（含待上架/在售/锁单）；分签仅作筛选 */
const FILTER_TABS = [
  { key: 'all', label: '全部在库' },
  { key: 'on_sale', label: '在售' },
  { key: 'locked', label: '锁单' },
]

const EMPTY_TEXT = {
  all: '暂无在库商品',
  on_sale: '暂无在售商品',
  locked: '暂无锁单商品',
}

Page({
  data: {
    filterTabs: FILTER_TABS,
    summary: {},
    list: [],
    listTab: 'all',
    q: '',
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
    emptyText: EMPTY_TEXT.all,
    legacyMatches: [],
    tagOptions: [],
    selectedTags: [],
    tagSheetVisible: false,
    tagSheetDraft: [],
    isSales: false,
    gapTodo: null,
  },

  openTagSheet() {
    if (!this.data.tagOptions.length) return
    this.setData({
      tagSheetVisible: true,
      tagSheetDraft: this.data.selectedTags.slice(),
    })
  },

  closeTagSheet() {
    this.setData({ tagSheetVisible: false })
  },

  toggleTagDraft(e) {
    const { name } = e.currentTarget.dataset
    if (!name) return
    const draft = this.data.tagSheetDraft.slice()
    const idx = draft.indexOf(name)
    if (idx >= 0) draft.splice(idx, 1)
    else draft.push(name)
    this.setData({ tagSheetDraft: draft })
  },

  clearTagDraft() {
    this.setData({ tagSheetDraft: [] })
  },

  confirmTagSheet() {
    const selected = this.data.tagSheetDraft.slice()
    const labelByName = {}
    this.data.tagOptions.forEach((t) => { labelByName[t.name] = t.label || t.name })
    this.setData({
      selectedTags: selected,
      selectedTagsText: selected.map((n) => labelByName[n] || n).join(' / '),
      tagSheetVisible: false,
    })
    this.reload()
  },

  onShow() {
    auth.ensureLogin().then(() => {
      const role = getApp().globalData.user?.role
      this.setData({
        isSales: role === 'SALES',
        isWarehouse: role === 'WAREHOUSE',
        canViewStocktake: role === 'WAREHOUSE' || role === 'ADMIN',
        canViewSkuMigration: role === 'WAREHOUSE' || role === 'ADMIN',
      })
      this.loadGapCount(role)
      return Promise.all([
        api.inventorySummary(),
        api.enabledWarehouseTags().catch(() => []),
      ])
    }).then(([summary, tags]) => {
      // 内置「历史迁移待核验」筛选:LEGACY_IMPORT 是迁移打的 sku 标签,不在后台标签主数据里
      const tagOptions = (tags || []).concat([
        { id: '__legacy_import__', name: 'LEGACY_IMPORT', label: '历史迁移待核验' },
      ])
      this.setData({ summary, tagOptions })
      // 已有列表时静默刷新（不清空、保持滚动位置）；首次进入才整页重载
      if (this.data.list.length) return this.refreshSilent()
      return this.reload()
    })
  },

  onPullDownRefresh() {
    Promise.all([
      api.inventorySummary().then((summary) => this.setData({ summary })),
      this.reload(),
    ]).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.reload(), 400)
  },

  onSearch() {
    this.reload()
  },

  onScanSearch() {
    scanBarcode()
      .then((code) => {
        if (this._searchTimer) clearTimeout(this._searchTimer)
        this.setData({ q: code })
        this.reload()
      })
      .catch(() => {})
  },

  switchListTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.listTab) return
    this.setData({
      listTab: tab,
      emptyText: EMPTY_TEXT[tab] || '暂无记录',
    })
    this.reload()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false, legacyMatches: [] })
    return this.loadMore()
  },

  // 从详情/其他页返回时的静默刷新：按已加载条数重拉数据，一次性整体替换，
  // 列表高度不塌，滚动位置得以保留；失败不打断、保留旧数据
  refreshSilent() {
    const loadedCount = this.data.list.length
    if (!loadedCount) return this.reload()
    const { q, listTab, selectedTags } = this.data
    const buildParams = (page, size) => {
      const params = { page, size }
      if (listTab === 'all') {
        params.in_warehouse = true
      } else {
        params.phase = listTab
      }
      if (q) params.q = q
      if (selectedTags && selectedTags.length) params.tags = selectedTags.join(',')
      return params
    }
    const size = 100 // 后端 size 上限 100，超出已加载条数时分页并发拉取
    const pages = Math.ceil(loadedCount / size)
    const reqs = []
    for (let p = 1; p <= pages; p++) reqs.push(api.listSkus(buildParams(p, size)))
    return Promise.all(reqs).then((results) => {
      const items = results.reduce((acc, r) => acc.concat(r.items || []), [])
      const total = results[0] ? (results[0].total || 0) : 0
      this.setData({
        list: items,
        total,
        page: Math.floor(items.length / PAGE_SIZE) + 1,
        noMore: items.length >= total || items.length < pages * size,
        legacyMatches: results[0] ? (results[0].legacy_matches || []) : [],
      })
    }).catch(() => {})
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, listTab, selectedTags } = this.data
    const params = { page, size: PAGE_SIZE }
    if (listTab === 'all') {
      params.in_warehouse = true
    } else {
      params.phase = listTab
    }
    if (q) params.q = q
    if (selectedTags && selectedTags.length) params.tags = selectedTags.join(',')
    return api.listSkus(params).then((res) => {
      const items = res.items || []
      const merged = page === 1 ? items : this.data.list.concat(items)
      const noMore = merged.length >= (res.total || 0) || items.length < PAGE_SIZE
      this.setData({
        list: merged,
        total: res.total || 0,
        page: page + 1,
        noMore,
        loading: false,
        // 搜索无在库结果时,后端附带返回老系统历史记录(仅供核对)
        legacyMatches: page === 1 ? (res.legacy_matches || []) : this.data.legacyMatches,
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  openDetail(e) {
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${e.currentTarget.dataset.code}` })
  },

  goManualInbound() {
    wx.navigateTo({ url: '/pages/warehouse/manual-inbound/index' })
  },

  // 老系统历史记录 → 带资料转手动入库(实物核验后)。图片必须现场新拍,不带老图。
  goLegacyInbound(e) {
    const item = this.data.legacyMatches[e.currentTarget.dataset.index]
    if (!item) return
    const remarkParts = ['老系统转入库']
    if (item.goods_no) remarkParts.push(`老货号${item.goods_no}`)
    if (item.location) remarkParts.push(`老库位${item.location}`)
    getApp().globalData.manualInboundIntent = {
      sku_code: item.goods_no || '',
      product_name: item.product_name || '',
      model: item.model || '',
      serial_number: item.barcode || item.serial_no || '',
      cost_price: item.purchase_price_fen != null ? String(item.purchase_price_fen / 100) : '',
      remark: remarkParts.join(' '),
    }
    wx.navigateTo({ url: '/pages/warehouse/manual-inbound/index' })
  },

  goOutbound() {
    wx.navigateTo({ url: '/pages/warehouse/outbound/index' })
  },

  goStocktake() {
    wx.navigateTo({ url: '/pages/warehouse/stocktake/index' })
  },

  goStocktakeRecords() {
    wx.navigateTo({ url: '/pages/warehouse/stocktake-records/index' })
  },

  goSkuMigration() {
    wx.navigateTo({ url: '/pages/warehouse/sku-migration/index' })
  },

  goBarcodeMigration() {
    wx.navigateTo({ url: '/pages/warehouse/barcode-migration/index' })
  },

  // 库存缺口入口上的「要人补 N 件」：系统自己在等的（爬虫在爬价、在搜图）不算
  loadGapCount(role) {
    if (['ADMIN', 'WAREHOUSE', 'SALES'].indexOf(role) < 0) return this.setData({ gapTodo: null })
    api.listStockGaps({ size: 1 })
      .then((res) => this.setData({ gapTodo: (res.kinds || []).reduce((n, k) => n + k.todo, 0) }))
      .catch(() => this.setData({ gapTodo: null }))
  },

  goGaps() {
    wx.navigateTo({ url: '/pages/warehouse/gaps/index' })
  },

  goSpuMatch() {
    wx.navigateTo({ url: '/pages/warehouse/spu-match/index' })
  },

  goShip() {
    wx.navigateTo({ url: '/pages/sales/index' })
  },

  goDelist(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/shop-off/index?code=${code}` })
  },

  goPublish(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    listingAutosave.gotoPublish(code)
  },

})
