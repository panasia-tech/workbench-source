const auth = require('@services/auth')
const api = require('@services/api')
const { sanitizeDecimal } = require('@utils/money')

const PAGE_SIZE = 20

// 出库类型筛选：与后端 OutboundType 对应。「销售」=平台发货+手动成交。
const TYPE_TABS = [
  { key: '', label: '全部' },
  { key: 'ORDER_SHIP,MANUAL', label: '销售' },
  { key: 'PICKUP', label: '自提' },
  { key: 'SWITCH', label: '切单' },
]

const TYPE_LABEL = {
  ORDER_SHIP: '发货',
  MANUAL: '手动',
  PICKUP: '自提',
  SWITCH: '切单',
}
const TYPE_TAG = {
  ORDER_SHIP: 'tag-info',
  MANUAL: 'tag-info',
  PICKUP: 'tag-success',
  SWITCH: 'tag-pending',
}

// 北京当日 YYYY-MM-DD（设备时区可能非北京，统一换算）
function cnToday() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const cn = new Date(utc + 8 * 3600000)
  const m = String(cn.getMonth() + 1).padStart(2, '0')
  const d = String(cn.getDate()).padStart(2, '0')
  return `${cn.getFullYear()}-${m}-${d}`
}

function enrich(item) {
  return {
    ...item,
    typeLabel: TYPE_LABEL[item.outbound_type] || '出库',
    typeTag: TYPE_TAG[item.outbound_type] || 'tag-pending',
  }
}

Page({
  data: {
    list: [],
    q: '',
    typeTabs: TYPE_TABS,
    typeKey: '',
    dateFrom: '',
    dateTo: '',
    page: 1,
    total: 0,
    loading: false,
    noMore: false,
  },

  onLoad() {
    // 默认展示「今日」出库，与「我的-今日出库」统计口径一致
    const today = cnToday()
    this.setData({ dateFrom: today, dateTo: today })
  },

  onShow() {
    auth.ensureLogin().then(() => {
      if (this._loaded) return
      this._loaded = true
      this.reload()
    })
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  onSearchInput(e) {
    this.setData({ q: e.detail.value })
  },

  onDateFromChange(e) {
    this.setData({ dateFrom: e.detail.value }, () => this.reload())
  },

  onDateToChange(e) {
    this.setData({ dateTo: e.detail.value }, () => this.reload())
  },

  onSearch() {
    this.reload()
  },

  onTypeTab(e) {
    const key = e.currentTarget.dataset.key || ''
    if (key === this.data.typeKey) return
    this.setData({ typeKey: key }, () => this.reload())
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  loadMore() {
    if (this.data.loading || this.data.noMore) return Promise.resolve()
    this.setData({ loading: true })
    const { page, q, typeKey, dateFrom, dateTo } = this.data
    const params = { mine: true, page, size: PAGE_SIZE }
    if (typeKey) params.outbound_type = typeKey
    if (q) params.q = q
    if (dateFrom) params.date_from = dateFrom
    if (dateTo) params.date_to = dateTo
    return api.listOutbounds(params).then((res) => {
      const items = (res.items || []).map(enrich)
      const merged = page === 1 ? items : this.data.list.concat(items)
      const noMore = merged.length >= (res.total || 0) || items.length < PAGE_SIZE
      this.setData({
        list: merged,
        total: res.total || 0,
        page: page + 1,
        noMore,
        loading: false,
      })
    }).catch(() => {
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  openDetail(e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${code}` })
  },

  // 补填 / 改闲鱼服务费（订单页上的数）；清空 = 回到按档估
  editFee(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.list[index]
    if (!item || !item.fee_editable) return
    wx.showModal({
      title: '闲鱼服务费',
      editable: true,
      placeholderText: '订单页上的服务费，元',
      content: item.platform_fee == null ? '' : String(item.platform_fee),
      success: (res) => {
        if (!res.confirm) return
        const text = sanitizeDecimal((res.content || '').trim())
        const fee = text === '' ? null : Number(text)
        api.setOutboundFee(item.id, fee).then((out) => {
          this.setData({ [`list[${index}].platform_fee`]: out.platform_fee })
          wx.showToast({ title: '已保存', icon: 'success' })
        }).catch((err) => {
          wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
        })
      },
    })
  },

  goReturn(e) {
    const code = e.currentTarget.dataset.code
    if (code) wx.navigateTo({ url: `/pages/returns/create/index?sku_code=${code}` })
  },
})
