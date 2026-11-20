const auth = require('@services/auth')
const api = require('@services/api')

const FILTER_TABS = [
  { key: '', label: '全部' },
  { key: 'RETURNING', label: '退货中' },
  { key: 'PENDING_INBOUND', label: '待入库' },
  { key: 'ABNORMAL', label: '异常' },
  { key: 'DONE', label: '已完成' },
]

const EMPTY_TEXT = {
  '': '暂无退货单',
  RETURNING: '暂无退货中订单',
  PENDING_INBOUND: '暂无待入库退货',
  ABNORMAL: '暂无异常退回',
  DONE: '暂无已完成退货',
}

const RESOLVE_CONFIRM = {
  RESTOCK: '确认恢复在库？将按收货核对填写的库位恢复库存。',
  LOSS: '确认报损？商品将转为报损状态，不再计入可售库存。',
  REJECT: '确认驳回？退货单退回「待入库」，由仓库重新收货核对。',
}

Page({
  data: {
    filterTabs: FILTER_TABS,
    listTab: '',
    list: [],
    total: 0,
    loading: false,
    emptyText: '暂无退货单',
    canCreate: false,
    canReceive: false,
    canResolve: false,
  },

  onShow() {
    // 注意：ensureLogin() resolve 的是 globalData 不是 user，角色必须从 globalData.user 拿
    auth.ensureLogin().then(() => {
      const user = getApp().globalData.user || {}
      const role = user.role
      this.setData({
        canCreate: role === 'SALES' || role === 'WAREHOUSE' || role === 'ADMIN',
        canReceive: role === 'WAREHOUSE' || role === 'ADMIN',
        canResolve: role === 'ADMIN',
      })
      if (this._loaded) return
      this._loaded = true
      return this.reload()
    })
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.listTab) return
    this.setData({ listTab: tab, emptyText: EMPTY_TEXT[tab] || EMPTY_TEXT[''] })
    this.reload()
  },

  reload() {
    this.setData({ loading: true })
    const params = { page: 1, size: 50 }
    if (this.data.listTab) params.status = this.data.listTab
    return api.listReturns(params)
      .then((res) => {
        this.setData({
          list: res.items || [],
          total: res.total || 0,
          loading: false,
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/returns/create/index' })
  },

  markInbound(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '标记待入库',
      content: '确认客户已寄回，等待仓库签收？',
      success: (res) => {
        if (!res.confirm) return
        api.returnToInbound(id)
          .then(() => {
            wx.showToast({ title: '已标记', icon: 'success' })
            this.reload()
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '操作失败', icon: 'none' })
          })
      },
    })
  },

  receive(e) {
    const item = e.currentTarget.dataset.item
    if (!item || !item.id) return
    // 收货改为强制核对：跳核对页填序列号/状态/库位/照片
    const name = encodeURIComponent(item.product_name || '')
    wx.navigateTo({
      url: `/pages/returns/receive/index?id=${item.id}&sku_code=${item.sku_code || ''}&return_no=${item.return_no || ''}&product_name=${name}`,
    })
  },

  resolve(e) {
    const { id, action } = e.currentTarget.dataset
    if (!id || !RESOLVE_CONFIRM[action]) return
    wx.showModal({
      title: '异常件裁决',
      content: RESOLVE_CONFIRM[action],
      success: (res) => {
        if (!res.confirm) return
        api.resolveReturn(id, { action })
          .then(() => {
            wx.showToast({ title: '已处理', icon: 'success' })
            this.reload()
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.detail) || '操作失败', icon: 'none' })
          })
      },
    })
  },
})
